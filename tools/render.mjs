// ============================================================================
// 无头批量渲染 —— 用本机已安装的 Chrome / Edge，通过 CDP 逐帧抓图。
// 零 npm 依赖：静态服务器用 node:http，CDP 客户端用 Node 内置 WebSocket。
//
// 用法示例：
//   node tools/render.mjs --scene presets/demo-scene.json --out .out/demo --fps 24
//   node tools/render.mjs --template hud-frame --duration 3 --out .out/hud --width 1920 --height 1080
//   node tools/render.mjs --scene x.json --out .out/x --range 0 2.5 --include-media
//
// 参数：
//   --scene <file>      scene JSON（见 presets/）
//   --template <id>     快速模式：只用这一个模板铺满整段时间
//   --duration <sec>    快速模式时长（默认 3）
//   --width/--height    分辨率（默认 1920x1080）
//   --fps <n>           帧率（默认 24）
//   --range <a> <b>     只渲染 [a,b] 秒
//   --out <dir>         输出目录（默认 .out/frames）
//   --bg <hex>          不透明底色（默认透明）
//   --include-media     把载入的素材一起渲染（默认只渲染叠加层）
//   --browser <path>    指定浏览器可执行文件
//   --keep              保留浏览器进程（调试用）
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function argNum(name, def) { const v = arg(name); return v === null ? def : Number(v); }
const hasFlag = (n) => argv.includes('--' + n);

const OPT = {
  scene: arg('scene'),
  template: arg('template'),
  duration: argNum('duration', 3),
  width: argNum('width', 1920),
  height: argNum('height', 1080),
  fps: argNum('fps', 24),
  out: arg('out', path.join(ROOT, '.out', 'frames')),
  bg: arg('bg'),
  includeMedia: hasFlag('include-media'),
  media: arg('media'),
  page: arg('page'),
  browser: arg('browser'),
  keep: hasFlag('keep'),
};
const rangeIdx = argv.indexOf('--range');
const RANGE = rangeIdx >= 0 ? [Number(argv[rangeIdx + 1]), Number(argv[rangeIdx + 2])] : null;

// ---------------------------------------------------------------- 静态服务器
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/studio/index.html';
      const file = path.join(ROOT, p);
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        fs.createReadStream(file).pipe(res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------- 找浏览器
function findBrowser(explicit) {
  const cands = [
    explicit,
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error('找不到 Chrome/Edge，请用 --browser 指定路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 30000, interval = 120, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + what);
    await sleep(interval);
  }
}

// ---------------------------------------------------------------- CDP 客户端
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        const arr = this.events.get(msg.method);
        if (arr) arr.forEach((f) => f(msg.params));
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, fn) {
    if (!this.events.has(method)) this.events.set(method, []);
    this.events.get(method).push(fn);
  }
  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => resolve(new CDP(ws)));
      ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败')));
    });
  }
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const { server, port: sport } = await startServer();
  const dport = 9222 + Math.floor(Math.random() * 900);
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'motionkit-profile-'));
  const exe = findBrowser(OPT.browser);
  // --page 可以直接跑打包好的单文件版（dist/studio.html），无需服务器
  const pageUrl = OPT.page
    ? 'file:///' + path.resolve(ROOT, OPT.page).replace(/\\/g, '/') + '?render=1'
    : `http://127.0.0.1:${sport}/studio/index.html?render=1`;

  console.log(`浏览器: ${exe}`);
  console.log(`静态服务: http://127.0.0.1:${sport}`);

  const child = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${dport}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--mute-audio', '--window-size=' + OPT.width + ',' + OPT.height,
    '--allow-file-access-from-files',
    pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  let cdp;
  try {
    const target = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${dport}/json/list`);
      const list = await res.json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, { timeout: 40000, what: '浏览器 DevTools 端口' });

    cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    // 页面错误直接抛出来，别静默失败
    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const txt = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error' && txt) pageErrors.push(txt);
    });

    // 等待工作室就绪
    await waitFor(async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: 'typeof window.MotionKit !== "undefined"', returnByValue: true });
      return r.result.value === true;
    }, { timeout: 40000, what: 'MotionKit 初始化' });

    // 组装场景
    let sceneJson = null;
    if (OPT.scene) {
      sceneJson = JSON.parse(fs.readFileSync(path.resolve(ROOT, OPT.scene), 'utf8'));
    } else if (OPT.template) {
      sceneJson = {
        name: 'quick', width: OPT.width, height: OPT.height, fps: OPT.fps, duration: OPT.duration,
        bg: OPT.bg || null, transparent: !OPT.bg,
        beat: { bpm: 120, offset: 0 },
        layers: [{ template: OPT.template, start: 0, end: OPT.duration, params: {}, seed: 'quick', name: OPT.template }],
        captions: [], fx: [],
      };
    } else {
      sceneJson = {
        name: 'demo', width: OPT.width, height: OPT.height, fps: OPT.fps, duration: OPT.duration,
        bg: OPT.bg || null, transparent: !OPT.bg,
        beat: { bpm: 120, offset: 0 },
        layers: [
          { template: 'hud-frame', start: 0, end: OPT.duration, params: {}, seed: 'hud' },
          { template: 'kinetic-type', start: 0.2, end: OPT.duration - 0.2, params: { beatsPerStep: 2 }, seed: 'kt' },
        ],
        captions: [], fx: [{ type: 'grain', amount: 0.08 }],
      };
    }
    if (OPT.bg) sceneJson.bg = OPT.bg;
    // 命令行显式给的分辨率 / 帧率 / 时长覆盖工程里的值
    if (argv.includes('--width')) sceneJson.width = OPT.width;
    if (argv.includes('--height')) sceneJson.height = OPT.height;
    if (argv.includes('--fps')) sceneJson.fps = OPT.fps;
    if (argv.includes('--duration')) sceneJson.duration = OPT.duration;

    // 可选底图：把一张图当素材铺在下面，方便核对叠加层与转场
    const mediaFile = OPT.media || sceneJson.media || null;
    let mediaExpr = 'null';
    if (mediaFile) {
      const abs = path.resolve(ROOT, mediaFile);
      const b64 = fs.readFileSync(abs).toString('base64');
      const mime = /\.png$/i.test(abs) ? 'image/png' : /\.webp$/i.test(abs) ? 'image/webp' : 'image/jpeg';
      mediaExpr = 'window.__mkMedia';
      await cdp.send('Runtime.evaluate', {
        expression: `(async()=>{const img=new Image();img.src='data:${mime};base64,${b64}';await img.decode();window.__mkMedia=img;return true;})()`,
        returnByValue: true, awaitPromise: true,
      });
      sceneJson.bg = null;
      console.log('底图:', path.basename(abs));
    }

    await cdp.send('Runtime.evaluate', {
      expression: `window.MotionKit.setScene(${JSON.stringify(sceneJson)});window.MotionKit.state.media.video=${mediaExpr};window.MotionKit.blit();true`,
      returnByValue: true, awaitPromise: true,
    });

    // 渲染
    const s = sceneJson;
    const fps = s.fps || OPT.fps;
    const dur = s.duration || OPT.duration;
    const from = RANGE ? RANGE[0] : 0;
    const to = RANGE ? RANGE[1] : dur;
    const first = Math.round(from * fps);
    const last = Math.min(Math.round(dur * fps) - 1, Math.round(to * fps) - 1);
    const count = last - first + 1;
    const outDir = path.resolve(ROOT, OPT.out);
    await fsp.mkdir(outDir, { recursive: true });
    const pad = String(Math.max(last, 1)).length;

    console.log(`渲染 ${count} 帧  ${s.width}x${s.height} @${fps}fps  ->  ${outDir}`);
    const t0 = Date.now();
    for (let i = first; i <= last; i++) {
      const t = i / fps;
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(async()=>{const t=${t};const c=window.MotionKit.renderAt(t);
          const blob=await (c.convertToBlob?c.convertToBlob({type:'image/png'}):new Promise(r=>c.toBlob(r,'image/png')));
          const buf=new Uint8Array(await blob.arrayBuffer());
          let s='';const CH=0x8000;
          for(let k=0;k<buf.length;k+=CH){s+=String.fromCharCode.apply(null,buf.subarray(k,k+CH));}
          return btoa(s);})()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error('页面渲染报错: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
      const b64 = r.result.value;
      const bytes = Buffer.from(b64, 'base64');
      const name = `frame_${String(i).padStart(pad, '0')}.png`;
      await fsp.writeFile(path.join(outDir, name), bytes);
      if (i === first || (i - first) % Math.max(1, Math.round(count / 20)) === 0 || i === last) {
        const pct = ((i - first + 1) / count) * 100;
        process.stdout.write(`  ${pct.toFixed(0).padStart(3)}%  ${name}  ${(bytes.length / 1024).toFixed(0)} KB\r`);
      }
    }
    const secs = (Date.now() - t0) / 1000;
    process.stdout.write('\n');
    console.log(`完成：${count} 帧，用时 ${secs.toFixed(1)}s（${(count / secs).toFixed(1)} 帧/秒）`);

    if (pageErrors.length) {
      console.log('\n页面里出现过这些报错（可能是模板参数问题）：');
      [...new Set(pageErrors)].slice(0, 10).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));
    }
  } finally {
    try { cdp?.ws?.close(); } catch (_) {}
    if (!OPT.keep) child.kill();
    server.close();
    await sleep(150);
    try { await fsp.rm(profile, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((e) => { console.error('\n渲染失败：' + e.message); process.exit(1); });
