import type { McpPrincipal } from './auth';

/**
 * Builds a fresh McpServer + WebStandardStreamableHTTPServerTransport pair
 * for a single request, scoped to the already-authenticated `principal`.
 * Stateless: sessionIdGenerator is undefined (no `Mcp-Session-Id` affinity,
 * which Cloud Functions v2 can't guarantee across instances) and
 * enableJsonResponse is true (a single JSON-RPC response body instead of an
 * SSE stream, since these tools never emit server-initiated notifications).
 */
export async function buildMcpTransport(principal: McpPrincipal) {
  // Required lazily so `@modelcontextprotocol/sdk`'s dependency tree
  // (express, hono, jose, ajv, zod...) never loads for cold starts of other
  // functions in this codebase (e.g. pulsePlatformAction).
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { WebStandardStreamableHTTPServerTransport } = await import(
    '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
  );
  const { registerReadTools } = await import('./tools/read');
  const { registerWriteTools } = await import('./tools/write');

  const server = new McpServer({ name: 'pulse-mcp', version: '0.1.0' });
  registerReadTools(server, principal);
  registerWriteTools(server, principal);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport;
}
