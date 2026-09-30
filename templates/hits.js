// ============================================================================
// 冲击类模板：故障爆闪、遮幅推入、色散冲击
// 都是"整帧级"的强效果，用来打出节奏重音。
// ============================================================================

import { label, ui, palette, scanlines, fullRect } from '../engine/draw.js';
import { clamp, Rng, easeOutCubic } from '../engine/core.js';
import { color, P } from './_lib.js';

const _buf = new Map();
function buf(key, w, h) {
  let e = _buf.get(key);
  if (!e || e.c.width !== w || e.c.height !== h) {
    const c = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    e = { c, x: c.getContext('2d') };
    _buf.set(key, e);
  }
  e.x.setTransform(1, 0, 0, 1, 0, 0);
  e.x.globalAlpha = 1;
  e.x.globalCompositeOperation = 'source-over';
  e.x.filter = 'none';
  e.x.clearRect(0, 0, w, h);
  return e;
}
function grab(ctx, w, h, key) {
  const b = buf(key, w, h);
  b.x.drawImage(ctx.canvas, 0, 0, w, h);
  return b;
}
function reset(ctx, w, h) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.clearRect(0, 0, w, h);
  ctx.restore();
}

const _tints = new Map();
function tint(srcCanvas, col, w, h) {
  const key = col + w + 'x' + h;
  let c = _tints.get(key);
  if (!c) {
    c = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    _tints.set(key, c);
  }
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over';
  x.clearRect(0, 0, w, h);
  x.drawImage(srcCanvas, 0, 0);
  x.globalCompositeOperation = 'multiply';
  x.fillStyle = col;
  x.fillRect(0, 0, w, h);
  return c;
}

// ---------------------------------------------------------------------------
export const glitchBurst = {
  id: 'glitch-burst',
  name: '故障爆闪',
  category: 'transition',
  hint: '最强的一档：切片错位 + RGB 分离 + 闪帧，适合段落切换。',
  params: [
    { key: 'amount', label: '强度', type: 'number', default: 1, min: 0.1, max: 3, step: 0.05 },
    { key: 'slices', label: '切片数', type: 'number', default: 22, min: 2, max: 80, step: 1 },
    { key: 'shift', label: '错位距离', type: 'number', default: 90, min: 4, max: 400, step: 4 },
    { key: 'rgb', label: 'RGB 分离', type: 'number', default: 1, min: 0, max: 2, step: 0.05 },
    { key: 'flashes', label: '夹闪帧', type: 'number', default: 3, min: 0, max: 10, step: 1 },
    { key: 'blockColor', label: '色块', type: 'color', default: '#ff4b1f' },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const src = grab(ctx, w, h, '_gb');
    const u = clamp(env.progress, 0, 1);
    const amp = Math.sin(Math.PI * u) * p.amount;
    if (amp <= 0.01) return;

    reset(ctx, w, h);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(src.c, 0, 0);
    const rng = new Rng(Math.floor(env.t * env.fps * 3) + 17);

    const n = Math.round(p.slices * amp);
    for (let i = 0; i < n; i++) {
      const sy = Math.floor(rng.range(0, h));
      const sh = Math.floor(rng.range(3, h * 0.08));
      const ox = (rng.next() * 2 - 1) * p.shift * amp;
      ctx.drawImage(src.c, 0, sy, w, sh, ox, sy, w, sh);
    }

    if (p.rgb > 0) {
      const sep = 10 * p.rgb * amp;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.5 * Math.min(1, amp);
      ctx.drawImage(tint(src.c, '#ff0000', w, h), sep, 0);
      ctx.drawImage(tint(src.c, '#0000ff', w, h), -sep, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    const acc = color(p.blockColor, palette.orange);
    ctx.globalAlpha = 0.85 * Math.min(1, amp);
    ctx.fillStyle = acc;
    for (let i = 0; i < Math.round(6 * amp); i++) {
      ctx.fillRect(rng.range(0, w), rng.range(0, h), rng.range(20, w * 0.35), rng.range(2, 14));
    }

    ctx.globalAlpha = 1;
    const fl = Math.max(1, p.flashes);
    for (let i = 0; i < fl; i++) {
      const ft = fl === 1 ? 0 : i / (fl - 1);
      if (Math.abs(u - ft) < 0.07 / Math.max(0.3, p.amount)) {
        ctx.fillStyle = i % 2 === 0 ? '#fff' : '#000';
        ctx.globalAlpha = 0.9;
        ctx.fillRect(0, 0, w, h);
      }
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const letterboxPush = {
  id: 'letterbox-push',
  name: '遮幅推入',
  category: 'transition',
  hint: '上下黑边推进来把画面压成宽银幕，常配合章节切换。',
  params: [
    { key: 'ratio', label: '目标画幅比', type: 'number', default: 2.39, min: 1, max: 3, step: 0.01 },
    { key: 'holdIn', label: '保持占比', type: 'number', default: 0.4, min: 0, max: 0.9, step: 0.05 },
    { key: 'caption', label: '档位文字', type: 'string', default: '' },
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const u = clamp(env.progress, 0, 1);
    const target = Math.max(0, (h - w / p.ratio) / 2);
    if (target <= 0) return;
    const k = u < 0.35
      ? easeOutCubic(u / 0.35)
      : u < 0.35 + p.holdIn
        ? 1
        : 1 - easeOutCubic((u - 0.35 - p.holdIn) / Math.max(0.05, 1 - 0.35 - p.holdIn));
    const bar = target * clamp(k, 0, 1);
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, bar);
    ctx.fillRect(0, h - bar, w, bar);
    if (p.caption && bar > 4) {
      label(ctx, p.caption, w / 2, bar + 10, { align: 'center', size: 12, color: color(p.accent, palette.orange) });
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const rgbSplit = {
  id: 'rgb-split',
  name: '色散冲击',
  category: 'transition',
  hint: '整帧 RGB 拉开并抖动，比 glitch-burst 更克制，适合做"数据异常"。',
  params: [
    { key: 'amount', label: '色散像素', type: 'number', default: 14, min: 0, max: 80, step: 1 },
    { key: 'jitter', label: '抖动', type: 'number', default: 6, min: 0, max: 40, step: 1 },
    { key: 'scan', label: '附加扫描线', type: 'bool', default: true },
    { key: 'double', label: '双向', type: 'bool', default: false },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const src = grab(ctx, w, h, '_rgb');
    const u = clamp(env.progress, 0, 1);
    const k = Math.sin(Math.PI * u);
    reset(ctx, w, h);
    const rng = new Rng(Math.floor(env.t * env.fps * 2) + 5);
    const jx = (rng.next() * 2 - 1) * p.jitter * k;
    const sep = p.amount * k;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(src.c, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.5;
    ctx.drawImage(tint(src.c, '#ff0000', w, h), -sep + jx, 0);
    ctx.drawImage(tint(src.c, '#0000ff', w, h), sep - jx, 0);
    if (p.double) ctx.drawImage(tint(src.c, '#ff0000', w, h), sep + jx, 0);
    ctx.restore();
    if (p.scan) scanlines(ctx, 0, 0, w, h, { step: 3, color: 'rgba(0,0,0,0.3)', alpha: 0.6 * k });
  },
};

export default [glitchBurst, letterboxPush, rgbSplit];
