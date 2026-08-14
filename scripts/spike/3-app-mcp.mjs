// SPIKE 3: can a zero-dependency local HTTP MCP server hand app tools to a
// session, and can the app tell WHICH session called (token in the URL)?
//
// This is the spine of the design: it is how 토끼 saves a task list, how any
// person updates its own nameplate, and how job instructions get read back.
//
//   node scripts/spike/3-app-mcp.mjs
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnClaude, killTree, lineJson, assistantText, pass, fail } from './lib.mjs';

const PORT = 4399;                       // spike-only port
const TOKEN = randomUUID();              // stands in for a per-session token
const WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-spike3-'));
const calls = [];                        // what the server actually received

// ---------------------------------------------------------------- MCP server
const TOOLS = [{
  name: 'set_status',
  description: 'Set the one-line status shown under this person\'s nameplate in the office UI. Call this whenever you start or finish something.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Short Korean status, max 12 chars.' } },
    required: ['text'],
    additionalProperties: false,
  },
}];

function rpc(res, id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const m = url.pathname.match(/^\/mcp\/([^/]+)$/);
  if (!m) { res.writeHead(404).end(); return; }
  const sessionToken = m[1];             // <- this is how the app knows who called

  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }

    // Notifications carry no id and expect no JSON-RPC response.
    if (msg.id === undefined) { res.writeHead(202).end(); return; }

    switch (msg.method) {
      case 'initialize':
        return rpc(res, msg.id, {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'claude-crew-office', version: '0.0.1' },
        });
      case 'tools/list':
        return rpc(res, msg.id, { tools: TOOLS });
      case 'tools/call': {
        calls.push({ sessionToken, name: msg.params?.name, args: msg.params?.arguments });
        console.log(`[mcp] ${msg.params?.name} from token=${sessionToken.slice(0, 8)}… args=${JSON.stringify(msg.params?.arguments)}`);
        return rpc(res, msg.id, { content: [{ type: 'text', text: 'ok, nameplate updated' }] });
      }
      default:
        return rpc(res, msg.id, {});
    }
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`mcp server : http://127.0.0.1:${PORT}/mcp/${TOKEN}`);
console.log(`workdir    : ${WORKDIR}\n`);

// ------------------------------------------------------------------- session
const mcpConfig = JSON.stringify({
  mcpServers: { office: { type: 'http', url: `http://127.0.0.1:${PORT}/mcp/${TOKEN}` } },
});
const sessionId = randomUUID();
const args = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--session-id', sessionId,
  '--model', 'haiku',
  '--mcp-config', mcpConfig,
  '--no-session-persistence',   // 검증용 세션이 사용자의 Claude Code 기록에 남지 않게
  '--strict-mcp-config',
  '--setting-sources', '',
  '--settings', '{"disableAllHooks":true}',
  '--allowedTools', 'mcp__office__set_status',
];

const child = spawnClaude(args, { cwd: WORKDIR });
let init = null, text = '', stderr = '';

child.stdout.on('data', lineJson((ev) => {
  if (ev.type === 'system' && ev.subtype === 'init') init = ev;
  else if (ev.type === 'assistant') text += assistantText(ev);
}));
child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

child.stdin.write(JSON.stringify({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text: 'set_status 툴로 상태를 "보고서 쓰는 중" 으로 바꿔줘.' }] },
  parent_tool_use_id: null,
  session_id: sessionId,
}) + '\n');
child.stdin.end();

const done = await new Promise((r) => {
  const t = setTimeout(() => { killTree(child); r('timeout'); }, 120_000);
  child.on('close', (c) => { clearTimeout(t); r(c); });
});

console.log(`\nmcp_servers: ${JSON.stringify(init?.mcp_servers ?? null)}`);
console.log(`tools      : ${JSON.stringify((init?.tools ?? []).filter((t) => String(t).startsWith('mcp__')))}`);
console.log(`answer     : ${text.replace(/\s+/g, ' ').slice(0, 200)}`);
console.log(`exit       : ${done}`);
if (stderr) console.log(`stderr     : ${stderr.slice(0, 400)}`);

server.close();
killTree(child);

const connected = (init?.mcp_servers ?? []).some((s) => s.name === 'office' && s.status === 'connected');
const call = calls.find((c) => c.name === 'set_status');

if (!connected) fail(`session did not connect to the app MCP server: ${JSON.stringify(init?.mcp_servers)}`);
else if (!call) fail('MCP server connected but the tool was never called');
else if (call.sessionToken !== TOKEN) fail(`token mismatch — cannot attribute the call to a session`);
else if (!String(call.args?.text ?? '').includes('보고서')) fail(`tool called with unexpected args: ${JSON.stringify(call.args)}`);
else pass('zero-dep HTTP MCP server reached, tool called, session identified by URL token');
