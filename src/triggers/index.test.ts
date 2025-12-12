import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createTriggerState,
  isValidCronSchedule,
  matchesPattern,
  clearTriggers,
  setupTriggers,
  handleFileChange,
  getMatchingFileChangeTriggers,
  getScheduledWorkflows,
  DEFAULT_DEBOUNCE_MS,
  type TriggerState,
  type TriggerRunner,
} from "./index.js";
import type { WorkflowDefinition, Logger } from "../types.js";

describe("Triggers Module", () => {
  let mockLogger: Logger;
  let mockRunner: TriggerRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    mockRunner = {
      run: vi.fn().mockResolvedValue({ success: true }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  // =============================================================================
  // createTriggerState Tests
  // =============================================================================
  describe("createTriggerState", () => {
    it("should create empty trigger state", () => {
      const state = createTriggerState();

      expect(state.scheduledTasks).toEqual([]);
      expect(state.debounceTimers).toBeInstanceOf(Map);
      expect(state.debounceTimers.size).toBe(0);
    });
  });

  // =============================================================================
  // isValidCronSchedule Tests
  // =============================================================================
  describe("isValidCronSchedule", () => {
    it("should validate correct cron expressions", () => {
      expect(isValidCronSchedule("* * * * *")).toBe(true); // Every minute
      expect(isValidCronSchedule("0 * * * *")).toBe(true); // Every hour
      expect(isValidCronSchedule("0 0 * * *")).toBe(true); // Every day at midnight
      expect(isValidCronSchedule("0 2 * * *")).toBe(true); // Every day at 2am
      expect(isValidCronSchedule("0 0 * * 0")).toBe(true); // Every Sunday at midnight
      expect(isValidCronSchedule("*/5 * * * *")).toBe(true); // Every 5 minutes
      expect(isValidCronSchedule("0 9-17 * * 1-5")).toBe(true); // Every hour 9-5 Mon-Fri
    });

    it("should reject invalid cron expressions", () => {
      expect(isValidCronSchedule("invalid")).toBe(false);
      expect(isValidCronSchedule("")).toBe(false);
      expect(isValidCronSchedule("* * *")).toBe(false); // Too few fields
      expect(isValidCronSchedule("60 * * * *")).toBe(false); // Invalid minute
      expect(isValidCronSchedule("* 25 * * *")).toBe(false); // Invalid hour
    });
  });

  // =============================================================================
  // matchesPattern Tests
  // =============================================================================
  describe("matchesPattern", () => {
    it("should match simple glob patterns", () => {
      expect(matchesPattern("src/file.ts", "**/*.ts")).toBe(true);
      expect(matchesPattern("src/file.js", "**/*.ts")).toBe(false);
      expect(matchesPattern("src/file.ts", "src/*.ts")).toBe(true);
      expect(matchesPattern("src/nested/file.ts", "src/*.ts")).toBe(false);
    });

    it("should match double star patterns", () => {
      expect(matchesPattern("src/nested/deep/file.ts", "**/*.ts")).toBe(true);
      expect(matchesPattern("file.ts", "**/*.ts")).toBe(true);
    });

    it("should match specific directories", () => {
      expect(matchesPattern("src/components/Button.tsx", "src/components/**/*.tsx")).toBe(true);
      expect(matchesPattern("src/utils/helper.tsx", "src/components/**/*.tsx")).toBe(false);
    });

    it("should match brace expansion", () => {
      expect(matchesPattern("file.ts", "**/*.{ts,tsx}")).toBe(true);
      expect(matchesPattern("file.tsx", "**/*.{ts,tsx}")).toBe(true);
      expect(matchesPattern("file.js", "**/*.{ts,tsx}")).toBe(false);
    });

    it("should match exact paths", () => {
      expect(matchesPattern("package.json", "package.json")).toBe(true);
      expect(matchesPattern("other.json", "package.json")).toBe(false);
    });
  });

  // =============================================================================
  // clearTriggers Tests
  // =============================================================================
  describe("clearTriggers", () => {
    it("should clear all scheduled tasks", () => {
      const mockTask = { stop: vi.fn() };
      const state: TriggerState = {
        scheduledTasks: [mockTask as unknown as TriggerState["scheduledTasks"][0], mockTask as unknown as TriggerState["scheduledTasks"][0]],
        debounceTimers: new Map(),
      };

      clearTriggers(state);

      expect(mockTask.stop).toHaveBeenCalledTimes(2);
      expect(state.scheduledTasks.length).toBe(0);
    });

    it("should clear all debounce timers", () => {
      const state: TriggerState = {
        scheduledTasks: [],
        debounceTimers: new Map([
          ["workflow-1", setTimeout(() => {}, 1000)],
          ["workflow-2", setTimeout(() => {}, 1000)],
        ]),
      };

      clearTriggers(state);

      expect(state.debounceTimers.size).toBe(0);
    });
  });

  // =============================================================================
  // setupTriggers Tests
  // =============================================================================
  describe("setupTriggers", () => {
    it("should setup cron schedules for workflows with schedule trigger", () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "nightly-backup",
          {
            id: "nightly-backup",
            steps: [{ id: "s1", type: "shell", command: "backup.sh" }],
            trigger: { schedule: "0 2 * * *" },
          },
        ],
      ]);

      const result = setupTriggers(state, definitions, mockRunner, mockLogger);

      expect(result.cronCount).toBe(1);
      expect(result.eventCount).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(state.scheduledTasks.length).toBe(1);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Scheduled workflow 'nightly-backup'")
      );
    });

    it("should count file change triggers", () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "test-on-save",
          {
            id: "test-on-save",
            steps: [{ id: "s1", type: "shell", command: "npm test" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const result = setupTriggers(state, definitions, mockRunner, mockLogger);

      expect(result.cronCount).toBe(0);
      expect(result.eventCount).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Registered file change trigger")
      );
    });

    it("should handle invalid cron schedules", () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "bad-schedule",
          {
            id: "bad-schedule",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { schedule: "invalid cron" },
          },
        ],
      ]);

      const result = setupTriggers(state, definitions, mockRunner, mockLogger);

      expect(result.cronCount).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].workflowId).toBe("bad-schedule");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Invalid cron schedule")
      );
    });

    it("should clear existing triggers before setup", () => {
      const mockTask = { stop: vi.fn() };
      const state: TriggerState = {
        scheduledTasks: [mockTask as unknown as TriggerState["scheduledTasks"][0]],
        debounceTimers: new Map([["old", setTimeout(() => {}, 1000)]]),
      };
      const definitions = new Map<string, WorkflowDefinition>();

      setupTriggers(state, definitions, mockRunner, mockLogger);

      expect(mockTask.stop).toHaveBeenCalled();
      expect(state.debounceTimers.size).toBe(0);
    });

    it("should handle workflows without triggers", () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "no-trigger",
          {
            id: "no-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
          },
        ],
      ]);

      const result = setupTriggers(state, definitions, mockRunner, mockLogger);

      expect(result.cronCount).toBe(0);
      expect(result.eventCount).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should setup multiple triggers", () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "cron-1",
          {
            id: "cron-1",
            steps: [{ id: "s1", type: "shell", command: "echo 1" }],
            trigger: { schedule: "0 * * * *" },
          },
        ],
        [
          "cron-2",
          {
            id: "cron-2",
            steps: [{ id: "s1", type: "shell", command: "echo 2" }],
            trigger: { schedule: "0 0 * * *" },
          },
        ],
        [
          "file-trigger",
          {
            id: "file-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo 3" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const result = setupTriggers(state, definitions, mockRunner, mockLogger);

      expect(result.cronCount).toBe(2);
      expect(result.eventCount).toBe(1);
      expect(state.scheduledTasks.length).toBe(2);
    });
  });

  // =============================================================================
  // handleFileChange Tests
  // =============================================================================
  describe("handleFileChange", () => {
    it("should trigger workflow when file matches pattern", async () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "test-runner",
          {
            id: "test-runner",
            steps: [{ id: "s1", type: "shell", command: "npm test" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const triggered = handleFileChange(
        state,
        definitions,
        mockRunner,
        mockLogger,
        "src/index.ts"
      );

      expect(triggered).toContain("test-runner");
      expect(state.debounceTimers.has("test-runner")).toBe(true);

      // Fast forward past debounce
      await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS + 10);

      expect(mockRunner.run).toHaveBeenCalledWith("test-runner", { changedFile: "src/index.ts" });
    });

    it("should not trigger workflow when file does not match pattern", () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "ts-only",
          {
            id: "ts-only",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const triggered = handleFileChange(
        state,
        definitions,
        mockRunner,
        mockLogger,
        "src/styles.css"
      );

      expect(triggered).toHaveLength(0);
      expect(state.debounceTimers.size).toBe(0);
    });

    it("should debounce rapid file changes", async () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "debounced",
          {
            id: "debounced",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      // Trigger multiple times rapidly
      handleFileChange(state, definitions, mockRunner, mockLogger, "src/a.ts");
      await vi.advanceTimersByTimeAsync(100);
      handleFileChange(state, definitions, mockRunner, mockLogger, "src/b.ts");
      await vi.advanceTimersByTimeAsync(100);
      handleFileChange(state, definitions, mockRunner, mockLogger, "src/c.ts");

      // Should only have one timer
      expect(state.debounceTimers.size).toBe(1);

      // Wait for debounce to complete
      await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS + 10);

      // Should only run once (with the last file)
      expect(mockRunner.run).toHaveBeenCalledTimes(1);
      expect(mockRunner.run).toHaveBeenCalledWith("debounced", { changedFile: "src/c.ts" });
    });

    it("should support custom debounce delay", async () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "custom-debounce",
          {
            id: "custom-debounce",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const customDebounce = 500;
      handleFileChange(state, definitions, mockRunner, mockLogger, "src/a.ts", customDebounce);

      // Should not have run yet
      await vi.advanceTimersByTimeAsync(400);
      expect(mockRunner.run).not.toHaveBeenCalled();

      // Now it should run
      await vi.advanceTimersByTimeAsync(200);
      expect(mockRunner.run).toHaveBeenCalled();
    });

    it("should trigger multiple workflows for same file", async () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "lint",
          {
            id: "lint",
            steps: [{ id: "s1", type: "shell", command: "npm run lint" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
        [
          "test",
          {
            id: "test",
            steps: [{ id: "s1", type: "shell", command: "npm test" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const triggered = handleFileChange(
        state,
        definitions,
        mockRunner,
        mockLogger,
        "src/index.ts"
      );

      expect(triggered).toContain("lint");
      expect(triggered).toContain("test");
      expect(state.debounceTimers.size).toBe(2);

      await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS + 10);

      expect(mockRunner.run).toHaveBeenCalledTimes(2);
    });

    it("should handle runner errors gracefully", async () => {
      const state = createTriggerState();
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "failing",
          {
            id: "failing",
            steps: [{ id: "s1", type: "shell", command: "exit 1" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      mockRunner.run = vi.fn().mockRejectedValue(new Error("Workflow failed"));

      handleFileChange(state, definitions, mockRunner, mockLogger, "src/index.ts");
      await vi.advanceTimersByTimeAsync(DEFAULT_DEBOUNCE_MS + 10);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("File-triggered workflow 'failing' failed")
      );
    });
  });

  // =============================================================================
  // getMatchingFileChangeTriggers Tests
  // =============================================================================
  describe("getMatchingFileChangeTriggers", () => {
    it("should return matching workflow IDs", () => {
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "ts-trigger",
          {
            id: "ts-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
        [
          "css-trigger",
          {
            id: "css-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.css" },
          },
        ],
      ]);

      const matches = getMatchingFileChangeTriggers(definitions, "src/app.ts");

      expect(matches).toEqual(["ts-trigger"]);
    });

    it("should return empty array for no matches", () => {
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "ts-trigger",
          {
            id: "ts-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const matches = getMatchingFileChangeTriggers(definitions, "styles.css");

      expect(matches).toEqual([]);
    });

    it("should ignore workflows without file.change event", () => {
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "cron-workflow",
          {
            id: "cron-workflow",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { schedule: "0 * * * *" },
          },
        ],
      ]);

      const matches = getMatchingFileChangeTriggers(definitions, "src/app.ts");

      expect(matches).toEqual([]);
    });
  });

  // =============================================================================
  // getScheduledWorkflows Tests
  // =============================================================================
  describe("getScheduledWorkflows", () => {
    it("should return scheduled workflows", () => {
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "hourly",
          {
            id: "hourly",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { schedule: "0 * * * *" },
          },
        ],
        [
          "daily",
          {
            id: "daily",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { schedule: "0 0 * * *" },
          },
        ],
      ]);

      const scheduled = getScheduledWorkflows(definitions);

      expect(scheduled).toHaveLength(2);
      expect(scheduled).toContainEqual({ id: "hourly", schedule: "0 * * * *" });
      expect(scheduled).toContainEqual({ id: "daily", schedule: "0 0 * * *" });
    });

    it("should return empty array for no scheduled workflows", () => {
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "file-trigger",
          {
            id: "file-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
            trigger: { event: "file.change", pattern: "**/*.ts" },
          },
        ],
      ]);

      const scheduled = getScheduledWorkflows(definitions);

      expect(scheduled).toEqual([]);
    });

    it("should ignore workflows without triggers", () => {
      const definitions = new Map<string, WorkflowDefinition>([
        [
          "no-trigger",
          {
            id: "no-trigger",
            steps: [{ id: "s1", type: "shell", command: "echo" }],
          },
        ],
      ]);

      const scheduled = getScheduledWorkflows(definitions);

      expect(scheduled).toEqual([]);
    });
  });
});
