import { Terminal } from "@xterm/xterm";
import "@xterm-css";
const status = document.querySelector("#status");
const result = document.querySelector("#result");
const button = document.querySelector("#run");
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function sample(visible) {
  const terminals = Array.from({length:8}, () => new Terminal({cols:142, rows:34, scrollback:10000,fontFamily:"Menlo",fontSize:12,lineHeight:1.25}));
  const container = document.querySelector("#terminal");
  container.style.display=visible?"block":"none";
  if(visible) {
    terminals[0].open(container);
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
  }
  let previous = performance.now(), beats = 0, largestGapMS = 0;
  const timer = setInterval(() => {
    const now = performance.now(); largestGapMS = Math.max(largestGapMS, now-previous);
    previous = now; beats++;
  }, 2);
  try {
    const start = performance.now();
    let totalBytes = 0;
    await Promise.all(terminals.map(async (terminal,index) => {
      const line = "\x1b[32m终端 " + index + " 中文😀\x1b[0m abcdefghijklmnopqrstuvwxyz\r\n";
      const payload = new TextEncoder().encode(line.repeat(5000) + "COMPLETE-" + index + "\r\n");
      totalBytes += payload.byteLength;
      // 与生产 consumer 一样调用公开 write；固定 4KiB 到达块，最后回调为解析完成。
      await new Promise(resolve => {
        for (let offset=0; offset<payload.length; offset+=4096) {
          const end = Math.min(offset+4096,payload.length);
          terminal.write(payload.subarray(offset,end),end===payload.length?resolve:undefined);
        }
      });
    }));
    const elapsedMS = performance.now()-start;
    const finalBeat = beats;
    while(beats===finalBeat) await delay(1);
    clearInterval(timer);
    for(const [index, terminal] of terminals.entries()) {
      const buffer = terminal.buffer.active;
      let text = "";
      for(let row=0;row<buffer.length;row++) text += buffer.getLine(row)?.translateToString(true)+"\n";
      for(let other=0;other<8;other++) {
        if(text.includes("COMPLETE-"+other)!==(other===index)) throw Error("终端输出丢失或串流");
      }
    }
    return {elapsedMS,largestGapMS,beats,totalBytes};
  } finally {clearInterval(timer); terminals.forEach(t=>t.dispose()); container.replaceChildren();}
}
button.onclick = async () => {
  button.disabled=true;
  const samples=[];
  const visible=document.querySelector("#visible").checked;
  document.querySelector("#visible").disabled=true;
  try {
    for(let index=0;index<6;index++) {
      status.textContent = index===0?"预热中":"采样 "+index+"/5";
      samples.push(await sample(visible)); await delay(100);
    }
    result.textContent=JSON.stringify({engine:"xterm 6.0.0",visible,grid:[142,34],chunkBytes:4096,warmup:samples[0],samples:samples.slice(1)},null,2);
    status.textContent="完成：全部输出标记与流隔离检查通过";
  } catch(error){status.textContent="失败："+error.message;} finally{button.disabled=false;document.querySelector("#visible").disabled=false;}
};
