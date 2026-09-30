// ============================================================================
// 动效引擎 · 后期特效
// 这些是"全屏"级别的效果，作用在整帧画面上：
// 颗粒、扫描线、色差、故障切片、闪白/闪黑、暗角、半调网点、辉光、像素化、VHS……
// 每个特效签名统一为 (ctx, scene, t, params)，可自由组合成特效栈。
// ============================================================================

import { clamp, lerp, Rng, hashSeed } from './core.js';
import { TAU } from './core.js';
import { fullRect } from './draw.js';

// ---------------------------------------------------------------- 离屏画布池
const _pool = new Map();
function scratch(key, w, h) {
  let entry = _pool.get(key);
  if (!entry || entry.c.width !== w || entry.c.height !== h) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    entry = { c, x: c.getContext('2d') };
    _pool.set(key, entry);
  }
  entry.x.setTransform(1, 0, 0, 1, 0, 0);
  entry.x.clearRect(0, 0, w, h);
  return entry;
}

function snapshot(ctx, w, h, key = '_snap') {
  const s = scratch(key, w, h);
  s.x.drawImage(ctx.canvas, 0, 0, w, h);
  return s;
}

// ---------------------------------------------------------------- 基础特效

/** 噪点颗粒。用预生成噪点贴图叠加，速度远快于逐像素。 */
const _grainTiles = [];
function grainTile(i, size = 256) {
  if (_grainTiles[i]) return _grainTiles[i];
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const x = c.getContext('2d');
  const img = x.createImageData(size, size);
  const rng = new Rng(1000 + i);
  for (let p = 0; p < img.data.length; p += 4) {
    const v = 128 + (rng.next() - 0.5) * 255;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v;
    img.data[p + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  _grainTiles[i] = c;
  return c;
}

export function grain(ctx, scene, t, { amount = 0.14, size = 1.0, mode = 'overlay' } = {}) {
  const { width: w, height: h } = scene;
  const tile = grainTile(Math.floor(t * scene.fps) % 6);
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = mode;
  const s = 256 * size;
  for (let y = 0; y < h; y += s) for (let x = 0; x < w; x += s) {
    ctx.drawImage(tile, x, y, s, s);
  }
  ctx.restore();
}

/** 扫描线 */
export function scanlines(ctx, scene, t, { amount = 0.22, step = 3, speed = 0, color = '#000' } = {}) {
  const { width: w, height: h } = scene;
  const off = speed ? (t * speed) % step : 0;
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.fillStyle = color;
  for (let y = off; y < h; y += step) ctx.fillRect(0, y, w, 1);
  ctx.restore();
}

/**
 * 色差（RGB 分离）。
 * 用三次 multiply 通道隔离 + lighter 合成，全程走 GPU，比逐像素快得多。
 */
export function chromatic(ctx, scene, t, { amount = 6, angle = 0, animated = false, jitter = 0 } = {}) {
  const { width: w, height: h } = scene;
  if (amount <= 0.01) return;
  const dx = Math.cos(angle) * amount + (animated ? Math.sin(t * 11.3) * jitter : 0);
  const dy = Math.sin(angle) * amount * 0.4;
  const src = snapshot(ctx, w, h, '_chrome_src');

  const channels = [
    ['#ff0000', dx, dy],
    ['#00ff00', 0, 0],
    ['#0000ff', -dx, -dy],
  ];

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 3; i++) {
    const [col, ox, oy] = channels[i];
    const ch = scratch('_chrome_ch_' + i, w, h);
    ch.x.globalCompositeOperation = 'source-over';
    ch.x.drawImage(src.c, 0, 0);
    ch.x.globalCompositeOperation = 'multiply';
    ch.x.fillStyle = col;
    ch.x.fillRect(0, 0, w, h);
    ctx.drawImage(ch.c, ox, oy);
  }
  ctx.restore();
}

/** 故障切片：随机水平条错位 + 可选色差 */
export function glitch(ctx, scene, t, { amount = 0.35, slices = 14, shift = 60, rgb = 0.5, seed = 7, blocky = true } = {}) {
  const { width: w, height: h } = scene;
  const rng = new Rng(Math.floor(t * scene.fps * 13) + seed);
  const src = snapshot(ctx, w, h, '_glitch_src');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(src.c, 0, 0);

  const n = Math.round(slices * clamp(amount, 0, 2));
  for (let i = 0; i < n; i++) {
    if (rng.next() > 0.55) continue;
    const sy = Math.floor(rng.range(0, h));
    const sh = Math.floor(rng.range(2, blocky ? h * 0.06 : 26));
    const ox = (rng.next() * 2 - 1) * shift * amount;
    ctx.drawImage(src.c, 0, sy, w, sh, ox, sy, w, sh);
    if (rgb > 0) {
      ctx.save();
      ctx.globalAlpha = rgb * 0.6;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(tinted(src.c, '#ff0000'), ox + 6 * amount, sy, w, sh);
      ctx.drawImage(tinted(src.c, '#0000ff'), ox - 6 * amount, sy, w, sh);
      ctx.restore();
    }
  }
  ctx.restore();
}

const _tintCache = new Map();
function tinted(sourceCanvas, color) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const key = `_tint_${color}_${w}x${h}`;
  let c = _tintCache.get(key);
  if (!c) {
    c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    _tintCache.set(key, c);
  }
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, w, h);
  x.drawImage(sourceCanvas, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = color;
  x.fillRect(0, 0, w, h);
  return c;
}

/** 闪白 / 闪黑（卡点最常用的一招） */
export function flash(ctx, scene, t, { color = '#ffffff', amount = 1, duration = 0.12, hits = null, period = null, decay = 2.2 } = {}) {
  const { width: w, height: h } = scene;
  let a = 0;
  if (hits && hits.length) {
    for (const hTime of hits) {
      const d = t - hTime;
      if (d >= 0 && d < duration) a = Math.max(a, Math.pow(1 - d / duration, decay));
    }
  } else if (period) {
    const p = ((t % period) + period) % period;
    if (p < duration) a = Math.pow(1 - p / duration, decay);
  }
  if (a <= 0.001) return 0;
  fullRect(ctx, w, h, color, a * amount);
  return a;
}

/** 暗角 */
export function vignette(ctx, scene, t, { amount = 0.55, radius = 0.72, softness = 0.5 } = {}) {
  const { width: w, height: h } = scene;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * radius * 0.4, w / 2, h / 2, Math.max(w, h) * radius);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1 - softness * 0.5, `rgba(0,0,0,${amount * 0.4})`);
  g.addColorStop(1, `rgba(0,0,0,${amount})`);
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); ctx.restore();
}

/** 辉光 / 光晕 */
export function bloom(ctx, scene, t, { amount = 0.45, radius = 26, threshold = 'rgba(0,0,0,0)' } = {}) {
  const { width: w, height: h } = scene;
  const src = snapshot(ctx, w, h, '_bloom_src');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = amount;
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(src.c, 0, 0);
  ctx.filter = 'none';
  ctx.restore();
}

/** 半调网点（把画面做成印刷/漫画质感） */
let _halftonePattern = null;
function halftoneTile(scale) {
  const key = 'ht' + scale;
  if (_halftonePattern && _halftonePattern.key === key) return _halftonePattern.c;
  const size = scale * 2;
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(0,0,0,0.85)';
  x.beginPath(); x.arc(scale / 2, scale / 2, scale * 0.42, 0, TAU); x.fill();
  _halftonePattern = { key, c };
  return c;
}

export function halftone(ctx, scene, t, { amount = 0.4, scale = 6, offset = 0 } = {}) {
  const { width: w, height: h } = scene;
  const tile = halftoneTile(scale);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = 'multiply';
  const ox = (offset % scale + scale) % scale;
  for (let y = 0; y < h + scale; y += scale) for (let x = -scale; x < w + scale; x += scale) {
    ctx.drawImage(tile, x + ox, y);
  }
  ctx.restore();
}

/** 像素化 */
export function pixelate(ctx, scene, t, { amount = 8 } = {}) {
  const { width: w, height: h } = scene;
  if (amount < 2) return;
  const src = snapshot(ctx, w, h, '_pix_src');
  const pw = Math.max(1, Math.round(w / amount)), ph = Math.max(1, Math.round(h / amount));
  const small = scratch('_pix_small', pw, ph);
  small.x.imageSmoothingEnabled = true;
  small.x.drawImage(src.c, 0, 0, pw, ph);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(small.c, 0, 0, pw, ph, 0, 0, w, h);
  ctx.restore();
}

/** VHS：轻微水平抖动 + 磁带噪声带 + 边缘发虚 */
export function vhs(ctx, scene, t, { amount = 0.5, jitter = 5, bands = 6, seed = 3 } = {}) {
  const { width: w, height: h } = scene;
  const src = snapshot(ctx, w, h, '_vhs_src');
  const rng = new Rng(Math.floor(t * scene.fps) + seed * 131);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const rows = Math.max(4, Math.round(h / 8));
  for (let i = 0; i < rows; i++) {
    const sy = (i * h) / rows, sh = h / rows + 1;
    const wob = Math.sin(t * 3.1 + i * 0.35) * jitter * amount + (rng.next() - 0.5) * amount * 2;
    ctx.drawImage(src.c, 0, sy, w, sh, wob, sy, w, sh);
  }
  for (let b = 0; b < bands; b++) {
    if (rng.next() > 0.5) continue;
    const by = rng.range(0, h), bh = rng.range(3, 16);
    ctx.globalAlpha = 0.28 * amount;
    ctx.drawImage(src.c, 0, by, w, bh, rng.range(-30, 30) * amount, by, w, bh);
    ctx.globalAlpha = 1;
    ctx.fillStyle = `rgba(255,255,255,${0.08 * amount})`;
    ctx.fillRect(0, by, w, bh);
  }
  ctx.restore();
}

/** 数据摩什：把上一帧拖尾混进来，制造"画面粘住"的感觉 */
const _moshState = new Map();
export function datamosh(ctx, scene, t, { amount = 0.4, key = 'default', shift = 40, reset = 0.02 } = {}) {
  const { width: w, height: h } = scene;
  const state = _moshState.get(key);
  const rng = new Rng(Math.floor(t * scene.fps) + 99);
  if (state && rng.next() > reset) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = amount;
    // 用上一帧的上半部分盖住当前帧下半部分，制造撕裂
    const cut = rng.range(0.3, 0.8) * h;
    ctx.drawImage(state, 0, 0, w, cut, (rng.next() * 2 - 1) * shift, 0, w, cut);
    ctx.globalAlpha = 1;
    ctx.restore();
  }
  const s = scratch('_mosh_' + key, w, h);
  s.x.drawImage(ctx.canvas, 0, 0, w, h);
  _moshState.set(key, s.c);
}

export function moshReset(key = 'default') { _moshState.delete(key); }

/** 上下黑边（2.39:1 / 1.85:1 遮幅） */
export function letterbox(ctx, scene, t, { ratio = 1.85, animate = 0, amount = 0 } = {}) {
  const { width: w, height: h } = scene;
  const target = Math.max(0, (h - w / ratio) / 2);
  const bar = animate ? target * amount : target;
  if (bar <= 0) return;
  ctx.save(); ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, bar); ctx.fillRect(0, h - bar, w, bar);
  ctx.restore();
}

/** 极端曝光漂白（片尾那种"洗白"） */
export function bleach(ctx, scene, t, { amount = 0, color = '#ffffff' } = {}) {
  fullRect(ctx, scene.width, scene.height, color, clamp(amount, 0, 1));
}

/** 反相闪光 */
export function invert(ctx, scene, t, { amount = 0, hits = null, duration = 0.08 } = {}) {
  let a = clamp(amount, 0, 1);
  if (hits) {
    a = 0;
    for (const ht of hits) {
      const d = t - ht;
      if (d >= 0 && d < duration) a = Math.max(a, 1 - d / duration);
    }
  }
  if (a <= 0.001) return;
  const { width: w, height: h } = scene;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = a;
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// ---------------------------------------------------------------- 特效栈
export const FX = {
  grain, scanlines, chromatic, glitch, flash, vignette, bloom, halftone,
  pixelate, vhs, datamosh, letterbox, bleach, invert,
};

/**
 * 执行特效栈。
 * stack: [{type:'grain', amount:0.1}, 'scanlines', ...]
 * 支持用 t0/t1 限定生效区间；amount 也可以给成函数 (t)=>number 做动态变化。
 */
export function runFx(ctx, scene, t, stack, resolvers = {}) {
  for (const raw of stack || []) {
    const spec = typeof raw === 'string' ? { type: raw } : raw;
    if (spec.enabled === false) continue;
    if (spec.t0 !== undefined && t < spec.t0) continue;
    if (spec.t1 !== undefined && t >= spec.t1) continue;
    const fn = resolvers[spec.type] || FX[spec.type];
    if (!fn) continue;
    const params = { ...spec };
    delete params.type;
    if (typeof params.amount === 'function') params.amount = params.amount(t, scene);
    // hits 可以是 'beats' / 'downbeats' / 'bars'，也可以是一串自定义时间
    if (typeof params.hits === 'string') {
      if (params.hits === 'beats') params.hits = beatHits(scene, { division: spec.division ?? 1, every: spec.every ?? 1 });
      else if (params.hits === 'downbeats') params.hits = beatHits(scene, { division: 0.25, every: 4 });
      else if (params.hits === 'bars') params.hits = beatHits(scene, { division: 1, every: 4 });
      else params.hits = resolvers[params.hits] || null;
    }
    ctx.save();
    try { fn(ctx, scene, t, params); } catch (e) { if (!spec.silent) console.error(`[fx:${spec.type}]`, e); }
    ctx.restore();
  }
}

/** 把节拍图转成 flash/invert 用的 hits 数组 */
export function beatHits(scene, { division = 1, from = 0, to = null, every = 1 } = {}) {
  const end = to ?? scene.duration;
  const all = scene.beat.hitsIn(from, end, division);
  return all.filter((_, i) => i % every === 0);
}

export { Rng, hashSeed, lerp };
