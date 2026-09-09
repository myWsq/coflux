import { createRequire } from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mergeConfig, defineConfig } from '../../web/node_modules/vite/dist/node/index.js';
import webConfig from '../../web/vite.config';
const require = createRequire(new URL('../../web/package.json', import.meta.url));
// 独立fixture端口可变，但基准代理始终只连接本机。
const fixturePort = process.env.COFLUX_BENCHMARK_SERVER_PORT ?? '19873';
if (!/^\d+$/.test(fixturePort) || Number(fixturePort) < 1 || Number(fixturePort) > 65535) {
  throw new Error('COFLUX_BENCHMARK_SERVER_PORT 必须是有效的本机端口');
}
export default defineConfig((env) => mergeConfig(webConfig(env), {
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [{name:'benchmark-report',configurePreviewServer(server) {server.middlewares.use('/__benchmark/report',(req,res)=>{
    if(req.method!=='POST') {res.statusCode=405;res.end();return;}
    req.setEncoding('utf8');let body='';req.on('data',chunk=>{body+=chunk;if(body.length>1000000)req.destroy();});req.on('end',()=>{try {
      const data=JSON.parse(body);if(!(data.terminalCount===8 && data.phases?.length===2) && !(data.kind==='input-roundtrip' && data.terminalCount===1 && data.phases?.length===1 && data.phases[0].samplesMS?.length===30))throw new Error('invalid report');
      const dir=fileURLToPath(new URL('../../../.coflux-dev/web-workbench-results',import.meta.url));mkdirSync(dir,{recursive:true});
      const name=randomUUID()+'.json';writeFileSync(dir+'/'+name,JSON.stringify(data,null,2));res.end(name);
    }catch {res.statusCode=400;res.end('invalid report');}});
  });}}],
  resolve: { alias: [{ find: /^(react(?:-dom)?|@xterm\/[^/]+|@coflux\/(?:client|protocol)|@astryxdesign\/(?:core|theme-neutral))(?:\/.*)?$/, replacement: '$&', customResolver: (id: string) => require.resolve(id) }] },
  optimizeDeps: { entries: ['workbench.html'] },
  build: { outDir: fileURLToPath(new URL('../../../.coflux-dev/web-workbench-benchmark', import.meta.url)), emptyOutDir: true, rollupOptions: { input: fileURLToPath(new URL('./workbench.html', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 15278, strictPort: true },
  preview: { host: '127.0.0.1', port: 15278, strictPort: true, proxy: { '/client': { target: `http://127.0.0.1:${fixturePort}`, ws: true, changeOrigin: true } } },
}));
