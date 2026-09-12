// Executable Codex boundary fixture: speaks JSON-RPC over WebSocket, never calls
// application code or a real daemon/model. Descendants deliberately resist TERM.
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const directory = process.env.FIXTURE_HOME;
const save = (name, data) => writeFileSync(join(directory, name), JSON.stringify(data));
if (args.includes('app-server')) {
  const endpoint = args[args.indexOf('--listen') + 1];
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], {stdio: 'ignore'});
  const state = {pid: process.pid, child: child.pid, args, endpoint, calls: []};
  save('server.json', state);
  const server = createServer();
  const ws = new WebSocketServer({server});
  let roots = [];
  ws.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.id === undefined) return;
    state.calls.push(message.method);
    save('server.json', state);
    if (message.method === 'skills/extraRoots/set' && process.env.FIXTURE_UNSUPPORTED) {
      socket.send(JSON.stringify({id: message.id, error: {code: -32601, message: 'Method not found'}}));
      return;
    }
    let result = {};
    if (message.method === 'skills/extraRoots/set') roots = message.params.extraRoots;
    if (message.method === 'skills/list') {
      result = {data: [{skills: [{name: 'coflux', path: join(roots[0], 'coflux/SKILL.md'), enabled: true}]}]};
    }
    socket.send(JSON.stringify({id: message.id, result}));
  }));
  server.listen(endpoint.slice('unix://'.length));
} else {
  save('frontend.json', {pid: process.pid, args, bundle: process.env.COFLUX_AGENT_BUNDLE});
  if (process.env.FIXTURE_WAIT) setInterval(() => {}, 1000);
  else process.exit(17);
}
