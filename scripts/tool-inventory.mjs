import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { productionTools } from '../dist/tools/registry.js';
import { SERVER_PROMPTS } from '../dist/mcp/prompts.js';

const tools = [...productionTools].sort((a, b) => a.name.localeCompare(b.name));
const rows = tools.map(
  (tool) =>
    `| \`${tool.name}\` | ${tool.spec.annotations.readOnlyHint ? 'Read' : 'Confirmed write'} | ${tool.meta.scopes.map((scope) => `\`${scope}\``).join(', ')} | ${tool.spec.title} |`
);
const content = `# Tool inventory\n\nGenerated from the production registry by \`npm run inventory:generate\`.\n${tools.length} tools and ${SERVER_PROMPTS.length} prompts; no resources or persistent MCP sessions.\n\n| Tool | Operation | Required scopes | Title |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n\n## Prompts\n\n${SERVER_PROMPTS.map((prompt) => `- \`${prompt.name}\`: ${prompt.title}`).join('\n')}\n`;
const path = 'docs/tool-inventory.md';
if (process.argv.includes('--check')) {
  assert.equal(
    readFileSync(path, 'utf8'),
    content,
    'Run npm run inventory:generate'
  );
} else {
  writeFileSync(path, content);
}
