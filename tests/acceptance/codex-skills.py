"""Real Codex TUI skill discovery against a local model and gateway fixture.

Run after cargo build -p coflux-cli: python3 tests/acceptance/codex-skills.py
No user configuration, credentials, daemon, or external model is used.
"""
import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'target/debug/coflux'
requests = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if self.path == '/agent':
            body = json.dumps({'ok': True, 'workspaceId': 'skill-workspace',
                               'owningWorkspaceId': 'skill-workspace'}).encode()
            self.send_response(200)
        elif self.path == '/hook':
            body = b'{"ok":true}'
            self.send_response(200)
        else:
            requests.append(json.loads(raw))
            body = b'{"error":{"message":"intentional local acceptance stop"}}'
            self.send_response(400)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def children(pid):
    rows = subprocess.check_output(['ps', '-axo', 'pid=,ppid='], text=True)
    return [int(row.split()[0]) for row in rows.splitlines()
            if int(row.split()[1]) == pid]


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


class Terminal:
    def __init__(self, args, env, cwd):
        self.master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
        self.process = subprocess.Popen(args, env=env, cwd=cwd, stdin=slave,
                                        stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        self.screen = ''

    def read(self, seconds):
        output = b''
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([self.master], [], [], .1)[0]:
                try:
                    data = os.read(self.master, 65536)
                except OSError:
                    break
                if b'\x1b[6n' in data:
                    os.write(self.master, b'\x1b[1;1R')
                output += data
        self.screen += re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', output.decode(errors='replace'))
        return self.screen

    def send(self, text):
        try:
            os.write(self.master, text.encode())
            time.sleep(.2)
            os.write(self.master, b'\r')
        except OSError as error:
            raise AssertionError(self.screen[-5000:]) from error

    def close(self):
        if self.process.poll() is None:
            os.killpg(self.process.pid, signal.SIGTERM)
        self.process.wait(timeout=15)
        os.close(self.master)


with tempfile.TemporaryDirectory(prefix='coflux-native-skills-', dir='/tmp') as temporary:
    directory = Path(temporary).resolve()
    codex_home = directory / 'codex'
    codex_home.mkdir()
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f'http://127.0.0.1:{server.server_port}'
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
'''
    (codex_home / 'config.toml').write_text(config)
    (codex_home / 'skill-probe.config.toml').write_text('model="profile-probe"\ndeveloper_instructions="COFLUX_PROFILE_SENTINEL"\n')
    env = {'PATH': os.environ['PATH'], 'HOME': str(directory), 'CODEX_HOME': str(codex_home),
           'TERM': 'xterm-256color', 'LANG': 'en_US.UTF-8',
           'COFLUX_HOME': str(directory / 'coflux'), 'COFLUX_SESSION_ID': 'skill-session',
           'COFLUX_WORKSPACE_ID': 'stale-workspace', 'COFLUX_TASK_ID': 'skill-task',
           'COFLUX_LOCAL_GATEWAY_PORT': str(server.server_port)}
    command = [str(CLI), 'agent', 'run', 'codex', '--', '--no-alt-screen']
    try:
        for mode, extra, abrupt in [('startup', ['--yolo'], False),
                                    ('resume-read-only', ['resume', '--last', '-s', 'read-only', '-a', 'never'], False),
                                    ('resume', ['--yolo', 'resume', '--last'], False),
                                    ('fork', ['--yolo', 'fork', '--last'], True)]:
            terminal = Terminal(command + extra, env, directory)
            try:
                terminal.read(4)
                if mode == 'startup':
                    assert 'Hooks need review' in terminal.screen, terminal.screen[-4000:]
                    # Trust only the seven known test hooks through the native UI.
                    terminal.send('2')
                    terminal.read(3)
                assert terminal.process.poll() is None, terminal.screen[-5000:]
                owned = children(terminal.process.pid)
                backends = [child for pid in owned for child in children(pid)]
                assert backends, 'No owned Codex backend found'
                sockets = [path for pid in owned for path in Path('/tmp').glob(f'coflux-codex-{pid}-*')]
                assert len(sockets) == 1, sockets
                assert sockets[0].stat().st_mode & 0o777 == 0o700
                terminal.send('/skills')
                terminal.read(1)
                terminal.send('')
                terminal.read(1)
                assert re.search(r'coflux\s*\(coflux\)\s*\[Skill\]', terminal.screen), terminal.screen[-5000:]
                if abrupt:
                    os.killpg(terminal.process.pid, signal.SIGKILL)
                    terminal.process.wait(timeout=5)
                else:
                    os.write(terminal.master, b'\x1b')
                    terminal.read(.3)
                    os.write(terminal.master, b'\x15')
                    requests.clear()
                    terminal.send('Say okay.')
                    terminal.read(3)
                    payload = json.dumps(requests)
                    main_requests = [request for request in requests if '- coflux:coflux:' in json.dumps(request)]
                    assert main_requests, terminal.screen[-5000:]
                    for request in main_requests:
                        metadata = json.loads(request['client_metadata']['x-codex-turn-metadata'])
                        expected = 'read-only' if mode == 'resume-read-only' else 'danger-full-access'
                        assert metadata['sandbox_mode'] == expected, metadata
                    assert '- coflux:coflux:' in payload, terminal.screen[-5000:]
                    assert '<coflux-session>' in payload and 'skill-workspace' in payload
                    if mode == 'startup':
                        assert '## Local commands' not in payload, 'The whole skill was inlined'
                        requests.clear()
                        terminal.send('$coflux')
                        terminal.read(.5)
                        terminal.send(' Say okay using this skill.')
                        terminal.read(3)
                        assert '## Local commands' in json.dumps(requests), terminal.screen[-5000:]
                    os.write(terminal.master, b'\x04')
                    terminal.read(1)
                    assert terminal.process.wait(timeout=15) == 0, terminal.screen[-3000:]
                deadline = time.monotonic() + 12
                while time.monotonic() < deadline and any(alive(pid) for pid in backends):
                    time.sleep(.1)
                assert not any(alive(pid) for pid in backends), backends
                assert not sockets[0].exists(), 'Socket directory survived shutdown'
                print('PASS native /skills on', mode, 'and cleanup after', 'SIGKILL' if abrupt else 'normal exit', flush=True)
            finally:
                terminal.close()
        # app-server cannot load profiles. Keep the native runtime and all profile
        # fields rather than silently losing developer instructions on --remote.
        terminal = Terminal(command + ['--yolo', '-p', 'skill-probe'], env, directory)
        try:
            terminal.read(4)
            assert 'Codex profiles keep their native runtime' in terminal.screen
            requests.clear()
            terminal.send('Say okay.')
            terminal.read(3)
            assert 'COFLUX_PROFILE_SENTINEL' in json.dumps(requests)
            assert any(request.get('model') == 'profile-probe' for request in requests)
            os.write(terminal.master, b'\x04')
            terminal.read(1)
            assert terminal.process.wait(timeout=10) == 0
            print('PASS profile model and developer instructions on the native fallback')
        finally:
            terminal.close()
        # Enabling process-local roots never installs a user skill or plugin.
        assert not (directory / '.agents/skills/coflux').exists()
        assert not (codex_home / 'skills/coflux').exists()
        persisted = (codex_home / 'config.toml').read_text()
        assert '[marketplaces.' not in persisted and '[plugins.' not in persisted
        print('PASS process-local discovery, model catalog, hooks, and no persistent registration')
    finally:
        server.shutdown()
        server.server_close()
