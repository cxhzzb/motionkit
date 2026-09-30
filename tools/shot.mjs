// 工作室界面截图：无头 Chrome 打开界面，可选地跑一段脚本来驱动真实交互，然后整页截图。
//
// 用法：
//   node tools/shot.mjs --out .out/ui.png
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" --out .out/ui.png
//   node tools/shot.mjs --js-file .out/drive.js --out .out/after.png --wait 800
//
// 参数：
//   --url <相对路径>   默认 studio/index.html
//   --out <file>       输出 PNG，默认 .out/ui.png
//   --w / --h          视口尺寸，默认 1340x900
//   --js <代码>        页面就绪后执行的一段代码
//   --js-file <file>   同上，从文件读（脚本长了用这个）
//   --reload           跑完脚本后刷新页面，再跑 --js-file2（用来验证"刷新后状态还在"）
//   --js2 / --js-file2 刷新之后执行的脚本
//   --wait <ms>        截图前额外等待，默认 600
//   --browser <path>   指定浏览器

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const OPT = {
  url: arg('url', 'studio/index.html'),
  out: arg('out', path.join(ROOT, '.out', 'ui.png')),
  w: Number(arg('w', 1340)),
  h: Number(arg('h', 900)),
  js: arg('js'),
  jsFile: arg('js-file'),
  js2: arg('js2'),
  jsFile2: arg('js-file2'),
  reload: argv.includes('--reload'),
  wait: Number(arg('wait', 600)),
  browser: arg('browser'),
};

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

function findBrowser(explicit) {
  const cands = [
    explicit, process.env.CHROME_PATH,
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
async function waitFor(fn, { timeout = 40000, interval = 120, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + what);
    await sleep(interval);
  }
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = new Map();
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
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
    });
  }
}

async function main() {
  const { server, port: sport } = await startServer();
  const dport = 9222 + Math.floor(Math.random() * 900);
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'motionkit-shot-'));
  const exe = findBrowser(OPT.browser);
  const asFile = /^(file:|dist\/)/.test(OPT.url) || path.isAbsolute(OPT.url);
  const pageUrl = asFile
    ? 'file:///' + path.resolve(ROOT, OPT.url.replace(/^file:\/\/\//, '')).replace(/\\/g, '/')
    : (/^https?:\/\//i.test(OPT.url)
      ? OPT.url                                    // 直接给完整地址（比如正在跑的开发服务器）
      : 'http://127.0.0.1:' + sport + '/' + OPT.url.replace(/^\//, ''));

  console.log('浏览器:', exe);
  console.log('页面:', pageUrl);

  const child = spawn(exe, [
    '--headless=new', '--remote-debugging-port=' + dport, '--user-data-dir=' + profile,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--mute-audio', '--window-size=' + OPT.w + ',' + OPT.h,
    '--allow-file-access-from-files', pageUrl,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  try {
    const target = await waitFor(async () => {
      const res = await fetch('http://127.0.0.1:' + dport + '/json/list');
      const list = await res.json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    }, { what: '浏览器 DevTools 端口' });

    const cdp = await CDP.connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'unknown');
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const txt = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (p.type === 'error' && txt) pageErrors.push(txt);
    });

    const waitReady = () => waitFor(async () => {
      const r = await cdp.send('Runtime.evaluate', { expression: 'typeof window.MotionKit !== "undefined"', returnByValue: true });
      return r.result.value === true;
    }, { what: 'MotionKit 初始化' });

    // 脚本可以 return 一个对象，也可以挂到 window.__mkReport 上（后者能过 node --check）
    const runScript = async (js) => {
      if (!js) return;
      await cdp.send('Runtime.evaluate', { expression: 'window.__mkReport = undefined; true', returnByValue: true });
      const r = await cdp.send('Runtime.evaluate', {
        expression: '(async()=>{ ' + js + ' })()',
        returnByValue: true, awaitPromise: true, userGesture: true,
      });
      if (r.exceptionDetails) {
        throw new Error('驱动脚本出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      }
      let val = r.result.value;
      if (val === undefined || val === null) {
        const r2 = await cdp.send('Runtime.evaluate', { expression: 'window.__mkReport ?? null', returnByValue: true });
        val = r2.result.value;
      }
      if (val !== undefined && val !== null) console.log('脚本结果:', JSON.stringify(val));
    };
    const readScript = (inline, file) => (file ? fs.readFileSync(path.resolve(ROOT, file), 'utf8') : inline);

    await waitReady();
    await runScript(readScript(OPT.js, OPT.jsFile));

    // --reload：刷新一遍再跑第二段脚本，用来确认"刷新后状态还在"
    if (OPT.reload) {
      console.log('刷新页面…');
      await cdp.send('Page.reload', { ignoreCache: false });
      await sleep(600);
      await waitReady();
      await runScript(readScript(OPT.js2, OPT.jsFile2));
    }

    await sleep(OPT.wait);

    const lm = await cdp.send('Page.getLayoutMetrics');
    const cs = lm.cssContentSize || lm.contentSize;
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: Math.round(cs.width), height: Math.round(cs.height), deviceScaleFactor: 1, mobile: false,
    });
    await sleep(250);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });

    const out = path.resolve(ROOT, OPT.out);
    await fsp.mkdir(path.dirname(out), { recursive: true });
    await fsp.writeFile(out, Buffer.from(shot.data, 'base64'));
    console.log('已保存:', out, '(' + Math.round(cs.width) + 'x' + Math.round(cs.height) + ')');

    if (pageErrors.length) {
      console.log('页面报错:');
      for (const e of pageErrors.slice(0, 8)) console.log('  - ' + String(e).split('\n')[0]);
      process.exitCode = 2;
    } else {
      console.log('页面无报错');
    }
  } finally {
    try { child.kill(); } catch (_) {}
    server.close();
  }
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
