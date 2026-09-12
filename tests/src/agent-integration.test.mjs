import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '../../target/debug/coflux');
function invoke(binary, args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')); }, 12000);
    child.stdout.on('data', b => { stdout += b; });
    child.stderr.on('data', b => { stderr += b; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({code, stdout, stderr}); });
    child.stdin.end(input);
  });
}

test('原生集成：完整交付、上下文刷新、延迟审核后的恢复', async () => {
  const home = mkdtempSync(join(tmpdir(), 'coflux-integration-'));
  let unavailable = false, workspace = 'current-workspace';
  const actions = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    actions.push(JSON.parse(raw));
    const response = JSON.stringify(unavailable ? {ok: false, error: 'offline'} : {ok: true, workspaceId: workspace, owningWorkspaceId: workspace});
    res.writeHead(unavailable ? 503 : 200, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(response)});
    res.end(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {HOME: home, COFLUX_HOME: home, PATH: '', COFLUX_SESSION_ID: 'session', COFLUX_WORKSPACE_ID: 'stale',
    COFLUX_PROJECT_ID: 'project', COFLUX_AGENT_RUN: `${process.pid}-123`, COFLUX_LOCAL_GATEWAY_PORT: String(server.address().port)};
  try {
    const prepared = await invoke(CLI, ['agent', 'prepare'], env);
    assert.equal(prepared.code, 0, prepared.stderr);
    const directory = JSON.parse(prepared.stdout).directory;
    env.COFLUX_AGENT_BUNDLE = directory;
    const binary = join(directory, 'coflux');
    const hook = (event, extra = {}) => invoke(binary, ['agent', 'hook', 'codex'], env, JSON.stringify({hook_event_name: event, cwd: home, ...extra}));
    for (const source of ['startup', 'resume', 'compact']) {
      workspace = `workspace-${source}`;
      const result = await hook('SessionStart', {source});
      assert.equal(result.code, 0);
      assert.equal(result.stdout.match(/<coflux-session>/g)?.length, 1);
      assert.ok(result.stdout.includes(workspace));
      assert.ok(!result.stdout.includes('Workspace: stale'));
    }
    const status = JSON.parse((await invoke(binary, ['agent', 'status'], env)).stdout).runs;
    assert.equal(status.length, 1);
    assert.equal(status[0].integration, directory);
    assert.equal((await hook('UserPromptSubmit')).stdout, '', 'unchanged context is not injected repeatedly');
    unavailable = true;
    assert.ok((await hook('SessionStart')).stdout.includes('unavailable'));
    unavailable = false;
    workspace = 'workspace-recovered';
    assert.ok((await hook('UserPromptSubmit')).stdout.includes(workspace));
    assert.equal((await hook('UserPromptSubmit')).stdout, '');
    await invoke(binary, ['agent', 'hook', 'claude'], env, JSON.stringify({hook_event_name:'WorktreeRemove',worktree_path:'/deleted/worktree'}));
    assert.ok(actions.some(a => a.action === 'workspace.forget' && a.path === '/deleted/worktree'));
    const guard = await invoke(binary, ['agent', 'hook', 'claude'], env, JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'git -C /repo worktree remove feature'}}));
    assert.equal(JSON.parse(guard.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const hooks = join(directory, 'hooks/hooks.json');
    const original = readFileSync(hooks, 'utf8');
    writeFileSync(hooks, '{}');
    assert.notEqual((await invoke(CLI, ['agent', 'prepare'], env)).code, 0);
    writeFileSync(hooks, original);
    assert.equal((await invoke(CLI, ['agent', 'prepare'], env)).code, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, {recursive:true, force:true});
  }
});

test('explicit Codex workspace selection survives tools, compaction and resume without following temporary cwd', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'coflux-enter-')));
  const main = join(home, 'main'), child = join(home, 'child with spaces'), foreign = join(home, 'foreign');
  for (const path of [main, child, foreign]) mkdirSync(path);
  const ids = new Map([[main, 'main-id'], [child, 'child-id']]);
  let owner = 'main-id', offline = false;
  const actions = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    let response = {ok: true};
    if (req.url === '/agent') {
      actions.push(body);
      const path = body.action === 'workspace.locate' ? body.path : body.cwd;
      if (offline || !ids.has(path)) {
        response = {ok: false, error: offline ? 'offline' : 'different repository'};
      } else {
        if (body.action === 'workspace.locate') owner = ids.get(path);
        response = {ok: true, workspaceId: ids.get(path), path, owningWorkspaceId: owner, moved: false};
      }
    }
    const encoded = JSON.stringify(response);
    res.writeHead(response.ok ? 200 : 409, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded)});
    res.end(encoded);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = {HOME: home, COFLUX_HOME: home, PATH: '', COFLUX_DEVICE_ID: 'device',
    COFLUX_SESSION_ID: 'terminal-one', COFLUX_PROJECT_ID: 'project', COFLUX_AGENT_RUN: `${process.pid}-456`,
    COFLUX_LOCAL_GATEWAY_PORT: String(server.address().port)};
  const hook = (event, extra = {}) => invoke(CLI, ['agent', 'hook', 'codex'], env,
    JSON.stringify({hook_event_name: event, session_id: 'conversation-one', cwd: main, ...extra}));
  const enter = path => invoke(CLI, ['workspace', 'enter', path], env);
  try {
    assert.match((await hook('SessionStart', {source: 'startup'})).stdout, /Workspace: main-id/);
    const selected = await enter(child);
    assert.equal(selected.code, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout).path, child);
    assert.equal(JSON.parse(selected.stdout).resumeSupported, true);
    assert.equal(JSON.parse(selected.stdout).hostCwdChanged, false);
    assert.match(JSON.parse(selected.stdout).instruction, /workdir\/cwd.*absolute paths.*AGENTS.md/);
    assert.equal(owner, 'child-id');
    const next = await hook('PostToolUse', {tool_name: 'Bash', tool_input: {command: 'coflux workspace enter'}});
    assert.match(JSON.parse(next.stdout).hookSpecificOutput.additionalContext, /Workspace: child-id/);
    assert.ok(next.stdout.includes('Selected working directory:'));
    assert.equal(actions.at(-1).cwd, child, 'hook queries the selected path, not its process cwd');
    const beforeTemporary = actions.length;
    assert.equal((await hook('PostToolUse', {tool_name: 'Bash', cwd: foreign,
      tool_input: {command: 'pwd', workdir: foreign}})).stdout, '');
    assert.equal((await hook('UserPromptSubmit')).stdout, '');
    assert.ok(actions.slice(beforeTemporary).every(a => a.action === 'workspace.current'));
    assert.equal(owner, 'child-id', 'temporary commands do not migrate the terminal');
    assert.match((await hook('SessionStart', {source: 'compact'})).stdout, /Workspace: child-id/);
    assert.equal(actions.at(-1).path, child, 'compaction must not locate the original cwd');

    env.COFLUX_AGENT_RUN = `${process.pid}-789`;
    env.COFLUX_SESSION_ID = 'terminal-two';
    owner = 'main-id';
    assert.match((await hook('SessionStart', {source: 'resume'})).stdout, /Workspace: child-id/);
    assert.equal(owner, 'child-id', 'resume reattaches the new terminal');
    assert.match((await hook('SessionStart', {source: 'startup', session_id: 'conversation-two'})).stdout, /Workspace: main-id/);
    assert.equal(owner, 'main-id', 'a different conversation does not inherit the selection');
    await hook('SessionStart', {source: 'resume'});

    const failed = await enter(foreign);
    assert.notEqual(failed.code, 0);
    assert.equal(owner, 'child-id');
    assert.match((await hook('SessionStart', {source: 'compact'})).stdout, /Workspace: child-id/);
    const beforeOffline = actions.length;
    offline = true;
    assert.match((await hook('SessionStart', {source: 'compact'})).stdout, /Cannot verify.*offline/);
    assert.ok(actions.slice(beforeOffline).every(a => a.path === child), 'no fallback to original cwd while offline');
    offline = false;
    assert.match((await hook('UserPromptSubmit')).stdout, /Workspace: child-id/);

    rmSync(child, {recursive: true});
    const beforeMissing = actions.length;
    assert.match((await hook('SessionStart', {source: 'compact'})).stdout, /Selected directory is missing/);
    assert.equal(actions.length, beforeMissing, 'missing selection cannot silently relocate to the original cwd');
    assert.equal((await enter(main)).code, 0);
    assert.match((await hook('PostToolUse', {tool_name: 'Bash'})).stdout, /Workspace: main-id/);
    assert.match((await hook('SessionStart', {source: 'compact'})).stdout, /Workspace: main-id/);
    const prepared = await invoke(CLI, ['agent', 'prepare'], env);
    env.COFLUX_AGENT_BUNDLE = JSON.parse(prepared.stdout).directory;
    const npmEntry = await invoke(process.execPath,
      [resolve(import.meta.dirname, '../../packages/cli/coflux.mjs'), 'workspace', 'enter', main], env);
    assert.equal(npmEntry.code, 0, npmEntry.stderr);
    assert.equal(JSON.parse(npmEntry.stdout).resumeSupported, true, 'npm uses the pinned native conversation state');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(home, {recursive: true, force: true});
  }
});
