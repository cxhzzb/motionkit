// ============================================================================
// 零依赖静态服务器 —— 用来打开工作室（ES Module 必须走 http，不能直接双击 html）
// 用法: npm run studio   /   node tools/serve.mjs [端口]
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { spawn } from 'node:child_process';
import { makeZip } from '../engine/zip.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const OPEN_BROWSER = ARGV.includes('--open');
const PORT = Number(ARGV.find((a) => /^\d+$/.test(a)) || 5178);
const PORT_MAX = PORT + 12;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
};

// ============================================================================
// Agent API
//   工作室的界面跑在浏览器里，但分析/转写/规划要调 ffmpeg、python 和无头浏览器，
//   所以把这几步放到本地服务里，浏览器只负责收进度和结果。
// ============================================================================

function json(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

function readConfig() {
  const out = { llm: {}, asr: {} };
  for (const f of ['agent/config.json']) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      for (const k of ['llm', 'asr']) if (d[k] && typeof d[k] === 'object') Object.assign(out[k], d[k]);
    } catch (_) { /* 没配就是没配 */ }
  }
  const env = { llm: { baseUrl: 'MK_LLM_BASE', apiKey: 'MK_LLM_KEY', model: 'MK_LLM_MODEL' },
                asr: { baseUrl: 'MK_ASR_BASE', apiKey: 'MK_ASR_KEY', model: 'MK_ASR_MODEL' } };
  for (const k of ['llm', 'asr']) {
    for (const [field, name] of Object.entries(env[k])) if (process.env[name]) out[k][field] = process.env[name];
  }
  return out;
}

function probePython() {
  return new Promise((resolve) => {
    const p = spawn('python', ['-c', 'import sys, json;print(json.dumps({"v":sys.version.split()[0]}))'], { cwd: ROOT });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => resolve({ ok: false, error: '找不到 python' }));
    p.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: err.slice(0, 200) || 'python 调用失败' });
      try { resolve({ ok: true, ...JSON.parse(out.trim()) }); } catch (_) { resolve({ ok: true, v: '?' }); }
    });
  });
}

function probeModule(name) {
  return new Promise((resolve) => {
    const p = spawn('python', ['-c', `import ${name}`], { cwd: ROOT });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

async function agentStatus(res) {
  const cfg = readConfig();
  const py = await probePython();
  const ff = await probeModule('imageio_ffmpeg');
  const fw = py.ok ? await probeModule('faster_whisper') : false;
  let styles = {};
  try {
    styles = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent/styles.json'), 'utf8')).styles || {};
  } catch (_) {}
  const asr = [];
  if (fw) asr.push('local');
  if (cfg.asr.apiKey && cfg.asr.baseUrl) asr.push('api');
  json(res, {
    ok: py.ok,
    python: py.v || null,
    ffmpeg: ff,
    fasterWhisper: fw,
    asrProviders: asr,
    asrModel: cfg.asr.model || null,
    llm: { configured: !!cfg.llm.apiKey, model: cfg.llm.model || null, baseUrl: cfg.llm.baseUrl || null },
    styles: Object.entries(styles).map(([id, s]) => ({
      id, name: s.name, desc: s.desc, dark: !!s.dark,
      ink: s.ink, accent: s.accent, plate: s.plate,
    })),
    defaults: { target: 30, width: 1920, height: 1080, fps: 30, intensity: 0.6, density: 0.55 },
  });
}

/** 把上传的视频存到 projects/agent-<时间戳>/ 下，然后起 python 跑全流程。 */
function agentRun(req, res) {
  const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'input.mp4'));
  const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(-60) || 'input.mp4';
  let brief = {};
  try { brief = JSON.parse(decodeURIComponent(String(req.headers['x-brief'] || '%7B%7D'))); } catch (_) {}

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = path.join(ROOT, 'projects', 'agent-' + stamp);
  fs.mkdirSync(workDir, { recursive: true });
  const upload = path.join(workDir, 'source_' + safe);
  const sink = fs.createWriteStream(upload);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
  send({ type: 'progress', step: 'upload', progress: 0.02, msg: '正在保存上传的素材…' });

  req.pipe(sink);
  req.on('aborted', () => { try { sink.close(); } catch (_) {} });
  sink.on('error', (e) => { send({ type: 'error', msg: '写入素材失败：' + e.message }); res.end(); });
  sink.on('finish', () => {
    const args = [
      path.join(ROOT, 'agent/autopilot.py'),
      '--video', upload,
      '--out', workDir,
      '--json-progress',
      '--style', String(brief.style || 'auto'),
      '--intensity', String(brief.intensity ?? 0.6),
      '--density', String(brief.density ?? 0.55),
      '--captions', String(brief.captions || 'auto'),
      '--caption-style', String(brief.captionStyle || 'bar'),
      '--target', String(brief.target ?? 30),
      '--width', String(brief.width ?? 1920),
      '--height', String(brief.height ?? 1080),
      '--fps', String(brief.fps ?? 30),
      '--clip', String(brief.clip || 'auto'),
      '--notes', String(brief.notes || ''),
    ];
    if (brief.lang) args.push('--lang', String(brief.lang));
    if (brief.render) args.push('--render');
    if (brief.llm === false) args.push('--no-llm');

    const p = spawn('python', args, { cwd: ROOT });
    let tail = '';
    p.stdout.on('data', (d) => {
      // python 侧就是按行输出 NDJSON，原样转发给浏览器
      res.write(d);
      const s = d.toString('utf8');
      tail = (tail + s).slice(-4000);
    });
    p.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-4000);
      send({ type: 'log', msg: s.trim().slice(0, 400) });
    });
    p.on('error', (e) => { send({ type: 'error', msg: '启动 python 失败：' + e.message }); res.end(); });
    p.on('close', (code) => {
      if (code !== 0) send({ type: 'error', msg: '流程失败（退出码 ' + code + '）', detail: tail.slice(-1200) });
      try { res.end(); } catch (_) {}
    });
  });
}

// ============================================================================
// Git / 同步 API
//   工作室界面上"点按钮"就能：看状态、存身份、提交并上传、拉取、打包给另一台电脑。
//   所有 git 命令都在这里跑，界面上不需要敲任何命令。
// ============================================================================

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let p;
    try { p = spawn(cmd, args, { cwd: ROOT, env: process.env, ...opts }); }
    catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => { resolve({ code: -1, out, err: err + e.message }); });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

// safe.directory：文件夹属主和当前用户不一致时（共用盘、从别处拷过来的仓库）也照样能跑
// GIT_TERMINAL_PROMPT=0 + BatchMode：缺凭据时立刻失败，而不是挂在那儿等输入
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const git = (args, opts) => run('git', [
  '-c', `safe.directory=${ROOT}`,
  '-c', 'core.sshCommand=ssh -o BatchMode=yes -o ConnectTimeout=15',
  ...args,
], { env: GIT_ENV, ...opts });

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (_) { resolve({}); } });
  });
}

const SSH_DIR = path.join(os.homedir(), '.ssh');
// 专门给 GitHub 用的一把，不碰你机器上原有的密钥
const SSH_KEY = path.join(SSH_DIR, 'id_ed25519_github');
const SSH_CFG = path.join(SSH_DIR, 'config');

/** 这台机器实测只有 SSH(443) 能连上 GitHub，所以把 github.com 指过去 */
function ensureSshConfig() {
  let txt = '';
  try { txt = fs.readFileSync(SSH_CFG, 'utf8'); } catch (_) {}
  if (/^Host\s+github\.com\s*$/m.test(txt)) return { changed: false, existed: true };
  try {
    fs.mkdirSync(SSH_DIR, { recursive: true });
    const block = '# MotionKit 同步用：这台机器只有 SSH 的 443 端口连得上 GitHub\n'
      + 'Host github.com\n  HostName ssh.github.com\n  Port 443\n  User git\n'
      + '  IdentityFile ~/.ssh/id_ed25519_github\n  IdentitiesOnly yes\n';
    fs.appendFileSync(SSH_CFG, (txt && !txt.endsWith('\n') ? '\n' : '') + (txt ? '\n' : '') + block);
    return { changed: true, existed: false };
  } catch (e) { return { changed: false, error: e.message }; }
}

async function gitStatusPayload() {
  const ver = await run('git', ['--version']);
  if (!ver.out.trim()) return { git: false, repo: false, error: '这台电脑没装 git' };
  const inside = await git(['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0) return { git: true, repo: false, error: inside.err.trim().slice(0, 200) };
  const branch = (await git(['branch', '--show-current'])).out.trim() || 'main';
  const remote = (await git(['remote', 'get-url', 'origin'])).out.trim();
  const name = (await git(['config', 'user.name'])).out.trim();
  const email = (await git(['config', 'user.email'])).out.trim();
  const porcelain = (await git(['status', '--porcelain'])).out.replace(/\s+$/, '');
  const files = porcelain ? porcelain.split('\n') : [];
  const hasCommit = (await git(['rev-parse', '--verify', 'HEAD'])).code === 0;
  const ahead = hasCommit && remote ? (await git(['rev-list', '--count', '@{u}..HEAD'])).out.trim() : '';
  return {
    git: true, repo: true, branch, remote, name, email,
    dirty: files.length, files: files.slice(0, 50),
    hasCommit, ahead: ahead ? Number(ahead) : null,
    sshKey: fs.existsSync(SSH_KEY),
  };
}

async function gitApi(p, req, res) {
  if (p === '/api/git/status') { json(res, await gitStatusPayload()); return true; }

  if (p === '/api/git/setup' && req.method === 'POST') {
    const b = await readBody(req);
    const done = [];
    if (b.name) { await git(['config', 'user.name', String(b.name)]); done.push('名字'); }
    if (b.email) { await git(['config', 'user.email', String(b.email)]); done.push('邮箱'); }
    if (b.remote) {
      const r0 = String(b.remote).trim();
      // 允许 https / git@ / ssh:// / 局域网共享路径；只挡掉空值和会被当成参数的写法
      if (!r0 || /\s/.test(r0) || r0.startsWith('-')) {
        json(res, { ok: false, error: '仓库地址要长得像 https://github.com/用户名/仓库.git（或 git@github.com:用户名/仓库.git）' }, 400); return true;
      }
      // https://github.com/a/b.git 这种情况自动换成 SSH——这台机器只有 SSH 通
      const asSsh = r0.replace(/^https?:\/\/github\.com\//i, 'git@github.com:');
      const has = (await git(['remote', 'get-url', 'origin'])).code === 0;
      const r = has ? await git(['remote', 'set-url', 'origin', asSsh]) : await git(['remote', 'add', 'origin', asSsh]);
      if (r.code !== 0) { json(res, { ok: false, error: r.err.trim().slice(0, 300) }, 400); return true; }
      done.push('仓库地址');
    }
    json(res, { ok: true, done, ...(await gitStatusPayload()) }); return true;
  }

  if (p === '/api/git/sshkey') {
    const exists = fs.existsSync(SSH_KEY);
    // 只有点按钮（POST）才动你的 ~/.ssh：生成密钥 + 把 github.com 指到 443 端口
    let created = false, cfg = { changed: false };
    if (req.method === 'POST') {
      if (!exists) {
        fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
        await run('ssh-keygen', ['-t', 'ed25519', '-f', SSH_KEY, '-N', '', '-C', 'motionkit@' + os.hostname()]);
        created = true;
      }
      cfg = ensureSshConfig();
    }
    let pub = '';
    try { pub = fs.readFileSync(SSH_KEY + '.pub', 'utf8').trim(); } catch (_) {}
    json(res, { ok: !!pub, exists, created, pub, sshConfig: cfg, path: SSH_KEY + '.pub' }); return true;
  }

  if (p === '/api/git/commit' && req.method === 'POST') {
    const b = await readBody(req);
    const st = await gitStatusPayload();
    if (!st.dirty) { json(res, { ok: true, skipped: '没有改动，不用提交', ...st }); return true; }
    const add = await git(['add', '-A']);
    if (add.code !== 0) { json(res, { ok: false, error: add.err.trim().slice(0, 400) }, 400); return true; }
    const msg = String(b.message || '').trim() || ('同步：' + new Date().toLocaleString('zh-CN'));
    const ci = await git(['commit', '-m', msg]);
    if (ci.code !== 0 && !/nothing to commit/i.test(ci.out + ci.err)) {
      json(res, { ok: false, error: (ci.out + ci.err).trim().slice(0, 600) }, 400); return true;
    }
    json(res, { ok: true, message: msg, out: (ci.out + ci.err).trim().slice(-400), ...(await gitStatusPayload()) }); return true;
  }

  if (p === '/api/git/push' && req.method === 'POST') {
    const st = await gitStatusPayload();
    if (!st.remote) { json(res, { ok: false, error: '还没填仓库地址' }, 400); return true; }
    if (!st.hasCommit) { json(res, { ok: false, error: '还没有任何提交' }, 400); return true; }
    const r = await git(['push', '-u', 'origin', st.branch], { timeout: 180000 });
    const text = (r.out + r.err).trim();
    if (r.code !== 0) { json(res, { ok: false, error: text.slice(-800) || '推送失败' }, 400); return true; }
    json(res, { ok: true, out: text.slice(-400), ...(await gitStatusPayload()) }); return true;
  }

  if (p === '/api/git/pull' && req.method === 'POST') {
    const st = await gitStatusPayload();
    if (!st.remote) { json(res, { ok: false, error: '还没填仓库地址' }, 400); return true; }
    const r = await git(['pull', '--rebase'], { timeout: 180000 });
    const text = (r.out + r.err).trim();
    json(res, { ok: r.code === 0, error: r.code === 0 ? undefined : (text.slice(-800) || '拉取失败'),
                out: text.slice(-400), ...(await gitStatusPayload()) });
    return true;
  }

  // 新电脑第一次用：把远程仓库整个接过来（本机没上传的改动会被覆盖）
  if (p === '/api/git/sync-down' && req.method === 'POST') {
    const st = await gitStatusPayload();
    if (!st.remote) { json(res, { ok: false, error: '还没填仓库地址' }, 400); return true; }
    const f = await git(['fetch', 'origin'], { timeout: 180000 });
    if (f.code !== 0) {
      json(res, { ok: false, error: (f.out + f.err).trim().slice(-800) || '连不上远程仓库' }, 400); return true;
    }
    const ref = `origin/${st.branch}`;
    const chk = await git(['rev-parse', '--verify', ref]);
    if (chk.code !== 0) {
      json(res, { ok: false, error: '远程仓库还是空的 —— 先在已经写好的那台电脑上点「提交并上传」。' }, 400); return true;
    }
    const r = await git(['reset', '--hard', ref]);
    const text = (r.out + r.err).trim();
    json(res, {
      ok: r.code === 0,
      error: r.code === 0 ? undefined : (text.slice(-800) || '接过来失败'),
      out: text.slice(-400), ...(await gitStatusPayload()),
    });
    return true;
  }

  if (p === '/api/git/package' && req.method === 'POST') {
    const parent = path.dirname(ROOT);
    const folder = path.basename(ROOT);
    const stamp = new Date().toISOString().slice(0, 10);
    const outFile = path.join(parent, `${folder}-传给新电脑-${stamp}.zip`);
    // 用工程自带的 zip 写入器（纯 JS，文件名走 UTF-8，中文名不会变乱码）；
    // 外面套一层同名文件夹，解压出来是整整齐齐的一个工程目录
    const SKIP = new Set(['projects', '.out', 'node_modules', '__pycache__', '.gitmodules']);
    const files = [];
    let bytes = 0;
    (function walk(dirAbs, rel) {
      let entries = [];
      try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        if (SKIP.has(e.name) || /\.zip$/i.test(e.name) || e.isSymbolicLink()) continue;
        const abs = path.join(dirAbs, e.name);
        const r = rel ? rel + '/' + e.name : e.name;
        if (e.isDirectory()) walk(abs, r);
        else if (e.isFile()) {
          try {
            const data = fs.readFileSync(abs);
            bytes += data.length;
            files.push({ name: folder + '/' + r, data });
          } catch (_) {}
        }
      }
    })(ROOT, '');
    if (!files.length) { json(res, { ok: false, error: '没扫到文件' }, 400); return true; }
    const blob = makeZip(files);
    fs.writeFileSync(outFile, Buffer.from(await blob.arrayBuffer()));
    let size = 0;
    try { size = fs.statSync(outFile).size; } catch (_) {}
    json(res, { ok: true, file: outFile, size, count: files.length, dir: parent }); return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  // 轻量探活：不能拿 /api/agent/status 当心跳，它要起 python，两秒才回，
  // 而"是不是已经有一个工作室在跑"必须在几百毫秒内问出答案。
  if (p === '/api/ping') { json(res, { app: 'motionkit-studio', ok: true }); return; }
  if (p === '/api/agent/status') { agentStatus(res); return; }
  if (p === '/api/agent/run' && req.method === 'POST') { agentRun(req, res); return; }
  if (p.startsWith('/api/git/')) {
    try { if (await gitApi(p, req, res)) return; } catch (e) { json(res, { ok: false, error: e.message }, 500); return; }
  }
  if (p === '/' || p === '') p = '/studio/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found: ' + p); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------------------------------------------------------- 打开浏览器
function findBrowser() {
  const cands = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].filter(Boolean);
  return cands.find((c) => { try { return fs.existsSync(c); } catch (_) { return false; } }) || null;
}

function openBrowser(url) {
  const exe = findBrowser();
  try {
    if (process.platform === 'win32') {
      const child = exe
        ? spawn(exe, [url], { detached: true, stdio: 'ignore' })
        : spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    console.log(`  已用 ${exe ? path.basename(exe) : '默认浏览器'} 打开。`);
  } catch (e) {
    console.log(`  （自动打开失败：${e.message}，手动复制上面那个地址即可）`);
  }
}

/** 已经有一个工作室在跑就别再起一个（一键启动连点两次的常见情况）。 */
async function findRunning() {
  for (let p = PORT; p <= PORT_MAX; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`,
                            { signal: AbortSignal.timeout(700) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.app === 'motionkit-studio') return p;
      }
    } catch (_) { /* 这个端口没人在听 */ }
  }
  return null;
}

function banner(url) {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │  MotionKit 工作室（开发模式）                 │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log(`  地址   ${url}`);
  console.log('  功能   模板 / 卡点 / 字幕 / 导出  ＋  ✨ AI 助手');
  console.log('  停止   在这个窗口按 Ctrl+C');
  console.log('');
}

async function main() {
  const url0 = `http://localhost:${PORT}/studio/index.html`;
  if (OPEN_BROWSER) {
    const running = await findRunning();
    if (running) {
      const url = `http://localhost:${running}/studio/index.html`;
      console.log(`\n  已经有一个工作室在 ${url} 上跑着了，直接给你打开。`);
      console.log('  （要重启就先在原来那个窗口按 Ctrl+C）\n');
      openBrowser(url);
      return;
    }
  }

  let tries = 0;
  const listen = (port) => {
    server.listen(port, () => {
      const url = `http://localhost:${port}/studio/index.html`;
      banner(url);
      if (OPEN_BROWSER) openBrowser(url);
    });
  };
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < 12) {
      tries++;
      console.log(`端口 ${PORT + tries - 1} 被占用，换 ${PORT + tries} 试试…`);
      setTimeout(() => listen(PORT + tries), 120);
    } else {
      console.error('启动失败：', err.message);
      process.exit(1);
    }
  });
  listen(PORT);
}

main();
