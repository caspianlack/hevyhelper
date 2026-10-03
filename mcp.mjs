// MCP server exposing Hevy training data to Claude (Claude Code, Claude Desktop, etc.).
// Reads from the local cache; call the `sync_hevy` tool to pull fresh data.
// Never write to stdout here except via the MCP transport.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tools, INSTRUCTIONS } from './lib/tools.mjs';

const server = new McpServer({ name: 'hevy', version: '1.0.0' }, { instructions: INSTRUCTIONS });

for (const t of tools) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.schema }, async args => ({
    content: [{ type: 'text', text: await t.run(args) }],
  }));
}

await server.connect(new StdioServerTransport());
console.error('[hevy] MCP server ready');
