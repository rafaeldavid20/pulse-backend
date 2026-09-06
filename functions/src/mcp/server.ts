/**
 * Builds a fresh McpServer + WebStandardStreamableHTTPServerTransport pair
 * for a single request. Stateless: sessionIdGenerator is undefined (no
 * `Mcp-Session-Id` affinity, which Cloud Functions v2 can't guarantee across
 * instances) and enableJsonResponse is true (a single JSON-RPC response body
 * instead of an SSE stream, since these tools never emit server-initiated
 * notifications).
 */
export async function buildMcpTransport() {
  // Required lazily so `@modelcontextprotocol/sdk`'s dependency tree
  // (express, hono, jose, ajv, zod...) never loads for cold starts of other
  // functions in this codebase (e.g. pulsePlatformAction).
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { WebStandardStreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
  );
  const { z } = await import('zod');

  const server = new McpServer({ name: 'pulse-mcp-spike', version: '0.0.1' });

  server.registerTool(
    'pulse_whoami',
    {
      title: 'Pulse whoami (spike)',
      description: 'Spike tool to verify the transport round-trips tools/call correctly.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, at: new Date().toISOString() }) }],
    })
  );

  // Referenced so the lazy `zod` import above isn't flagged unused if a
  // future tool needs `z` before this spike is replaced by real tools.
  void z;

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport;
}
