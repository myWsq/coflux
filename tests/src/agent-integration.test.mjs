import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
