import { z } from "zod";

// =============================================================================
// Error Classes
// =============================================================================

/**
 * Error thrown when required workflow inputs are missing.
 * The Agent can interpret this error to prompt the user for the missing inputs.
 */
export class MissingInputsError extends Error {
  /** The workflow ID that requires the inputs */
  readonly workflowId: string;
  /** Array of missing input names */
  readonly missingInputs: string[];
  /** The workflow's full input schema */
  readonly inputSchema: Record<string, "string" | "number" | "boolean">;

  constructor(
    workflowId: string,
    missingInputs: string[],
    inputSchema: Record<string, "string" | "number" | "boolean">
  ) {
    const inputList = missingInputs.map(name => `${name} (${inputSchema[name]})`).join(", ");
    super(`Missing required input(s) for workflow '${workflowId}': ${inputList}`);
    this.name = "MissingInputsError";
    this.workflowId = workflowId;
    this.missingInputs = missingInputs;
    this.inputSchema = inputSchema;
  }
}

// =============================================================================
// Primitive Types
// =============================================================================

/** JSON-serializable primitive value */
export type JsonPrimitive = string | number | boolean | null;

/** JSON-serializable value (recursive) */
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** JSON-serializable object */
export type JsonObject = { [key: string]: JsonValue };

/** Input parameter value types */
export type InputValue = string | number | boolean;

/** Input parameters record */
export type WorkflowInputs = Record<string, InputValue>;

// =============================================================================
// Plugin Configuration
// =============================================================================

export interface WorkflowPluginConfig {
  /** Directory paths to scan for workflow definitions */
  workflowDirs?: string[];
  /** Path to SQLite/LibSQL database for persistence */
  dbPath?: string;
  /** Global timeout for workflow execution (ms) */
  timeout?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

export const DEFAULT_CONFIG: Required<WorkflowPluginConfig> = {
  workflowDirs: [".opencode/workflows", "~/.opencode/workflows"],
  dbPath: ".opencode/data/workflows.db",
  timeout: 300000, // 5 minutes
  verbose: false,
};

// =============================================================================
// Workflow Definition Types (JSON Schema)
// =============================================================================

/** Step types supported by the workflow engine */
export type StepType = "shell" | "tool" | "agent" | "suspend" | "wait" | "http" | "file" | "iterator";

/** HTTP methods supported by the HTTP step */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

/** File actions supported by the file step */
export type FileAction = "read" | "write" | "delete";

/** Base step definition */
export interface BaseStepDefinition {
  id: string;
  type: StepType;
  description?: string;
  /** Step IDs that must complete before this step runs */
  after?: string[];
  /** Condition expression to determine if step should run */
  condition?: string;
  /** Step-specific timeout in ms */
  timeout?: number;
  /** Retry configuration */
  retry?: {
    attempts: number;
    delay?: number;
  };
}

/** Shell command step */
export interface ShellStepDefinition extends BaseStepDefinition {
  type: "shell";
  command: string;
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Whether to fail the workflow if command exits non-zero */
  failOnError?: boolean;
}

/** Opencode tool invocation step */
export interface ToolStepDefinition extends BaseStepDefinition {
  type: "tool";
  tool: string;
  args?: JsonObject;
}

/** LLM agent prompt step - supports both named agent references and inline LLM calls */
export interface AgentStepDefinition extends BaseStepDefinition {
  type: "agent";
  /** Prompt to send to the agent/LLM */
  prompt: string;
  /** Name of a pre-defined opencode agent to invoke (mutually exclusive with inline config) */
  agent?: string;
  /** System prompt for inline LLM calls (ignored if agent is specified) */
  system?: string;
  /** Max tokens for response (applies to both modes) */
  maxTokens?: number;
}

/** Suspend step for human-in-the-loop */
export interface SuspendStepDefinition extends BaseStepDefinition {
  type: "suspend";
  /** Message to display when suspending */
  message?: string;
  /** Schema for expected resume data (JSON Schema format) */
  resumeSchema?: JsonObject;
}

/** Wait/delay step for pausing workflow execution */
export interface WaitStepDefinition extends BaseStepDefinition {
  type: "wait";
  /** Duration to wait in milliseconds */
  durationMs: number;
}

/** HTTP request step for API calls */
export interface HttpStepDefinition extends BaseStepDefinition {
  type: "http";
  /** HTTP method */
  method: HttpMethod;
  /** URL to request (supports interpolation) */
  url: string;
  /** Request headers (supports interpolation) */
  headers?: Record<string, string>;
  /** Request body (for POST/PUT/PATCH) */
  body?: JsonValue;
  /** Whether to fail the workflow if response is not OK (default: true) */
  failOnError?: boolean;
}

/** File operations step for platform-independent file handling */
export interface FileStepDefinition extends BaseStepDefinition {
  type: "file";
  /** File operation action */
  action: FileAction;
  /** File path (supports interpolation) */
  path: string;
  /** Content to write (for write action, supports interpolation) */
  content?: string | JsonValue;
}

/** Inner step types - all step types except iterator (no nesting) */
export type InnerStepDefinition =
  | ShellStepDefinition
  | ToolStepDefinition
  | AgentStepDefinition
  | SuspendStepDefinition
  | WaitStepDefinition
  | HttpStepDefinition
  | FileStepDefinition;

/**
 * Iterator step for batch processing.
 * Loops over an array and executes a sub-step for each item.
 */
export interface IteratorStepDefinition extends BaseStepDefinition {
  type: "iterator";
  /** Interpolation string resolving to an array (e.g., "{{steps.find-files.result}}") */
  items: string;
  /** The step definition to run for each item. The current item is available as {{inputs.item}} and index as {{inputs.index}}. The id is optional and will be auto-generated if not provided. */
  runStep: InnerStepDefinition | (Omit<InnerStepDefinition, "id"> & { id?: string });
}

/** Union of all step definition types */
export type StepDefinition =
  | ShellStepDefinition
  | ToolStepDefinition
  | AgentStepDefinition
  | SuspendStepDefinition
  | WaitStepDefinition
  | HttpStepDefinition
  | FileStepDefinition
  | IteratorStepDefinition;

/** Trigger configuration for automatic workflow execution */
export interface WorkflowTrigger {
  /** Auto-run on specific events (e.g., "file.change") */
  event?: string;
  /** Cron schedule expression (e.g., "0 2 * * *" for 2am daily) */
  schedule?: string;
  /** Glob pattern for file change triggers (used when event is "file.change") */
  pattern?: string;
}

/** Complete workflow definition */
export interface WorkflowDefinition {
  $schema?: string;
  id: string;
  name?: string;
  description?: string;
  /** Version of the workflow definition */
  version?: string;
  /** Input parameters schema - maps param name to type name */
  inputs?: Record<string, "string" | "number" | "boolean">;
  /** 
   * List of input names that contain sensitive data (e.g., passwords, API keys).
   * These values will be masked in logs (shown as ***) and encrypted in storage.
   * Environment variables accessed via {{env.VAR_NAME}} are always treated as secrets.
   */
  secrets?: string[];
  /** Ordered list of steps */
  steps: StepDefinition[];
  /** Tags for categorization */
  tags?: string[];
  /** Trigger configuration for automatic workflow execution */
  trigger?: WorkflowTrigger;
}

// =============================================================================
// Runtime Types
// =============================================================================

/** Workflow execution status */
export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "suspended"
  | "completed"
  | "failed"
  | "cancelled";

/** Shell step output */
export interface ShellStepOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
  skipped?: boolean;
}

/** Tool step output */
export interface ToolStepOutput {
  result: JsonValue;
  skipped?: boolean;
}

/** Agent step output */
export interface AgentStepOutput {
  response: string;
  skipped?: boolean;
}

/** Suspend step output */
export interface SuspendStepOutput {
  resumed: boolean;
  data?: JsonValue;
  skipped?: boolean;
}

/** Wait step output */
export interface WaitStepOutput {
  /** Whether the wait completed successfully */
  completed: boolean;
  /** Duration waited in milliseconds */
  durationMs: number;
  skipped?: boolean;
}

/** HTTP step output */
export interface HttpStepOutput {
  status: number;
  /** Parsed JSON body, or null if response is not valid JSON */
  body: JsonValue;
  /** Raw response text (useful when JSON parsing fails or for non-JSON responses) */
  text: string;
  headers: Record<string, string>;
  skipped?: boolean;
}

/** File step output */
export interface FileStepOutput {
  /** Content read from file (for read action) */
  content?: string;
  /** Success indicator (for write/delete actions) */
  success?: boolean;
  skipped?: boolean;
}

/** Iterator step output */
export interface IteratorStepOutput {
  /** Array of results from each iteration */
  results: StepOutput[];
  /** Number of items processed */
  count: number;
  skipped?: boolean;
}

/** Union of all step output types */
export type StepOutput = 
  | ShellStepOutput 
  | ToolStepOutput 
  | AgentStepOutput 
  | SuspendStepOutput
  | WaitStepOutput
  | HttpStepOutput
  | FileStepOutput
  | IteratorStepOutput;

/** Step execution result */
export interface StepResult {
  stepId: string;
  status: "success" | "failed" | "skipped";
  output?: StepOutput;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
  duration?: number;
}

/** Workflow run record */
export interface WorkflowRun {
  runId: string;
  workflowId: string;
  status: WorkflowRunStatus;
  inputs: WorkflowInputs;
  stepResults: Record<string, StepResult>;
  currentStepId?: string;
  suspendedData?: JsonValue;
  startedAt: Date;
  completedAt?: Date;
  error?: string;
}

/** Context passed during step execution */
export interface StepExecutionContext {
  /** Workflow inputs */
  inputs: WorkflowInputs;
  /** Results from previous steps (stepId -> output) */
  steps: Record<string, StepOutput>;
  /** Opencode client reference */
  client: OpencodeClient;
  /** Shell executor */
  shell: ShellExecutor;
  /** Logging utilities */
  log: Logger;
  /** List of input names that are secrets (for masking in logs) */
  secretInputs?: string[];
}

// =============================================================================
// External Dependencies (from Opencode)
// =============================================================================

/** Opencode client interface (subset of actual client) */
export interface OpencodeClient {
  tools: Record<string, {
    execute: (args: JsonObject) => Promise<JsonValue>;
  }>;
  /** Named agents available in opencode */
  agents?: Record<string, {
    /** Invoke the agent with a prompt */
    invoke: (prompt: string, options?: { maxTokens?: number }) => Promise<{ content: string }>;
  }>;
  /** Direct LLM access for inline agent calls (uses configured default model) */
  llm: {
    chat: (options: {
      messages: Array<{ role: string; content: string }>;
      maxTokens?: number;
    }) => Promise<{ content: string }>;
  };
  app: {
    log: (message: string, level?: "info" | "warn" | "error") => void;
  };
}

/** Shell command executor */
export type ShellExecutor = (
  command: string,
  options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }
) => Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}>;

/** Logger interface */
export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
}

// =============================================================================
// Zod Schemas for Validation
// =============================================================================

/** Zod schema for JSON values (recursive) */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

export const BaseStepSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["shell", "tool", "agent", "suspend", "wait", "http", "file", "iterator"]),
  description: z.string().optional(),
  after: z.array(z.string()).optional(),
  condition: z.string().optional(),
  timeout: z.number().positive().optional(),
  retry: z.object({
    attempts: z.number().int().positive(),
    delay: z.number().positive().optional(),
  }).optional(),
});

export const ShellStepSchema = BaseStepSchema.extend({
  type: z.literal("shell"),
  command: z.string().min(1),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  failOnError: z.boolean().optional().default(true),
});

export const ToolStepSchema = BaseStepSchema.extend({
  type: z.literal("tool"),
  tool: z.string().min(1),
  args: z.record(JsonValueSchema).optional(),
});

export const AgentStepSchema = BaseStepSchema.extend({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  /** Name of a pre-defined opencode agent to invoke */
  agent: z.string().optional(),
  /** System prompt for inline LLM calls (ignored if agent is specified) */
  system: z.string().optional(),
  /** Max tokens for response */
  maxTokens: z.number().positive().optional(),
});

export const SuspendStepSchema = BaseStepSchema.extend({
  type: z.literal("suspend"),
  message: z.string().optional(),
  resumeSchema: z.record(JsonValueSchema).optional(),
});

export const WaitStepSchema = BaseStepSchema.extend({
  type: z.literal("wait"),
  durationMs: z.number().int().positive(),
});

export const HttpStepSchema = BaseStepSchema.extend({
  type: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: JsonValueSchema.optional(),
  failOnError: z.boolean().optional().default(true),
});

export const FileStepSchema = BaseStepSchema.extend({
  type: z.literal("file"),
  action: z.enum(["read", "write", "delete"]),
  path: z.string().min(1),
  content: z.union([z.string(), JsonValueSchema]).optional(),
});

/** Schema for inner step within iterator (id is optional, will be auto-generated) */
const InnerStepSchema = z.object({
  id: z.string().optional(),
  type: z.enum(["shell", "tool", "agent", "suspend", "wait", "http", "file"]),
  description: z.string().optional(),
  after: z.array(z.string()).optional(),
  condition: z.string().optional(),
  timeout: z.number().positive().optional(),
  retry: z.object({
    attempts: z.number().int().positive(),
    delay: z.number().positive().optional(),
  }).optional(),
}).passthrough(); // Allow additional properties based on step type

export const IteratorStepSchema = BaseStepSchema.extend({
  type: z.literal("iterator"),
  items: z.string().min(1),
  runStep: InnerStepSchema,
});

export const StepSchema = z.discriminatedUnion("type", [
  ShellStepSchema,
  ToolStepSchema,
  AgentStepSchema,
  SuspendStepSchema,
  WaitStepSchema,
  HttpStepSchema,
  FileStepSchema,
  IteratorStepSchema,
]);

export const WorkflowTriggerSchema = z.object({
  event: z.string().optional(),
  schedule: z.string().optional(),
  pattern: z.string().optional(),
});

export const WorkflowDefinitionSchema = z.object({
  $schema: z.string().optional(),
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  version: z.string().optional(),
  inputs: z.record(z.enum(["string", "number", "boolean"])).optional(),
  secrets: z.array(z.string()).optional(),
  steps: z.array(StepSchema).min(1),
  tags: z.array(z.string()).optional(),
  trigger: WorkflowTriggerSchema.optional(),
});

// =============================================================================
// Plugin Hook Types
// =============================================================================

export interface WorkflowEventPayload {
  workflowId: string;
  runId: string;
  status: WorkflowRunStatus;
  stepId?: string;
  error?: string;
}

export interface WorkflowRegistry {
  workflows: Map<string, WorkflowDefinition>;
  runs: Map<string, WorkflowRun>;
  
  getWorkflow(id: string): WorkflowDefinition | undefined;
  listWorkflows(): WorkflowDefinition[];
  getRun(runId: string): WorkflowRun | undefined;
  listRuns(workflowId?: string): WorkflowRun[];
}
