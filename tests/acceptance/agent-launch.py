"""Isolated launcher/update acceptance with deterministic executable host fixtures."""
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'target/debug/coflux'
with tempfile.TemporaryDirectory(prefix='coflux-launch-') as temp:
    home = Path(temp)
    (home / 'bin').mkdir()
    (home / 'hosts').mkdir()
    stable = home / 'bin/coflux'
    shutil.copy2(CLI, stable)
    for host in ['claude', 'codex']:
        fixture = home / 'hosts' / host
        fixture.write_text('#!/bin/sh\nprintf "%s\\n" "$COFLUX_AGENT_BUNDLE"\nprintf "%s\\n" "$@"\n')
        fixture.chmod(0o755)
    env = {**os.environ, 'COFLUX_HOME': str(home), 'HOME': str(home), 'COFLUX_SESSION_ID': 'launch-probe',
           'PATH': str(home / 'hosts') + ':' + os.environ['PATH']}
    def run(args, overrides=None):
        return subprocess.run(args, env={**env, **(overrides or {})}, text=True, capture_output=True, check=True).stdout
    first = json.loads(run([str(stable), 'agent', 'prepare']))['directory']
    # The same live shell reads the stable launcher again after an atomic executable update.
    shell = subprocess.Popen(['/bin/bash', '--noprofile', '--norc'], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    try:
        shell.stdin.write(f'source "{ROOT}/crates/supervisor/src/shell/claude.sh"\nclaude "argument with spaces"\necho END\n')
        shell.stdin.flush()
        lines = []
        while (line := shell.stdout.readline().strip()) != 'END':
            lines.append(line)
        assert lines[0] == first and lines[-1] == 'argument with spaces', lines
        original = (Path(first) / 'coflux').read_bytes()
        # Appended executable data changes the delivery identity without rebuilding test code.
        replacement = home / 'bin/coflux.next'
        shutil.copy2(CLI, replacement)
        if os.uname().sysname == 'Darwin':
            subprocess.run(['/usr/bin/codesign', '--force', '--sign', '-', '--identifier', 'coflux.acceptance.next', str(replacement)], check=True, capture_output=True)
        else:
            with replacement.open('ab') as f:
                f.write(b'\ncoflux-acceptance-next-release\n')
        replacement.replace(stable)
        shell.stdin.write('codex "next invocation"\necho END\n')
        shell.stdin.flush()
        lines = []
        while (line := shell.stdout.readline().strip()) != 'END':
            lines.append(line)
        second = lines[0]
        assert second != first and Path(second).is_dir(), lines
        for host_shell, wrapper in [('zsh', 'claude.sh'), ('fish', 'coflux.fish')]:
            executable = shutil.which(host_shell)
            if executable:
                output = run([executable, '-c', 'source ' + shlex.quote(str(ROOT / 'crates/supervisor/src/shell' / wrapper)) + '; codex "argument with spaces"'])
                assert output.splitlines()[0] == second and output.splitlines()[-1] == 'argument with spaces'
        assert (Path(first) / 'coflux').read_bytes() == original
        assert json.loads(run([str(Path(first) / 'coflux'), 'agent', 'prepare']))['directory'] == first
        assert run([str(stable), 'agent', 'run', 'codex', '--', 'plain'], {'COFLUX_AGENT_INTEGRATION': 'off'}).splitlines() == ['', 'plain']
        assert run([str(stable), 'agent', 'run', 'claude', '--', 'plain'], {'COFLUX_SESSION_ID': ''}).splitlines() == ['', 'plain']
        (Path(second) / 'hooks/hooks.json').write_text('{}')
        corrupt = subprocess.run([str(stable), 'agent', 'run', 'claude', '--', 'plain'], env=env, text=True, capture_output=True)
        assert corrupt.returncode == 0 and 'damaged' in corrupt.stderr and corrupt.stdout.splitlines() == ['', 'plain']
        print('PASS live shell update, pinned previous bundle, argument preservation, bypass and corrupt-bundle fallback')
    finally:
        shell.stdin.close()
        shell.wait(timeout=5)
