// ============================================================================
// 零依赖静态服务器 —— 用来打开工作室（ES Module 必须走 http，不能直接双击 html）
// 用法: npm run studio   /   node tools/serve.mjs [端口]
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { makeZip } from '../engine/zip.js';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const OPEN_BROWSER = ARGV.includes('--open');
const PORT = Number(ARGV.find((a) => /^\d+$/.test(a)) || 5178);
const PORT_MAX = PORT + 12;
// 加了新接口就把这个数字 +1：启动器发现端口上跑的是旧版本，会把它换掉再起新的
const APP_VERSION = Number(process.env.MK_APP_VERSION || 9);
const DOWNLOAD_DIR = path.join(ROOT, 'downloads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.opus': 'audio/ogg', '.flac': 'audio/flac',
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
  const ytDlp = await probeYtDlp();   // 顶栏「下载视频」靠它；探不到就在界面上说清楚
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
    videoDownload: ytDlp.cmd ? (ytDlp.how || true) : false,
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

    // PYTHONIOENCODING：Windows 下 python 默认按 GBK 输出，遇到 ✓ 这类字符会直接崩
    const p = spawn('python', args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
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
// 一键铺满：存下上传的视频 → 跑 agent/fill.py（纯本地分析，不叫大模型）
// ============================================================================
function fillRun(req, res) {
  const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'input.mp4'));
  const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(-60) || 'input.mp4';
  let brief = {};
  try { brief = JSON.parse(decodeURIComponent(String(req.headers['x-brief'] || '%7B%7D'))); } catch (_) {}

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = path.join(ROOT, 'projects', 'fill-' + stamp);
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
      path.join(ROOT, 'agent/fill.py'),
      '--video', upload,
      '--out', workDir,
      '--json-progress',
      '--style', String(brief.style || 'slopcore'),
      '--intensity', String(brief.intensity ?? 0.6),
      '--width', String(brief.width ?? 1920),
      '--height', String(brief.height ?? 1080),
      '--fps', String(brief.fps ?? 30),
    ];
    if (brief.title) args.push('--title', String(brief.title));
    if (brief.duration) args.push('--duration', String(brief.duration));

    const p = spawn('python', args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let tail = '';
    p.stdout.on('data', (d) => {
      res.write(d);                       // python 侧就是 NDJSON，原样转发
      tail = (tail + d.toString('utf8')).slice(-3000);
    });
    p.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      tail = (tail + s).slice(-3000);
      send({ type: 'log', msg: s.trim().slice(0, 300) });
    });
    p.on('error', (e) => { send({ type: 'error', msg: '启动 python 失败：' + e.message }); res.end(); });
    p.on('close', (code) => {
      if (code !== 0) send({ type: 'error', msg: '铺满失败（退出码 ' + code + '）', detail: tail.slice(-1200) });
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
    // timeout：探测用的短命令不能被"卡住的进程"拖死（比如 yt-dlp 在等网络）
    const { timeout = 0, ...rest } = opts;
    let p;
    try { p = spawn(cmd, args, { cwd: ROOT, env: process.env, ...rest }); }
    catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
    let out = '', err = '';
    let timer = null;
    const done = (r) => { if (timer) clearTimeout(timer); resolve(r); };
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', (e) => done({ code: -1, out, err: err + e.message }));
    p.on('close', (code) => done({ code, out, err }));
    if (timeout > 0) {
      timer = setTimeout(() => {
        try { p.kill('SIGTERM'); } catch (_) {}
        done({ code: -1, out, err: err + `\n（超时 ${timeout}ms 没回应）` });
      }, timeout);
    }
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

function privateAddress(addr) {
  const ip = String(addr || '').replace(/^\[|\]$/g, '');
  const family = isIP(ip);
  if (family === 4) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
      || (p[0] === 169 && p[1] === 254)
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
      || (p[0] === 192 && p[1] === 168);
  }
  if (family === 6) {
    const h = ip.toLowerCase();
    if (h === '::' || h === '::1') return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const v4 = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) return privateAddress(v4[1]);
  }
  return false;
}

async function assertPublicDownloadUrl(u) {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || !host.includes('.') || /\.(local|internal|localhost)$/.test(host)) {
    throw new Error('这个地址看起来是内网或本机地址，已拒绝下载');
  }
  if (privateAddress(host)) throw new Error('不能下载内网或本机地址');
  let addrs = [];
  try { addrs = await dns.lookup(host, { all: true, verbatim: true }); } catch (_) {}
  if (addrs.some((x) => privateAddress(x.address))) throw new Error('域名解析到了内网地址，已拒绝下载');
}

function mediaKindFor(file) {
  return /\.(mp3|wav|m4a|aac|opus|flac)$/i.test(file) ? 'audio' : 'video';
}

function mimeForFile(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function pickDownloadedFile(dir) {
  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (/\.(part|ytdl|json|jpg|jpeg|png|webp|vtt|srt|ass)$/i.test(name)) continue;
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) files.push({ abs, size: st.size });
    } catch (_) {}
  }
  files.sort((a, b) => b.size - a.size);
  return files[0] || null;
}

// yt-dlp 有两种装法：命令行 yt-dlp 在 PATH 上，或者只装了 python 模块。
// 只试一种的话，另一种装法的机器上"下载视频"按钮会直接报"找不到 yt-dlp"。
// 探到哪个用哪个；探不到就报清楚怎么装（别只说一句 spawn ENOENT）。
let ytDlpProbe = null;

const YTDLP_HINT = '没找到 yt-dlp：本机既没有 yt-dlp 命令，也没有 yt_dlp 这个 python 模块。'
  + '装一个就行：pip install -U yt-dlp（或者 pipx install yt-dlp）。装完回来点「下载视频」即可，不用重启。';

async function probeYtDlp() {
  if (ytDlpProbe) return ytDlpProbe;
  const cli = await run('yt-dlp', ['--version'], { timeout: 8000 });
  if (cli.code === 0) return (ytDlpProbe = { cmd: 'yt-dlp', pre: [], how: 'yt-dlp 命令' });
  const mod = await run('python', ['-m', 'yt_dlp', '--version'], { timeout: 12000 });
  if (mod.code === 0) return (ytDlpProbe = { cmd: 'python', pre: ['-m', 'yt_dlp'], how: 'python -m yt_dlp' });
  return (ytDlpProbe = { cmd: null, hint: YTDLP_HINT });
}

async function downloadVideoApi(req, res) {
  const body = await readBody(req);
  const raw = String(body.url || '').trim();
  if (!raw) { json(res, { ok: false, error: '先粘贴一个视频网址' }, 400); return; }
  if (raw.length > 4096) { json(res, { ok: false, error: '网址太长了' }, 400); return; }

  let source;
  try {
    source = new URL(raw);
    if (!/^https?:$/.test(source.protocol)) throw new Error('只支持 http / https 网址');
    if (source.username || source.password) throw new Error('网址里不要带账号密码');
    await assertPublicDownloadUrl(source);
  } catch (e) {
    json(res, { ok: false, error: e.message }, 400);
    return;
  }

  const yt = await probeYtDlp();
  if (!yt.cmd) { json(res, { ok: false, error: yt.hint }, 500); return; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(DOWNLOAD_DIR, `${stamp}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(outDir, { recursive: true });

  const args = [
    ...yt.pre,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--restrict-filenames',
    '--merge-output-format', 'mp4',
    '--remux-video', 'mp4',
    '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
    '-o', path.join(outDir, '%(title).80s-%(id)s.%(ext)s'),
    '--',
    raw,
  ];

  const child = spawn(yt.cmd, args, { cwd: ROOT, env: process.env });
  let stdout = '';
  let stderr = '';
  let finished = false;
  const stopIfGone = () => {
    if (finished) return;
    finished = true;
    try { child.kill('SIGTERM'); } catch (_) {}
  };
  req.on('aborted', stopIfGone);
  res.on('close', () => { if (!res.writableEnded) stopIfGone(); });

  child.stdout.on('data', (d) => { stdout = (stdout + d.toString('utf8')).slice(-12000); });
  child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-12000); });
  child.on('error', (e) => {
    // 探过之后才坏的（比如被卸载 / PATH 变了）：让下次重新探一遍，别一直用坏的那个
    finished = true;
    ytDlpProbe = null;
    json(res, { ok: false, error: '启动 yt-dlp 失败（' + yt.how + '）：' + e.message }, 500);
  });
  child.on('close', (code) => {
    if (finished && code !== 0) return;
    finished = true;
    const picked = pickDownloadedFile(outDir);
    if (code !== 0 || !picked) {
      const detail = (stderr || stdout).trim().split('\n').slice(-8).join('\n');
      // 下载失败会留下 .part / .ytdl 半成品，不清理的话 downloads/ 会越堆越大
      for (const name of (() => { try { return fs.readdirSync(outDir); } catch (_) { return []; } })()) {
        if (!/\.(part|ytdl)$/i.test(name)) continue;
        try { fs.rmSync(path.join(outDir, name), { force: true, maxRetries: 3 }); } catch (_) {}
      }
      json(res, { ok: false, error: detail || '下载失败，可能是网址不支持或需要登录' }, 400);
      return;
    }
    const rel = path.relative(ROOT, picked.abs).replace(/\\/g, '/');
    json(res, {
      ok: true,
      url: '/' + rel.split('/').map(encodeURIComponent).join('/'),
      path: picked.abs,
      name: path.basename(picked.abs),
      size: picked.size,
      kind: mediaKindFor(picked.abs),
      mime: mimeForFile(picked.abs),
    });
  });
}

async function transcribeCaptionsApi(req, res) {
  const rawName = decodeURIComponent(String(req.headers['x-file-name'] || 'input.mp4'));
  const safe = rawName.replace(/[\\/:*?"<>|]/g, '_').slice(-80) || 'input.mp4';
  const lang = decodeURIComponent(String(req.headers['x-lang'] || '')).trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = path.join(ROOT, 'projects', 'captions-' + stamp);
  const upload = path.join(workDir, 'source_' + safe);
  const outJson = path.join(workDir, 'transcript.json');
  fs.mkdirSync(workDir, { recursive: true });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (_) {} };
  send({ type: 'progress', progress: 0.02, msg: '正在保存素材…' });

  const sink = fs.createWriteStream(upload);
  req.pipe(sink);
  req.on('aborted', () => { try { sink.close(); } catch (_) {} });
  sink.on('error', (e) => { send({ type: 'error', msg: '写入素材失败：' + e.message }); res.end(); });
  sink.on('finish', () => {
    const args = [
      path.join(ROOT, 'agent/transcribe.py'),
      '--video', upload,
      '--json', outJson,
    ];
    if (lang) args.push('--lang', lang);

    const p = spawn('python', args, { cwd: ROOT, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let tail = '';
    const onLog = (raw) => {
      for (const line of String(raw || '').split(/\r?\n/)) {
        const msg = line.trim();
        if (!msg) continue;
        tail = (tail + '\n' + msg).slice(-4000);
        const progress = /加载本地语音模型/.test(msg) ? 0.18
          : /本地转写中|调用语音识别接口/.test(msg) ? 0.45
            : /段数=/.test(msg) ? 0.96
              : 0.12;
        send({ type: 'log', progress, msg });
      }
    };
    p.stdout.on('data', onLog);
    p.stderr.on('data', onLog);
    p.on('error', (e) => { send({ type: 'error', msg: '启动 Python 失败：' + e.message }); res.end(); });
    p.on('close', (code) => {
      if (code !== 0) {
        send({ type: 'error', msg: '语音识别失败（退出码 ' + code + '）', detail: tail.slice(-1200) });
        res.end();
        return;
      }
      try {
        const result = JSON.parse(fs.readFileSync(outJson, 'utf8'));
        send({
          type: 'result',
          progress: 1,
          result: {
            segments: result.segments || [],
            provider: result.provider || null,
            error: result.error || null,
            file: outJson,
          },
        });
      } catch (e) {
        send({ type: 'error', msg: '读取识别结果失败：' + e.message });
      }
      res.end();
    });
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
    const SKIP = new Set(['projects', 'downloads', '.out', 'node_modules', '__pycache__', '.gitmodules']);
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
    if (p === '/api/ping') {
      json(res, { app: 'motionkit-studio', ok: true, v: APP_VERSION, pid: process.pid });
      return;
    }
  if (p === '/api/agent/status') { agentStatus(res); return; }
  if (p === '/api/agent/run' && req.method === 'POST') { agentRun(req, res); return; }
  if (p === '/api/agent/fill' && req.method === 'POST') { fillRun(req, res); return; }
  if (p === '/api/captions/transcribe' && req.method === 'POST') { transcribeCaptionsApi(req, res); return; }
  if (p === '/api/video/download' && req.method === 'POST') { downloadVideoApi(req, res); return; }
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

/**
 * 端口上已经有工作室在跑？
 *   · 同一个版本 → 直接用它（一键启动连点两次的常见情况）
 *   · 旧版本     → 返回它的端口和 pid，让 main() 把它换掉（否则新加的接口会 404）
 */
async function findRunning() {
  for (let p = PORT; p <= PORT_MAX; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`,
                            { signal: AbortSignal.timeout(700) });
      if (r.ok) {
        const j = await r.json();
        if (j && j.app === 'motionkit-studio') {
          if (j.v === APP_VERSION) return { port: p, same: true, v: j.v, pid: j.pid };
          return { port: p, same: false, v: j.v ?? null, pid: j.pid ?? null };
        }
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
    if (running && running.same) {
      const url = `http://localhost:${running.port}/studio/index.html`;
      console.log(`\n  已经有一个工作室在 ${url} 上跑着了，直接给你打开。`);
      console.log('  （要重启就先在原来那个窗口按 Ctrl+C）\n');
      openBrowser(url);
      return;
    }
    if (running && !running.same) {
      // 端口上那个是旧版本：新加的接口它会 404，先把它换掉
      console.log(`\n  端口 ${running.port} 上跑的是旧版服务（v${running.v ?? '?'}），正在换成本次启动的新版…`);
      if (running.pid) {
        try { process.kill(running.pid); await new Promise((r) => setTimeout(r, 700)); }
        catch (_) { console.log('  （旧进程没能自动关掉，新的会换到下一个端口）'); }
      } else {
        console.log('  （旧版没留 pid，新的会换到下一个端口；旧窗口可以随时手动关掉）');
      }
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
