// ============================================================================
// 秩序 / 混沌 · 延伸篇
//
//   type-stack   压扁大字（横排 / 竖排，末尾橙点，可高亮某个词）
//   dot-matrix   规则点阵的同类崩坏（点会位移、消失、混橙的）
//   line-sweep   扫描线扫过，扫到哪儿哪儿才"显影"
//   chaos-meter  角上的监测仪读数（数值 + 状态词 + 迷你趋势）
// ============================================================================

import { clamp, smoothstep, easeOutCubic } from '../engine/core.js';
import { FONTS, ui, text, label, measure, fitSize, roundRect } from '../engine/draw.js';
import { color } from './_lib.js';

const TAU = Math.PI * 2;
const INK = '#111214';
const PAPER = '#f2f0ea';
const ORANGE = '#ff4a1c';

function nums(s, n = 2, def = [0.5, 0.5]) {
  const a = String(s || '').split(',').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number.isFinite(a[i]) ? a[i] : def[i]);
  return out;
}
function ramp(t, a, b) { return smoothstep(a, b, t); }

// ---------------------------------------------------------------------------
export const typeStack = {
  id: 'type-stack',
  name: '压扁大字',
  category: 'chaos',
  hint: '压扁的大写标题，行距很紧，末尾跟一个橙点；也能竖排（中文标题好用），还能高亮某个词。',
  params: [
    { key: 'text', label: '文字（换行=多行）', type: 'multiline', default: 'THE GRID\nIS LYING' },
    { key: 'mode', label: '排法', type: 'select', default: 'stack', options: ['stack', 'vertical', 'inline'] },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.09,0.74' },
    { key: 'size', label: '字号', type: 'number', default: 116, min: 18, max: 400, step: 2 },
    { key: 'maxWidth', label: '最大宽度[0-1]', type: 'number', default: 0.62, min: 0.1, max: 1, step: 0.02 },
    { key: 'lineHeight', label: '行距倍数', type: 'number', default: 0.86, min: 0.6, max: 1.6, step: 0.02 },
    { key: 'tracking', label: '字距', type: 'number', default: -0.01, min: -0.1, max: 0.3, step: 0.01 },
    { key: 'align', label: '对齐', type: 'select', default: 'left', options: ['left', 'center', 'right'] },
    { key: 'period', label: '末尾橙点', type: 'bool', default: true },
    { key: 'accentWord', label: '高亮词（可空）', type: 'string', default: '' },
    { key: 'stagger', label: '逐行错峰(秒)', type: 'number', default: 0.09, min: 0, max: 1, step: 0.01 },
    { key: 'paper', label: '纸白底', type: 'bool', default: false },
    { key: 'ink', label: '墨色', type: 'color', default: '#111214' },
    { key: 'paperColor', label: '纸色', type: 'color', default: '#f2f0ea' },
    { key: 'accent', label: '强调色', type: 'color', default: '#ff4a1c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.6, min: 0.05, max: 4, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 4, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.ink, INK);
    const acc = color(p.accent, ORANGE);
    const lines = String(p.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const maxW = W * p.maxWidth;
    const size = fitSize(ctx, lines.reduce((a, b) => (a.length >= b.length ? a : b)), maxW, {
      font: FONTS.condensed, size: p.size, weight: 700, tracking: p.size * p.tracking, min: 12,
    });
    const [nx, ny] = nums(p.position, 2, [0.09, 0.74]);
    const lh = size * p.lineHeight;

    ctx.save();
    ctx.globalAlpha = out;
    if (p.paper) {
      ctx.globalAlpha = out * ramp(env.local, 0, p.inDur * 0.5);
      ctx.fillStyle = color(p.paperColor, PAPER);
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = out;
    }

    // 竖向：每个字一格里往下排；多行就是多列
    if (p.mode === 'vertical') {
      const cols = lines;
      const colGap = size * 1.25;
      const totalW = (cols.length - 1) * colGap;
      const x0 = W * nx - (p.align === 'center' ? totalW / 2 : p.align === 'right' ? totalW : 0);
      const top = H * ny - size * 1.2;
      cols.forEach((ln, ci) => {
        const tLine = easeOutCubic(clamp((env.local - ci * p.stagger) / Math.max(0.1, p.inDur), 0, 1));
        if (tLine <= 0) return;
        const cx2 = x0 + ci * colGap;
        ctx.save();
        ctx.globalAlpha = out * tLine;
        ctx.translate(0, (1 - tLine) * -size * 0.18);
        [...ln].forEach((ch, i) => {
          const isAcc = p.accentWord && ln.includes(p.accentWord) && ch !== '';
          text(ctx, ch, cx2, top + lh * (i + 0.8), {
            font: FONTS.condensed, size, weight: 700, color: isAcc ? acc : ink,
            align: p.align === 'center' ? 'center' : p.align === 'right' ? 'right' : 'left',
            baseline: 'alphabetic', tracking: size * p.tracking,
          });
        });
        // 竖排的收尾重点
        if (p.period && ci === cols.length - 1) {
          const last = [...ln].length;
          ctx.beginPath();
          ctx.arc(cx2 + size * 0.06, top + lh * (last + 0.22), size * 0.105, 0, TAU);
          ctx.fillStyle = acc;
          ctx.fill();
        }
        ctx.restore();
      });
      ctx.restore();
      return;
    }

    // 横排 / 堆叠
    const rows = p.mode === 'inline' ? [lines.join(' ')] : lines;
    const alignX = p.align === 'center' ? W * nx : p.align === 'right' ? W * nx : W * nx;
    rows.forEach((s, i) => {
      const tLine = easeOutCubic(clamp((env.local - i * p.stagger) / Math.max(0.1, p.inDur), 0, 1));
      if (tLine <= 0) return;
      ctx.save();
      ctx.globalAlpha = out * tLine;
      ctx.translate(0, (1 - tLine) * size * 0.16);
      const segs = [];
      if (p.accentWord && s.includes(p.accentWord)) {
        const parts = s.split(p.accentWord);
        parts.forEach((part, k) => {
          if (part) segs.push({ s: part, acc: false });
          if (k < parts.length - 1) segs.push({ s: p.accentWord, acc: true });
        });
      } else segs.push({ s, acc: false });
      let cursorX = alignX;
      if (p.align === 'center') cursorX = alignX - measure(ctx, s, { font: FONTS.condensed, size, weight: 700, tracking: size * p.tracking }) / 2;
      if (p.align === 'right') cursorX = alignX - measure(ctx, s, { font: FONTS.condensed, size, weight: 700, tracking: size * p.tracking });
      const y = H * ny + lh * i;
      for (const seg of segs) {
        const wSeg = text(ctx, seg.s, cursorX, y, {
          font: FONTS.condensed, size, weight: 700, color: seg.acc ? acc : ink,
          align: 'left', baseline: 'alphabetic', tracking: size * p.tracking,
        });
        cursorX += wSeg;
      }
      if (p.period && i === rows.length - 1) {
        const pop = 1 + 0.55 * Math.max(0, Math.sin(clamp((env.local - p.inDur * 0.9) / 0.32, 0, 1) * Math.PI));
        ctx.beginPath();
        ctx.arc(cursorX + size * 0.1, y - size * 0.12, size * 0.105 * pop, 0, TAU);
        ctx.fillStyle = acc;
        ctx.fill();
      }
      ctx.restore();
    });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const chaosMeter = {
  id: 'chaos-meter',
  name: '混沌读数',
  category: 'chaos',
  hint: '角上的监测仪：大数字 + 横条 + ORDER/CHAOS 状态词 + 迷你趋势线。数值可以自动往上走。',
  params: [
    { key: 'position', label: '位置', type: 'select', default: 'tr', options: ['tl', 'tr', 'bl', 'br'] },
    { key: 'title', label: '标题', type: 'string', default: 'CHAOS INDEX' },
    { key: 'value', label: '数值[0-1]', type: 'number', default: 0.42, min: 0, max: 1, step: 0.01 },
    { key: 'auto', label: '自动升到 1', type: 'bool', default: true },
    { key: 'autoDur', label: '升到 1 用时(秒)', type: 'number', default: 6, min: 0.5, max: 60, step: 0.5 },
    { key: 'threshold', label: '转 CHAOS 的阈值', type: 'number', default: 0.5, min: 0, max: 1, step: 0.02 },
    { key: 'labelA', label: '低状态词', type: 'string', default: 'ORDER' },
    { key: 'labelB', label: '高状态词', type: 'string', default: 'CHAOS' },
    { key: 'spark', label: '迷你趋势线', type: 'bool', default: true },
    { key: 'sparkN', label: '趋势采样点数', type: 'number', default: 22, min: 6, max: 60, step: 1 },
    { key: 'margin', label: '边距(px)', type: 'number', default: 56, min: 12, max: 200, step: 2 },
    { key: 'size', label: '大数字字号', type: 'number', default: 48, min: 14, max: 140, step: 2 },
    { key: 'ink', label: '墨色', type: 'color', default: '#111214' },
    { key: 'accent', label: '强调色', type: 'color', default: '#ff4a1c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.5, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.ink, INK);
    const acc = color(p.accent, ORANGE);
    const m = p.margin;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    // 数值：手动 or 自动从 0 涨到 1
    const v = clamp(p.auto ? ramp(env.local, p.inDur * 0.4, Math.max(p.inDur * 0.5, p.autoDur)) : p.value, 0, 1);
    const high = v >= p.threshold;
    const col = high ? acc : ink;
    const size = p.size;
    const small = Math.max(11, Math.round(size * 0.3));
    const bw = size * 7.2;
    const right = p.position === 'tr' || p.position === 'br';
    const bottom = p.position === 'bl' || p.position === 'br';
    const x0 = right ? W - m - bw : m;
    const y0 = bottom ? H - m - size * 3.9 : m + size * 0.6;

    ctx.save();
    ctx.globalAlpha = out;
    ctx.translate(0, (1 - t) * 10 * (bottom ? 1 : -1));
    // 标题
    label(ctx, p.title, x0, y0, {
      font: FONTS.mono, size: small, color: ink, align: 'left', baseline: 'alphabetic',
      tracking: small * 0.22, alpha: 0.7,
    });
    // 大数字 + 百分号
    const numTxt = String(Math.round(v * 100)).padStart(2, '0');
    const wNum = text(ctx, numTxt, x0, y0 + size * 1.05, {
      font: FONTS.condensed, size, weight: 700, color: col, align: 'left', baseline: 'alphabetic',
      tracking: -size * 0.02,
    });
    label(ctx, '%', x0 + wNum + small * 0.2, y0 + size * 1.05, {
      font: FONTS.mono, size: small * 1.1, color: col, align: 'left', baseline: 'alphabetic',
    });
    // 状态词：超过阈值才变橙，并且会闪一下
    const blink = high ? 0.75 + 0.25 * Math.sin(env.t * 7) : 0.75;
    label(ctx, high ? p.labelB : p.labelA, x0 + bw, y0 + small * 1.1, {
      font: FONTS.mono, size: small * 1.15, color: col, align: 'right', baseline: 'alphabetic',
      tracking: small * 0.24, alpha: blink,
    });
    // 横条
    const barY = y0 + size * 1.5;
    ctx.fillStyle = 'rgba(17,18,20,0.18)';
    ctx.fillRect(x0, barY, bw, Math.max(3, size * 0.09));
    ctx.fillStyle = col;
    ctx.fillRect(x0, barY, bw * v, Math.max(3, size * 0.09));
    // 阈值刻度
    ctx.fillStyle = ink;
    ctx.fillRect(x0 + bw * p.threshold - 1, barY - size * 0.12, 2, Math.max(3, size * 0.09) + size * 0.24);
    // 迷你趋势线
    if (p.spark) {
      const n = Math.max(6, p.sparkN);
      const sh = size * 1.05, sy = barY + size * 0.5;
      ctx.strokeStyle = col;
      ctx.lineWidth = Math.max(1, size * 0.045);
      ctx.globalAlpha = out * 0.85;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const vt = clamp(p.auto ? (v / Math.max(0.0001, k + 0.02)) * 0.9 + Math.sin(k * 9 + env.t) * 0.04 : p.value + Math.sin(k * 7 + env.t * 0.6) * 0.06, 0, 1);
        const x = x0 + bw * k;
        const y = sy + sh - sh * vt;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = out;
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const lineSweep = {
  id: 'line-sweep',
  name: '扫描显影',
  category: 'chaos',
  hint: '一条扫描线扫过，扫到哪儿哪儿才显影（网格/点阵），角上带百分比读数。',
  params: [
    { key: 'dir', label: '方向', type: 'select', default: 'down', options: ['down', 'up', 'right', 'left'] },
    { key: 'speed', label: '扫完用时(秒)', type: 'number', default: 3.2, min: 0.4, max: 30, step: 0.1 },
    { key: 'hold', label: '扫完后保持(秒)', type: 'number', default: 0.8, min: 0, max: 10, step: 0.1 },
    { key: 'loop', label: '循环', type: 'bool', default: false },
    { key: 'content', label: '显影内容', type: 'select', default: 'grid', options: ['grid', 'dots', 'both'] },
    { key: 'cols', label: '网格列数', type: 'number', default: 22, min: 2, max: 80, step: 1 },
    { key: 'rows', label: '网格行数', type: 'number', default: 13, min: 2, max: 80, step: 1 },
    { key: 'chaos', label: '显影后的混沌[0-1]', type: 'number', default: 0.25, min: 0, max: 1, step: 0.02 },
    { key: 'trail', label: '拖尾(px)', type: 'number', default: 120, min: 0, max: 600, step: 10 },
    { key: 'readout', label: '角上读数', type: 'bool', default: true },
    { key: 'lineW', label: '线宽', type: 'number', default: 13, min: 1, max: 60, step: 1 },
    { key: 'paper', label: '纸白底', type: 'bool', default: true },
    { key: 'ink', label: '墨色', type: 'color', default: '#111214' },
    { key: 'paperColor', label: '纸色', type: 'color', default: '#f2f0ea' },
    { key: 'accent', label: '扫描线色', type: 'color', default: '#ff4a1c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.2, min: 0, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.ink, INK);
    const acc = color(p.accent, ORANGE);
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const t0 = p.inDur;
    const cycle = Math.max(0.2, p.speed) + Math.max(0, p.hold);
    let local = Math.max(0, env.local - t0);
    if (p.loop) local = local % cycle;
    const k = clamp(local / Math.max(0.2, p.speed), 0, 1);
    const down = p.dir === 'down' || p.dir === 'up';
    const rng = env.rng;

    ctx.save();
    ctx.globalAlpha = out;
    if (p.paper) {
      ctx.fillStyle = color(p.paperColor, PAPER);
      ctx.fillRect(0, 0, W, H);
    }

    // 显影内容：只画"扫过"的那一侧
    const cut = down ? (p.dir === 'down' ? H * k : H * (1 - k)) : (p.dir === 'right' ? W * k : W * (1 - k));
    ctx.save();
    ctx.beginPath();
    if (p.dir === 'down') ctx.rect(0, 0, W, cut);
    else if (p.dir === 'up') ctx.rect(0, cut, W, H - cut);
    else if (p.dir === 'right') ctx.rect(0, 0, cut, H);
    else ctx.rect(cut, 0, W - cut, H);
    ctx.clip();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1.1;
    const chaos = clamp(p.chaos, 0, 1);
    if (p.content !== 'dots') {
      for (let i = 0; i <= p.cols; i++) {
        const nx = i / p.cols;
        ctx.beginPath();
        for (let s = 0; s <= 20; s++) {
          const ny = s / 20;
          const wob = Math.sin(ny * 4.2 + env.t * 0.35) * 0.02 * chaos;
          const x = W * (0.06 + nx * 0.88) + wob * W, y = H * (0.1 + ny * 0.8);
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      for (let j = 0; j <= p.rows; j++) {
        const ny = j / p.rows;
        ctx.beginPath();
        for (let s = 0; s <= 20; s++) {
          const nx = s / 20;
          const wob = Math.cos(nx * 3.8 - env.t * 0.3) * 0.02 * chaos;
          const x = W * (0.06 + nx * 0.88), y = H * (0.1 + ny * 0.8) + wob * H;
          if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    if (p.content !== 'grid') {
      const cols = Math.round(p.cols * 1.2), rows = Math.round(p.rows * 1.2);
      for (let j = 0; j <= rows; j++) {
        for (let i = 0; i <= cols; i++) {
          const nx = i / cols, ny = j / rows;
          const dx = (rng.next() * 2 - 1) * 0.015 * chaos * W;
          const dy = (rng.next() * 2 - 1) * 0.015 * chaos * H;
          ctx.beginPath();
          ctx.arc(W * (0.06 + nx * 0.88) + dx, H * (0.1 + ny * 0.8) + dy, 2.2 * (1 - chaos * 0.3), 0, TAU);
          ctx.fill();
        }
      }
    }
    ctx.restore();

    // 扫描线 + 拖尾
    const linePos = down
      ? (p.dir === 'down' ? H * k : H * (1 - k))
      : (p.dir === 'right' ? W * k : W * (1 - k));
    if (k < 1 || p.loop) {
      ctx.save();
      const g = down
        ? ctx.createLinearGradient(0, linePos - p.trail, 0, linePos + p.trail)
        : ctx.createLinearGradient(linePos - p.trail, 0, linePos + p.trail, 0);
      const mid = down && p.dir === 'up' ? '0' : '1';
      g.addColorStop(0, mid === '1' ? 'rgba(255,74,28,0)' : 'rgba(255,74,28,0.5)');
      g.addColorStop(1, mid === '1' ? 'rgba(255,74,28,0.5)' : 'rgba(255,74,28,0)');
      ctx.fillStyle = 'rgba(255,74,28,0.16)';
      ctx.globalAlpha = out * 0.9;
      if (down) ctx.fillRect(0, Math.min(linePos, linePos), W, Math.max(2, p.lineW * 0.5));
      else ctx.fillRect(linePos, 0, Math.max(2, p.lineW * 0.5), H);
      ctx.globalAlpha = out;
      ctx.fillStyle = acc;
      if (down) ctx.fillRect(0, linePos - p.lineW / 2, W, p.lineW);
      else ctx.fillRect(linePos - p.lineW / 2, 0, p.lineW, H);
      ctx.restore();
    }

    // 角上读数
    if (p.readout) {
      const fs = Math.max(13, Math.round(Math.min(W, H) * 0.022));
      const txt = `SCAN ${String(Math.round(k * 100)).padStart(3, '0')}%`;
      const wTxt = measure(ctx, txt, { font: FONTS.mono, size: fs, tracking: fs * 0.16 }) + fs * 1.6;
      ctx.globalAlpha = out;
      ctx.fillStyle = ink;
      ctx.fillRect(W - wTxt - 46, 40, wTxt, fs * 2.2);
      label(ctx, txt, W - wTxt - 46 + fs * 0.8, 40 + fs * 1.5, {
        font: FONTS.mono, size: fs, color: PAPER, align: 'left', baseline: 'alphabetic', tracking: fs * 0.16,
      });
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const dotMatrix = {
  id: 'dot-matrix',
  name: '点阵崩坏',
  category: 'chaos',
  hint: '规则圆点阵，chaos 越大点越会位移、消失、散开；混几个橙点当重音。',
  params: [
    { key: 'region', label: '范围 x,y,w,h', type: 'string', default: '0.08,0.20,0.84,0.62' },
    { key: 'cols', label: '列数', type: 'number', default: 26, min: 2, max: 90, step: 1 },
    { key: 'rows', label: '行数', type: 'number', default: 15, min: 2, max: 90, step: 1 },
    { key: 'dotR', label: '点半径', type: 'number', default: 2.6, min: 0.6, max: 14, step: 0.2 },
    { key: 'chaos', label: '混沌程度[0-1]', type: 'number', default: 0.4, min: 0, max: 1, step: 0.02 },
    { key: 'auto', label: '自动崩坏', type: 'bool', default: false },
    { key: 'autoDur', label: '崩坏用时(秒)', type: 'number', default: 6, min: 0.5, max: 60, step: 0.5 },
    { key: 'accentCount', label: '橙点数', type: 'number', default: 3, min: 0, max: 20, step: 1 },
    { key: 'paper', label: '纸白底', type: 'bool', default: true },
    { key: 'ink', label: '墨色', type: 'color', default: '#111214' },
    { key: 'paperColor', label: '纸色', type: 'color', default: '#f2f0ea' },
    { key: 'accent', label: '强调色', type: 'color', default: '#ff4a1c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.6, min: 0, max: 4, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.4, min: 0, max: 4, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.ink, INK);
    const acc = color(p.accent, ORANGE);
    const r0 = nums(p.region, 4, [0.08, 0.2, 0.84, 0.62]);
    const bx = W * r0[0], by = H * r0[1], bw = W * r0[2], bh = H * r0[3];
    const rng = env.rng;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const tIn = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    const chaos = clamp(p.auto ? ramp(env.local, p.inDur * 0.4, Math.max(0.6, p.autoDur)) : p.chaos, 0, 1);

    ctx.save();
    ctx.globalAlpha = out;
    if (p.paper) {
      ctx.globalAlpha = out * tIn;
      ctx.fillStyle = color(p.paperColor, PAPER);
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = out;
    }
    const total = (p.cols + 1) * (p.rows + 1);
    let idx = 0;
    for (let j = 0; j <= p.rows; j++) {
      for (let i = 0; i <= p.cols; i++, idx++) {
        const nx = i / p.cols, ny = j / p.rows;
        // 入场：从左上往右下扫过来
        const pop = clamp((tIn - (nx + ny) * 0.35) / 0.4, 0, 1);
        if (pop <= 0) continue;
        const wob = Math.sin(nx * 5.1 + env.t * 0.4) * Math.cos(ny * 4.3 - env.t * 0.3);
        const dx = (wob * 0.03 + (rng.next() * 2 - 1) * 0.02 * chaos) * bw * chaos;
        const dy = (wob * 0.02 + (rng.next() * 2 - 1) * 0.02 * chaos) * bh * chaos;
        const gone = rng.next() < chaos * 0.42;
        const r = p.dotR * (1 - chaos * 0.35) * pop * (gone ? 0.25 : 1);
        if (r <= 0.2) continue;
        const x = bx + nx * bw + dx, y = by + ny * bh + dy;
        const isAcc = p.accentCount > 0 && idx % Math.max(1, Math.round(total / p.accentCount)) === 0;
        ctx.globalAlpha = out * (gone ? 0.22 : 1) * pop;
        ctx.fillStyle = isAcc ? acc : ink;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.fill();
      }
    }
    ctx.restore();
  },
};

// 注意：export 放在最后，避免 TDZ（前面几批踩过两次了）
export default [typeStack, dotMatrix, lineSweep, chaosMeter];
