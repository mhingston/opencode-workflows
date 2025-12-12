import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OpencodeClient } from "../types.js";

// Use vi.hoisted to create mocks that can be used in vi.mock factories
const { mockExecAsync } = vi.hoisted(() => ({
  mockExecAsync: vi.fn(),
}));

// Mock child_process - needs to work with promisify
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
}));

// Mock node:util to return our async mock when promisify is called with exec
vi.mock("node:util", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:util")>();
  return {
    ...original,
    promisify: () => mockExecAsync,
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

// Mock @mastra/core/workflows to return our execute function
vi.mock("@mastra/core/workflows", () => ({
  createStep: vi.fn((config) => ({
    id: config.id,
    execute: config.execute,
    description: config.description,
  })),
}));

// Import after mocks
import {
  createShellStep,
  createToolStep,
  createAgentStep,
  createSuspendStep,
  createWaitStep,
  createHttpStep,
  createFileStep,
  createIteratorStep,
} from "./steps.js";
import { readFile, writeFile, unlink } from "node:fs/promises";

// Helper to simulate successful exec - works with the promisified version
function mockExecSuccess(stdout: string, stderr = "") {
  mockExecAsync.mockResolvedValue({ stdout, stderr });
}

function mockExecError(code: number, stderr: string, stdout = "") {
  const error = Object.assign(new Error(stderr), { code, stdout, stderr });
  mockExecAsync.mockRejectedValue(error);
}

describe("Step Adapters", () => {
  let mockClient: OpencodeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      tools: {
        testTool: {
          execute: vi.fn().mockResolvedValue({ success: true }),
        },
      },
      llm: {
        chat: vi.fn().mockResolvedValue({ content: "LLM response" }),
      },
      app: {
        log: vi.fn(),
      },
    };
  });

  // =============================================================================
  // Suspend Step Tests
  // =============================================================================
  describe("createSuspendStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists in data.steps", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Please approve",
        });

        const previousResult = {
          resumed: true,
          data: { approved: true },
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "approval-step": previousResult,
            },
          },
          suspend: vi.fn(),
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        // Should return the cached result without calling suspend
        expect(result).toEqual(previousResult);
      });

      it("should not skip when actively resuming this step (resumeData provided)", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Please approve",
        });

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              // Even if a previous result exists...
              "approval-step": { resumed: true, data: { old: "data" } },
            },
          },
          suspend: vi.fn(),
          // ...resumeData takes precedence because we're actively resuming
          resumeData: { approved: true, newData: "fresh" },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          resumed: true,
          data: { approved: true, newData: "fresh" },
        });
      });

      it("should suspend when no previous result exists", async () => {
        const suspendFn = vi.fn();
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Please approve deployment",
        });

        await step.execute({
          inputData: {
            inputs: {},
            steps: {}, // No previous results
          },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(suspendFn).toHaveBeenCalledWith({
          message: "Please approve deployment",
        });
      });

      it("should handle multiple suspend steps in sequence (hydration scenario)", async () => {
        // This tests the scenario where we have:
        // Step A -> Suspend B -> Step C -> Suspend D
        // And we're rehydrating at Suspend D

        const suspendB = createSuspendStep({
          id: "suspend-b",
          type: "suspend",
          message: "First approval",
        });

        const suspendD = createSuspendStep({
          id: "suspend-d",
          type: "suspend",
          message: "Second approval",
        });

        const suspendFn = vi.fn();
        const previousSteps = {
          "step-a": { stdout: "done", exitCode: 0 },
          "suspend-b": { resumed: true, data: { approved: true } },
          "step-c": { stdout: "processed", exitCode: 0 },
          // suspend-d is NOT in steps - it's where we're suspended
        };

        // Suspend B should be skipped (already completed)
        const resultB = await suspendB.execute({
          inputData: {
            inputs: {},
            steps: previousSteps,
          },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof suspendB.execute>[0]);

        expect(resultB).toEqual({ resumed: true, data: { approved: true } });
        expect(suspendFn).not.toHaveBeenCalled();

        // Suspend D should actually suspend (not in previous steps)
        suspendFn.mockClear();
        await suspendD.execute({
          inputData: {
            inputs: {},
            steps: previousSteps,
          },
          suspend: suspendFn,
          resumeData: undefined,
        } as unknown as Parameters<typeof suspendD.execute>[0]);

        expect(suspendFn).toHaveBeenCalledWith({
          message: "Second approval",
        });
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition evaluates to false", async () => {
        const step = createSuspendStep({
          id: "conditional-suspend",
          type: "suspend",
          message: "Approval needed",
          condition: "{{inputs.needsApproval}}",
        });

        const result = await step.execute({
          inputData: {
            inputs: { needsApproval: "false" },
            steps: {},
          },
          suspend: vi.fn(),
          resumeData: undefined,
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          resumed: false,
          data: undefined,
          skipped: true,
        });
      });
    });

    describe("resume data validation", () => {
      it("should validate resume data against schema", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: { type: "boolean" },
            reason: { type: "string" },
          },
        });

        // Missing required field should throw
        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
            suspend: vi.fn(),
            resumeData: { approved: true }, // missing 'reason'
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Missing required resume data: reason");
      });

      it("should reject non-object resume data when schema exists", async () => {
        const step = createSuspendStep({
          id: "approval-step",
          type: "suspend",
          message: "Approve?",
          resumeSchema: {
            approved: { type: "boolean" },
          },
        });

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
            suspend: vi.fn(),
            resumeData: "invalid",
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Resume data must be an object");
      });
    });
  });

  // =============================================================================
  // Shell Step Tests
  // =============================================================================
  describe("createShellStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createShellStep(
          {
            id: "build-step",
            type: "shell",
            command: "npm run build",
          },
          mockClient
        );

        const previousResult = {
          stdout: "Build complete",
          stderr: "",
          exitCode: 0,
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "build-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(mockExecAsync).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: build-step",
          "info"
        );
      });
    });

    describe("command execution", () => {
      it("should execute command and return stdout/stderr", async () => {
        mockExecSuccess("output text", "warning text");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "echo hello" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          stdout: "output text",
          stderr: "warning text",
          exitCode: 0,
        });
        expect(mockExecAsync).toHaveBeenCalled();
      });

      it("should interpolate variables in command", async () => {
        mockExecSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "deploy {{inputs.env}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { env: "production" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith(
          "deploy production",
          expect.any(Object)
        );
      });

      it("should use step results in interpolation", async () => {
        mockExecSuccess("deployed");
        const step = createShellStep(
          { id: "deploy", type: "shell", command: "deploy {{steps.build.artifact}}" },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {},
            steps: { build: { artifact: "app.zip", exitCode: 0 } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith(
          "deploy app.zip",
          expect.any(Object)
        );
      });

      it("should pass cwd option when specified", async () => {
        mockExecSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "ls", cwd: "/tmp" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith(
          "ls",
          expect.objectContaining({ cwd: "/tmp" })
        );
      });

      it("should pass interpolated cwd option", async () => {
        mockExecSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "ls", cwd: "{{inputs.dir}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { dir: "/home/user" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith(
          "ls",
          expect.objectContaining({ cwd: "/home/user" })
        );
      });

      it("should merge env variables", async () => {
        mockExecSuccess("done");
        const step = createShellStep(
          {
            id: "cmd",
            type: "shell",
            command: "echo $MY_VAR",
            env: { MY_VAR: "value", INTERP: "{{inputs.val}}" },
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { val: "interpolated" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith(
          "echo $MY_VAR",
          expect.objectContaining({
            env: expect.objectContaining({
              MY_VAR: "value",
              INTERP: "interpolated",
            }),
          })
        );
      });

      it("should pass timeout option when specified", async () => {
        mockExecSuccess("done");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "long-task", timeout: 5000 },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith(
          "long-task",
          expect.objectContaining({ timeout: 5000 })
        );
      });
    });

    describe("error handling", () => {
      it("should throw error when command fails with failOnError=true (default)", async () => {
        mockExecError(1, "command failed");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "fail" },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Command failed with exit code 1");
      });

      it("should return error output when failOnError=false", async () => {
        mockExecError(127, "not found", "partial output");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "missing-cmd", failOnError: false },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          stdout: "partial output",
          stderr: "not found",
          exitCode: 127,
        });
      });
    });

    describe("condition evaluation", () => {
      it("should skip execution when condition is false", async () => {
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "risky", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          stdout: "",
          stderr: "Skipped due to condition",
          exitCode: 0,
          skipped: true,
        });
        expect(mockExecAsync).not.toHaveBeenCalled();
      });

      it("should execute when condition is true", async () => {
        mockExecSuccess("executed");
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "safe", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "true" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.stdout).toBe("executed");
        expect(mockExecAsync).toHaveBeenCalled();
      });

      it("should skip when condition evaluates to empty string", async () => {
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "test", condition: "{{inputs.empty}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { empty: "" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.skipped).toBe(true);
      });

      it("should skip when condition evaluates to 0", async () => {
        const step = createShellStep(
          { id: "cmd", type: "shell", command: "test", condition: "{{inputs.zero}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { zero: "0" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.skipped).toBe(true);
      });
    });
  });

  // =============================================================================
  // Tool Step Tests
  // =============================================================================
  describe("createToolStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createToolStep(
          {
            id: "tool-step",
            type: "tool",
            tool: "testTool",
            args: { input: "test" },
          },
          mockClient
        );

        const previousResult = {
          result: { success: true, data: "cached" },
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "tool-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(mockClient.tools.testTool.execute).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: tool-step",
          "info"
        );
      });
    });

    describe("tool execution", () => {
      it("should execute tool and return result", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "testTool", args: { data: "test" } },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ result: { success: true } });
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({ data: "test" });
      });

      it("should interpolate args", async () => {
        const step = createToolStep(
          {
            id: "tool",
            type: "tool",
            tool: "testTool",
            args: { path: "{{inputs.filePath}}", count: "{{inputs.num}}" },
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { filePath: "/tmp/file.txt", num: 42 }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({
          path: "/tmp/file.txt",
          count: 42,
        });
      });

      it("should use step results in args", async () => {
        const step = createToolStep(
          {
            id: "tool",
            type: "tool",
            tool: "testTool",
            args: { content: "{{steps.read.content}}" },
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {},
            steps: { read: { content: "file contents" } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({
          content: "file contents",
        });
      });

      it("should throw error for missing tool", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "unknownTool", args: {} },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Tool 'unknownTool' not found");
      });

      it("should execute without args", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "testTool" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({});
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createToolStep(
          { id: "tool", type: "tool", tool: "testTool", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ result: null, skipped: true });
        expect(mockClient.tools.testTool.execute).not.toHaveBeenCalled();
      });
    });
  });

  // =============================================================================
  // Agent Step Tests
  // =============================================================================
  describe("createAgentStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createAgentStep(
          {
            id: "agent-step",
            type: "agent",
            prompt: "Analyze this",
          },
          mockClient
        );

        const previousResult = {
          response: "Previous LLM response",
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "agent-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: agent-step",
          "info"
        );
      });
    });

    describe("named agent execution", () => {
      it("should invoke named agent when agent property is specified", async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ content: "Agent response" });
        mockClient.agents = {
          "code-reviewer": { invoke: mockInvoke },
        };

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "code-reviewer", prompt: "Review this code" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ response: "Agent response" });
        expect(mockInvoke).toHaveBeenCalledWith("Review this code", { maxTokens: undefined });
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
      });

      it("should pass maxTokens to named agent", async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ content: "Response" });
        mockClient.agents = {
          summarizer: { invoke: mockInvoke },
        };

        const step = createAgentStep(
          { id: "summary", type: "agent", agent: "summarizer", prompt: "Summarize", maxTokens: 500 },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockInvoke).toHaveBeenCalledWith("Summarize", { maxTokens: 500 });
      });

      it("should interpolate prompt for named agent", async () => {
        const mockInvoke = vi.fn().mockResolvedValue({ content: "Response" });
        mockClient.agents = {
          reviewer: { invoke: mockInvoke },
        };

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "reviewer", prompt: "Review: {{inputs.code}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { code: "const x = 1" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockInvoke).toHaveBeenCalledWith("Review: const x = 1", { maxTokens: undefined });
      });

      it("should throw error when agent is not found", async () => {
        mockClient.agents = {
          "other-agent": { invoke: vi.fn() },
        };

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "unknown-agent", prompt: "Test" },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Agent 'unknown-agent' not found. Available agents: other-agent");
      });

      it("should throw error when no agents are available", async () => {
        // mockClient.agents is undefined by default

        const step = createAgentStep(
          { id: "review", type: "agent", agent: "any-agent", prompt: "Test" },
          mockClient
        );

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("No agents available on the opencode client");
      });
    });

    describe("inline LLM execution", () => {
      it("should call LLM with prompt and return response", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Summarize this" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ response: "LLM response" });
        expect(mockClient.llm.chat).toHaveBeenCalledWith({
          messages: [{ role: "user", content: "Summarize this" }],
          maxTokens: undefined,
        });
      });

      it("should interpolate prompt", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Review: {{inputs.code}}" },
          mockClient
        );

        await step.execute({
          inputData: { inputs: { code: "const x = 1" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: expect.arrayContaining([
              { role: "user", content: "Review: const x = 1" },
            ]),
          })
        );
      });

      it("should include system prompt when provided", async () => {
        const step = createAgentStep(
          {
            id: "agent",
            type: "agent",
            prompt: "What is 2+2?",
            system: "You are a math tutor.",
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [
              { role: "system", content: "You are a math tutor." },
              { role: "user", content: "What is 2+2?" },
            ],
          })
        );
      });

      it("should pass maxTokens config", async () => {
        const step = createAgentStep(
          {
            id: "agent",
            type: "agent",
            prompt: "Hello",
            maxTokens: 500,
          },
          mockClient
        );

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith({
          messages: [{ role: "user", content: "Hello" }],
          maxTokens: 500,
        });
      });

      it("should use step results in prompt", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Error: {{steps.build.stderr}}" },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {},
            steps: { build: { stdout: "", stderr: "Build failed", exitCode: 1 } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockClient.llm.chat).toHaveBeenCalledWith(
          expect.objectContaining({
            messages: [{ role: "user", content: "Error: Build failed" }],
          })
        );
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createAgentStep(
          { id: "agent", type: "agent", prompt: "Analyze", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ response: "", skipped: true });
        expect(mockClient.llm.chat).not.toHaveBeenCalled();
      });

      it("should skip named agent when condition is false", async () => {
        const mockInvoke = vi.fn();
        mockClient.agents = { reviewer: { invoke: mockInvoke } };

        const step = createAgentStep(
          { id: "agent", type: "agent", agent: "reviewer", prompt: "Review", condition: "{{inputs.run}}" },
          mockClient
        );

        const result = await step.execute({
          inputData: { inputs: { run: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ response: "", skipped: true });
        expect(mockInvoke).not.toHaveBeenCalled();
      });
    });
  });

  // =============================================================================
  // HTTP Step Tests
  // =============================================================================
  describe("createHttpStep", () => {
    beforeEach(() => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"data":"response"}'),
        headers: new Headers([["content-type", "application/json"]]),
      });
    });

    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createHttpStep({
          id: "http-step",
          type: "http",
          method: "POST",
          url: "https://api.example.com/webhook",
        });

        const previousResult = {
          status: 200,
          body: { success: true },
          text: '{"success":true}',
          headers: {},
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "http-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });

    describe("HTTP request execution", () => {
      it("should make HTTP request and return response", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/data",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.status).toBe(200);
        expect(result.body).toEqual({ data: "response" });
        expect(result.text).toBe('{"data":"response"}');
        expect(global.fetch).toHaveBeenCalledWith("https://api.example.com/data", {
          method: "GET",
          headers: {},
          body: undefined,
          signal: expect.any(AbortSignal),
        });
      });

      it("should interpolate URL", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/{{inputs.endpoint}}",
        });

        await step.execute({
          inputData: { inputs: { endpoint: "users/123" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/users/123",
          expect.any(Object)
        );
      });

      it("should send headers", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/data",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer {{inputs.token}}",
          },
        });

        await step.execute({
          inputData: { inputs: { token: "secret123" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/data",
          expect.objectContaining({
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer secret123",
            },
          })
        );
      });

      it("should send string body with interpolation", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/notify",
          body: "Message: {{inputs.message}}",
        });

        await step.execute({
          inputData: { inputs: { message: "Hello World" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/notify",
          expect.objectContaining({
            body: "Message: Hello World",
          })
        );
      });

      it("should serialize object body as JSON", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/data",
          body: { name: "test", count: 5 },
        });

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(global.fetch).toHaveBeenCalledWith(
          "https://api.example.com/data",
          expect.objectContaining({
            body: '{"name":"test","count":5}',
          })
        );
      });

      it("should handle non-JSON response", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: true,
          status: 200,
          text: () => Promise.resolve("plain text response"),
          headers: new Headers([["content-type", "text/plain"]]),
        } as Response);

        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/text",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.body).toBeNull();
        expect(result.text).toBe("plain text response");
      });
    });

    describe("error handling", () => {
      it("should throw error on non-OK response with failOnError=true (default)", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          status: 500,
          text: () => Promise.resolve("Internal Server Error"),
          headers: new Headers(),
        } as Response);

        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/error",
        });

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("HTTP 500: Internal Server Error");
      });

      it("should return error response when failOnError=false", async () => {
        vi.mocked(global.fetch).mockResolvedValue({
          ok: false,
          status: 404,
          text: () => Promise.resolve("Not Found"),
          headers: new Headers(),
        } as Response);

        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "GET",
          url: "https://api.example.com/missing",
          failOnError: false,
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.status).toBe(404);
        expect(result.text).toBe("Not Found");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createHttpStep({
          id: "http",
          type: "http",
          method: "POST",
          url: "https://api.example.com/notify",
          condition: "{{inputs.notify}}",
        });

        const result = await step.execute({
          inputData: { inputs: { notify: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          status: 0,
          body: null,
          text: "",
          headers: {},
          skipped: true,
        });
        expect(global.fetch).not.toHaveBeenCalled();
      });
    });
  });

  // =============================================================================
  // File Step Tests
  // =============================================================================
  describe("createFileStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createFileStep({
          id: "file-step",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "test content",
        });

        const previousResult = {
          success: true,
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "file-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(writeFile).not.toHaveBeenCalled();
      });
    });

    describe("read action", () => {
      it("should read file and return content", async () => {
        vi.mocked(readFile).mockResolvedValue("file contents here");

        const step = createFileStep({
          id: "read",
          type: "file",
          action: "read",
          path: "/tmp/input.txt",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ content: "file contents here" });
        expect(readFile).toHaveBeenCalledWith("/tmp/input.txt", "utf-8");
      });

      it("should interpolate path", async () => {
        vi.mocked(readFile).mockResolvedValue("data");

        const step = createFileStep({
          id: "read",
          type: "file",
          action: "read",
          path: "{{inputs.dir}}/{{inputs.file}}",
        });

        await step.execute({
          inputData: { inputs: { dir: "/home/user", file: "config.json" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(readFile).toHaveBeenCalledWith("/home/user/config.json", "utf-8");
      });
    });

    describe("write action", () => {
      it("should write string content to file", async () => {
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "hello world",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ success: true });
        expect(writeFile).toHaveBeenCalledWith("/tmp/output.txt", "hello world", "utf-8");
      });

      it("should interpolate content", async () => {
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "Result: {{steps.compute.output}}",
        });

        await step.execute({
          inputData: {
            inputs: {},
            steps: { compute: { output: "42" } },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(writeFile).toHaveBeenCalledWith("/tmp/output.txt", "Result: 42", "utf-8");
      });

      it("should auto-stringify object content", async () => {
        vi.mocked(writeFile).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/config.json",
          content: { name: "test", enabled: true },
        });

        await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(writeFile).toHaveBeenCalledWith(
          "/tmp/config.json",
          JSON.stringify({ name: "test", enabled: true }, null, 2),
          "utf-8"
        );
      });

      it("should throw error when content is missing", async () => {
        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
        } as Parameters<typeof createFileStep>[0]);

        await expect(
          step.execute({
            inputData: { inputs: {}, steps: {} },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Content is required for write action");
      });
    });

    describe("delete action", () => {
      it("should delete file", async () => {
        vi.mocked(unlink).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "delete",
          type: "file",
          action: "delete",
          path: "/tmp/temp.txt",
        });

        const result = await step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ success: true });
        expect(unlink).toHaveBeenCalledWith("/tmp/temp.txt");
      });

      it("should interpolate path for delete", async () => {
        vi.mocked(unlink).mockResolvedValue(undefined);

        const step = createFileStep({
          id: "delete",
          type: "file",
          action: "delete",
          path: "{{inputs.tempDir}}/{{inputs.file}}",
        });

        await step.execute({
          inputData: { inputs: { tempDir: "/tmp", file: "cache.dat" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(unlink).toHaveBeenCalledWith("/tmp/cache.dat");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createFileStep({
          id: "write",
          type: "file",
          action: "write",
          path: "/tmp/output.txt",
          content: "data",
          condition: "{{inputs.write}}",
        });

        const result = await step.execute({
          inputData: { inputs: { write: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({ skipped: true });
        expect(writeFile).not.toHaveBeenCalled();
      });
    });
  });

  // =============================================================================
  // Wait Step Tests
  // =============================================================================
  describe("createWaitStep", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createWaitStep({
          id: "wait-step",
          type: "wait",
          durationMs: 5000,
        });

        const previousResult = {
          completed: true,
          durationMs: 5000,
        };

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "wait-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
      });
    });

    describe("wait execution", () => {
      it("should wait for specified duration and return completed", async () => {
        const step = createWaitStep({
          id: "wait-5s",
          type: "wait",
          durationMs: 5000,
        });

        const executePromise = step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        // Fast-forward timer
        await vi.advanceTimersByTimeAsync(5000);

        const result = await executePromise;

        expect(result).toEqual({
          completed: true,
          durationMs: 5000,
        });
      });

      it("should handle short wait durations", async () => {
        const step = createWaitStep({
          id: "wait-100ms",
          type: "wait",
          durationMs: 100,
        });

        const executePromise = step.execute({
          inputData: { inputs: {}, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        await vi.advanceTimersByTimeAsync(100);

        const result = await executePromise;

        expect(result).toEqual({
          completed: true,
          durationMs: 100,
        });
      });

      it("should have correct description", () => {
        const step = createWaitStep({
          id: "wait-step",
          type: "wait",
          durationMs: 3000,
        });

        expect(step.description).toBe("Wait 3000ms");
      });

      it("should use custom description when provided", () => {
        const step = createWaitStep({
          id: "wait-step",
          type: "wait",
          durationMs: 3000,
          description: "Wait for deployment to complete",
        });

        expect(step.description).toBe("Wait for deployment to complete");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createWaitStep({
          id: "conditional-wait",
          type: "wait",
          durationMs: 5000,
          condition: "{{inputs.shouldWait}}",
        });

        const result = await step.execute({
          inputData: { inputs: { shouldWait: "false" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          completed: false,
          durationMs: 0,
          skipped: true,
        });
      });

      it("should execute when condition is true", async () => {
        const step = createWaitStep({
          id: "conditional-wait",
          type: "wait",
          durationMs: 1000,
          condition: "{{inputs.shouldWait}}",
        });

        const executePromise = step.execute({
          inputData: { inputs: { shouldWait: "true" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        await vi.advanceTimersByTimeAsync(1000);

        const result = await executePromise;

        expect(result).toEqual({
          completed: true,
          durationMs: 1000,
        });
      });

      it("should skip when condition evaluates to empty string", async () => {
        const step = createWaitStep({
          id: "wait",
          type: "wait",
          durationMs: 1000,
          condition: "{{inputs.empty}}",
        });

        const result = await step.execute({
          inputData: { inputs: { empty: "" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.skipped).toBe(true);
      });

      it("should skip when condition evaluates to 0", async () => {
        const step = createWaitStep({
          id: "wait",
          type: "wait",
          durationMs: 1000,
          condition: "{{inputs.zero}}",
        });

        const result = await step.execute({
          inputData: { inputs: { zero: "0" }, steps: {} },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.skipped).toBe(true);
      });
    });
  });

  // =============================================================================
  // Iterator Step Tests
  // =============================================================================
  describe("createIteratorStep", () => {
    describe("idempotency check", () => {
      it("should skip execution when step result already exists", async () => {
        const step = createIteratorStep(
          {
            id: "iterator-step",
            type: "iterator",
            items: "{{inputs.files}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
          },
          mockClient
        );

        const previousResult = {
          results: [{ stdout: "file1", stderr: "", exitCode: 0 }],
          count: 1,
        };

        const result = await step.execute({
          inputData: {
            inputs: { files: ["file1.txt"] },
            steps: {
              "iterator-step": previousResult,
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual(previousResult);
        expect(mockExecAsync).not.toHaveBeenCalled();
        expect(mockClient.app.log).toHaveBeenCalledWith(
          "Skipping already-completed step: iterator-step",
          "info"
        );
      });
    });

    describe("iteration execution", () => {
      it("should iterate over array and execute runStep for each item", async () => {
        mockExecAsync.mockResolvedValue({ stdout: "processed", stderr: "" });
        const step = createIteratorStep(
          {
            id: "lint-files",
            type: "iterator",
            items: "{{inputs.files}}",
            runStep: {
              type: "shell",
              command: "eslint {{inputs.item}}",
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.count).toBe(3);
        expect(result.results).toHaveLength(3);
        expect(mockExecAsync).toHaveBeenCalledTimes(3);
        expect(mockExecAsync).toHaveBeenCalledWith("eslint src/a.ts", expect.any(Object));
        expect(mockExecAsync).toHaveBeenCalledWith("eslint src/b.ts", expect.any(Object));
        expect(mockExecAsync).toHaveBeenCalledWith("eslint src/c.ts", expect.any(Object));
      });

      it("should provide index in iteration context", async () => {
        mockExecAsync.mockResolvedValue({ stdout: "done", stderr: "" });
        const step = createIteratorStep(
          {
            id: "numbered",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo Item {{inputs.index}}: {{inputs.item}}",
            },
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: { items: ["apple", "banana"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith("echo Item 0: apple", expect.any(Object));
        expect(mockExecAsync).toHaveBeenCalledWith("echo Item 1: banana", expect.any(Object));
      });

      it("should iterate over array from previous step result", async () => {
        mockExecAsync.mockResolvedValue({ stdout: "linted", stderr: "" });
        const step = createIteratorStep(
          {
            id: "lint-found-files",
            type: "iterator",
            items: "{{steps.find-files.result}}",
            runStep: {
              type: "shell",
              command: "lint {{inputs.item}}",
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: {},
            steps: {
              "find-files": { result: ["file1.ts", "file2.ts"] },
            },
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.count).toBe(2);
        expect(mockExecAsync).toHaveBeenCalledWith("lint file1.ts", expect.any(Object));
        expect(mockExecAsync).toHaveBeenCalledWith("lint file2.ts", expect.any(Object));
      });

      it("should handle objects in the array", async () => {
        mockExecAsync.mockResolvedValue({ stdout: "deployed", stderr: "" });
        const step = createIteratorStep(
          {
            id: "deploy-services",
            type: "iterator",
            items: "{{inputs.services}}",
            runStep: {
              type: "shell",
              command: "deploy {{inputs.item.name}} to {{inputs.item.region}}",
            },
          },
          mockClient
        );

        await step.execute({
          inputData: {
            inputs: {
              services: [
                { name: "api", region: "us-east" },
                { name: "web", region: "eu-west" },
              ],
            },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(mockExecAsync).toHaveBeenCalledWith("deploy api to us-east", expect.any(Object));
        expect(mockExecAsync).toHaveBeenCalledWith("deploy web to eu-west", expect.any(Object));
      });

      it("should handle empty array", async () => {
        const step = createIteratorStep(
          {
            id: "empty-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: [] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.count).toBe(0);
        expect(result.results).toHaveLength(0);
        expect(mockExecAsync).not.toHaveBeenCalled();
      });

      it("should execute tool runStep for each item", async () => {
        const step = createIteratorStep(
          {
            id: "process-files",
            type: "iterator",
            items: "{{inputs.files}}",
            runStep: {
              type: "tool",
              tool: "testTool",
              args: { path: "{{inputs.item}}" },
            },
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { files: ["/tmp/a.txt", "/tmp/b.txt"] },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.count).toBe(2);
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledTimes(2);
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({ path: "/tmp/a.txt" });
        expect(mockClient.tools.testTool.execute).toHaveBeenCalledWith({ path: "/tmp/b.txt" });
      });
    });

    describe("error handling", () => {
      it("should throw error when items does not resolve to array", async () => {
        const step = createIteratorStep(
          {
            id: "bad-items",
            type: "iterator",
            items: "{{inputs.notAnArray}}",
            runStep: {
              type: "shell",
              command: "echo test",
            },
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: {
              inputs: { notAnArray: "just a string" },
              steps: {},
            },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Iterator items must resolve to an array");
      });

      it("should propagate errors from runStep", async () => {
        mockExecAsync.mockRejectedValue(
          Object.assign(new Error("Command failed"), { code: 1, stderr: "error", stdout: "" })
        );
        const step = createIteratorStep(
          {
            id: "failing-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "fail-command",
            },
          },
          mockClient
        );

        await expect(
          step.execute({
            inputData: {
              inputs: { items: ["a"] },
              steps: {},
            },
          } as unknown as Parameters<typeof step.execute>[0])
        ).rejects.toThrow("Command failed");
      });
    });

    describe("condition evaluation", () => {
      it("should skip when condition is false", async () => {
        const step = createIteratorStep(
          {
            id: "conditional-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
            condition: "{{inputs.shouldRun}}",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: ["a", "b"], shouldRun: "false" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result).toEqual({
          results: [],
          count: 0,
          skipped: true,
        });
        expect(mockExecAsync).not.toHaveBeenCalled();
      });

      it("should execute when condition is true", async () => {
        mockExecAsync.mockResolvedValue({ stdout: "done", stderr: "" });
        const step = createIteratorStep(
          {
            id: "conditional-iter",
            type: "iterator",
            items: "{{inputs.items}}",
            runStep: {
              type: "shell",
              command: "echo {{inputs.item}}",
            },
            condition: "{{inputs.shouldRun}}",
          },
          mockClient
        );

        const result = await step.execute({
          inputData: {
            inputs: { items: ["a"], shouldRun: "true" },
            steps: {},
          },
        } as unknown as Parameters<typeof step.execute>[0]);

        expect(result.count).toBe(1);
        expect(mockExecAsync).toHaveBeenCalled();
      });
    });
  });
});
