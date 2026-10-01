// ============================================================================
// 秩序 / 混沌：纸白 + 墨黑 + 一记橙红
//
// 参考语言：Swiss 网格海报那一路 —— 规整的网格一点点扭曲、断裂、爆散，
// 最后化成一团墨。配系列编号、小注脚和大字标题。
//
//   grid-field   网格场（干净 → 扭曲 → 断裂 → 爆散，一个 chaos 参数驱动全过程）
//   series-index 系列编号框（01 / 右上小字 / ORDER → CHAOS / 页码 / 大标题）
//   ink-scatter  墨迹与碎块（散落方块 + 墨团 + 细线，可以单独叠在实拍上）
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
export const gridField = {
  id: 'grid-field',
  name: '网格场',
  category: 'chaos',
  hint: '规整网格一步步扭曲、断裂、爆散。chaos 一个参数驱动全过程，也能自动演进。',
  params: [
    { key: 'mode', label: '崩坏方式', type: 'select', default: 'warp', options: ['grid', 'warp', 'break', 'burst'] },
    { key: 'region', label: '网格区域 x,y,w,h', type: 'string', default: '0.08,0.22,0.84,0.60' },
    { key: 'cols', label: '竖线数', type: 'number', default: 16, min: 2, max: 60, step: 1 },
    { key: 'rows', label: '横线数', type: 'number', default: 10, min: 2, max: 60, step: 1 },
    { key: 'chaos', label: '混沌程度[0-1]', type: 'number', default: 0.5, min: 0, max: 1, step: 0.02 },
    { key: 'auto', label: '自动崩坏', type: 'bool', default: false },
    { key: 'autoDur', label: '崩坏用时(秒)', type: 'number', default: 6, min: 0.5, max: 60, step: 0.5 },
    { key: 'lineW', label: '线宽', type: 'number', default: 1.2, min: 0.4, max: 6, step: 0.2 },
    { key: 'blocks', label: '散落方块数', type: 'number', default: 14, min: 0, max: 80, step: 1 },
    { key: 'blockScale', label: '方块大小', type: 'number', default: 1, min: 0.4, max: 3, step: 0.1 },
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
    const paper = color(p.paperColor, PAPER);
    const acc = color(p.accent, ORANGE);
    const r0 = nums(p.region, 4, [0.08, 0.22, 0.84, 0.6]);
    const bx = W * r0[0], by = H * r0[1], bw = W * r0[2], bh = H * r0[3];
    const rng = env.rng;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const tIn = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    // 混沌程度：手动给，或者从 0 自己长到 1
    const chaos = clamp(p.auto
      ? ramp(env.local, p.inDur * 0.5, Math.max(p.inDur * 0.6, p.inDur * 0.5 + p.autoDur))
      : p.chaos, 0, 1);

    if (p.paper) {
      ctx.save();
      ctx.globalAlpha = out * tIn;
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    /** 网格点的位移：平滑扭曲 + 断裂抖动 + 爆散外推 */
    const warp = (nx, ny, tag) => {
      const s = 0.085 * chaos;
      let dx = (Math.sin((ny * 2.6 + env.t * 0.30) * Math.PI) * 0.6
              + Math.sin((ny * 7.1 - env.t * 0.22) * Math.PI) * 0.25) * s;
      let dy = (Math.cos((nx * 2.2 - env.t * 0.26) * Math.PI) * 0.5
              + Math.cos((nx * 6.3 + env.t * 0.18) * Math.PI) * 0.2) * s;
      if (p.mode === 'break') {
        const j = (rng.next() * 2 - 1);
        dx += j * 0.03 * chaos * (tag % 3 === 0 ? 2.2 : 1);
        dy += (rng.next() * 2 - 1) * 0.025 * chaos;
      }
      if (p.mode === 'burst') {
        const cxp = nx - 0.5, cyp = ny - 0.5;
        const r = Math.hypot(cxp, cyp) + 1e-4;
        const push = chaos * 0.30 * Math.pow(r * 1.8, 1.5);
        dx += (cxp / r) * push;
        dy += (cyp / r) * push;
      }
      return [dx * bw, dy * bh, nx, ny];
    };

    ctx.save();
    ctx.globalAlpha = out * tIn;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.4, p.lineW);
    ctx.lineCap = 'round';
    const NSEG = 26;

    // 竖线
    for (let i = 0; i <= p.cols; i++) {
      const nx = i / p.cols;
      // 越到后面越容易断
      const broken = p.mode === 'break' || p.mode === 'burst' ? rng.next() < chaos * 0.45 : false;
      const gapAt = rng.next();
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= NSEG; k++) {
        const ny = k / NSEG;
        if (broken && Math.abs(ny - gapAt) < 0.06 + chaos * 0.05) { pen = false; continue; }
        const d = warp(nx, ny, i);
        const x = bx + nx * bw + d[0], y = by + ny * bh + d[1];
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    // 横线
    for (let j = 0; j <= p.rows; j++) {
      const ny = j / p.rows;
      const broken = p.mode === 'break' || p.mode === 'burst' ? rng.next() < chaos * 0.45 : false;
      const gapAt = rng.next();
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k <= NSEG; k++) {
        const nx = k / NSEG;
        if (broken && Math.abs(nx - gapAt) < 0.06 + chaos * 0.05) { pen = false; continue; }
        const d = warp(nx, ny, j);
        const x = bx + nx * bw + d[0], y = by + ny * bh + d[1];
        if (!pen) { ctx.moveTo(x, y); pen = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // 散落方块：chaos 越大越多，中间混一两个橙的
    const nb = Math.round(p.blocks * chaos);
    for (let i = 0; i < nb; i++) {
      const nx = rng.next(), ny = rng.next();
      const d = warp(nx, ny, i);
      const size = (8 + rng.next() * 26) * p.blockScale;
      const x = bx + nx * bw + d[0] * 1.4, y = by + ny * bh + d[1] * 1.4;
      const pop = easeOutCubic(clamp((env.local - p.inDur * 0.4 - i * 0.02) / 0.28, 0, 1));
      if (pop <= 0) continue;
      ctx.save();
      ctx.globalAlpha = out * pop;
      ctx.translate(x, y);
      ctx.rotate((rng.next() * 2 - 1) * 0.12 * chaos);
      ctx.scale(pop, pop);
      const isAcc = i === 0 && chaos > 0.35;
      if (isAcc) ctx.fillStyle = acc;
      else if (rng.next() < 0.22) { ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, p.lineW * 1.2); }
      else ctx.fillStyle = ink;
      if (isAcc || rng.next() < 0.8) ctx.fillRect(-size / 2, -size / 2, size, size);
      else ctx.strokeRect(-size / 2, -size / 2, size, size);
      ctx.restore();
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const seriesIndex = {
  id: 'series-index',
  name: '系列编号',
  category: 'chaos',
  hint: '左上大编号 + 右上小注脚 + 左下 ORDER→CHAOS + 右下页码 + 中间大字标题（橙点）。',
  params: [
    { key: 'index', label: '大编号', type: 'string', default: '03' },
    { key: 'note', label: '右上小字（换行=多行）', type: 'multiline', default: 'THE LINES\nSTART TO BREAK.' },
    { key: 'from', label: '左下前段', type: 'string', default: 'ORDER' },
    { key: 'to', label: '左下后段', type: 'string', default: 'CHAOS' },
    { key: 'arrow', label: '两段之间画箭头', type: 'bool', default: true },
    { key: 'page', label: '右下页码', type: 'string', default: '/03' },
    { key: 'title', label: '大字标题（空=不显示）', type: 'multiline', default: 'THE GRID\nIS LYING' },
    { key: 'titlePos', label: '标题位置 X,Y', type: 'string', default: '0.075,0.62' },
    { key: 'titleSize', label: '标题字号', type: 'number', default: 96, min: 24, max: 260, step: 2 },
    { key: 'margin', label: '边距(px)', type: 'number', default: 54, min: 16, max: 200, step: 2 },
    { key: 'idxSize', label: '编号字号', type: 'number', default: 62, min: 20, max: 200, step: 2 },
    { key: 'small', label: '小字号', type: 'number', default: 15, min: 8, max: 40, step: 1 },
    { key: 'frame', label: '细边框', type: 'bool', default: true },
    { key: 'paper', label: '纸白底', type: 'bool', default: true },
    { key: 'ink', label: '墨色', type: 'color', default: '#111214' },
    { key: 'paperColor', label: '纸色', type: 'color', default: '#f2f0ea' },
    { key: 'accent', label: '强调色', type: 'color', default: '#ff4a1c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.8, min: 0.05, max: 4, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 4, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.ink, INK);
    const paper = color(p.paperColor, PAPER);
    const acc = color(p.accent, ORANGE);
    const m = p.margin;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));

    ctx.save();
    ctx.globalAlpha = out;
    if (p.paper) {
      ctx.globalAlpha = out * t;
      ctx.fillStyle = paper;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = out;
    }
    if (p.frame) {
      ctx.strokeStyle = ink;
      ctx.globalAlpha = out * t * 0.8;
      ctx.lineWidth = 1;
      ctx.strokeRect(m * 0.55 + 0.5, m * 0.55 + 0.5, W - m * 1.1 - 1, H - m * 1.1 - 1);
      ctx.globalAlpha = out;
    }

    // 大编号 + 下面那道短线
    const idxSize = p.idxSize;
    const tIdx = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur * 0.5)));
    ctx.globalAlpha = out * tIdx;
    ctx.save();
    ctx.translate(0, (1 - tIdx) * -14);
    label(ctx, p.index, m, m + idxSize * 0.82, {
      font: FONTS.condensed, size: idxSize, weight: 700, color: ink,
      align: 'left', baseline: 'alphabetic', tracking: -idxSize * 0.02,
    });
    const iw = measure(ctx, p.index, { font: FONTS.condensed, size: idxSize, weight: 700, tracking: -idxSize * 0.02 });
    const ruleW = iw * ramp(env.local, p.inDur * 0.25, p.inDur * 0.7);
    ctx.fillStyle = ink;
    ctx.fillRect(m, m + idxSize * 1.02, Math.max(0, ruleW), Math.max(2, idxSize * 0.045));
    ctx.restore();

    // 右上小字
    const noteLines = String(p.note || '').split('\n').map((s) => s.trim()).filter(Boolean);
    const tNote = ramp(env.local, p.inDur * 0.3, p.inDur * 0.8);
    ctx.globalAlpha = out * tNote;
    noteLines.forEach((s, i) => {
      label(ctx, s, W - m, m + p.small * (1.0 + i * 1.55), {
        font: FONTS.mono, size: p.small, color: ink, align: 'right', baseline: 'alphabetic',
        tracking: p.small * 0.2,
      });
    });

    // 左下 ORDER → CHAOS
    const tRow = ramp(env.local, p.inDur * 0.45, p.inDur);
    ctx.globalAlpha = out * tRow;
    const rowY = H - m * 1.2;
    const fs = p.small * 1.15;
    label(ctx, p.from, m, rowY, {
      font: FONTS.mono, size: fs, color: ink, align: 'left', baseline: 'alphabetic', tracking: fs * 0.22,
    });
    const fromW = measure(ctx, p.from, { font: FONTS.mono, size: fs, tracking: fs * 0.22 });
    // 箭头：从 from 后面长出来
    const a0 = m + fromW + fs * (p.arrow ? 1.2 : 0.7);
    const a1 = a0 + fs * 4.2;
    const arrowP = clamp((env.local - p.inDur * 0.55) / Math.max(0.15, p.inDur * 0.6), 0, 1);
    if (p.arrow) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.2, fs * 0.1);
      ctx.beginPath();
      ctx.moveTo(a0, rowY - fs * 0.3);
      ctx.lineTo(a0 + (a1 - a0) * arrowP, rowY - fs * 0.3);
      ctx.stroke();
      if (arrowP > 0.9) {
        const hx = a0 + (a1 - a0) * arrowP, hy = rowY - fs * 0.3;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx - fs * 0.55, hy - fs * 0.32);
        ctx.lineTo(hx - fs * 0.55, hy + fs * 0.32);
        ctx.closePath();
        ctx.fillStyle = ink;
        ctx.fill();
      }
    }
    label(ctx, p.to, p.arrow ? a1 + fs * 0.7 : a0 + fs * 0.2, rowY, {
      font: FONTS.mono, size: fs, color: acc, align: 'left', baseline: 'alphabetic', tracking: fs * 0.22,
      alpha: p.arrow ? arrowP : 1,
    });
    // 右下页码
    label(ctx, p.page, W - m, rowY, {
      font: FONTS.mono, size: fs, color: ink, align: 'right', baseline: 'alphabetic', tracking: fs * 0.18, alpha: 0.75,
    });

    // 大字标题：整块砸进来，末尾那个橙点单独弹一下
    const titleLines = String(p.title || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (titleLines.length) {
      const tp = nums(p.titlePos, 2, [0.075, 0.62]);
      const tx0 = W * tp[0], ty0 = H * tp[1];
      const size = fitSize(ctx, titleLines.reduce((a, b) => (a.length > b.length ? a : b)), W * 0.5, {
        font: FONTS.condensed, size: p.titleSize, weight: 700, tracking: -p.titleSize * 0.01, min: 14,
      });
      const tT = easeOutCubic(ramp(env.local, p.inDur * 0.35, p.inDur * 0.85));
      const lh = size * 0.92;
      ctx.save();
      ctx.globalAlpha = out * tT;
      ctx.translate(tx0, ty0 + (1 - tT) * size * 0.18);
      ctx.scale(1 + (1 - tT) * 0.04, 1 + (1 - tT) * 0.04);
      ctx.translate(-tx0, -ty0);
      titleLines.forEach((s, i) => {
        text(ctx, s, tx0, ty0 + lh * (i + 0.8), {
          font: FONTS.condensed, size, weight: 700, color: ink,
          align: 'left', baseline: 'alphabetic', tracking: -size * 0.01,
        });
        // 最后一行末尾点一个橙点（标题里本来就有句点的效果）
        if (i === titleLines.length - 1) {
          const wLast = measure(ctx, s, { font: FONTS.condensed, size, weight: 700, tracking: -size * 0.01 });
          const pop = 1 + 0.5 * Math.max(0, Math.sin(clamp((env.local - p.inDur * 0.8) / 0.35, 0, 1) * Math.PI));
          ctx.beginPath();
          ctx.arc(tx0 + wLast + size * 0.12, ty0 + lh * (i + 0.72), size * 0.075 * pop, 0, TAU);
          ctx.fillStyle = acc;
          ctx.fill();
        }
      });
      ctx.restore();
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const inkScatter = {
  id: 'ink-scatter',
  name: '墨迹与碎块',
  category: 'chaos',
  hint: '散落的方块 + 墨团 + 细线，一块块弹出来。可以单独叠在实拍上当"混沌质感"。',
  params: [
    { key: 'mode', label: '形态', type: 'select', default: 'mix', options: ['mix', 'blocks', 'ink'] },
    { key: 'region', label: '范围 x,y,w,h', type: 'string', default: '0.05,0.15,0.90,0.72' },
    { key: 'count', label: '元素数量', type: 'number', default: 26, min: 2, max: 120, step: 1 },
    { key: 'inkBlobs', label: '墨团数', type: 'number', default: 4, min: 0, max: 12, step: 1 },
    { key: 'lines', label: '细线数', type: 'number', default: 8, min: 0, max: 40, step: 1 },
    { key: 'size', label: '元素大小', type: 'number', default: 1, min: 0.3, max: 3, step: 0.1 },
    { key: 'accentCount', label: '橙色元素数', type: 'number', default: 2, min: 0, max: 8, step: 1 },
    { key: 'stagger', label: '错峰(秒/个)', type: 'number', default: 0.035, min: 0, max: 0.4, step: 0.005 },
    { key: 'drift', label: '缓慢漂移', type: 'number', default: 0.25, min: 0, max: 2, step: 0.05 },
    { key: 'ink', label: '墨色', type: 'color', default: '#111214' },
    { key: 'accent', label: '强调色', type: 'color', default: '#ff4a1c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.5, min: 0.05, max: 4, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.4, min: 0, max: 4, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.ink, INK);
    const acc = color(p.accent, ORANGE);
    const r0 = nums(p.region, 4, [0.05, 0.15, 0.9, 0.72]);
    const bx = W * r0[0], by = H * r0[1], bw = W * r0[2], bh = H * r0[3];
    const rng = env.rng;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const drift = p.drift * 10;

    ctx.save();
    ctx.globalAlpha = out;
    const blob = (cx, cy, rr, alpha, squash) => {
      ctx.globalAlpha = out * alpha;
      ctx.fillStyle = ink;
      ctx.beginPath();
      // 半径用几条正弦叠加，比逐点随机圆润得多，更像墨
      const k1 = rng.next() * TAU, k2 = rng.next() * TAU, k3 = rng.next() * TAU;
      for (let a = 0; a <= 36; a++) {
        const ang = (a / 36) * TAU;
        const wob = 0.86 + 0.16 * Math.sin(ang * 3 + k1) + 0.09 * Math.sin(ang * 5 + k2) + 0.06 * Math.sin(ang * 8 + k3);
        const rad = rr * wob;
        const x = cx + Math.cos(ang) * rad;
        const y = cy + Math.sin(ang) * rad * squash;
        if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    };

    // 墨团：灰晕 + 墨芯
    const nBlob = p.mode === 'blocks' ? 0 : p.inkBlobs;
    for (let k = 0; k < nBlob; k++) {
      const cx = bx + bw * (0.12 + rng.next() * 0.76);
      const cy = by + bh * (0.2 + rng.next() * 0.6);
      const rr = (60 + rng.next() * 190) * p.size;
      const pop = easeOutCubic(clamp((env.local - p.inDur * 0.15 - k * 0.12) / 0.5, 0, 1));
      if (pop <= 0) continue;
      const dx = Math.sin(env.t * 0.12 + k) * drift;
      const dy = Math.cos(env.t * 0.1 + k * 1.7) * drift * 0.6;
      blob(cx + dx, cy + dy, rr * 1.9, pop * 0.16, 0.55);
      blob(cx + dx, cy + dy, rr, pop * 0.85, 0.42);
    }

    // 细线
    if (p.mode !== 'ink') {
      for (let k = 0; k < p.lines; k++) {
        const pop = clamp((env.local - p.inDur * 0.1 - k * 0.05) / 0.45, 0, 1);
        if (pop <= 0) continue;
        const x0 = bx + bw * rng.next(), y0 = by + bh * rng.next();
        const ang = rng.next() * TAU, len = (60 + rng.next() * 420) * p.size;
        const bend = (rng.next() * 2 - 1) * 0.35;
        ctx.globalAlpha = out * pop * (0.25 + rng.next() * 0.5);
        ctx.strokeStyle = ink;
        ctx.lineWidth = Math.max(0.6, (0.8 + rng.next() * 1.8) * p.size);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.quadraticCurveTo(x0 + Math.cos(ang + bend) * len * 0.5, y0 + Math.sin(ang + bend) * len * 0.5,
                             x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
        ctx.stroke();
      }
    }

    // 方块
    const n = p.mode === 'ink' ? Math.round(p.count * 0.3) : p.count;
    const everyAcc = Math.max(1, Math.round(n / Math.max(1, p.accentCount)));
    for (let i = 0; i < n; i++) {
      const pop = easeOutCubic(clamp((env.local - p.inDur * 0.2 - i * p.stagger) / 0.3, 0, 1));
      if (pop <= 0) continue;
      const nx = bx + bw * rng.next(), ny = by + bh * rng.next();
      const size = (6 + rng.next() * 34) * p.size;
      const dx = Math.sin(env.t * 0.15 + i) * drift * 0.6;
      const dy = Math.cos(env.t * 0.13 + i * 1.3) * drift * 0.5;
      const outline = rng.next() < 0.2;
      const isAcc = p.accentCount > 0 && i % everyAcc === 0;
      ctx.save();
      ctx.globalAlpha = out * pop;
      ctx.translate(nx + dx, ny + dy);
      ctx.rotate((rng.next() * 2 - 1) * 0.25);
      ctx.scale(pop, pop);
      if (isAcc) { ctx.fillStyle = acc; ctx.fillRect(-size / 2, -size / 2, size, size); }
      else if (outline) {
        ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, p.size * 1.2);
        ctx.strokeRect(-size / 2, -size / 2, size, size);
      } else { ctx.fillStyle = ink; ctx.fillRect(-size / 2, -size / 2, size, size); }
      ctx.restore();
    }
    ctx.restore();
  },
};

export default [gridField, seriesIndex, inkScatter];
