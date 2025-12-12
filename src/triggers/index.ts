/**
 * Trigger system for workflow automation
 *
 * Handles cron scheduling and file change event triggers
 *
 * @module opencode-workflows/triggers
 */

import cron, { type ScheduledTask } from "node-cron";
import { minimatch } from "minimatch";
import type { WorkflowDefinition, Logger, WorkflowInputs } from "../types.js";

/** Default debounce delay in milliseconds */
export const DEFAULT_DEBOUNCE_MS = 300;

/**
 * Trigger manager state
 */
export interface TriggerState {
  /** Active cron scheduled tasks */
  scheduledTasks: ScheduledTask[];
  /** Debounce timers for file change triggers (keyed by workflow ID) */
  debounceTimers: Map<string, NodeJS.Timeout>;
}

/**
 * Workflow runner interface for trigger execution
 */
export interface TriggerRunner {
  run(workflowId: string, inputs: WorkflowInputs): Promise<unknown>;
}

/**
 * Create initial trigger state
 */
export function createTriggerState(): TriggerState {
  return {
    scheduledTasks: [],
    debounceTimers: new Map(),
  };
}

/**
 * Validate a cron schedule expression
 */
export function isValidCronSchedule(schedule: string): boolean {
  return cron.validate(schedule);
}

/**
 * Check if a file path matches a glob pattern
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  return minimatch(filePath, pattern);
}

/**
 * Clear all scheduled tasks and debounce timers
 */
export function clearTriggers(state: TriggerState): void {
  // Stop all cron tasks
  for (const task of state.scheduledTasks) {
    task.stop();
  }
  state.scheduledTasks.length = 0;

  // Clear all debounce timers
  for (const timer of state.debounceTimers.values()) {
    clearTimeout(timer);
  }
  state.debounceTimers.clear();
}

/**
 * Setup result containing counts of configured triggers
 */
export interface SetupTriggersResult {
  cronCount: number;
  eventCount: number;
  errors: Array<{ workflowId: string; error: string }>;
}

/**
 * Setup cron schedules and prepare for file change triggers
 */
export function setupTriggers(
  state: TriggerState,
  definitions: Map<string, WorkflowDefinition>,
  runner: TriggerRunner,
  log: Logger
): SetupTriggersResult {
  // Clear existing triggers first
  clearTriggers(state);

  const result: SetupTriggersResult = {
    cronCount: 0,
    eventCount: 0,
    errors: [],
  };

  for (const [id, def] of definitions) {
    // Setup cron schedules
    if (def.trigger?.schedule) {
      if (!isValidCronSchedule(def.trigger.schedule)) {
        const error = `Invalid cron schedule: ${def.trigger.schedule}`;
        log.error(`Workflow '${id}': ${error}`);
        result.errors.push({ workflowId: id, error });
        continue;
      }

      try {
        const task = cron.schedule(def.trigger.schedule, async () => {
          log.info(`Triggering scheduled workflow: ${id}`);
          try {
            await runner.run(id, {});
          } catch (error) {
            log.error(`Scheduled workflow '${id}' failed: ${error}`);
          }
        });
        state.scheduledTasks.push(task);
        result.cronCount++;
        log.debug(`Scheduled workflow '${id}' with cron: ${def.trigger.schedule}`);
      } catch (error) {
        const errorMsg = `Failed to schedule: ${error}`;
        log.error(`Workflow '${id}': ${errorMsg}`);
        result.errors.push({ workflowId: id, error: errorMsg });
      }
    }

    // Count event-based triggers (actual handling happens in handleFileChange)
    if (def.trigger?.event === "file.change" && def.trigger.pattern) {
      result.eventCount++;
      log.debug(`Registered file change trigger for '${id}' with pattern: ${def.trigger.pattern}`);
    }
  }

  if (result.cronCount > 0 || result.eventCount > 0) {
    log.info(`Setup ${result.cronCount} cron schedule(s) and ${result.eventCount} file change trigger(s)`);
  }

  return result;
}

/**
 * Handle file change triggers with debouncing
 *
 * @param state - The trigger state
 * @param definitions - Map of workflow definitions
 * @param runner - The workflow runner
 * @param log - Logger
 * @param filePath - The file path that changed
 * @param debounceMs - Debounce delay in milliseconds
 */
export function handleFileChange(
  state: TriggerState,
  definitions: Map<string, WorkflowDefinition>,
  runner: TriggerRunner,
  log: Logger,
  filePath: string,
  debounceMs: number = DEFAULT_DEBOUNCE_MS
): string[] {
  const triggeredWorkflows: string[] = [];

  for (const [id, def] of definitions) {
    if (def.trigger?.event === "file.change" && def.trigger.pattern) {
      // Check if the path matches the pattern
      if (matchesPattern(filePath, def.trigger.pattern)) {
        // Clear any existing debounce timer for this workflow
        const existingTimer = state.debounceTimers.get(id);
        if (existingTimer) {
          clearTimeout(existingTimer);
        }

        // Set up a debounced trigger
        const timer = setTimeout(async () => {
          state.debounceTimers.delete(id);
          log.info(`File change triggered workflow: ${id} (file: ${filePath})`);
          try {
            await runner.run(id, { changedFile: filePath });
          } catch (error) {
            log.error(`File-triggered workflow '${id}' failed: ${error}`);
          }
        }, debounceMs);

        state.debounceTimers.set(id, timer);
        triggeredWorkflows.push(id);
      }
    }
  }

  return triggeredWorkflows;
}

/**
 * Get workflow IDs that have file change triggers matching a pattern
 */
export function getMatchingFileChangeTriggers(
  definitions: Map<string, WorkflowDefinition>,
  filePath: string
): string[] {
  const matches: string[] = [];

  for (const [id, def] of definitions) {
    if (def.trigger?.event === "file.change" && def.trigger.pattern) {
      if (matchesPattern(filePath, def.trigger.pattern)) {
        matches.push(id);
      }
    }
  }

  return matches;
}

/**
 * Get workflow IDs that have cron schedule triggers
 */
export function getScheduledWorkflows(
  definitions: Map<string, WorkflowDefinition>
): Array<{ id: string; schedule: string }> {
  const scheduled: Array<{ id: string; schedule: string }> = [];

  for (const [id, def] of definitions) {
    if (def.trigger?.schedule) {
      scheduled.push({ id, schedule: def.trigger.schedule });
    }
  }

  return scheduled;
}
