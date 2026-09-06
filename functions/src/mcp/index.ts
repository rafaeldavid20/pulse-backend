import { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { onRequest } from 'firebase-functions/v2/https';
import { buildMcpTransport } from './server';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

/**
 * Converts firebase-functions' Express-style req/res into a Web Standard
 * Request/Response pair for WebStandardStreamableHTTPServerTransport, then
 * writes the resulting Response back onto the Express res.
 *
 * Deliberately NOT using the SDK's own Express wrapper
 * (StreamableHTTPServerTransport), which goes through @hono/node-server's
 * getRequestListener to bridge Node's IncomingMessage into a web Request —
 * an extra layer that reconstructs a body stream from a request
 * firebase-functions has already consumed. Building the web Request
 * directly from the already-parsed `req.body` sidesteps that entirely.
 */
async function bridgeToWebFetch(req: ExpressRequest, res: ExpressResponse) {
  const url = `https://${req.headers.host ?? 'localhost'}${req.originalUrl}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const webRequest = new Request(url, {
    method: req.method,
    headers,
    // `duplex: 'half'` is required by the fetch spec when a body is present
    // on a Request constructed from a string/stream in Node's fetch impl.
    ...(hasBody ? { body: JSON.stringify(req.body), duplex: 'half' as const } : {}),
  });

  const transport = await buildMcpTransport();
  const webResponse = await transport.handleRequest(webRequest, {
    parsedBody: hasBody ? req.body : undefined,
  });

  res.status(webResponse.status);
  webResponse.headers.forEach((value, key) => res.setHeader(key, value));
  const text = await webResponse.text();
  res.send(text);
}

export const pulseMcp = onRequest(
  { region: 'us-east4', memory: '512MiB', timeoutSeconds: 60 },
  async (req, res) => {
    for (const [key, value] of Object.entries(CORS_HEADERS)) res.setHeader(key, value);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method === 'GET') {
      // SSE streaming isn't needed for this spike/tool-only server.
      res.status(405).send('Method Not Allowed: this MCP server only supports POST.');
      return;
    }

    try {
      await bridgeToWebFetch(req, res);
    } catch (error) {
      console.error('[pulseMcp] Transport error:', error);
      res.status(500).json({ error: 'Internal MCP transport error' });
    }
  }
);
