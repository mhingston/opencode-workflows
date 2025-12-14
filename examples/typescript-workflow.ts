/**
 * Example TypeScript workflow definition.
 * 
 * TypeScript workflows provide type safety, IDE autocomplete, and the ability
 * to dynamically generate workflow definitions using code.
 * 
 * This file demonstrates:
 * 1. Type-safe workflow definition with full IDE support
 * 2. Using TypeScript features like const assertions and type imports
 * 3. Organizing steps with comments and proper typing
 * 
 * NOTE: In a real project, you would import types from "opencode-workflows":
 *   import type { WorkflowDefinition } from "opencode-workflows";
 * 
 * For this example, we define the types inline for portability.
 */

// Type definitions (in a real project, import from "opencode-workflows")
interface WorkflowDefinition {
  id: string;
  name?: string;
  description?: string;
  inputs?: Record<string, "string" | "number" | "boolean" | "object" | "array">;
  secrets?: string[];
  steps: StepDefinition[];
  onFailure?: StepDefinition[];
  finally?: StepDefinition[];
}

interface BaseStep {
  id: string;
  description?: string;
  after?: string[];
  condition?: string;
  timeout?: number;
}

interface ShellStep extends BaseStep {
  type: "shell";
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  failOnError?: boolean;
}

interface AgentStep extends BaseStep {
  type: "agent";
  prompt: string;
  agent?: string;
  system?: string;
  maxTokens?: number;
}

interface HttpStep extends BaseStep {
  type: "http";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  failOnError?: boolean;
}

type StepDefinition = ShellStep | AgentStep | HttpStep;

// Helper function to create build steps with consistent configuration
const createBuildStep = (id: string, command: string): ShellStep => ({
  id,
  type: "shell",
  command,
  failOnError: true,
});

// Type-safe workflow definition with full IDE autocomplete
const workflow: WorkflowDefinition = {
  id: "ts-build-and-deploy",
  name: "TypeScript Build and Deploy",
  description: "A type-safe workflow defined in TypeScript with full IDE support",
  
  // Input schema with TypeScript type annotations in comments
  inputs: {
    environment: "string",  // "staging" | "production"
    version: "string",      // Semantic version like "1.2.3"
    dryRun: "boolean",      // If true, skip actual deployment
  },
  
  // Mark sensitive inputs
  secrets: ["deployToken"],
  
  steps: [
    // Step 1: Validate inputs
    {
      id: "validate",
      type: "shell",
      command: "echo 'Deploying version {{inputs.version}} to {{inputs.environment}}'",
      description: "Validate deployment parameters",
    },
    
    // Step 2: Run tests
    createBuildStep("test", "npm test"),
    
    // Step 3: Build the project
    {
      ...createBuildStep("build", "npm run build"),
      after: ["test"],
      env: {
        NODE_ENV: "production",
        BUILD_VERSION: "{{inputs.version}}",
      },
    },
    
    // Step 4: Type check
    {
      id: "typecheck",
      type: "shell",
      command: "npm run typecheck",
      after: ["test"],
      description: "Run TypeScript type checking",
    },
    
    // Step 5: Deploy (conditional based on dryRun)
    {
      id: "deploy",
      type: "shell",
      command: "npm run deploy -- --env={{inputs.environment}} --version={{inputs.version}}",
      after: ["build", "typecheck"],
      condition: "{{inputs.dryRun}}==false",
      description: "Deploy to the specified environment",
    },
    
    // Step 6: Generate release notes using AI
    {
      id: "release-notes",
      type: "agent",
      prompt: "Generate release notes for version {{inputs.version}} based on recent commits. Be concise and focus on user-facing changes.",
      system: "You are a technical writer who creates clear, professional release notes.",
      maxTokens: 500,
      after: ["deploy"],
    },
    
    // Step 7: Notify completion
    {
      id: "notify",
      type: "http",
      method: "POST",
      url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        text: "Deployed {{inputs.version}} to {{inputs.environment}}",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "*Deployment Complete*\n{{steps.release-notes.response}}",
            },
          },
        ],
      },
      after: ["release-notes"],
      failOnError: false, // Don't fail workflow if notification fails
    },
  ],
  
  // Cleanup on failure
  onFailure: [
    {
      id: "notify-failure",
      type: "http",
      method: "POST",
      url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        text: "Deployment of {{inputs.version}} to {{inputs.environment}} FAILED: {{error.message}}",
      },
    },
  ],
};

export default workflow;
