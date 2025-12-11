import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { topologicalSort, loadWorkflows, createLogger } from "./index.js";
import type { Logger, StepDefinition } from "../types.js";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

// Mock os - use arrow function to ensure proper hoisting
vi.mock("node:os", () => {
  return {
    homedir: () => "/home/testuser",
  };
});

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";

// Helper to create mock Dirent-like object
function mockDirent(name: string, isFile: boolean) {
  return {
    name,
    isFile: () => isFile,
    isDirectory: () => !isFile,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    path: "",
    parentPath: "",
  };
}

// Helper to create mock Stats-like object
function mockStats(isDir: boolean) {
  return {
    isDirectory: () => isDir,
    isFile: () => !isDir,
  };
}

describe("Loader Module", () => {
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  // =============================================================================
  // topologicalSort Tests
  // =============================================================================
  describe("topologicalSort", () => {
    it("should return steps in correct order for linear dependencies", () => {
      const steps: StepDefinition[] = [
        { id: "c", type: "shell", command: "echo c", after: ["b"] },
        { id: "a", type: "shell", command: "echo a" },
        { id: "b", type: "shell", command: "echo b", after: ["a"] },
      ];

      const sorted = topologicalSort(steps);
      const ids = sorted.map((s) => s.id);

      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
    });

    it("should handle steps with no dependencies", () => {
      const steps: StepDefinition[] = [
        { id: "a", type: "shell", command: "echo a" },
        { id: "b", type: "shell", command: "echo b" },
        { id: "c", type: "shell", command: "echo c" },
      ];

      const sorted = topologicalSort(steps);

      expect(sorted.length).toBe(3);
      expect(sorted.map((s) => s.id)).toContain("a");
      expect(sorted.map((s) => s.id)).toContain("b");
      expect(sorted.map((s) => s.id)).toContain("c");
    });

    it("should handle diamond dependencies", () => {
      // a -> b, a -> c, b -> d, c -> d
      const steps: StepDefinition[] = [
        { id: "d", type: "shell", command: "echo d", after: ["b", "c"] },
        { id: "b", type: "shell", command: "echo b", after: ["a"] },
        { id: "c", type: "shell", command: "echo c", after: ["a"] },
        { id: "a", type: "shell", command: "echo a" },
      ];

      const sorted = topologicalSort(steps);
      const ids = sorted.map((s) => s.id);

      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
      expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("d"));
    });

    it("should handle complex DAG with multiple roots", () => {
      const steps: StepDefinition[] = [
        { id: "a", type: "shell", command: "echo a" },
        { id: "b", type: "shell", command: "echo b" },
        { id: "c", type: "shell", command: "echo c", after: ["a"] },
        { id: "d", type: "shell", command: "echo d", after: ["b"] },
        { id: "e", type: "shell", command: "echo e", after: ["c", "d"] },
      ];

      const sorted = topologicalSort(steps);
      const ids = sorted.map((s) => s.id);

      // a and b should come before their dependents
      expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
      expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
      expect(ids.indexOf("c")).toBeLessThan(ids.indexOf("e"));
      expect(ids.indexOf("d")).toBeLessThan(ids.indexOf("e"));
    });

    it("should handle single step", () => {
      const steps: StepDefinition[] = [
        { id: "only", type: "shell", command: "echo only" },
      ];

      const sorted = topologicalSort(steps);

      expect(sorted.length).toBe(1);
      expect(sorted[0].id).toBe("only");
    });

    it("should handle empty steps array", () => {
      const sorted = topologicalSort([]);
      expect(sorted).toEqual([]);
    });

    it("should preserve step properties during sort", () => {
      const steps: StepDefinition[] = [
        {
          id: "build",
          type: "shell",
          command: "npm run build",
          description: "Build the project",
          timeout: 60000,
          env: { NODE_ENV: "production" },
        },
        {
          id: "test",
          type: "shell",
          command: "npm test",
          after: ["build"],
          failOnError: false,
        },
      ];

      const sorted = topologicalSort(steps);
      const buildStep = sorted.find((s) => s.id === "build") as StepDefinition & { type: "shell" };
      const testStep = sorted.find((s) => s.id === "test") as StepDefinition & { type: "shell" };

      expect(buildStep.command).toBe("npm run build");
      expect(buildStep.description).toBe("Build the project");
      expect(buildStep.timeout).toBe(60000);
      expect(testStep.failOnError).toBe(false);
    });
  });

  // =============================================================================
  // loadWorkflows Tests
  // =============================================================================
  describe("loadWorkflows", () => {
    it("should load valid JSON workflow from directory", async () => {
      const validWorkflow = {
        id: "test-workflow",
        description: "A test workflow",
        steps: [{ id: "step1", type: "shell", command: "echo hello" }],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("test.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".opencode/workflows"]);

      expect(result.workflows.size).toBe(1);
      expect(result.workflows.get("test-workflow")).toBeDefined();
      expect(result.workflows.get("test-workflow")?.description).toBe("A test workflow");
      expect(result.errors).toHaveLength(0);
    });

    it("should load JSONC files with comments", async () => {
      const jsonc = `{
        // This is a comment
        "id": "jsonc-workflow",
        "steps": [
          { "id": "s1", "type": "shell", "command": "echo test" }
        ]
      }`;

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("workflow.jsonc", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(jsonc);

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(1);
      expect(result.workflows.get("jsonc-workflow")).toBeDefined();
    });

    it("should handle non-existent directory gracefully", async () => {
      vi.mocked(stat).mockRejectedValue(new Error("ENOENT"));

      const result = await loadWorkflows("/project", mockLogger, ["nonexistent"]);

      expect(result.workflows.size).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("not found")
      );
    });

    it("should skip non-JSON files", async () => {
      const validWorkflow = {
        id: "valid",
        steps: [{ id: "s1", type: "shell", command: "echo" }],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("valid.json", true),
        mockDirent("readme.md", true),
        mockDirent("script.sh", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(validWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(1);
      expect(readFile).toHaveBeenCalledTimes(1);
    });

    it("should warn about TypeScript workflow files", async () => {
      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("workflow.ts", true),
      ] as never);

      await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("TypeScript/JS workflow files not yet supported")
      );
    });

    it("should skip directories in workflow folder", async () => {
      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("subdir", false),
      ] as never);

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(readFile).not.toHaveBeenCalled();
    });

    it("should handle invalid JSON gracefully", async () => {
      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("invalid.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue("{ invalid json }");

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid JSON")
      );
    });

    it("should reject workflow with invalid schema", async () => {
      const invalidWorkflow = {
        id: "invalid",
        // Missing required 'steps' field
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("invalid.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid workflow schema")
      );
    });

    it("should reject workflow with unknown step dependency", async () => {
      const workflowWithBadDep = {
        id: "bad-deps",
        steps: [
          { id: "step1", type: "shell", command: "echo", after: ["nonexistent"] },
        ],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("bad.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(workflowWithBadDep));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('depends on unknown step "nonexistent"')
      );
    });

    it("should reject workflow with circular dependencies", async () => {
      const circularWorkflow = {
        id: "circular",
        steps: [
          { id: "a", type: "shell", command: "echo a", after: ["b"] },
          { id: "b", type: "shell", command: "echo b", after: ["a"] },
        ],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("circular.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(circularWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Circular dependencies detected")
      );
    });

    it("should detect complex circular dependencies", async () => {
      const circularWorkflow = {
        id: "complex-circular",
        steps: [
          { id: "a", type: "shell", command: "echo a", after: ["c"] },
          { id: "b", type: "shell", command: "echo b", after: ["a"] },
          { id: "c", type: "shell", command: "echo c", after: ["b"] },
        ],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("circular.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(circularWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Circular dependencies detected")
      );
    });

    it("should warn about duplicate workflow IDs", async () => {
      const workflow1 = {
        id: "duplicate",
        steps: [{ id: "s1", type: "shell", command: "echo 1" }],
      };
      const workflow2 = {
        id: "duplicate",
        steps: [{ id: "s1", type: "shell", command: "echo 2" }],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir)
        .mockResolvedValueOnce([mockDirent("w1.json", true)] as never)
        .mockResolvedValueOnce([mockDirent("w2.json", true)] as never);
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(workflow1))
        .mockResolvedValueOnce(JSON.stringify(workflow2));

      const result = await loadWorkflows("/project", mockLogger, ["dir1", "dir2"]);

      expect(result.workflows.size).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Workflow "duplicate" already loaded')
      );
    });

    it("should expand home directory paths", async () => {
      // Verify the homedir mock is working
      expect(homedir()).toBe("/home/testuser");

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([] as never);

      await loadWorkflows("/project", mockLogger, ["~/.opencode/workflows"]);

      // The path should be expanded from ~ to the mocked homedir
      expect(stat).toHaveBeenCalledWith(
        expect.stringContaining(".opencode/workflows")
      );
      // Verify the path contains the expanded home directory
      const statCalls = vi.mocked(stat).mock.calls;
      expect(statCalls.length).toBeGreaterThan(0);
      const calledPath = statCalls[0][0] as string;
      expect(calledPath).not.toContain("~");
    });

    it("should load workflows from multiple directories", async () => {
      const workflow1 = {
        id: "workflow-1",
        steps: [{ id: "s1", type: "shell", command: "echo 1" }],
      };
      const workflow2 = {
        id: "workflow-2",
        steps: [{ id: "s1", type: "shell", command: "echo 2" }],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir)
        .mockResolvedValueOnce([mockDirent("w1.json", true)] as never)
        .mockResolvedValueOnce([mockDirent("w2.json", true)] as never);
      vi.mocked(readFile)
        .mockResolvedValueOnce(JSON.stringify(workflow1))
        .mockResolvedValueOnce(JSON.stringify(workflow2));

      const result = await loadWorkflows("/project", mockLogger, ["dir1", "dir2"]);

      expect(result.workflows.size).toBe(2);
      expect(result.workflows.has("workflow-1")).toBe(true);
      expect(result.workflows.has("workflow-2")).toBe(true);
    });

    it("should validate all step types", async () => {
      const multiTypeWorkflow = {
        id: "multi-type",
        steps: [
          { id: "shell-step", type: "shell", command: "echo test" },
          { id: "tool-step", type: "tool", tool: "read", args: { path: "/tmp" } },
          { id: "agent-step", type: "agent", prompt: "Hello" },
          { id: "suspend-step", type: "suspend", message: "Wait" },
          { id: "http-step", type: "http", method: "GET", url: "https://example.com" },
          { id: "file-step", type: "file", action: "read", path: "/tmp/file.txt" },
        ],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("multi.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(multiTypeWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(1);
      expect(result.workflows.get("multi-type")?.steps.length).toBe(6);
    });

    it("should reject invalid step type", async () => {
      const invalidTypeWorkflow = {
        id: "invalid-type",
        steps: [{ id: "s1", type: "unknown", command: "echo" }],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("invalid.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidTypeWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid workflow schema")
      );
    });

    it("should handle file read errors gracefully", async () => {
      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("unreadable.json", true),
      ] as never);
      vi.mocked(readFile).mockRejectedValue(new Error("EACCES: permission denied"));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(0);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load workflow")
      );
    });

    it("should load workflow with all optional fields", async () => {
      const fullWorkflow = {
        id: "full-workflow",
        name: "Full Workflow",
        description: "A complete workflow with all fields",
        version: "1.0.0",
        tags: ["test", "example"],
        inputs: {
          name: "string",
          count: "number",
          enabled: "boolean",
        },
        steps: [
          {
            id: "step1",
            type: "shell",
            command: "echo {{inputs.name}}",
            description: "First step",
            cwd: "/tmp",
            env: { FOO: "bar" },
            timeout: 30000,
            retry: { attempts: 3, delay: 1000 },
          },
        ],
      };

      vi.mocked(stat).mockResolvedValue(mockStats(true) as never);
      vi.mocked(readdir).mockResolvedValue([
        mockDirent("full.json", true),
      ] as never);
      vi.mocked(readFile).mockResolvedValue(JSON.stringify(fullWorkflow));

      const result = await loadWorkflows("/project", mockLogger, [".workflows"]);

      expect(result.workflows.size).toBe(1);
      const wf = result.workflows.get("full-workflow");
      expect(wf?.name).toBe("Full Workflow");
      expect(wf?.version).toBe("1.0.0");
      expect(wf?.tags).toEqual(["test", "example"]);
      expect(wf?.inputs).toEqual({
        name: "string",
        count: "number",
        enabled: "boolean",
      });
    });
  });

  // =============================================================================
  // createLogger Tests
  // =============================================================================
  describe("createLogger", () => {
    it("should create a logger with all methods", () => {
      const logger = createLogger();

      expect(typeof logger.info).toBe("function");
      expect(typeof logger.warn).toBe("function");
      expect(typeof logger.error).toBe("function");
      expect(typeof logger.debug).toBe("function");
    });

    it("should log info messages", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger();

      logger.info("test message");

      expect(consoleSpy).toHaveBeenCalledWith("[workflow] test message");
      consoleSpy.mockRestore();
    });

    it("should log warn messages", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const logger = createLogger();

      logger.warn("warning message");

      expect(consoleSpy).toHaveBeenCalledWith("[workflow] warning message");
      consoleSpy.mockRestore();
    });

    it("should log error messages", () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logger = createLogger();

      logger.error("error message");

      expect(consoleSpy).toHaveBeenCalledWith("[workflow] error message");
      consoleSpy.mockRestore();
    });

    it("should not log debug messages when verbose is false", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger(false);

      logger.debug("debug message");

      expect(consoleSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("should log debug messages when verbose is true", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const logger = createLogger(true);

      logger.debug("debug message");

      expect(consoleSpy).toHaveBeenCalledWith("[workflow:debug] debug message");
      consoleSpy.mockRestore();
    });
  });
});
