// ============================================================================
// 排版类模板：卡点大字、词块宫格、标题定格、卡点字幕
// 成片里 "LOCK" / "ESCAPE" / "VELOCITY..." / "ZERO-DAY." 这些全靠它们。
// ============================================================================

import {
  text, label, measure, fitSize, wrap, scramble, typewriter, ui, palette, FONTS,
  hudPanel, hbar, dotGrid, gridLines, cornerTicks, fullRect, roundRect,
} from '../engine/draw.js';
import { clamp, lerp, Rng, EASINGS, easeOutExpo, easeOutBack, pulse } from '../engine/core.js';
import { envelope, color, trng, stepDur, beatCell, words, chars, P } from './_lib.js';

// ---------------------------------------------------------------------------
export const kineticType = {
  id: 'kinetic-type',
  name: '卡点大字',
  category: 'typography',
  hint: '每个卡点换一句大字。把内容一行一句写进"文案"里即可。',
  params: [
    { key: 'text', label: '文案(每行一句)', type: 'multiline', default: 'LOCK IN\nESCAPE VELOCITY\nPERMANENT UNDERCLASS\nFEEL THE ENGINE\nWE ARE SO BACK' },
    { key: 'mode', label: '切换方式', type: 'select', default: 'slam', options: ['slam', 'cut', 'scramble', 'typewriter', 'stack'] },
    { key: 'position', label: '位置', type: 'string', default: '0.5,0.5' },
    { key: 'size', label: '字号', type: 'number', default: 150, min: 20, max: 620, step: 2 },
    { key: 'weight', label: '字重', type: 'select', default: '700', options: ['400', '500', '600', '700', '800', '900'] },
    { key: 'tracking', label: '字距(tracking)', type: 'number', default: -0.03, min: -0.1, max: 0.6, step: 0.005 },
    { key: 'plate', label: '文字底衬色', type: 'color', default: '' },
    { key: 'outline', label: '描边色', type: 'color', default: '' },
    { key: 'maxWidth', label: '最大宽度[0-1]', type: 'number', default: 0.86, min: 0.2, max: 1, step: 0.02 },
    { key: 'fit', label: '自动缩放到宽', type: 'bool', default: true },
    { key: 'ghost', label: '残影', type: 'bool', default: true },
    { key: 'align', label: '对齐', type: 'select', default: 'center', options: ['left', 'center', 'right'] },
    P.color('white'),
    P.accent('orange'),
    P.beatSync(true),
    P.beatsPerStep(2),
    P.scale(1),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h, t } = env;
    const a = envelope(env.progress, { inFrac: 0.05, outFrac: 0.06 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const cx = w * (isNaN(nx) ? 0.5 : nx), cy = h * (isNaN(ny) ? 0.5 : ny);

    const items = String(p.text).split('\n').map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    const d = Math.max(0.08, stepDur(env, p.beatsPerStep));
    const raw = (env.t - env.layer.start) / d;
    const idx = Math.floor(raw), frac = raw - idx;
    const curText = items[((idx % items.length) + items.length) % items.length];
    const prevText = items[(((idx - 1) % items.length) + items.length) % items.length];
    const rng = new Rng(Math.floor(env.t * env.fps) * 31 + idx);

    const baseSize = p.size * p.scale;
    const trackPx = baseSize * p.tracking;
    const maxW = w * p.maxWidth;
    const size = p.fit ? fitSize(ctx, curText, maxW, { font: FONTS.condensed, size: baseSize, weight: +p.weight, tracking: trackPx, min: 16 }) : baseSize;
    const align = p.align;

    ctx.save();
    ctx.globalAlpha *= a;

    // 出场动画
    const inP = clamp(frac / 0.34, 0, 1);
    let scale = 1, dy = 0, alphaMul = 1, textOverride = null;
    switch (p.mode) {
      case 'slam':
        scale = lerp(1.18, 1, easeOutExpo(inP));
        alphaMul = clamp(inP * 2.2, 0, 1);
        break;
      case 'cut':
        scale = 1; alphaMul = 1;
        break;
      case 'scramble':
        textOverride = scramble(curText, Math.pow(inP, 0.7), rng);
        break;
      case 'typewriter':
        textOverride = typewriter(curText, Math.pow(inP, 0.55));
        break;
      case 'stack':
        dy = lerp(size * 0.42, 0, easeOutExpo(inP));
        alphaMul = clamp(inP * 1.8, 0, 1);
        break;
    }
    const shown = textOverride !== null ? textOverride : curText;

    const fontOpt = { font: FONTS.condensed, size, weight: +p.weight, tracking: trackPx };
    const tw = measure(ctx, shown, fontOpt);

    // 残影：上一句淡出并轻微位移，制造"刷"的感觉
    if (p.ghost && idx > 0 && inP < 1) {
      ctx.save();
      ctx.globalAlpha *= (1 - inP) * 0.35;
      const pw = measure(ctx, prevText, { ...fontOpt, size: size * 0.98 });
      text(ctx, prevText, cx + (align === 'center' ? 0 : align === 'right' ? -pw : pw) * 0, cy - size * 0.06, {
        ...fontOpt, size: size * 0.98, color: ink, align: p.align,
        baseline: 'middle', tracking: trackPx,
      });
      ctx.restore();
    }

    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha *= alphaMul;

    // 底衬（黑底白字/白底黑字，成片里大量使用）
    if (p.plate) {
      const padX = size * 0.22, padY = size * 0.16;
      ctx.fillStyle = color(p.plate, '#000');
      const bx = align === 'center' ? cx - tw / 2 - padX : align === 'right' ? cx - tw - padX : cx - padX;
      ctx.fillRect(bx, cy - size * 0.62 + dy - padY, tw + padX * 2, size * 1.02 + padY * 2);
    }

    text(ctx, shown, cx, cy + size * 0.36 + dy, {
      ...fontOpt, size, color: ink, align, baseline: 'alphabetic',
      stroke: p.outline ? color(p.outline) : null,
      strokeWidth: Math.max(1, size * 0.014),
      shadow: p.plate ? null : { color: 'rgba(0,0,0,0.55)', blur: size * 0.16, y: size * 0.02 },
    });

    // 卡点辅助：下方细进度线，跟着拍走
    const lineW = Math.min(tw, w * 0.5);
    const lx = align === 'center' ? cx - lineW / 2 : align === 'right' ? cx - lineW : cx;
    hbar(ctx, lx, cy + size * 0.62 + dy, lineW, 3, frac, { color: acc, marks: 0 });
    // 当前句序号
    label(ctx, `${String((idx % items.length) + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`, lx, cy + size * 0.72 + dy, {
      size: Math.max(10, size * 0.075), color: ink,
    });

    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const wordGrid = {
  id: 'word-grid',
  name: '词块宫格',
  category: 'typography',
  hint: 'ESCAPE / VELOCITY / PERMANENT / UNDERCLASS 那种逐格点亮的词块墙。',
  params: [
    { key: 'text', label: '词表(空格或换行分隔)', type: 'multiline', default: 'ESCAPE VELOCITY PERMANENT UNDERCLASS 18 MONTHS LOCK IN FEEL THE ENGINE' },
    { key: 'cols', label: '列数', type: 'number', default: 5, min: 1, max: 12, step: 1 },
    { key: 'position', label: '位置', type: 'string', default: '0.5,0.5' },
    { key: 'cellW', label: '单元宽', type: 'number', default: 260, min: 60, max: 700, step: 5 },
    { key: 'cellH', label: '单元高', type: 'number', default: 84, min: 30, max: 300, step: 2 },
    { key: 'gap', label: '间距', type: 'number', default: 8, min: 0, max: 60, step: 1 },
    { key: 'mode', label: '点亮方式', type: 'select', default: 'sequence', options: ['sequence', 'row', 'random', 'sweep'] },
    { key: 'fillActive', label: '点亮时反白', type: 'bool', default: true },
    { key: 'fontSize', label: '字号', type: 'number', default: 30, min: 8, max: 120, step: 1 },
    P.color('white'),
    P.accent('orange'),
    P.beatsPerStep(1),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.08, outFrac: 0.1 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);

    const items = String(p.text).split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    const cols = Math.max(1, p.cols);
    const rows = Math.ceil(items.length / cols);
    const cw = p.cellW, ch = p.cellH, g = p.gap;
    const gw = cols * cw + (cols - 1) * g;
    const gh = rows * ch + (rows - 1) * g;
    const [nx, ny] = String(p.position).split(',').map(Number);
    const cx = w * (isNaN(nx) ? 0.5 : nx), cy = h * (isNaN(ny) ? 0.5 : ny);
    const x0 = cx - gw / 2, y0 = cy - gh / 2;

    // 每格一个拍
    const d = Math.max(0.06, stepDur(env, p.beatsPerStep));
    const stepIdx = Math.floor((env.t - env.layer.start) / d);
    const total = items.length;

    ctx.save();
    ctx.globalAlpha *= a;

    const rng = trng(env, 'grid');
    const order = items.map((_, i) => i);
    if (p.mode === 'random') { for (let i = order.length - 1; i > 0; i--) { const j = rng.int(0, i); [order[i], order[j]] = [order[j], order[i]]; } }
    const litSet = new Set();
    for (let k = 0; k <= stepIdx; k++) {
      let who = k % total;
      if (p.mode === 'row') who = Math.floor(k / cols) * cols + (k % cols);
      else if (p.mode === 'sweep') who = (k * 2) % total;
      else if (p.mode === 'random') who = order[k % total];
      litSet.add(((who % total) + total) % total);
    }
    const justLit = (() => {
      let who = stepIdx % total;
      if (p.mode === 'row') who = Math.floor(stepIdx / cols) * cols + (stepIdx % cols);
      else if (p.mode === 'sweep') who = (stepIdx * 2) % total;
      else if (p.mode === 'random') who = order[stepIdx % total];
      return ((who % total) + total) % total;
    })();
    const cellP = clamp(((env.t - env.layer.start) / d - stepIdx), 0, 1);

    items.forEach((word, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const bx = x0 + c * (cw + g), by = y0 + r * (ch + g);
      const lit = litSet.has(i);
      const isNew = i === justLit;

      ctx.save();
      if (isNew) {
        const pop = 1 + 0.06 * (1 - cellP) * (1 - cellP);
        ctx.translate(bx + cw / 2, by + ch / 2);
        ctx.scale(pop, pop);
        ctx.translate(-(bx + cw / 2), -(by + ch / 2));
      }
      // 格
      if (lit && p.fillActive) {
        ctx.fillStyle = i === justLit ? acc : ink;
        ctx.fillRect(bx, by, cw, ch);
      } else {
        ctx.strokeStyle = lit ? ink : 'rgba(255,255,255,0.32)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(bx + 0.75, by + 0.75, cw - 1.5, ch - 1.5);
        if (lit) { ctx.fillStyle = 'rgba(0,0,0,0.32)'; ctx.fillRect(bx, by, cw, ch); }
      }
      const fg = (lit && p.fillActive) ? (i === justLit ? '#0a0a0a' : '#0a0a0a') : ink;
      const fs = fitSize(ctx, word, cw - 20, { font: FONTS.condensed, size: p.fontSize, weight: 700, tracking: p.fontSize * 0.02, min: 8 });
      text(ctx, word, bx + cw / 2, by + ch / 2, {
        font: FONTS.condensed, size: fs, weight: 700, color: fg, align: 'center', baseline: 'middle',
        tracking: fs * 0.02, alpha: lit ? 1 : 0.65,
      });
      // 角落小刻度
      cornerTicks(ctx, bx + 6, by + 6, cw - 12, ch - 12, { len: 7, color: lit ? fg : 'rgba(255,255,255,0.28)', width: 1 });
      ctx.restore();
    });

    // 进度刻度
    hbar(ctx, x0, y0 + gh + 18, gw, 3, clamp((stepIdx + cellP) / Math.max(1, total), 0, 1), { color: acc, marks: total });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const titleMark = {
  id: 'title-mark',
  name: '标题定格',
  category: 'typography',
  hint: '"ZERO-DAY." / "STARGATE:" / "12°" 这种带引线和小注解的标题。',
  params: [
    { key: 'title', label: '主标题', type: 'string', default: 'ZERO-DAY.' },
    { key: 'kicker', label: '上方小字', type: 'string', default: 'SUBSECTION 04 / CLASSIFIED' },
    { key: 'note', label: '下方注解', type: 'string', default: 'ANSWER KEYS HACKED IN JULY' },
    { key: 'position', label: '位置', type: 'string', default: '0.5,0.52' },
    { key: 'size', label: '字号', type: 'number', default: 170, min: 24, max: 600, step: 2 },
    { key: 'maxWidth', label: '最大宽度[0-1]', type: 'number', default: 0.9, min: 0.2, max: 1, step: 0.02 },
    { key: 'fit', label: '自动缩字', type: 'bool', default: true },
    { key: 'rule', label: '显示引线', type: 'bool', default: true },
    { key: 'boxed', label: '加外框', type: 'bool', default: false },
    { key: 'plate', label: '底色块(空=无)', type: 'color', default: '' },
    { key: 'align', label: '对齐', type: 'select', default: 'center', options: ['left', 'center', 'right'] },
    P.color('white'),
    P.accent('orange'),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.1, outFrac: 0.12 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const cx = w * (isNaN(nx) ? 0.5 : nx), cy = h * (isNaN(ny) ? 0.52 : ny);
    // 字号自适应：宁可缩字也不要冲出画幅（大标题最容易踩这个坑）
    const size = p.fit
      ? fitSize(ctx, p.title, w * p.maxWidth, { font: FONTS.condensed, size: p.size, weight: 700, tracking: -p.size * 0.015, min: 12 })
      : p.size;
    const inP = clamp(env.progress / 0.28, 0, 1);
    const rise = (1 - easeOutExpo(inP)) * size * 0.28;
    const tw = measure(ctx, p.title, { font: FONTS.condensed, size, weight: 700 });
    const align = p.align;
    const lx = align === 'center' ? cx - tw / 2 : align === 'right' ? cx - tw : cx;

    ctx.save();
    ctx.globalAlpha *= a * clamp(inP * 2.4, 0, 1);
    ctx.translate(0, rise);

    // 底色块：亮背景上不垫底的大字是读不出来的（花背景更甚），
    // 垫一块实色底衬是最省事也最稳的解法。
    if (p.plate) {
      const kw = p.kicker ? measure(ctx, p.kicker, { font: FONTS.mono, size: 14, tracking: 1.2 }) : 0;
      const nw = p.note ? measure(ctx, p.note, { font: FONTS.mono, size: 14, tracking: 1.2 }) : 0;
      const bw = Math.max(tw, kw, nw) + size * 0.6;
      const bh = size * 1.7;
      const bx = align === 'center' ? cx - bw / 2 : align === 'right' ? cx - bw : lx - size * 0.3;
      hudPanel(ctx, bx, cy - size * 0.9, bw, bh, {
        fill: color(p.plate, '#000000'), stroke: null, ticks: false, radius: 3, shadow: true,
      });
    }
    if (p.boxed) {
      hudPanel(ctx, lx - 28, cy - size * 0.78, tw + 56, size * 1.1, { stroke: ink, tickLen: 16 });
    }
    if (p.kicker) label(ctx, p.kicker, align === 'center' ? cx : lx, cy - size * 0.72, { align, size: 14, color: ui.dim });
    if (p.rule) {
      ctx.strokeStyle = acc; ctx.lineWidth = 2;
      const rw = Math.min(tw, w * 0.6);
      const rx = align === 'center' ? cx - rw / 2 : align === 'right' ? cx - rw : lx;
      ctx.beginPath(); ctx.moveTo(rx, cy - size * 0.5); ctx.lineTo(rx + rw, cy - size * 0.5); ctx.stroke();
    }
    text(ctx, p.title, align === 'center' ? cx : lx, cy, {
      font: FONTS.condensed, size, weight: 700, color: ink, align, baseline: 'middle',
      tracking: -size * 0.015,
      shadow: { color: 'rgba(0,0,0,0.5)', blur: size * 0.2, y: size * 0.03 },
    });
    if (p.note) {
      label(ctx, p.note, align === 'center' ? cx : lx, cy + size * 0.62, { align, size: 14, color: ui.dim });
      if (p.rule) {
        const rw = Math.min(tw, w * 0.4);
        const rx = align === 'center' ? cx - rw / 2 : align === 'right' ? cx - rw : lx;
        ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(rx, cy + size * 0.56); ctx.lineTo(rx + rw, cy + size * 0.56); ctx.stroke();
      }
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const subtitleKinetic = {
  id: 'subtitle-kinetic',
  name: '卡点字幕',
  category: 'caption',
  hint: '自动读取工程里的字幕轨。支持整句弹出、逐词高亮（卡拉OK）、大标题式。',
  params: [
    { key: 'style', label: '样式', type: 'select', default: 'bar', options: ['bar', 'mono', 'hero', 'karaoke'] },
    { key: 'position', label: '位置', type: 'string', default: '0.5,0.86' },
    { key: 'size', label: '字号', type: 'number', default: 44, min: 12, max: 220, step: 2 },
    { key: 'maxWidth', label: '最大宽度[0-1]', type: 'number', default: 0.78, min: 0.2, max: 1, step: 0.02 },
    { key: 'plate', label: '文字底板', type: 'bool', default: true },
    { key: 'uppercase', label: '强制大写', type: 'bool', default: false },
    { key: 'pop', label: '卡点弹出', type: 'bool', default: true },
    P.color('white'),
    P.accent('orange'),
  ],

  draw(ctx, env) {
    const cap = env.caption;
    if (!cap) return;
    const { params: p, width: w, height: h } = env;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const cx = w * (isNaN(nx) ? 0.5 : nx), cy = h * (isNaN(ny) ? 0.86 : ny);
    const maxW = w * p.maxWidth;

    const local = env.t - cap.start;
    const span = Math.max(0.05, cap.end - cap.start);
    const inP = clamp(local / Math.min(0.22, span * 0.35), 0, 1);
    const outP = clamp((span - local) / Math.min(0.18, span * 0.3), 0, 1);
    const vis = Math.min(inP, outP);
    if (vis <= 0.001) return;

    let body = p.uppercase ? String(cap.text).toUpperCase() : String(cap.text);
    const fs = p.size;
    const lines = wrap(ctx, body, maxW, { font: p.style === 'mono' ? FONTS.mono : FONTS.condensed, size: fs, weight: p.style === 'hero' ? 800 : 700 });

    ctx.save();
    ctx.globalAlpha *= vis;
    const pop = p.pop ? 1 + 0.14 * (1 - easeOutBack(inP)) : 1;
    const shakeY = p.pop ? (1 - easeOutExpo(inP)) * fs * 0.45 : 0;
    ctx.translate(cx, cy + shakeY);
    ctx.scale(pop, pop);
    ctx.translate(-cx, -(cy + shakeY));

    const lh = fs * 1.24;
    const totalH = lines.length * lh;
    const top = cy - totalH / 2 + lh * 0.5;

    if (p.style === 'hero') {
      lines.forEach((ln, i) => {
        text(ctx, ln, cx, top + i * lh, {
          font: FONTS.condensed, size: fs, weight: 800, color: ink, align: 'center', baseline: 'middle',
          tracking: -fs * 0.01, shadow: { color: 'rgba(0,0,0,0.6)', blur: fs * 0.4, y: fs * 0.06 },
        });
      });
      ctx.fillStyle = acc;
      ctx.fillRect(cx - fs * 0.6, top - lh * 0.62, fs * 1.2, 4);
    } else if (p.style === 'mono') {
      const bw = Math.max(...lines.map((l) => measure(ctx, l, { font: FONTS.mono, size: fs, tracking: 1 })));
      if (p.plate) { ctx.fillStyle = 'rgba(0,0,0,0.66)'; ctx.fillRect(cx - bw / 2 - 16, top - lh * 0.62 - 10, bw + 32, totalH + 12); }
      lines.forEach((ln, i) => text(ctx, ln, cx, top + i * lh, {
        font: FONTS.mono, size: fs, weight: 500, color: ink, align: 'center', baseline: 'middle', tracking: 1,
      }));
    } else if (p.style === 'karaoke') {
      // 逐词高亮：需要词级时间，没有就按句内线性铺开
      const ws = (cap.words && cap.words.length) ? cap.words : null;
      const prog = clamp((local - inP * 0.05) / (span * 0.92), 0, 1);
      const line = body;
      const bw = measure(ctx, line, { font: FONTS.condensed, size: fs, weight: 700 });
      if (p.plate) {
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(cx - bw / 2 - 20, cy - lh * 0.62 - 8, bw + 40, lh + 6);
      }
      // 底：暗字
      text(ctx, line, cx, cy, { font: FONTS.condensed, size: fs, weight: 700, color: 'rgba(255,255,255,0.35)', align: 'center', baseline: 'middle' });
      // 上：高亮裁剪
      ctx.save();
      ctx.beginPath();
      const clipW = bw * prog;
      ctx.rect(cx - bw / 2, cy - lh, clipW, lh * 2);
      ctx.clip();
      text(ctx, line, cx, cy, { font: FONTS.condensed, size: fs, weight: 700, color: acc, align: 'center', baseline: 'middle' });
      ctx.restore();
    } else {
      // bar：黑色短条 + 白字，最像成片里的字幕
      const bw = Math.max(...lines.map((l) => measure(ctx, l, { font: FONTS.condensed, size: fs, weight: 700 })));
      lines.forEach((ln, i) => {
        const ly = top + i * lh;
        const lw = measure(ctx, ln, { font: FONTS.condensed, size: fs, weight: 700 });
        if (p.plate) {
          ctx.fillStyle = 'rgba(0,0,0,0.74)';
          ctx.fillRect(cx - lw / 2 - fs * 0.38, ly - lh * 0.5 - fs * 0.16, lw + fs * 0.76, lh * 0.98);
          // 左右两条小标记
          ctx.fillStyle = acc;
          ctx.fillRect(cx - lw / 2 - fs * 0.38, ly - lh * 0.5 - fs * 0.16, 3, lh * 0.98);
        }
        text(ctx, ln, cx, ly, {
          font: FONTS.condensed, size: fs, weight: 700, color: ink, align: 'center', baseline: 'middle',
          tracking: fs * 0.005,
        });
      });
    }
    ctx.restore();
  },
};

export default [kineticType, wordGrid, titleMark, subtitleKinetic];
