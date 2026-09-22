import type { McpPrincipal } from './auth';
import { TOOL_SCOPES } from './scopes';
import { NO_SALESFORCE_PROJECT_MESSAGE, SALESFORCE_TOOL_PREFIX, workspaceHasSalesforceProject } from '../salesforce/gate';

/**
 * Wraps `server.tool`/`server.registerTool` so every tool registered by
 * `registerReadTools`/`registerWriteTools` is checked against `TOOL_SCOPES`
 * before its real handler runs — a single enforcement point instead of a
 * check duplicated in every tool body (D11/TES-207). Both overloads take the
 * handler as their last argument, so wrapping generically by position covers
 * every call site without the tool files needing to know scopes exist.
 */
function enforceScopes(server: any, principal: McpPrincipal) {
  for (const methodName of ['tool', 'registerTool'] as const) {
    const original = (server[methodName] as (...args: any[]) => any).bind(server);
    server[methodName] = (name: string, ...rest: any[]) => {
      const handler = rest[rest.length - 1];
      if (typeof handler !== 'function') return original(name, ...rest);

      const required = TOOL_SCOPES[name];
      const guarded = async (...handlerArgs: any[]) => {
        if (required && !principal.scopes.includes(required)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `scope '${required}' requerido` }, null, 2) }],
            isError: true,
          };
        }
        // TES-270: toda tool `pulse_sf_*` responde con un mensaje accionable si
        // el workspace no tiene proyectos Salesforce. Va acá, junto a los
        // scopes, para que ninguna tool nueva pueda olvidarlo. No es un control
        // de seguridad: lo es el `workspaceId` del principal.
        if (name.startsWith(SALESFORCE_TOOL_PREFIX) && !(await workspaceHasSalesforceProject(principal.workspaceId))) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: NO_SALESFORCE_PROJECT_MESSAGE }, null, 2) }],
            isError: true,
          };
        }
        return handler(...handlerArgs);
      };
      return original(name, ...rest.slice(0, -1), guarded);
    };
  }
}

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
  const { registerSalesforceTools } = await import('./tools/salesforce');

  const server = new McpServer({ name: 'pulse-mcp', version: '0.1.0' });
  enforceScopes(server, principal);
  registerReadTools(server, principal);
  registerWriteTools(server, principal);
  registerSalesforceTools(server, principal);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport;
}
