// ============================================================================
// 动效引擎 · 绘图原语
// 这里放的是"视频里那套视觉语言"的基本积木：
// HUD 细线框、等宽微标签、跑马灯条、条码、仪表盘、点阵、扫描线、乱码揭示……
// 所有模板都靠这些拼出来，风格才能统一。
// ============================================================================

import { TAU, clamp, lerp, mapRange, smoothstep, Rng } from './core.js';

// ---------------------------------------------------------------- 字体
// 全部使用系统字体，保证离线可用、导出与预览一致。
export const FONTS = {
  // 窄体大标题（视频里的 LOCK / ESCAPE / VELOCITY）
  condensed: '"Archivo Narrow","Oswald","Arial Narrow","Roboto Condensed",Impact,"Haettenschweiler","Microsoft YaHei UI",sans-serif',
  // 通用无衬线
  sans: '"Inter","Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei UI",sans-serif',
  // 等宽（HUD 读数、终端、字幕）
  mono: '"Cascadia Mono","Consolas","SFMono-Regular","Courier New","Noto Sans Mono CJK SC",monospace',
};

export const ui = {
  ink: '#0a0a0a',
  paper: '#ffffff',
  dim: 'rgba(255,255,255,0.55)',
  faint: 'rgba(255,255,255,0.28)',
  hair: 'rgba(255,255,255,0.75)',
  accent: '#ff4b1f',
  warn: '#ffcc00',
  good: '#39ff88',
};

// ---------------------------------------------------------------- 文本
/**
 * 绘制文本。
 * @param {object} o {font, size, weight, color, align, baseline, tracking(px), scaleX, alpha,
 *                    stroke, strokeWidth, plate:{color,pad,radius}, shadow:{color,blur,x,y}}
 */
export function text(ctx, str, x, y, o = {}) {
  const {
    font = FONTS.sans, size = 24, weight = 400, italic = false,
    color = ui.paper, align = 'left', baseline = 'alphabetic',
    tracking = null, scaleX = 1, alpha = 1,
    stroke = null, strokeWidth = 2,
    plate = null, shadow = null, lineHeight = 1.25, maxWidth = null,
  } = o;
  if (str === undefined || str === null) return 0;
  const s = String(str);

  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  if (tracking !== null) ctx.letterSpacing = `${tracking}px`;

  let m = ctx.measureText(s);
  let sx = scaleX;
  if (maxWidth && m.width > maxWidth) sx *= maxWidth / m.width;

  const w = m.width * sx;
  const asc = m.actualBoundingBoxAscent || size * 0.72;
  const desc = m.actualBoundingBoxDescent || size * 0.24;

  if (plate) {
    const pad = plate.pad ?? size * 0.3;
    ctx.fillStyle = plate.color ?? 'rgba(0,0,0,0.72)';
    roundRect(ctx, x - pad + (align === 'center' ? -w / 2 : align === 'right' ? -w : 0),
      y - asc - pad, w + pad * 2, asc + desc + pad * 2, plate.radius ?? 0);
    ctx.fill();
  }

  if (shadow) {
    ctx.shadowColor = shadow.color ?? 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = shadow.blur ?? 12;
    ctx.shadowOffsetX = shadow.x ?? 0;
    ctx.shadowOffsetY = shadow.y ?? 2;
  }

  ctx.translate(x, y);
  if (sx !== 1) ctx.scale(sx, 1);
  if (stroke) { ctx.lineWidth = strokeWidth; ctx.strokeStyle = stroke; ctx.lineJoin = 'round'; ctx.strokeText(s, 0, 0); }
  ctx.fillStyle = color;
  ctx.fillText(s, 0, 0);
  ctx.restore();

  return w;
}

/** 等宽小标签（HUD 里的那些 PROMPT / SIGNAL / 02:08:09） */
export function label(ctx, str, x, y, o = {}) {
  return text(ctx, str, x, y, {
    font: FONTS.mono, size: 13, weight: 500, tracking: 1.2,
    color: ui.paper, baseline: 'top', ...o,
  });
}

export function measure(ctx, str, o = {}) {
  const { font = FONTS.sans, size = 24, weight = 400, tracking = null } = o;
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  if (tracking !== null) ctx.letterSpacing = `${tracking}px`;
  const w = ctx.measureText(String(str)).width;
  ctx.restore();
  return w;
}

/** 在给定宽度内自动缩字号 */
export function fitSize(ctx, str, maxWidth, o = {}) {
  let size = o.size ?? 64;
  const min = o.min ?? 10;
  while (size > min && measure(ctx, str, { ...o, size }) > maxWidth) size -= 1;
  return size;
}

/** 按宽度折行 */
export function wrap(ctx, str, maxWidth, o = {}) {
  const words = String(str).split(/(\s+)/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur + w;
    if (cur && measure(ctx, test, o) > maxWidth) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
    else cur = test;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/**
 * 乱码揭示：文字从随机字符逐步"解码"成真身。
 * 视频里那种文字刷屏感基本都靠它。
 */
export function scramble(str, progress, rng, charset = 'ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789/\\|<>[]{}#%&*+-=_') {
  const s = String(str);
  const p = clamp(progress, 0, 1);
  const reveal = s.length * p;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ' ') { out += ' '; continue; }
    const lock = reveal - i;
    if (lock >= 1) out += ch;
    else if (lock <= -1.2) out += rng.next() < 0.35 ? rng.pick([...charset]) : ' ';
    else out += rng.pick([...charset]);
  }
  return out;
}

/** 打字机 */
export function typewriter(str, progress) {
  const s = String(str);
  const n = Math.floor(clamp(progress, 0, 1) * s.length * 1.0001);
  return s.slice(0, n);
}

/** 闪烁：按秒切换 */
export function blink(t, hz = 2, duty = 0.5) {
  return ((t * hz) % 1) < duty ? 1 : 0;
}

// ---------------------------------------------------------------- 形状
export function roundRect(ctx, x, y, w, h, r = 0) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (rr <= 0) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 四角短线，HUD 框的主角 */
export function cornerTicks(ctx, x, y, w, h, { len = 14, color = ui.paper, width = 1.5, alpha = 1 } = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x, y + len); ctx.lineTo(x, y); ctx.lineTo(x + len, y);
  ctx.moveTo(x + w - len, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + len);
  ctx.moveTo(x + w, y + h - len); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - len, y + h);
  ctx.moveTo(x + len, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - len);
  ctx.stroke();
  ctx.restore();
}

/**
 * 核心组件：HUD 面板。
 * 一个细线框 + 可选标题条 + 可选四角 + 可选半透底。
 * 视频里的 PROMPT / AGENT / LOOK 卡片全都是它的变体。
 */
export function hudPanel(ctx, x, y, w, h, o = {}) {
  const {
    stroke = ui.hair, strokeWidth = 1.25, fill = null, radius = 2,
    ticks = true, tickLen = 12, alpha = 1, dash = null, shadow = false, title = null,
  } = o;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 4; }
  if (fill) { ctx.fillStyle = fill; roundRect(ctx, x, y, w, h, radius); ctx.fill(); }
  ctx.shadowColor = 'transparent';
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    if (dash) ctx.setLineDash(dash);
    roundRect(ctx, x, y, w, h, radius);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (ticks) cornerTicks(ctx, x, y, w, h, { len: tickLen, color: stroke || ui.paper, width: strokeWidth, alpha });
  if (title) {
    ctx.fillStyle = fill || 'rgba(0,0,0,0.72)';
    ctx.fillRect(x, y - 20, measure(ctx, title, { font: FONTS.mono, size: 12, tracking: 1.2 }) + 16, 18);
    label(ctx, title, x + 8, y - 17, { size: 12 });
  }
  ctx.restore();
}

/** 键值读数行：["SIGNAL","LOCKED"], ["2.3 KB","±0.01"] */
export function microRow(ctx, pairs, x, y, o = {}) {
  const { size = 12, gap = 10, align = 'left', color = ui.dim, keyColor = null, line = false } = o;
  let cx = x;
  let totalW = 0;
  for (const [k, v] of pairs) totalW += measure(ctx, k, { font: FONTS.mono, size, tracking: 1 }) + gap * 0.5 + (v ? measure(ctx, v, { font: FONTS.mono, size, tracking: 1 }) : 0) + gap;
  if (align === 'right') cx = x - totalW;
  else if (align === 'center') cx = x - totalW / 2;
  for (const [k, v] of pairs) {
    const kw = label(ctx, k, cx, y, { size, color: keyColor || color });
    cx += kw + gap * 0.5;
    if (v) { const vw = label(ctx, v, cx, y, { size, color: o.valueColor || ui.paper }); cx += vw; }
    if (line) { ctx.fillStyle = ui.faint; ctx.fillRect(cx + gap * 0.3, y + size * 0.62, 1, size * 0.7); }
    cx += gap;
  }
  return totalW;
}

/** 标签 + 值 + 底部细进度条 */
export function statBlock(ctx, x, y, w, { label: lb = '', value = '', progress = null, size = 12, barH = 2, color = ui.paper } = {}) {
  label(ctx, lb.toUpperCase(), x, y, { size, color: ui.dim });
  text(ctx, value, x, y + size + 16, { font: FONTS.condensed, size: 34, weight: 700, color, baseline: 'top' });
  if (progress !== null) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(x, y + size + 60, w, barH);
    ctx.fillStyle = color;
    ctx.fillRect(x, y + size + 60, w * clamp(progress, 0, 1), barH);
  }
}

/** 横向进度条 */
export function hbar(ctx, x, y, w, h, p, { color = ui.paper, track = 'rgba(255,255,255,0.18)', marks = 0 } = {}) {
  ctx.fillStyle = track; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color; ctx.fillRect(x, y, w * clamp(p, 0, 1), h);
  for (let i = 1; i < marks; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + (w * i) / marks, y, 1, h);
  }
}

/**
 * 跑马灯条：视频里上下边缘那些不断滚动的数字/文字带。
 * 内部用重复文本 + 分隔符，并且自带分列刻度。
 */
export function ticker(ctx, x, y, w, h, str, o = {}) {
  const {
    t = 0, speed = 90, size = 14, color = ui.paper, bg = null, sep = '   ',
    separatorGlyph = '|', alpha = 1, dim = 0.45, columns = 0, border = true, direction = 1, padding = 12,
  } = o;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(x, y, w, h); }
  if (border) {
    ctx.strokeStyle = color; ctx.globalAlpha *= 0.5; ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.globalAlpha /= 0.5;
  }
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();

  const unit = `${str}${sep}${separatorGlyph}${sep}`;
  const unitW = measure(ctx, unit, { font: FONTS.mono, size, tracking: 1.4 });
  const shift = (((t * speed * direction) % unitW) + unitW) % unitW;
  const y0 = y + h / 2;
  ctx.textBaseline = 'middle';
  for (let i = -1; i <= Math.ceil(w / Math.max(1, unitW)) + 1; i++) {
    const px = x + padding + i * unitW - shift;
    if (px > x + w) break;
    if (px + unitW < x) continue;
    text(ctx, unit, px, y0, {
      font: FONTS.mono, size, tracking: 1.4, baseline: 'middle',
      color: (i % 3 === 0) ? color : `rgba(255,255,255,${dim})`,
    });
  }
  if (columns > 0) {
    for (let i = 1; i < columns; i++) {
      ctx.fillStyle = 'rgba(255,255,255,0.30)';
      ctx.fillRect(x + (w * i) / columns, y + h * 0.2, 1, h * 0.6);
    }
  }
  ctx.restore();
  return unitW;
}

/** 条码（"Made in San Francisco" 那种吊牌） */
export function barcode(ctx, x, y, w, h, rng, o = {}) {
  const { color = ui.ink, alpha = 1 } = o;
  ctx.save(); ctx.globalAlpha *= alpha;
  ctx.fillStyle = color;
  let cx = x;
  while (cx < x + w - 2) {
    const bw = rng.range(1, 4.2);
    const gap = rng.range(1, 3.4);
    if (rng.next() > 0.22) ctx.fillRect(cx, y, Math.min(bw, x + w - cx), h);
    cx += bw + gap;
  }
  ctx.restore();
}

/** 圆盘仪表 */
export function dial(ctx, cx, cy, r, p, o = {}) {
  const { color = ui.paper, track = 'rgba(255,255,255,0.22)', width = 2, ticks = 48, arc = TAU * 0.75, start = TAU * 0.625, value = null, size = 12 } = o;
  ctx.save();
  ctx.strokeStyle = track; ctx.lineWidth = width;
  ctx.beginPath(); ctx.arc(cx, cy, r, start, start + arc); ctx.stroke();
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.arc(cx, cy, r, start, start + arc * clamp(p, 0, 1)); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
  for (let i = 0; i <= ticks; i++) {
    const a = start + (arc * i) / ticks;
    const l = i % 6 === 0 ? 6 : 3;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (r - l - 3), cy + Math.sin(a) * (r - l - 3));
    ctx.lineTo(cx + Math.cos(a) * (r - 3), cy + Math.sin(a) * (r - 3));
    ctx.stroke();
  }
  if (value !== null) text(ctx, value, cx, cy + size * 0.36, { font: FONTS.mono, size, color, align: 'center' });
  ctx.restore();
}

/** 十字准星 */
export function crosshair(ctx, cx, cy, r, { color = ui.paper, width = 1, gap = 0.28, alpha = 1 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color; ctx.lineWidth = width;
  const g = r * gap;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx - g, cy);
  ctx.moveTo(cx + g, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - g);
  ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + r);
  ctx.stroke();
  ctx.restore();
}

/** 点阵网格（背景质感） */
export function dotGrid(ctx, x, y, w, h, step = 24, { color = 'rgba(255,255,255,0.35)', r = 1, alpha = 1 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color;
  for (let gy = y; gy <= y + h; gy += step)
    for (let gx = x; gx <= x + w; gx += step) {
      ctx.beginPath(); ctx.arc(gx, gy, r, 0, TAU); ctx.fill();
    }
  ctx.restore();
}

/** 十字网格线（"STARGATE / GRID HALL" 那种） */
export function gridLines(ctx, x, y, w, h, step = 80, { color = 'rgba(255,255,255,0.25)', width = 1, alpha = 1 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  for (let gx = x; gx <= x + w; gx += step) { ctx.moveTo(gx + 0.5, y); ctx.lineTo(gx + 0.5, y + h); }
  for (let gy = y; gy <= y + h; gy += step) { ctx.moveTo(x, gy + 0.5); ctx.lineTo(x + w, gy + 0.5); }
  ctx.stroke(); ctx.restore();
}

/** 扫描线（直接画，不依赖后期） */
export function scanlines(ctx, x, y, w, h, { step = 3, color = 'rgba(0,0,0,0.28)', alpha = 1, offset = 0 } = {}) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color;
  for (let gy = y + (offset % step); gy < y + h; gy += step) ctx.fillRect(x, gy, w, 1);
  ctx.restore();
}

/** 圆角卡片（Look N 那种白卡） */
export function card(ctx, x, y, w, h, o = {}) {
  const { fill = ui.paper, radius = 6, shadow = true, stroke = null, strokeWidth = 1, alpha = 1, rotate = 0 } = o;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.translate(x + w / 2, y + h / 2);
  if (rotate) ctx.rotate(rotate);
  ctx.translate(-w / 2, -h / 2);
  if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 22; ctx.shadowOffsetY = 6; }
  roundRect(ctx, 0, 0, w, h, radius);
  ctx.fillStyle = fill; ctx.fill();
  ctx.shadowColor = 'transparent';
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = strokeWidth; roundRect(ctx, 0, 0, w, h, radius); ctx.stroke(); }
  ctx.restore();
}

/** 竖排刻度尺（视频边缘那种"胶片齿孔 + 时间码"） */
export function ruler(ctx, x, y, h, o = {}) {
  const { color = 'rgba(255,255,255,0.5)', step = 10, longEvery = 5, alpha = 1, phase = 0 } = o;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.strokeStyle = color; ctx.lineWidth = 1;
  const start = Math.floor(phase / step) * step;
  for (let i = start; i < phase + h; i += step) {
    const py = y + (i - phase);
    const long = Math.round(i / step) % longEvery === 0;
    ctx.beginPath(); ctx.moveTo(x, py + 0.5); ctx.lineTo(x + (long ? 10 : 5), py + 0.5); ctx.stroke();
  }
  ctx.restore();
}

/** 齿孔胶片边 */
export function sprockets(ctx, x, y, h, o = {}) {
  const { color = 'rgba(255,255,255,0.8)', w = 10, hh = 7, gap = 14, alpha = 1, phase = 0 } = o;
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color;
  const shift = ((phase % gap) + gap) % gap;
  for (let py = y - shift; py < y + h; py += gap) {
    roundRect(ctx, x, py, w, hh, 2); ctx.fill();
  }
  ctx.restore();
}

/** 带底色的引用/提示气泡（视频里那个 command+shift+k 黑卡） */
export function quoteBubble(ctx, x, y, w, lines, o = {}) {
  const { fill = 'rgba(8,8,8,0.94)', color = ui.paper, size = 15, pad = 18, radius = 8, lineHeight = 1.55, tail = true, shadow = true } = o;
  const lh = size * lineHeight;
  const h = pad * 2 + lines.length * lh;
  ctx.save();
  if (shadow) { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 26; ctx.shadowOffsetY = 8; }
  roundRect(ctx, x, y, w, h, radius); ctx.fillStyle = fill; ctx.fill();
  ctx.shadowColor = 'transparent';
  if (tail) {
    ctx.beginPath();
    ctx.moveTo(x + 26, y + h); ctx.lineTo(x + 16, y + h + 14); ctx.lineTo(x + 44, y + h);
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  }
  lines.forEach((ln, i) => text(ctx, ln, x + pad, y + pad + i * lh + size * 0.72, {
    font: FONTS.mono, size, color, tracking: 0.6,
  }));
  ctx.restore();
  return h;
}

/** 抖动/晃动：拿到一个可用的位移，通常配合"卡点"使用 */
export function shake(t, amount = 8, freq = 18, seed = 1) {
  const r = new Rng(Math.floor(t * freq) * 7919 + seed);
  const decay = 1;
  return { x: (r.next() * 2 - 1) * amount * decay, y: (r.next() * 2 - 1) * amount * decay };
}

/** 全屏矩形 */
export function fullRect(ctx, w, h, color, alpha = 1) {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color; ctx.fillRect(0, 0, w, h); ctx.restore();
}

/** 相对坐标助手：把 0..1 的归一化坐标换算成像素 */
export function box(scene, nx, ny, nw, nh) {
  return { x: scene.width * nx, y: scene.height * ny, w: scene.width * nw, h: scene.height * nh };
}

/** 把 0..1 等比坐标换算为像素点 */
export function pt(scene, nx, ny) {
  return { x: scene.width * nx, y: scene.height * ny };
}

/** 常用颜色 */
export const palette = {
  black: '#000000', white: '#ffffff', ink: '#0b0b0c', bone: '#efece4',
  orange: '#ff4b1f', amber: '#ffb300', lime: '#c6ff00', cyan: '#00e5ff',
  magenta: '#ff2bd6', red: '#ff2d2d', slate: '#1a1c20', steel: '#8a9099',
};

export { lerp, clamp, mapRange, smoothstep };
