#!/usr/bin/env node
// Deterministic provider double. Never reads native Codex/Claude credentials.
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2);
if (args.includes('--version')) console.log('Pulse fixture CLI 1.0');
else if (args[0] === 'login' && args[1] === 'status') console.log('Logged in (local fixture)');
else if (args[0] === 'auth' && args[1] === 'status') console.log(JSON.stringify({ loggedIn: true }));
else {
  let url, credential;
  if (args.includes('--mcp-config')) {
    const config = JSON.parse(await readFile(args[args.indexOf('--mcp-config') + 1], 'utf8'));
    const server = config.mcpServers.pulse;
    url = server.url; credential = server.headers.Authorization;
  } else {
    url = args.find(a => a.startsWith('mcp_servers.pulse.url='))?.split('=')[1].replace(/^"|"$/g, '');
    const auth = args.find(a => a.includes('Authorization') && a.includes('Bearer'));
    credential = auth?.match(/Bearer ([A-Za-z0-9_-]+)/)?.[0];
  }
  if (!url?.startsWith('http://127.0.0.1:5001/demo-pulse-local/') || !credential) throw new Error('Fixture refuses non-local MCP or missing job credential');
  const response = await fetch(url, { method: 'POST', headers: { Authorization: credential, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pulse_get_issue', arguments: { identifier: args.join(' ').match(/issue-local-(?:codex|claude)/)?.[0] } } }) });
  const result = await response.json();
  if (!response.ok || result.error || result.result?.isError || !JSON.stringify(result).includes('ws-aVEruGM7')) throw new Error('Scoped local MCP request failed');
  if (process.env.PULSE_LAB_FAIL === '1') { console.error('Fixture failure token=ghp_abcdefghijklmnopqrstuvwxyz1234567890'); process.exitCode = 7; }
  else console.log('LOCAL_MCP_OK');
}
