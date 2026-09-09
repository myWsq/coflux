// 离线诊断入口：挂载真实 Workbench，不进入原生 App 或 Web 发布入口。
import { measureInput } from './input-roundtrip';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { LayerProvider } from '@astryxdesign/core/Layer';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { Terminal } from '@xterm/xterm';
import { createCofluxClient } from '@coflux/client';
import { TaskStatus, type Task } from '@coflux/protocol';
import { Workbench } from '@/components/workbench/workbench';
import './workbench.css';
import '@/components/workbench/workspace-terminal';
import '@xterm/addon-webgl';

if (location.hostname !== '127.0.0.1' || location.port !== '15278') throw new Error('仅允许专用本机基准端口');
const style = document.createElement('style');
style.textContent = '#surface {width:1280px;height:684px} #surface .h-screen {height:684px!important} #controls{height:36px;background:#262626;color:white} #run,#measure{padding:4px 12px;background:#eee;color:#111} #result{white-space:pre-wrap;color:white;background:#111}';
document.head.append(style);
const root = createRoot(document.getElementById('surface')!);
const status = document.getElementById('status')!;
const result = document.getElementById('result')!;
const button = document.getElementById('run') as HTMLButtonElement;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
async function wait(label: string, condition: () => unknown, timeout = 20000) {
  const deadline = performance.now() + timeout;
  while (!condition()) { if (performance.now() > deadline) throw new Error(label); await sleep(10); }
}
const instances = new Set<Terminal>();
const originalOpen = Terminal.prototype.open;
Terminal.prototype.open = function (...args) { originalOpen.apply(this, args); instances.add(this); };
function focusedTerminal() { return [...instances].find(t => t.element?.contains(document.activeElement) && t.element.closest('[aria-hidden]')?.getAttribute('aria-hidden') === 'false'); }
function viewport(t: Terminal) {
  const b = t.buffer.active;
  return Array.from({length:t.rows}, (_, i) => b.getLine(b.viewportY+i)?.translateToString(true) ?? '').join('\n');
}
function tab(title: string) {
  const span = [...document.querySelectorAll('#surface button span')].find(e => e.textContent === title);
  const target = span?.closest('button');
  assert(target, '找不到终端标签：' + title); return target;
}
function base64(value: string) { return btoa(String.fromCharCode(...new TextEncoder().encode(value))); }
button.onclick = async () => {
  button.disabled = true; result.textContent = '';
  const inputMode = (document.getElementById('mode') as HTMLSelectElement).value;
  const isInput = inputMode !== 'switch';
  const tokenKey = 'coflux-benchmark-' + crypto.randomUUID();
  localStorage.removeItem('coflux_workspace');
  const client = createCofluxClient({serverUrl: `ws://${location.host}/client`, tokenStorageKey: tokenKey, buildId:'dev',
    deviceTransport:{enableLocalTransport:false, identityDatabaseName:'coflux-workbench-benchmark', origin:location.origin}});
  root.render(<Theme theme={neutralTheme} mode="dark"><LayerProvider><Workbench client={client}/></LayerProvider></Theme>);
  const prefix = 'switch-benchmark-' + crypto.randomUUID();
  const pendingKey = 'coflux-benchmark-pending-prefixes';
  const previousPrefixes: string[] = JSON.parse(localStorage.getItem(pendingKey) ?? '[]');
  localStorage.setItem(pendingKey, JSON.stringify([...previousPrefixes, prefix]));
  const tasks: Task[] = [], terminals: Terminal[] = [];
  const python = (script: string, session: string) => client.sendInput(session, `python3 -u -c "import base64;exec(base64.b64decode('${base64(script)}'))"\r`);
  try {
    if (isInput) assert(innerWidth === 1280 && innerHeight === 720, '输入对照要求浏览器视口1280×720，请调整视口后重试');
    status.textContent = '登录隔离环境…';
    await client.login('admin','admin');
    await wait('登录失败', () => client.store.getState().snapshotRevision > 0);
    for(const task of client.store.getState().tasks.filter(t=>previousPrefixes.some(p=>t.title.startsWith(p))))await client.closeTask(task);
    await wait('上次测试终端清理失败',()=>!client.store.getState().tasks.some(t=>previousPrefixes.some(p=>t.title.startsWith(p))));
    localStorage.setItem(pendingKey,JSON.stringify([prefix]));
    const workspace = client.store.getState().workspaces.find(w => w.isMain);
    assert(workspace, '缺少主工作区');
    // 固定40标签（32个背景标签+8个采样PTY），不依赖旧fixture残留数量。
    const existingTabs = client.store.getState().tasks.filter(t=>t.workspaceId===workspace.id).length;
    assert(existingTabs<=32, '隔离工作区已有超过32个标签，请使用干净fixture');
    for(let i=existingTabs;!isInput && i<32;i++) {
      const title=`${prefix}-padding-${i}`;
      client.send({case:'taskCreate',value:{workspaceId:workspace.id,title}});
      await wait('创建固定标签负载失败',()=>client.store.getState().tasks.some(t=>t.title===title));
    }
    for (let i=0;i<(isInput ? 1 : 8);i++) {
      status.textContent = `准备终端 ${i+1}/${isInput ? 1 : 8}`;
      const title = `${prefix}-${i}`;
      client.send({case:'taskCreate',value:{workspaceId:workspace.id,title}});
      await wait('创建终端失败', () => client.store.getState().tasks.some(t=>t.title===title));
      await wait('标签尚未挂载', () => [...document.querySelectorAll('#surface button span')].some(e=>e.textContent===title));
      tab(title).click();
      await wait('终端未运行', () => client.store.getState().tasks.some(t=>t.title===title && t.status===TaskStatus.RUNNING && t.sessionId));
      const task = client.store.getState().tasks.find(t=>t.title===title)!;
      await wait('焦点未进入新终端', () => focusedTerminal() && !terminals.includes(focusedTerminal()!));
      const terminal = focusedTerminal()!;
      tasks.push(task); terminals.push(terminal);
      // 控制权就绪后再写入；避免准备命令在 attach 中被门控丢弃。
      await wait('等待标签控制权', () => !tab(title).querySelector('.animate-spin'));
      if (!isInput) { python(`print('\\033[2J\\033[H',end=''); print(('历史 ${i} 中文😀 abcdefghijklmnopqrstuvwxyz\\n')*5000); print('READY_${i}_END')`, task.sessionId!);
      await wait('预填历史失败', () => viewport(terminal).includes(`READY_${i}_END`)); }
    }
    if (isInput) {
      status.textContent = '测量真实 PTY 输入往返…';
      const terminal = terminals[0]!;
      const shellReady = crypto.randomUUID();
      client.sendInput(tasks[0]!.sessionId!, `\x03printf '\\033[2J\\033[H%s:%s\\n' coflux ${shellReady}\r`);
      await wait('真实 shell 尚未就绪', () => viewport(terminal).includes('coflux:' + shellReady));
      const phase = await measureInput(terminal, inputMode === 'loaded', data => client.sendInput(tasks[0]!.sessionId!, data), () => viewport(terminal));
      const report = {kind: 'input-roundtrip', terminalCount: 1, phases: [phase], windowWidth: 1280, windowHeight: 684,
        viewportWidth: innerWidth, viewportHeight: innerHeight, devicePixelRatio, documentVisible: document.visibilityState, buildKind: 'production static'};
      const response = await fetch('/__benchmark/report', {method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(report)});
      assert(response.ok, '保存输入结果失败');
      result.textContent = JSON.stringify(report, null, 2); status.textContent = '输入测量通过。';
      return;
    }
    assert(client.store.getState().tasks.filter(t=>t.workspaceId===workspace.id).length===40,'两端性能对照必须固定40标签');
    status.textContent = '40标签与8个采样终端准备完成，请核对工作台布局后开始采样。';
    const gate = document.getElementById('measure') as HTMLButtonElement; gate.hidden = false;
    await new Promise<void>(resolve => { gate.onclick = () => { gate.hidden=true; resolve(); }; });
    const phases: object[] = [];
    async function sample(loaded: boolean) {
      status.textContent = loaded ? '测量8路持续输出切换…' : '测量空闲切换…';
      const samples: number[] = [];
      const start = performance.now(); let previous = start, gap=0;
      const timer = setInterval(() => { const now=performance.now(); gap=Math.max(gap,now-previous);previous=now; },2);
      try {
        for(let i=0;i<65;i++) {
          const index=i%8; const target=tab(tasks[index]!.title); const t=performance.now(); target.click();
          const deadline=t+5000;
          while(focusedTerminal()!==terminals[index]) { assert(performance.now()<deadline,'切换焦点超时');await sleep(1); }
          if(i>=5)samples.push(performance.now()-t);
          assert(terminals.every(t=>t.element?.isConnected),'切换重建或移除了终端');
          assert(terminals.filter(t=>t.element?.closest('[aria-hidden]')?.getAttribute('aria-hidden')==='false').length===1,'可见终端不唯一');
          await sleep(20);
        }
      } finally {clearInterval(timer);}
      const sorted=[...samples].sort((a,b)=>a-b);
      phases.push({loaded,samplesMS:samples,medianMS:(sorted[29]!+sorted[30]!)/2,p95MS:sorted[56],largestHeartbeatGapMS:gap,wallMS:performance.now()-start});
    }
    await sample(false);
    for(let i=0;i<8;i++) {
      status.textContent=`准备输出程序 ${i+1}/8`;
      python(`import time,sys\nprint('LOAD_READY_${i}',flush=True)\nsys.stdin.readline()\nend=time.monotonic()+20\nn=0\nwhile time.monotonic()<end:\n print(('LOAD_${i}_%d_END 中文😀 abcdefghijklmnopqrstuvwxyz\\n' % n)*16,end='',flush=True)\n n+=1\n time.sleep(.005)`,tasks[i]!.sessionId!);
      await wait('输出程序未就绪 '+i,()=>viewport(terminals[i]!).includes(`LOAD_READY_${i}`));
    }
    for(const task of tasks)client.sendInput(task.sessionId!,'go\r');
    for(let i=0;i<8;i++)await wait('后台输出未开始',()=>viewport(terminals[i]!).includes(`LOAD_${i}_`));
    const counter=(i:number)=>Math.max(-1,...[...viewport(terminals[i]!).matchAll(new RegExp(`LOAD_${i}_(\\d+)_END`,'g'))].map(m=>Number(m[1])));
    const before=terminals.map((_,i)=>counter(i));await sample(true);const after=terminals.map((_,i)=>counter(i));
    for(let i=0;i<8;i++) {assert(after[i]!>before[i]!,'后台输出未持续');for(let j=0;j<8;j++)if(i!==j)assert(!viewport(terminals[i]!).includes(`LOAD_${j}_`),'终端串流');}
    const report={terminalCount:8,mountedTerminalCount:[...instances].filter(t=>t.element?.isConnected).length,workspaceTabCount:client.store.getState().tasks.filter(t=>t.workspaceId===workspace.id).length,
      windowWidth:1280,windowHeight:684,viewportWidth:innerWidth,viewportHeight:innerHeight,devicePixelRatio,documentVisible:document.visibilityState,
      grids:terminals.map(t=>({cols:t.cols,rows:t.rows})),historyLinesPerTerminal:5000,phases,loadCountersBefore:before,loadCountersAfter:after,
      layout:{surface:document.querySelector('#surface')!.getBoundingClientRect().toJSON(),workbench:document.querySelector('#surface .h-screen')!.getBoundingClientRect().toJSON(),terminal:terminals[0]!.element!.getBoundingClientRect().toJSON()},
      loadPreparation:'所有程序就绪后统一发送go，避免准备阶段输出淹没后续启动输入',buildKind:'production static',
      scope:'真实Workbench；标签button.click到目标xterm textarea取得焦点；1ms轮询，非GPU呈现；无浏览器CPU/内存对照'};
    await fetch('/__benchmark/report',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(report)}).then(r=>{if(!r.ok)throw new Error('保存结果失败');return r.text();});
    result.textContent=JSON.stringify(report,null,2);status.textContent='测量通过，正在清理本轮测试终端和占位标签…';
  } catch(error) {result.textContent=JSON.stringify({error:String(error),stage:status.textContent,terminals:terminals.map(t=>({cols:t.cols,rows:t.rows,baseY:t.buffer.active.baseY,viewportY:t.buffer.active.viewportY,viewport:viewport(t).slice(-900),tail:Array.from({length:8},(_,i)=>t.buffer.active.getLine(Math.max(0,t.buffer.active.length-8)+i)?.translateToString(true)).join('\n')}))},null,2);status.textContent='测量失败，清理中…';}
  finally {
    const ownedPrefixes=[...previousPrefixes,prefix];
    for(const task of client.store.getState().tasks.filter(t=>ownedPrefixes.some(p=>t.title.startsWith(p))))await client.closeTask(task);
    try {await wait('测试终端清理超时',()=>!client.store.getState().tasks.some(t=>ownedPrefixes.some(p=>t.title.startsWith(p))));status.textContent += ' 清理完成。';localStorage.removeItem(pendingKey);}
    catch(error){result.textContent+='\n'+String(error);}
    client.logout();client.disconnect();root.render(null);instances.clear();localStorage.removeItem(tokenKey);button.disabled=false;
  }
};
