"""Exercise workspace entry through real Codex tools and resume, using only local fixtures.

Run after building coflux: python3 tests/acceptance/codex-workspace.py
No real daemon, credentials, user configuration, or external model is used.
"""
import http.server
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'target/debug/coflux'
CODEX = shutil.which('codex')
assert CLI.exists() and CODEX, 'Build coflux and install Codex before acceptance'

with tempfile.TemporaryDirectory(prefix='coflux-codex-workspace-') as temporary:
    directory = Path(temporary).resolve()
    main = directory / 'main'
    selected = directory / 'selected with spaces'
    main.mkdir()
    selected.mkdir()
    codex_home = directory / 'codex'
    codex_home.mkdir()
    requests = []
    actions = []
    owner = 'main-id'
    send_entry = True

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            global owner, send_entry
            payload = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
            if self.path == '/agent':
                actions.append(payload)
                path = payload.get('path') if payload['action'] == 'workspace.locate' else payload.get('cwd')
                workspace = 'selected-id' if path == str(selected) else 'main-id'
                if payload['action'] == 'workspace.locate':
                    owner = workspace
                body = json.dumps({'ok': True, 'workspaceId': workspace, 'path': path,
                                   'owningWorkspaceId': owner}).encode()
            elif self.path == '/hook':
                body = b'{"ok":true}'
            else:
                requests.append(payload)
                if send_entry:
                    tool = next(t for t in payload['tools'] if t.get('name') in
                                ['exec_command', 'shell_command', 'shell'])
                    properties = tool['parameters']['properties']
                    command = f'{shlex.quote(str(CLI))} workspace enter {shlex.quote(str(selected))}'
                    arguments = {'cmd' if 'cmd' in properties else 'command': command}
                    if tool['name'] == 'shell':
                        arguments['command'] = ['/bin/sh', '-c', command]
                    output = {'type': 'function_call', 'id': 'fc_enter', 'call_id': 'call_enter',
                              'name': tool['name'], 'arguments': json.dumps(arguments)}
                    send_entry = False
                else:
                    output = {'id': 'msg_done', 'type': 'message', 'status': 'completed',
                              'role': 'assistant', 'content': [{'type': 'output_text',
                              'text': 'Workspace acceptance complete.', 'annotations': []}]}
                response = {'id': f'resp_{len(requests)}', 'object': 'response', 'status': 'completed',
                            'output': [output], 'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}
                events = [
                    {'type': 'response.created', 'response': {**response, 'status': 'in_progress', 'output': []}},
                    {'type': 'response.output_item.done', 'output_index': 0, 'item': output},
                    {'type': 'response.completed', 'response': response},
                ]
                body = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    (codex_home / 'config.toml').write_text(f'''model="probe"
model_provider="probe"
[model_providers.probe]
name="probe"
base_url="http://127.0.0.1:{server.server_port}"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
[features]
apps=false
remote_plugin=false
''')
    env = {'PATH': os.environ['PATH'], 'HOME': str(directory), 'CODEX_HOME': str(codex_home),
           'COFLUX_HOME': str(directory / 'coflux'), 'COFLUX_SESSION_ID': 'terminal-one',
           'COFLUX_DEVICE_ID': 'probe-device', 'COFLUX_PROJECT_ID': 'probe-project',
           'COFLUX_LOCAL_GATEWAY_PORT': str(server.server_port)}
    # Trust bypass is confined to the inspected hooks and temporary config of
    # this synthetic acceptance process; it never changes the user's trust data.
    command = [str(CLI), 'agent', 'run', 'codex', '--', '--dangerously-bypass-hook-trust',
               '--sandbox', 'danger-full-access', '-a', 'never', 'exec']
    try:
        result = subprocess.run(command + ['--skip-git-repo-check', '--json', 'Enter the selected workspace.'],
                                env=env, cwd=main, capture_output=True, text=True, timeout=45)
        assert result.returncode == 0, result.stderr + result.stdout
        assert len(requests) >= 2, result.stdout
        assert owner == 'selected-id', result.stdout
        continuation = json.dumps(requests[-1])
        assert 'Selected working directory:' in continuation and 'selected with spaces' in continuation, continuation
        assert 'resumeSupported' in continuation and 'hostCwdChanged' in continuation, continuation
        thread = next(json.loads(line)['thread_id'] for line in result.stdout.splitlines()
                      if json.loads(line).get('type') == 'thread.started')
        print('PASS native Codex tool entry: confirmed path, persisted identity and PostToolUse model context')
        requests.clear()
        actions.clear()
        owner = 'main-id'
        env['COFLUX_SESSION_ID'] = 'terminal-two'
        result = subprocess.run(command + ['resume', thread, '--skip-git-repo-check', '--json', 'Continue.'],
                                env=env, cwd=main, capture_output=True, text=True, timeout=45)
        assert result.returncode == 0, result.stderr + result.stdout
        assert owner == 'selected-id', actions
        assert requests and 'Selected working directory:' in json.dumps(requests[0]), requests
        assert actions[0]['path'] == str(selected), actions
        print('PASS native Codex resume: original cwd preserved by host, selected workspace restored in a new terminal')
    finally:
        server.shutdown()
        server.server_close()
