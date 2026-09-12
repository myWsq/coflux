"""Opt-in native host acceptance; no external models, credentials, or user config.
Run: python3 tests/acceptance/agent-hosts.py
"""
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'target/debug/coflux'
CODEX = shutil.which('codex')
CLAUDE = shutil.which('claude')
assert CLI.exists() and CODEX and CLAUDE, 'Build coflux and install both native hosts before acceptance'
requests = []
workspace = 'workspace-current'
succeed = False
hook_events = []

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/agent':
            body = json.dumps({'ok': True, 'workspaceId': workspace, 'owningWorkspaceId': workspace, 'path': '/probe'}).encode()
            self.send_response(200)
        elif self.path == '/hook':
            hook_events.append(json.loads(raw))
            body = b'{"ok":true}'
            self.send_response(200)
        else:
            requests.append(raw)
            if succeed and '/messages' in self.path:
                message = {"id":"msg_probe", "type":"message", "role":"assistant", "model":"probe", "content":[], "stop_reason":None, "stop_sequence":None, "usage":{"input_tokens":10,"output_tokens":0}}
                events = [{"type":"message_start","message":message}, {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}, {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"The user asked for a synthetic acceptance response. Reply Okay."}}, {"type":"content_block_stop","index":0}, {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":None},"usage":{"output_tokens":12}}, {"type":"message_stop"}]
                body = ''.join('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n' for event in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if succeed and '/messages' not in self.path:
                output = {"id":"msg_probe", "type":"message", "status":"completed", "role":"assistant", "content":[{"type":"output_text", "text":"Okay.", "annotations":[]}]}
                response = {"id":"resp_probe", "object":"response", "status":"completed", "output":[output], "usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}
                events = [{"type":"response.created", "response":{**response,"status":"in_progress","output":[]}}, {"type":"response.output_item.done","output_index":0,"item":output}, {"type":"response.completed","response":response}]
                body = ''.join('event: '+event['type']+'\ndata: '+json.dumps(event)+'\n\n' for event in events).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            # Stop before a model response; the request is the evidence being tested.
            body = b'{"error":{"message":"intentional local probe stop","type":"invalid_request_error"}}'
            self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def native_review(args, env, cwd, compact=False):
    global workspace
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 35, 120, 0, 0))
    process = subprocess.Popen(args, cwd=cwd, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
    os.close(slave)
    def read(seconds):
        output = b''
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if b'\x1b[6n' in data:
                    os.write(master, b'\x1b[1;1R')
                output += data
        return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output.decode(errors='replace'))
    try:
        screen = read(4)
        if compact:
            os.write(master, b'Say okay.')
            time.sleep(.4)
            os.write(master, b'\r')
            screen += read(5)
            before = len([e for e in hook_events if e.get('event') == 'SessionStart'])
            os.write(master, b'/compact')
            time.sleep(.4)
            os.write(master, b'\r')
            screen += read(8)
            assert 'Context compacted' in screen, screen[-4000:]
            workspace = 'workspace-after-compact'
            requests.clear()
            os.write(master, b'Continue.')
            time.sleep(.4)
            os.write(master, b'\r')
            screen += read(5)
            after = len([e for e in hook_events if e.get('event') == 'SessionStart'])
            assert after > before and any(b'workspace-after-compact' in body for body in requests), screen[-4000:]
            return
        assert 'Hooks need review' in screen, screen[-2000:]
        # Trust only these synthetic, isolated, inspected Coflux hooks using the native UI.
        os.write(master, b'2')
        time.sleep(.3)
        os.write(master, b'\r')
        read(3)
    finally:
        os.killpg(process.pid, 15)
        process.wait(timeout=5)
        os.close(master)


with tempfile.TemporaryDirectory(prefix='coflux-native-acceptance-') as temporary:
    directory = Path(temporary).resolve()
    codex_home = directory / 'codex'
    codex_home.mkdir()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{server.server_port}'
    env = {'PATH': os.environ['PATH'], 'HOME': str(directory), 'CODEX_HOME': str(codex_home),
           'CLAUDE_CONFIG_DIR': str(directory / 'claude'), 'TMPDIR': str(directory), 'TERM': 'xterm-256color',
           'LANG': 'en_US.UTF-8', 'COFLUX_HOME': str(directory / 'coflux'),
           'COFLUX_SESSION_ID': 'probe-session', 'COFLUX_WORKSPACE_ID': 'stale-workspace',
           'COFLUX_TASK_ID': 'probe-task', 'COFLUX_LOCAL_GATEWAY_PORT': str(server.server_port)}
    config = f'''model="probe"
model_provider="probe"
[model_providers.probe]
name="probe"
base_url="{endpoint}"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
[features]
remote_plugin=false
apps=false
[projects.{json.dumps(str(directory))}]
trust_level="trusted"
[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type="command"
command="/bin/echo UNRELATED_SESSION_HOOK"
timeout=2
'''
    (codex_home / 'config.toml').write_text(config)
    try:
        command = [str(CLI), 'agent', 'run', 'codex', '--']
        exec_args = ['exec', '--skip-git-repo-check', '--json', 'Say okay.']
        result = subprocess.run(command + exec_args, env=env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
        assert requests and not any(b'<coflux-session>' in body for body in requests), 'Untrusted hook ran'
        requests.clear()
        native_review(command + ['--no-alt-screen'], env, directory)
        assert 'trusted_hash' in (codex_home / 'config.toml').read_text(), 'Native review did not persist trust'
        result = subprocess.run(command + exec_args, env=env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
        assert requests and any(b'<coflux-session>' in body and b'workspace-current' in body and b'SKILL.md' in body for body in requests), result.stderr.decode()[-2000:] + result.stdout.decode()[-2000:] + str(hook_events[-10:])
        assert any(b'UNRELATED_SESSION_HOOK' in body for body in requests), 'Session flags shadowed an unrelated user hook'
        print('PASS Codex: new hooks, native review, context, skill pointer and unrelated user hook')
        requests.clear()
        workspace = 'workspace-codex-resumed'
        result = subprocess.run(command + ['exec', 'resume', '--last', '--skip-git-repo-check', '--json', 'Say okay again.'], env=env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
        assert requests and any(b'<coflux-session>' in body and b'workspace-codex-resumed' in body for body in requests), result.stderr.decode()[-2000:] + result.stdout.decode()[-2000:] + str(hook_events[-10:])
        print('PASS Codex: native resume carries current context')
        requests.clear()
        workspace = 'workspace-current'
        claude_env = {**env, 'ANTHROPIC_API_KEY': 'local-probe-only', 'ANTHROPIC_BASE_URL': endpoint,
                      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        result = subprocess.run([str(CLI), 'agent', 'run', 'claude', '--', '-p', '--verbose', '--output-format', 'stream-json',
                                 '--setting-sources', '', 'Say okay.'],
                                env=claude_env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=35)
        assert requests and any(b'<coflux-session>' in body and b'workspace-current' in body for body in requests), result.stderr.decode()[-2000:] + result.stdout.decode()[-2000:]
        print('PASS Claude: session plugin, current context and native skill delivery')
        requests.clear()
        workspace = 'workspace-claude-resumed'
        result = subprocess.run([str(CLI), 'agent', 'run', 'claude', '--', '--continue', '-p', '--verbose', '--output-format', 'stream-json', '--setting-sources', '', 'Say okay again.'], env=claude_env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=35)
        assert requests and any(b'<coflux-session>' in body and b'workspace-claude-resumed' in body for body in requests), result.stderr.decode()[-2000:] + result.stdout.decode()[-2000:]
        print('PASS Claude: native resume carries current context')
        succeed = True
        native_review(command + ['--no-alt-screen'], env, directory, compact=True)
        print('PASS Codex: native compaction refreshes SessionStart context')
        before = len([e for e in hook_events if e.get('agent') == 'claude' and e.get('event') == 'SessionStart'])
        result = subprocess.run([str(CLI), 'agent', 'run', 'claude', '--', '--continue', '-p', '--verbose', '--output-format', 'stream-json', '--setting-sources', '', '/compact'], env=claude_env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=35)
        after = len([e for e in hook_events if e.get('agent') == 'claude' and e.get('event') == 'SessionStart'])
        assert after >= before + 2 and b'compact_boundary' in result.stdout, result.stdout.decode()[-4000:] + result.stderr.decode()[-1000:]
        print('PASS Claude: native compaction refreshes SessionStart context')
        updated = directory / 'updated-coflux'
        shutil.copy2(CLI, updated)
        if os.uname().sysname == 'Darwin':
            subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', 'coflux.native.acceptance.updated', str(updated)], check=True, capture_output=True)
        else:
            with updated.open('ab') as stream:
                stream.write(b'\ncoflux-next-native-acceptance\n')
        updated_command = [str(updated), 'agent', 'run', 'codex', '--']
        succeed = False
        workspace = 'workspace-updated'
        requests.clear()
        result = subprocess.run(updated_command + exec_args, env=env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
        assert requests and not any(b'<coflux-session>' in body for body in requests), 'Updated hooks reused old trust'
        native_review(updated_command + ['--no-alt-screen'], env, directory)
        requests.clear()
        result = subprocess.run(updated_command + exec_args, env=env, cwd=directory, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
        assert requests and any(b'workspace-updated' in body for body in requests), result.stderr.decode()[-2000:]
        print('PASS Codex: changed delivery requires native review and then injects current context')
    finally:
        server.shutdown()
        server.server_close()
