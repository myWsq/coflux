import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CLI = resolve(import.meta.dirname, '../../target/debug/coflux');
const FIXTURE = resolve(import.meta.dirname, '../fixtures/codex-app-server.mjs');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for isolated Codex fixture');
    await delay(50);
  }
}

async function fixture(options, body) {
  const home = mkdtempSync(join(tmpdir(), 'coflux skill bridge '));
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin/codex'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FIXTURE)} "$@"\n`, {mode: 0o755});
  const processEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('COFLUX_')));
  const child = spawn(CLI, ['agent', 'run', 'codex', '--', ...options.args], {
    env: {...processEnv, HOME: home, COFLUX_HOME: home, COFLUX_SESSION_ID: 'isolated',
      PATH: `${join(home, 'bin')}:${process.env.PATH}`, FIXTURE_HOME: home, ...options.env},
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  });
  try {
    await body({home, child, exited, stderr: () => stderr});
  } finally {
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGTERM');
    await exited;
    if (existsSync(join(home, 'server.json'))) {
      const server = read(join(home, 'server.json'));
      try {
        await until(() => !alive(server.pid) && !alive(server.child));
        assert.equal(existsSync(dirname(server.endpoint.slice('unix://'.length))), false, 'Socket directory leaked');
      } finally {
        // Even a broken implementation must not leave the test processes behind.
        if (alive(server.pid)) process.kill(-server.pid, 'SIGKILL');
        if (alive(server.child)) process.kill(server.child, 'SIGKILL');
      }
    }
    rmSync(home, {recursive: true, force: true});
  }
}

test('Codex bridge registers skills before the TUI, preserves arguments and exit status', async () => {
  await fixture({args: ['--yolo', '-c', 'model="fixture"', 'resume', '--last', 'a b']}, async ({home, exited, stderr}) => {
    assert.equal((await exited).code, 17, stderr());
    const server = read(join(home, 'server.json'));
    const frontend = read(join(home, 'frontend.json'));
    assert.deepEqual(server.calls, ['initialize', 'skills/extraRoots/set', 'skills/list']);
    assert.ok(server.args.includes('approval_policy="never"'));
    assert.ok(server.args.includes('sandbox_mode="danger-full-access"'));
    assert.ok(server.args.includes('model="fixture"'));
    assert.equal(frontend.args.includes('--yolo'), false);
    assert.equal(frontend.args[frontend.args.indexOf('--remote') + 1], server.endpoint);
    assert.deepEqual(frontend.args.slice(-3), ['resume', '--last', 'a b']);
    assert.ok(existsSync(join(frontend.bundle, 'skills/coflux/SKILL.md')));
  });
});

test('Codex bridge rejects an unsupported skills API before opening a misleading TUI', async () => {
  await fixture({args: [], env: {FIXTURE_UNSUPPORTED: '1'}}, async ({home, exited, stderr}) => {
    assert.notEqual((await exited).code, 0);
    assert.match(stderr(), /skills\/extraRoots\/set/);
    assert.equal(existsSync(join(home, 'frontend.json')), false);
  });
});

test('Codex bridge watchdog cleans up when the launcher process group is killed', async () => {
  await fixture({args: [], env: {FIXTURE_WAIT: '1'}}, async ({home, child, exited}) => {
    await until(() => existsSync(join(home, 'frontend.json')));
    process.kill(-child.pid, 'SIGKILL');
    assert.equal((await exited).signal, 'SIGKILL');
  });
});
