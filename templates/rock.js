// ============================================================================
// 摇滚 / 海报：压扁的大字、错版印刷、网点、胶带、撕边
//
// 设计语言：印刷海报那一路 —— 高对比、大字号、故意做旧的错版与网点，
// 动效是"砸下来 + 抖一下"，不是慢慢淡入。
// ============================================================================

import { clamp, smoothstep, easeOutCubic } from '../engine/core.js';
import { FONTS, ui, text, label, measure, fitSize, roundRect, dotGrid, shake } from '../engine/draw.js';
import { color } from './_lib.js';

function pos(param, dx = 0.5, dy = 0.5) {
  const [x, y] = String(param || '').split(',').map(Number);
  return { x: Number.isFinite(x) ? x : dx, y: Number.isFinite(y) ? y : dy };
}
function ramp(t, a, b) { return smoothstep(a, b, t); }

/** 撕边矩形：四条边都带锯齿，用来做撕纸 / 胶带 */
function tornRect(ctx, x, y, w, h, rng, jag = 6) {
  const j = (n) => (rng.next() * 2 - 1) * n;
  ctx.beginPath();
  ctx.moveTo(x + j(jag), y + j(jag));
  ctx.lineTo(x + w + j(jag), y + j(jag));
  ctx.lineTo(x + w + j(jag), y + h + j(jag));
  ctx.lineTo(x + j(jag), y + h + j(jag));
  ctx.closePath();
}

// ---------------------------------------------------------------------------
export const rockTitle = {
  id: 'rock-title',
  name: '摇滚大标题',
  category: 'rock',
  hint: '压扁的大字 + 错版重影 + 撕边色带，砸下来还会抖。开场 / 副歌 / 高潮用。',
  params: [
    { key: 'text', label: '主标题（换行=多行）', type: 'multiline', default: 'NO\nSURRENDER' },
    { key: 'sub', label: '下方小字', type: 'string', default: '2026 WORLD TOUR · LIVE IN SHANGHAI' },
    { key: 'tag', label: '左上角标签', type: 'string', default: 'SIDE A' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.5' },
    { key: 'size', label: '字号', type: 'number', default: 168, min: 20, max: 600, step: 2 },
    { key: 'maxWidth', label: '最大宽度[0-1]', type: 'number', default: 0.78, min: 0.2, max: 1, step: 0.02 },
    { key: 'rotate', label: '倾斜(度)', type: 'number', default: -1.4, min: -20, max: 20, step: 0.2 },
    { key: 'accent', label: '强调色', type: 'color', default: 'red' },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'band', label: '撕边色带', type: 'bool', default: true },
    { key: 'offset', label: '错版偏移(px)', type: 'number', default: 7, min: 0, max: 40, step: 1 },
    { key: 'holes', label: '网点底纹', type: 'bool', default: true },
    { key: 'shakeAmt', label: '落地抖动', type: 'number', default: 0.6, min: 0, max: 3, step: 0.1 },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.42, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const red = color(p.accent, '#ff2d2d');
    const c = pos(p.position);
    const cx = W * c.x, cy = H * c.y;
    const maxW = W * Math.max(0.2, p.maxWidth);

    const lines = String(p.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) return;

    // 每行都按最大宽度自动缩，保证是多长的词都不会冲出画面
    const perLine = lines.map((ln) => ({
      s: ln,
      size: fitSize(ctx, ln, maxW, { font: FONTS.condensed, size: p.size, weight: 800, tracking: -p.size * 0.01, min: 12 }),
    }));
    const size = Math.min(...perLine.map((l) => l.size));
    const lh = size * 0.94;
    const totalH = lh * perLine.length;
    const widest = Math.max(...perLine.map((l) => measure(ctx, l.s, { font: FONTS.condensed, size, weight: 800, tracking: -size * 0.01 })));

    const t = ramp(env.local, 0, Math.max(0.05, p.inDur));
    const pop = 1 + (1 - easeOutCubic(t)) * 0.18;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    // 落地抖动：只在入场那 0.35 秒内有，之后完全静止
    const sh = (1 - ramp(env.local, 0, 0.35)) * p.shakeAmt * size * 0.035;
    const off = sh > 0.01 ? shake(env.local, sh, 22, 7) : { x: 0, y: 0 };

    const padX = size * 0.34, padY = size * 0.22;
    const bandW = widest + padX * 2;
    const bandH = totalH + padY * 1.5;
    const bandX = cx - bandW / 2, bandY = cy - totalH / 2 - padY * 0.75;

    ctx.save();
    ctx.globalAlpha = out;
    ctx.translate(cx + off.x, cy + off.y);
    ctx.rotate((p.rotate || 0) * Math.PI / 180);
    ctx.scale(pop, pop);
    ctx.translate(-cx, -cy);

    // 网点底纹（印刷感）
    if (p.holes) {
      ctx.save();
      ctx.globalAlpha = out * 0.5;
      dotGrid(ctx, bandX - 26, bandY - 26, bandW + 52, bandH + 52, Math.max(7, size * 0.075), {
        color: ink, r: Math.max(0.8, size * 0.009), alpha: 0.32,
      });
      ctx.restore();
    }

    // 撕边色带
    if (p.band) {
      ctx.save();
      ctx.fillStyle = red;
      ctx.globalAlpha = out * 0.95;
      tornRect(ctx, bandX, bandY, bandW, bandH, env.rng, size * 0.05);
      ctx.fill();
      ctx.restore();
    }

    // 文字：先画错版重影，再画正字
    const drawLines = (dx, dy, col, alpha) => {
      ctx.save();
      ctx.globalAlpha = alpha * out;
      perLine.forEach((l, i) => {
        const y = cy - totalH / 2 + lh * (i + 0.78) + dy;
        text(ctx, l.s, cx + dx, y, {
          font: FONTS.condensed, size, weight: 800, color: col,
          align: 'center', baseline: 'alphabetic', tracking: -size * 0.01,
        });
      });
      ctx.restore();
    };
    if (p.offset > 0) drawLines(p.offset, p.offset * 0.6, '#0a0a0a', 0.55);
    drawLines(0, 0, ink, 1);

    ctx.restore();

    // 标签 + 下方小字（不跟着抖，位置固定在色带外侧）
    ctx.save();
    ctx.globalAlpha = out * clamp(t, 0, 1);
    if (p.tag) {
      const tagSize = Math.max(11, Math.round(size * 0.11));
      const tw = measure(ctx, p.tag, { font: FONTS.mono, size: tagSize, tracking: tagSize * 0.2 }) + tagSize * 1.4;
      const ty = cy - totalH / 2 - padY * 0.75 - tagSize * 2.1;
      ctx.fillStyle = '#0a0a0a';
      ctx.fillRect(cx - bandW / 2, ty - tagSize * 0.2, tw, tagSize * 1.7);
      label(ctx, p.tag, cx - bandW / 2 + tagSize * 0.7, ty + tagSize * 1.05, {
        font: FONTS.mono, size: tagSize, color: ink, align: 'left', baseline: 'alphabetic', tracking: tagSize * 0.2,
      });
    }
    if (p.sub) {
      const subSize = Math.max(12, Math.round(size * 0.135));
      label(ctx, p.sub, cx, cy + totalH / 2 + padY * 0.9 + subSize * 1.4, {
        font: FONTS.mono, size: subSize, color: ink, align: 'center', baseline: 'alphabetic',
        tracking: subSize * 0.26, alpha: 0.9,
        shadow: { color: 'rgba(0,0,0,0.55)', blur: 10, y: 1 },
      });
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const tapeLabel = {
  id: 'tape-label',
  name: '胶带标签',
  category: 'rock',
  hint: '一截胶带啪地贴上去：序号 / 侧标 / 备注。当章节标记或"手工感"的注脚。',
  params: [
    { key: 'label', label: '主标签', type: 'string', default: 'SIDE A' },
    { key: 'note', label: '第二截小字（空=不贴）', type: 'string', default: 'REEL 02 · 24FPS' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.5' },
    { key: 'size', label: '字号', type: 'number', default: 48, min: 12, max: 200, step: 2 },
    { key: 'angle', label: '倾斜(度)', type: 'number', default: -5, min: -30, max: 30, step: 0.5 },
    { key: 'tapeColor', label: '胶带色', type: 'color', default: '#e8d9a8' },
    { key: 'accent', label: '强调色', type: 'color', default: 'red' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.3, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const c = pos(p.position);
    const red = color(p.accent, '#ff2d2d');
    const size = p.size;
    const t = ramp(env.local, 0, Math.max(0.05, p.inDur));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    // 贴上去的那一下：从 -18° 甩到目标角度，稍微过冲
    const overshoot = Math.sin(clamp(t, 0, 1) * Math.PI) * 0.18;
    const ang = (p.angle || 0) - (1 - t) * 18;

    const tapW = measure(ctx, p.label, { font: FONTS.mono, size, tracking: size * 0.16 }) + size * 2.2;
    const tapH = size * 1.85;

    ctx.save();
    ctx.globalAlpha = out;
    ctx.translate(W * c.x, H * c.y);
    ctx.rotate((ang + overshoot) * Math.PI / 180);
    ctx.scale(1 + (1 - t) * 0.06, 1 + (1 - t) * 0.06);

    // 胶带本体
    ctx.save();
    ctx.globalAlpha = out * 0.92;
    ctx.fillStyle = color(p.tapeColor, '#e8d9a8');
    tornRect(ctx, -tapW / 2, -tapH / 2, tapW, tapH, env.rng, size * 0.16);
    ctx.fill();
    // 纤维纹路
    ctx.globalAlpha = out * 0.16;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
      const y = -tapH / 2 + (tapH / 6) * i;
      ctx.beginPath();
      ctx.moveTo(-tapW / 2 + size * 0.1, y);
      ctx.lineTo(tapW / 2 - size * 0.1, y + env.rng.range(-1.5, 1.5));
      ctx.stroke();
    }
    ctx.restore();

    // 标签文字
    label(ctx, p.label, 0, size * 0.34, {
      font: FONTS.mono, size, color: '#141416', align: 'center', baseline: 'alphabetic',
      tracking: size * 0.16,
    });
    // 一条红线（印刷标记）
    ctx.fillStyle = red;
    ctx.fillRect(-tapW / 2 + size * 0.5, -tapH / 2 + size * 0.28, tapW - size, Math.max(2, size * 0.06));

    // 第二截小胶带，斜着叠上去
    if (p.note) {
      const ns = Math.max(11, Math.round(size * 0.34));
      const nw = measure(ctx, p.note, { font: FONTS.mono, size: ns, tracking: ns * 0.14 }) + ns * 1.6;
      const nh = ns * 1.9;
      ctx.save();
      ctx.translate(tapW / 2 - ns * 1.2, tapH * 0.62);
      ctx.rotate(7 * Math.PI / 180);
      ctx.fillStyle = color(p.tapeColor, '#e8d9a8');
      ctx.globalAlpha = out * 0.9;
      tornRect(ctx, -nw, -nh / 2, nw, nh, env.rng, ns * 0.14);
      ctx.fill();
      ctx.globalAlpha = out;
      label(ctx, p.note, -nw / 2, ns * 0.34, {
        font: FONTS.mono, size: ns, color: '#141416', align: 'center', baseline: 'alphabetic',
        tracking: ns * 0.14,
      });
      ctx.restore();
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const gigPoster = {
  id: 'gig-poster',
  name: '演出海报',
  category: 'rock',
  hint: '演出海报式信息卡：压扁大标题 + 日期 / 场地 / 票价，带撕边和网点。信息卡 / 开场用。',
  params: [
    { key: 'title', label: '标题（换行=两行）', type: 'multiline', default: 'LOUD\n& CLEAR' },
    { key: 'kicker', label: '顶部小标', type: 'string', default: 'LIVE 2026' },
    { key: 'line1', label: '信息行 1', type: 'string', default: '07.18 SAT · 20:30' },
    { key: 'line2', label: '信息行 2', type: 'string', default: 'MAO LIVEHOUSE · SHANGHAI' },
    { key: 'line3', label: '信息行 3', type: 'string', default: '预售 ¥180 / 现场 ¥220' },
    { key: 'stamp', label: '角标', type: 'string', default: 'ADMIT ONE' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.5' },
    { key: 'width', label: '卡片宽度[0-1]', type: 'number', default: 0.46, min: 0.2, max: 0.9, step: 0.02 },
    { key: 'size', label: '标题字号', type: 'number', default: 118, min: 20, max: 400, step: 2 },
    { key: 'angle', label: '倾斜(度)', type: 'number', default: -1.2, min: -15, max: 15, step: 0.2 },
    { key: 'paper', label: '纸色底', type: 'bool', default: true },
    { key: 'accent', label: '强调色', type: 'color', default: 'red' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.5, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.4, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const red = color(p.accent, '#ff2d2d');
    const paper = p.paper ? '#efece4' : '#0d0d0f';
    const onPaper = p.paper ? '#0b0b0c' : '#efece4';
    const c = pos(p.position);
    const cx = W * c.x, cy = H * c.y;

    const cardW = W * clamp(p.width, 0.2, 0.9);
    const titleLines = String(p.title || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 2);
    if (!titleLines.length) return;
    const innerW = cardW - cardW * 0.16;
    const lineSizes = titleLines.map((ln) => fitSize(ctx, ln, innerW, {
      font: FONTS.condensed, size: p.size, weight: 800, tracking: -p.size * 0.01, min: 12,
    }));
    const size = Math.min(...lineSizes);
    const lh = size * 0.96;

    const kickSize = Math.max(11, Math.round(size * 0.13));
    const infoSize = Math.max(11, Math.round(size * 0.125));
    const padX = cardW * 0.08;
    const cardH = lh * titleLines.length + kickSize * 2.6 + infoSize * 4.6 + size * 0.5;

    const t = ramp(env.local, 0, Math.max(0.05, p.inDur));
    const tIn = easeOutCubic(clamp(t, 0, 1));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));

    ctx.save();
    ctx.globalAlpha = out;
    ctx.translate(cx, cy);
    ctx.rotate(((p.angle || 0) + (1 - tIn) * 4) * Math.PI / 180);
    ctx.scale(0.92 + 0.08 * tIn, 0.92 + 0.08 * tIn);
    ctx.translate(-cardW / 2, -cardH / 2);

    // 投影
    ctx.save();
    ctx.globalAlpha = out * 0.45;
    ctx.fillStyle = '#000';
    ctx.filter = 'blur(0px)';
    roundRect(ctx, 6, 8, cardW, cardH, 2);
    ctx.fill();
    ctx.restore();

    // 纸面
    ctx.fillStyle = paper;
    tornRect(ctx, 0, 0, cardW, cardH, env.rng, size * 0.05);
    ctx.fill();

    // 网点条（印刷感）
    ctx.save();
    ctx.globalAlpha = out * 0.5;
    const stripH = cardH * 0.13;
    dotGrid(ctx, padX, cardH - stripH * 1.5, cardW - padX * 2, stripH, Math.max(6, size * 0.06), {
      color: red, r: Math.max(0.9, size * 0.011), alpha: 0.55,
    });
    ctx.restore();

    // 顶部小标 + 红色横条
    ctx.fillStyle = red;
    ctx.fillRect(padX, kickSize * 1.5, cardW - padX * 2, Math.max(3, size * 0.035));
    label(ctx, p.kicker, padX, kickSize * 1.1, {
      font: FONTS.mono, size: kickSize, color: onPaper, align: 'left', baseline: 'alphabetic',
      tracking: kickSize * 0.3,
    });

    // 大标题
    titleLines.forEach((ln, i) => {
      const y = kickSize * 2.2 + lh * (i + 0.8);
      text(ctx, ln, padX, y, {
        font: FONTS.condensed, size, weight: 800, color: onPaper,
        align: 'left', baseline: 'alphabetic', tracking: -size * 0.01,
      });
    });

    // 信息行
    const infoTop = kickSize * 2.2 + lh * titleLines.length + infoSize * 1.2;
    [p.line1, p.line2, p.line3].filter(Boolean).forEach((s, i) => {
      label(ctx, s, padX, infoTop + infoSize * 1.7 * i, {
        font: FONTS.mono, size: infoSize, color: onPaper, align: 'left', baseline: 'alphabetic',
        tracking: infoSize * 0.1, alpha: i === 0 ? 0.95 : 0.7,
      });
    });

    // 角标
    if (p.stamp) {
      const ss = Math.max(10, Math.round(size * 0.1));
      const tw = measure(ctx, p.stamp, { font: FONTS.mono, size: ss, tracking: ss * 0.18 }) + ss * 1.2;
      ctx.save();
      ctx.translate(cardW - padX - tw, cardH - ss * 3.4);
      ctx.rotate(-6 * Math.PI / 180);
      ctx.fillStyle = red;
      ctx.fillRect(0, 0, tw, ss * 2);
      label(ctx, p.stamp, tw / 2, ss * 1.28, {
        font: FONTS.mono, size: ss, color: '#fff', align: 'center', baseline: 'alphabetic', tracking: ss * 0.18,
      });
      ctx.restore();
    }
    ctx.restore();
  },
};

// 注意：export 必须放在所有 const 之后，否则会踩 TDZ（这里踩过一次）
export default [rockTitle, gigPoster, tapeLabel];
