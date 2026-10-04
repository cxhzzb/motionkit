// ============================================================================
// 面板类模板：终端窗口、编号白卡、吊牌条码、注释气泡
// 成片里 "PROMPT:" 面板、Look 06 小卡、Do not iron 吊牌都是这一挂。
// ============================================================================

import {
  text, label, measure, fitSize, wrap, typewriter, blink, ui, palette, FONTS,
  hudPanel, card, barcode, roundRect, cornerTicks, crosshair, hbar, quoteBubble, microRow,
} from '../engine/draw.js';
import { clamp, lerp, Rng, easeOutExpo, easeOutBack } from '../engine/core.js';
import { envelope, color, trng, stepDur, fakeCode, P } from './_lib.js';

// ---------------------------------------------------------------------------
export const terminalPanel = {
  id: 'terminal-prompt',
  name: '终端面板',
  category: 'panel',
  hint: '黑底等宽文字窗，逐行打字机输出。成片里 PROMPT / AGENT 面板就是它。',
  params: [
    { key: 'title', label: '窗口标题', type: 'string', default: 'PROMPT' },
    { key: 'lines', label: '内容(每行一句)', type: 'multiline', default: 'command+shift+k 出戏\n> spawn 128 agents\n> budget 12.9B tokens\n> status: LOCKED IN' },
    { key: 'position', label: '位置', type: 'string', default: '0.08,0.42' },
    { key: 'width', label: '宽度', type: 'number', default: 430, min: 160, max: 1200, step: 10 },
    { key: 'size', label: '字号', type: 'number', default: 17, min: 9, max: 60, step: 1 },
    { key: 'lineHeight', label: '行高倍率', type: 'number', default: 1.7, min: 1, max: 3, step: 0.05 },
    { key: 'charDelay', label: '每字秒数', type: 'number', default: 0.022, min: 0.001, max: 0.3, step: 0.001 },
    { key: 'cursor', label: '光标', type: 'bool', default: true },
    { key: 'chrome', label: '窗口按钮', type: 'bool', default: true },
    { key: 'fill', label: '底色', type: 'color', default: '#08090b' },
    P.color('white'),
    P.accent('lime'),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.08, outFrac: 0.1 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.lime);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const x = w * (isNaN(nx) ? 0.08 : nx), y = h * (isNaN(ny) ? 0.42 : ny);
    const bw = p.width;
    const lines = String(p.lines).split('\n');
    const lh = p.size * p.lineHeight;
    const padTop = p.chrome ? 34 : 16;
    const bh = padTop + lines.length * lh + 16;
    const rng = trng(env, 'term');

    // 打字机总进度
    const totalChars = lines.reduce((s, l) => s + l.length, 0) || 1;
    const typed = env.local / p.charDelay;
    let budget = typed;

    ctx.save();
    ctx.globalAlpha *= a;
    // 阴影底
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 30; ctx.shadowOffsetY = 10;
    roundRect(ctx, x, y, bw, bh, 6);
    ctx.fillStyle = p.fill; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, bw - 1, bh - 1, 6); ctx.stroke();

    // 标题栏
    if (p.chrome) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, y, bw, 26);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath(); ctx.moveTo(x, y + 26.5); ctx.lineTo(x + bw, y + 26.5); ctx.stroke();
      [acc, '#ffb300', '#ff5f57'].forEach((c, i) => {
        ctx.fillStyle = c; ctx.globalAlpha = a * 0.9;
        ctx.beginPath(); ctx.arc(x + 16 + i * 15, y + 13, 4, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = a;
      });
      label(ctx, (p.title || '').toUpperCase(), x + bw - 12 - measure(ctx, (p.title || '').toUpperCase(), { font: FONTS.mono, size: 11, tracking: 1.2 }), y + 7, { size: 11, color: ui.dim });
    } else {
      hudPanel(ctx, x, y, bw, bh, { stroke: 'rgba(255,255,255,0.4)', tickLen: 10 });
    }

    // 内容
    let cy = y + padTop;
    lines.forEach((line) => {
      const take = clamp(budget / Math.max(1, line.length), 0, 1);
      const shown = typewriter(line, take);
      const isPrompt = /^[>＄$]/.test(line.trim());
      text(ctx, shown, x + 16, cy, {
        font: FONTS.mono, size: p.size, weight: 500,
        color: isPrompt ? acc : ink, baseline: 'top', tracking: 0.6,
      });
      // 行尾光标
      if (p.cursor && take > 0 && take < 1) {
        const cw = measure(ctx, shown, { font: FONTS.mono, size: p.size, tracking: 0.6 });
        if (blink(env.t, 3)) { ctx.fillStyle = acc; ctx.fillRect(x + 16 + cw + 2, cy + 2, p.size * 0.52, p.size * 1.05); }
      }
      budget -= line.length;
      cy += lh;
    });
    // 全部打完后的常亮光标
    if (p.cursor && typed > totalChars && blink(env.t, 1.6)) {
      const last = lines[lines.length - 1] || '';
      const cw = measure(ctx, last, { font: FONTS.mono, size: p.size, tracking: 0.6 });
      ctx.fillStyle = acc;
      ctx.fillRect(x + 16 + cw + 2, cy - lh + 2, p.size * 0.52, p.size * 1.05);
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const lookCard = {
  id: 'look-card',
  name: '编号卡片',
  category: 'panel',
  hint: 'Look 06 / Look 11 那种白底编号卡，一条一条按节拍弹出来。',
  params: [
    { key: 'title', label: '标题前缀', type: 'string', default: 'Look' },
    { key: 'items', label: '条目(每行一条)', type: 'multiline', default: 'Our Waymo hit someone.\nRISK PAUSED.\nNot an AI billboard.\nA real leather jacket.\nShoes off at the door.' },
    { key: 'position', label: '位置', type: 'string', default: '0.12,0.30' },
    { key: 'width', label: '卡片宽', type: 'number', default: 360, min: 140, max: 900, step: 10 },
    { key: 'size', label: '字号', type: 'number', default: 22, min: 10, max: 72, step: 1 },
    { key: 'startIndex', label: '起始编号', type: 'number', default: 6, min: 0, max: 99, step: 1 },
    { key: 'stagger', label: '每条几拍', type: 'number', default: 2, min: 0.25, max: 8, step: 0.25 },
    { key: 'hold', label: '常驻不消失', type: 'bool', default: false },
    { key: 'bgHeight', label: '背景高度倍率', type: 'number', default: 1.3, min: 0.3, max: 3, step: 0.05 },
    { key: 'fill', label: '卡片底色', type: 'color', default: '#ffffff' },
    { key: 'textColor', label: '文字颜色', type: 'color', default: '#0a0a0a' },
    P.accent('orange'),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.06, outFrac: 0.1 });
    if (a <= 0.001) return;
    const acc = color(p.accent, palette.orange);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const x = w * (isNaN(nx) ? 0.12 : nx), y = h * (isNaN(ny) ? 0.3 : ny);
    const items = String(p.items).split('\n').map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    const d = Math.max(0.15, stepDur(env, p.stagger));

    ctx.save();
    ctx.globalAlpha *= a;
    const fs = p.size;
    const padX = fs * 0.72, padY = fs * 0.5;
    const gapY = fs * 0.45;
    let cy = y;

    items.forEach((item, i) => {
      const appearAt = i * d;
      const local = env.t - env.layer.start - appearAt;
      if (local < 0) return;
      if (!p.hold && local > d) return;           // 每条只显示一个拍
      const tIn = clamp(local / 0.22, 0, 1);
      const tOut = p.hold ? 1 : clamp((d - local) / 0.18, 0, 1);
      const vis = Math.min(tIn, tOut);
      if (vis <= 0.001) return;

      const lineH = fs * 1.35;
      const num = `${p.title} ${String(p.startIndex + i).padStart(2, '0')}`;
      const bodyLines = wrap(ctx, item, p.width - padX * 2 - fs * 3.2, { font: FONTS.sans, size: fs });
      const bw = p.width;
      const bh = (padY * 2 + bodyLines.length * lineH) * clamp(p.bgHeight ?? 1.3, 0.3, 3);

      ctx.save();
      ctx.globalAlpha *= vis;
      const slide = (1 - easeOutExpo(tIn)) * 34;
      ctx.translate(-slide, 0);
      card(ctx, x, cy, bw, bh, { fill: p.fill, radius: 4, shadow: true });
      // 左侧色条
      ctx.fillStyle = i === 0 ? acc : '#0a0a0a';
      ctx.fillRect(x + 10, cy + padY * 0.8, 3, bh - padY * 1.6);
      text(ctx, num, x + padX, cy + padY + fs * 0.18, {
        font: FONTS.mono, size: fs * 0.66, weight: 700, color: i === 0 ? acc : '#666', baseline: 'top', tracking: 0.6,
      });
      bodyLines.forEach((ln, k) => text(ctx, ln, x + padX, cy + padY + fs * 1.5 + k * lineH, {
        font: FONTS.sans, size: fs, weight: 600, color: p.textColor, baseline: 'top',
      }));
      ctx.restore();

      cy += bh + gapY;
    });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const shippingLabel = {
  id: 'shipping-label',
  name: '吊牌 / 条码卡',
  category: 'panel',
  hint: '"Do not iron / Wash cold / Made in San Francisco" 那种吊牌，带条码和注意事项。',
  params: [
    { key: 'product', label: '品名', type: 'string', default: 'ESCAPE VELOCITY' },
    { key: 'sku', label: '货号', type: 'string', default: 'EV-11.2 / KM-S' },
    { key: 'care', label: '注意事项(逗号分隔)', type: 'string', default: 'Wash cold,Do not iron,Do not nerf,Made in San Francisco' },
    { key: 'position', label: '位置', type: 'string', default: '0.62,0.30' },
    { key: 'width', label: '卡片宽', type: 'number', default: 330, min: 140, max: 800, step: 10 },
    { key: 'rotate', label: '旋转(度)', type: 'number', default: -5, min: -45, max: 45, step: 0.5 },
    { key: 'string', label: '吊绳', type: 'bool', default: true },
    { key: 'size', label: '字号', type: 'number', default: 20, min: 8, max: 60, step: 1 },
    P.accent('orange'),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.1, outFrac: 0.12 });
    if (a <= 0.001) return;
    const acc = color(p.accent, palette.orange);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const cx = w * (isNaN(nx) ? 0.62 : nx), cy = h * (isNaN(ny) ? 0.3 : ny);
    const fs = p.size;
    const care = String(p.care).split(',').map((s) => s.trim()).filter(Boolean);
    const bw = p.width;
    const bh = fs * 1.6 + care.length * fs * 1.5 + fs * 5.2;
    const rng = trng(env, 'label');
    const inP = clamp(env.progress / 0.3, 0, 1);
    const swing = Math.sin(env.t * 1.4) * 0.035 * (1 - inP * 0.4);

    ctx.save();
    ctx.globalAlpha *= a * clamp(inP * 2, 0, 1);
    ctx.translate(cx, cy);
    ctx.rotate(((p.rotate || 0) * Math.PI) / 180 + swing);
    ctx.translate(-bw / 2, 0);

    // 吊绳
    if (p.string) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bw * 0.3, -fs * 1.2);
      ctx.quadraticCurveTo(bw * 0.2, -fs * 4.4, bw * 0.02, -fs * 7.0);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(bw * 0.3, -fs * 0.9, fs * 0.22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fill(); ctx.stroke();
    }

    card(ctx, 0, 0, bw, bh, { fill: '#f4f1ea', radius: 3, shadow: true, rotate: 0 });
    // 品名
    text(ctx, p.product, 18, fs * 1.1, {
      font: FONTS.condensed, size: fs * 1.35, weight: 800, color: '#0a0a0a', baseline: 'alphabetic', tracking: -0.5,
    });
    text(ctx, p.sku, bw - 18, fs * 1.1, {
      font: FONTS.mono, size: fs * 0.7, color: '#666', align: 'right', baseline: 'alphabetic',
    });
    ctx.fillStyle = acc; ctx.fillRect(18, fs * 1.5, bw - 36, 2);
    // 注意事项
    care.forEach((c, i) => {
      const yy = fs * 3.0 + i * fs * 1.5;
      text(ctx, '·', 18, yy, { font: FONTS.sans, size: fs, color: '#0a0a0a' });
      text(ctx, c, 32, yy, { font: FONTS.sans, size: fs, weight: 500, color: '#161616' });
    });
    // 条码区
    const barY = fs * 3.0 + care.length * fs * 1.5 + fs * 0.6;
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    ctx.fillRect(18, barY, bw - 36, fs * 3.4);
    barcode(ctx, 34, barY + fs * 0.6, bw - 68, fs * 1.5, rng, { color: '#0a0a0a' });
    text(ctx, fakeCode(rng, 12, '0123456789'), 34, barY + fs * 2.7, {
      font: FONTS.mono, size: fs * 0.6, color: '#0a0a0a', tracking: 2,
    });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const noteBubble = {
  id: 'note-bubble',
  name: '注释气泡',
  category: 'panel',
  hint: '黑底小气泡 + 一行代码/台词，成片里 command+shift+k 那张卡。',
  params: [
    { key: 'text', label: '内容(每行一句)', type: 'multiline', default: 'command+shift+k' },
    { key: 'position', label: '位置', type: 'string', default: '0.30,0.62' },
    { key: 'width', label: '宽度', type: 'number', default: 300, min: 120, max: 800, step: 10 },
    { key: 'size', label: '字号', type: 'number', default: 18, min: 9, max: 60, step: 1 },
    { key: 'fill', label: '底色', type: 'color', default: '#0b0b0c' },
    { key: 'tail', label: '小尾巴', type: 'bool', default: true },
    P.color('white'),
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.1, outFrac: 0.12 });
    if (a <= 0.001) return;
    const [nx, ny] = String(p.position).split(',').map(Number);
    const x = w * (isNaN(nx) ? 0.3 : nx), y = h * (isNaN(ny) ? 0.62 : ny);
    const lines = String(p.text).split('\n');
    const inP = clamp(env.progress / 0.22, 0, 1);
    ctx.save();
    ctx.globalAlpha *= a * clamp(inP * 2.2, 0, 1);
    ctx.translate(0, (1 - easeOutBack(inP)) * 26);
    const hh = quoteBubble(ctx, x, y, p.width * inP, lines, {
      fill: p.fill, color: color(p.color, ui.paper), size: p.size, tail: p.tail,
    });
    ctx.restore();
  },
};

export default [terminalPanel, lookCard, shippingLabel, noteBubble];
