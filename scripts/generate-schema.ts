import { zodToJsonSchema } from 'zod-to-json-schema';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkflowDefinitionSchema } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const jsonSchema = zodToJsonSchema(WorkflowDefinitionSchema, {
  name: 'WorkflowDefinition',
  $refStrategy: 'none', // Inline all definitions for better IDE support
});

// Add JSON Schema metadata
const schemaWithMeta = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://raw.githubusercontent.com/mark-hingston/opencode-workflows/main/schemas/workflow.schema.json',
  title: 'OpenCode Workflow Definition',
  description: 'Schema for OpenCode workflow definition files',
  ...jsonSchema,
};

const outputPath = join(__dirname, '..', 'schemas', 'workflow.schema.json');
writeFileSync(outputPath, `${JSON.stringify(schemaWithMeta, null, 2)}\n`);

console.log(`✅ Generated JSON Schema at: ${outputPath}`);
