// ============================================================================
// 转场 / 动效类模板
// 两类：
//  1) 遮罩式（flash / shutter / halftone / scan）—— 用来盖住剪辑点
//  2) 变换式（whip-pan / zoom / shake）—— 直接对底下画面做位移、缩放、动态模糊
// 变换式会先快照整帧再重绘，所以它必须放在图层栈最上面。
// ============================================================================

import {
  label, ui, palette, measure, scanlines, fullRect,
} from '../engine/draw.js';
import {
  clamp, Rng, easeOutExpo, easeInExpo, easeInOutCubic, easeOutCubic,
} from '../engine/core.js';
import { color, trng, P, fmtNumber } from './_lib.js';

// ---- 离屏缓存 -------------------------------------------------------------
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
export const whipPan = {
  id: 'whip-pan',
  name: '甩镜转场',
  category: 'transition',
  hint: '画面高速横移 + 拖影，用来连接两个不同景别。放在 0.25~0.5 秒的短图层上。',
  params: [
    { key: 'direction', label: '方向', type: 'select', default: 'right', options: ['left', 'right', 'up', 'down'] },
    { key: 'amount', label: '幅度(屏幕倍数)', type: 'number', default: 1.6, min: 0.2, max: 4, step: 0.1 },
    { key: 'trails', label: '拖影层数', type: 'number', default: 7, min: 1, max: 24, step: 1 },
    { key: 'streaks', label: '速度线', type: 'bool', default: true },
    { key: 'flashAtEnd', label: '结尾闪白', type: 'bool', default: false },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const src = grab(ctx, w, h, '_whip');
    reset(ctx, w, h);
    const u = clamp(env.progress, 0, 1);
    const speed = Math.sin(Math.PI * u);
    const dist = p.amount * speed;
    const dir = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[p.direction] || [1, 0];
    const dx = dir[0] * w * dist, dy = dir[1] * h * dist;

    const n = Math.max(1, Math.round(p.trails));
    for (let i = n - 1; i >= 0; i--) {
      const k = i / n;
      ctx.save();
      ctx.globalAlpha = 1 - k * 0.82;
      ctx.filter = k > 0 ? 'blur(' + (k * 22).toFixed(1) + 'px)' : 'none';
      ctx.drawImage(src.c, -dx * k, -dy * k);
      ctx.restore();
    }
    if (p.streaks) {
      const rng = new Rng(env.frame * 977);
      ctx.save();
      ctx.globalAlpha = 0.35 * speed;
      ctx.fillStyle = '#fff';
      const horiz = Math.abs(dir[0]) > 0;
      for (let i = 0; i < 90; i++) {
        if (horiz) {
          const y = rng.range(0, h), len = rng.range(w * 0.05, w * 0.4), th = rng.range(1, 3);
          ctx.fillRect(rng.range(-len, w), y, len, th);
        } else {
          const x = rng.range(0, w), len = rng.range(h * 0.05, h * 0.4), th = rng.range(1, 3);
          ctx.fillRect(x, rng.range(-len, h), th, len);
        }
      }
      ctx.restore();
    }
    if (p.flashAtEnd) {
      const f = clamp((u - 0.78) / 0.22, 0, 1) * (1 - clamp((u - 0.9) / 0.1, 0, 1));
      fullRect(ctx, w, h, '#fff', f);
    }
  },
};

// ---------------------------------------------------------------------------
export const zoomPunch = {
  id: 'zoom-punch',
  name: '冲击推近',
  category: 'transition',
  hint: '瞬间放大 + 径向速度线 + 轻微旋转，鼓点上用最爽。',
  params: [
    { key: 'amount', label: '放大量', type: 'number', default: 0.35, min: 0.02, max: 1.5, step: 0.01 },
    { key: 'rotate', label: '旋转(度)', type: 'number', default: 1.2, min: 0, max: 12, step: 0.1 },
    { key: 'blur', label: '模糊', type: 'number', default: 10, min: 0, max: 60, step: 1 },
    { key: 'streaks', label: '径向速度线', type: 'bool', default: true },
    { key: 'flash', label: '起始闪白', type: 'bool', default: true },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const src = grab(ctx, w, h, '_zoom');
    reset(ctx, w, h);
    const u = clamp(env.progress, 0, 1);
    const k = Math.pow(1 - u, 2);
    const scale = 1 + p.amount * k;
    const cx = w / 2, cy = h / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(((p.rotate * Math.PI) / 180) * k);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    if (p.blur > 0 && k > 0.02) ctx.filter = 'blur(' + (p.blur * k).toFixed(1) + 'px)';
    ctx.drawImage(src.c, 0, 0);
    ctx.restore();

    if (p.streaks && k > 0.05) {
      const rng = new Rng(env.frame * 313);
      ctx.save();
      ctx.globalAlpha = 0.4 * k;
      ctx.strokeStyle = '#fff';
      for (let i = 0; i < 70; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r0 = rng.range(0.15, 0.5) * Math.max(w, h);
        const r1 = r0 + rng.range(40, 320) * k;
        ctx.lineWidth = rng.range(0.5, 2.5);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (p.flash) fullRect(ctx, w, h, '#fff', Math.pow(1 - clamp(u / 0.25, 0, 1), 2) * 0.85);
  },
};

// ---------------------------------------------------------------------------
export const camShake = {
  id: 'cam-shake',
  name: '镜头震动',
  category: 'transition',
  hint: '低频冲击带来的机震，卡在重低音上。',
  params: [
    { key: 'amount', label: '强度(像素)', type: 'number', default: 26, min: 0, max: 160, step: 1 },
    { key: 'freq', label: '频率', type: 'number', default: 26, min: 4, max: 90, step: 1 },
    { key: 'decay', label: '衰减', type: 'number', default: 2.2, min: 0.2, max: 6, step: 0.1 },
    { key: 'roll', label: '旋转抖动(度)', type: 'number', default: 0.8, min: 0, max: 8, step: 0.1 },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const src = grab(ctx, w, h, '_shake');
    reset(ctx, w, h);
    const u = clamp(env.progress, 0, 1);
    const amp = p.amount * Math.pow(1 - u, p.decay);
    const rng = new Rng(Math.floor(env.t * p.freq) * 7919 + 13);
    const dx = (rng.next() * 2 - 1) * amp;
    const dy = (rng.next() * 2 - 1) * amp;
    const rot = ((rng.next() * 2 - 1) * p.roll * Math.PI) / 180;
    const ex = Math.abs(dx) + 2, ey = Math.abs(dy) + 2;
    ctx.save();
    ctx.translate(w / 2 + dx, h / 2 + dy);
    ctx.rotate(rot);
    ctx.translate(-w / 2, -h / 2);
    ctx.drawImage(src.c, 0, 0, w, h, -ex, -ey, w + ex * 2, h + ey * 2);
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const flashCut = {
  id: 'flash-cut',
  name: '闪白硬切',
  category: 'transition',
  hint: '最省事也最有效的卡点手段：一帧白（或黑/橙）盖住剪辑点。',
  params: [
    { key: 'fillColor', label: '颜色', type: 'color', default: '#ffffff' },
    { key: 'peak', label: '峰值不透明度', type: 'number', default: 1, min: 0.1, max: 1, step: 0.02 },
    { key: 'fadeIn', label: '上升占比', type: 'number', default: 0.45, min: 0.02, max: 1, step: 0.02 },
    { key: 'bar', label: '附加横条', type: 'bool', default: false },
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const u = clamp(env.progress, 0, 1);
    const a = u < p.fadeIn
      ? Math.pow(u / Math.max(0.001, p.fadeIn), 0.6)
      : Math.pow(1 - (u - p.fadeIn) / Math.max(0.001, 1 - p.fadeIn), 1.6);
    fullRect(ctx, w, h, color(p.fillColor, '#fff'), clamp(a, 0, 1) * p.peak);
    if (p.bar) {
      const acc = color(p.accent, palette.orange);
      const bh = h * 0.06;
      ctx.save();
      ctx.globalAlpha = clamp(a, 0, 1) * 0.9;
      ctx.fillStyle = acc;
      ctx.fillRect(0, h / 2 - bh / 2, w, bh);
      ctx.restore();
    }
  },
};

// ---------------------------------------------------------------------------
export const shutterWipe = {
  id: 'shutter-wipe',
  name: '百叶窗划像',
  category: 'transition',
  hint: '一排横条同时合上再拉开，比纯闪白更有设计感。',
  params: [
    { key: 'rows', label: '条数', type: 'number', default: 9, min: 2, max: 60, step: 1 },
    { key: 'fillColor', label: '颜色', type: 'color', default: '#0a0a0a' },
    { key: 'accent', label: '强调线', type: 'bool', default: true },
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const u = clamp(env.progress, 0, 1);
    const cover = u < 0.5 ? easeOutCubic(u / 0.5) : 1 - easeOutCubic((u - 0.5) / 0.5);
    const rows = Math.max(2, p.rows);
    const rh = h / rows;
    ctx.save();
    ctx.fillStyle = color(p.fillColor, '#0a0a0a');
    for (let i = 0; i < rows; i++) {
      const c = rh * cover;
      ctx.fillRect(0, i * rh + (rh - c) / 2, w, c);
    }
    if (p.accent) {
      ctx.fillStyle = color(p.accent, palette.orange);
      ctx.globalAlpha = cover * 0.9;
      ctx.fillRect(0, h * 0.5 - 1.5, w, 3);
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const halftoneRise = {
  id: 'halftone-rise',
  name: '网点升起',
  category: 'transition',
  hint: '半调网点从下方长出来吃掉画面，再退回去。印刷/漫画感的转场。',
  params: [
    { key: 'fillColor', label: '颜色', type: 'color', default: '#0a0a0a' },
    { key: 'dot', label: '网点直径', type: 'number', default: 7, min: 2, max: 30, step: 1 },
    { key: 'gap', label: '网点间距', type: 'number', default: 11, min: 3, max: 60, step: 1 },
    { key: 'direction', label: '方向', type: 'select', default: 'up', options: ['up', 'down', 'left', 'right'] },
    { key: 'jitter', label: '随机抖动', type: 'number', default: 0.4, min: 0, max: 1, step: 0.05 },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const u = clamp(env.progress, 0, 1);
    const cover = u < 0.5 ? easeOutExpo(u / 0.5) : 1 - easeInExpo((u - 0.5) / 0.5);
    const rng = trng(env, 'ht');
    const col = color(p.fillColor, '#0a0a0a');
    const step = p.gap;
    ctx.save();
    ctx.fillStyle = col;
    for (let gy = -step; gy < h + step; gy += step) {
      for (let gx = -step; gx < w + step; gx += step) {
        const nx = gx / w, ny = gy / h;
        let local;
        if (p.direction === 'up') local = 1 - ny;
        else if (p.direction === 'down') local = ny;
        else if (p.direction === 'left') local = 1 - nx;
        else local = nx;
        const kk = clamp((cover - local * 0.8) / 0.2, 0, 1);
        if (kk <= 0) continue;
        const jitter = 1 + (rng.next() - 0.5) * p.jitter * 0.6;
        ctx.beginPath();
        ctx.arc(gx + step / 2, gy + step / 2, (p.dot / 2) * kk * jitter, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const scanWipe = {
  id: 'scan-wipe',
  name: '扫描带转场',
  category: 'transition',
  hint: '一条扫描带从上（或下）扫过，带边缘辉光和小读数。科技感转场。',
  params: [
    { key: 'fillColor', label: '底色', type: 'color', default: '#0a0a0a' },
    { key: 'band', label: '扫描带高度', type: 'number', default: 220, min: 20, max: 800, step: 5 },
    { key: 'direction', label: '方向', type: 'select', default: 'down', options: ['down', 'up'] },
    { key: 'glowColor', label: '辉光色', type: 'color', default: '#00e5ff' },
    { key: 'readout', label: '显示读数', type: 'bool', default: true },
  ],
  draw(ctx, env) {
    const { width: w, height: h, params: p } = env;
    const u = clamp(env.progress, 0, 1);
    const cover = u < 0.5 ? easeInOutCubic(u / 0.5) : 1 - easeInOutCubic((u - 0.5) / 0.5);
    const col = color(p.fillColor, '#0a0a0a');
    const glow = color(p.glowColor, palette.cyan);
    const dir = p.direction === 'up' ? -1 : 1;
    const edge = dir > 0 ? cover * h : (1 - cover) * h;
    ctx.save();
    ctx.fillStyle = col;
    if (dir > 0) ctx.fillRect(0, 0, w, edge);
    else ctx.fillRect(0, edge, w, h - edge);
    const g = ctx.createLinearGradient(0, edge - p.band / 2, 0, edge + p.band / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, glow);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = g;
    ctx.fillRect(0, edge - p.band / 2, w, p.band);
    ctx.globalAlpha = 1;
    ctx.fillStyle = glow;
    ctx.fillRect(0, edge - 1.5, w, 3);
    if (p.readout) {
      const rng = new Rng(env.frame * 541);
      ctx.globalAlpha = 0.85;
      label(ctx, 'SCAN ' + fmtNumber(cover * 100, { decimals: 1, pad: 5 }) + '%  ' + String(env.frame).padStart(5, '0'), 40, edge + 14, { size: 13, color: glow });
      ctx.globalAlpha = 0.5;
      for (let i = 0; i < 24; i++) {
        ctx.fillRect(rng.range(0, w), edge + rng.range(-6, 6), rng.range(4, 60), 1);
      }
    }
    ctx.restore();
  },
};

export default [whipPan, zoomPunch, camShake, flashCut, shutterWipe, halftoneRise, scanWipe];
