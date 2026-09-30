// ============================================================================
// HUD 类模板：整屏细线框、读数、仪表、跑马灯、参数条
// 对应成片里那种"主机面板叠在画面上"的底噪感。
// ============================================================================

import {
  text, label, measure, hudPanel, cornerTicks, microRow, hbar, dial, crosshair,
  scanlines, ruler, sprockets, gridLines, ui, palette, FONTS, ticker,
  statBlock, barcode, dotGrid,
} from '../engine/draw.js';
import { clamp, lerp, Rng, timecode } from '../engine/core.js';
import { envelope, nb, color, trng, fmtNumber, fakeCode, anchor, P } from './_lib.js';

// ---------------------------------------------------------------------------
export const hudFrame = {
  id: 'hud-frame',
  name: 'HUD 全屏框',
  category: 'overlay',
  hint: '整屏四角、刻度、时间码、上下跑马灯。作为打底叠加层最稳。',
  params: [
    { key: 'inset', label: '内缩', type: 'number', default: 44, min: 0, max: 300, step: 2 },
    { key: 'corners', label: '四角括号', type: 'bool', default: true },
    { key: 'tickLen', label: '括号长度', type: 'number', default: 26, min: 6, max: 120, step: 2 },
    { key: 'rulers', label: '侧边刻度', type: 'bool', default: true },
    { key: 'timecode', label: '时间码', type: 'bool', default: true },
    { key: 'tickerTop', label: '上跑马灯', type: 'string', default: 'ESCAPE VELOCITY  11.2 KM/S  PERMANENT UNDERCLASS' },
    { key: 'tickerBottom', label: '下跑马灯', type: 'string', default: 'SIGNAL LOCKED  AGENT ONLINE  TOKENS BURNED  NVIDIA GTC' },
    { key: 'labelLeft', label: '左上标签', type: 'string', default: 'SIGNAL' },
    { key: 'labelRight', label: '右上标签', type: 'string', default: 'REC' },
    { key: 'meter', label: '电平条', type: 'bool', default: true },
    { key: 'noise', label: '噪点强度', type: 'number', default: 0.5, min: 0, max: 1.5, step: 0.05 },
    P.color('white'),
    P.accent('orange'),
    P.speed(1),
  ],

  draw(ctx, env) {
    const { width: w, height: h, params: p, t } = env;
    const a = envelope(env.progress, { inFrac: 0.06, outFrac: 0.06 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const rng = trng(env, 'hud');
    const ins = p.inset;
    const x = ins, y = ins, bw = w - ins * 2, bh = h - ins * 2;

    ctx.save();
    ctx.globalAlpha *= a;

    // 细边框 + 四角
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, bw - 1, bh - 1);
    if (p.corners) cornerTicks(ctx, x, y, bw, bh, { len: p.tickLen, color: ink, width: 2 });

    // 侧边刻度
    if (p.rulers) {
      ruler(ctx, x + 10, y + 40, bh - 80, { phase: t * 26 * p.speed, color: 'rgba(255,255,255,0.4)' });
      ctx.save();
      ctx.translate(w - x - 10, y + 40);
      ctx.rotate(Math.PI / 2);
      ruler(ctx, 0, 0, h - y * 2 - 80, { phase: t * 26 * p.speed, color: 'rgba(255,255,255,0.4)' });
      ctx.restore();
    }

    // 左上：标签 + 状态 + 假数据
    const bx = x + 22, by = y + 20;
    label(ctx, p.labelLeft || 'SIGNAL', bx, by, { color: ui.dim });
    const stateTxt = rng.next() > 0.5 ? 'LOCKED' : 'TRACKING';
    label(ctx, stateTxt, bx + measure(ctx, p.labelLeft || 'SIGNAL', { font: FONTS.mono, size: 13, tracking: 1.2 }) + 14, by, { color: acc });
    label(ctx, `${fakeCode(rng, 3)}-${fakeCode(rng, 4)}`, bx, by + 20, { color: 'rgba(255,255,255,0.42)' });

    // 右上：REC 点 + 时间码
    const rx = x + bw - 22;
    label(ctx, (p.labelRight || 'REC').toUpperCase(), rx - 16, by, { color: ui.dim, align: 'right' });
    ctx.fillStyle = acc;
    ctx.globalAlpha *= 0.55 + 0.45 * (env.beatPhase > -0.06 && env.beatPhase < 0.06 ? 1 : 0.2);
    ctx.beginPath(); ctx.arc(rx - 4, by + 6, 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = a * (env.layer.opacity ?? 1);

    if (p.timecode) {
      ctx.save();
      ctx.globalAlpha *= a;
      text(ctx, timecode(t, env.fps, true), rx, by + 22, {
        font: FONTS.mono, size: 15, color: ink, align: 'right', baseline: 'top', tracking: 1.5,
      });
      ctx.restore();
    }

    // 电平条（跟着节拍跳）
    if (p.meter) {
      const mw = 132, mh = 6;
      const mx = bx, my = y + bh - 30;
      const lvl = clamp(0.28 + 0.72 * Math.max(0, 1 - Math.abs(env.beatPhase) / (env.beat.beatDur * 0.5)), 0, 1);
      hbar(ctx, mx, my, mw, mh, lvl, { color: acc, track: 'rgba(255,255,255,0.18)', marks: 12 });
      label(ctx, 'LEVEL', mx, my - 16, { size: 11, color: ui.dim });
    }

    // 跑马灯
    if (p.tickerTop) {
      ticker(ctx, x + 22, y + 46, bw - 44, 24, p.tickerTop, {
        t, speed: 70 * p.speed, size: 13, color: ink, alpha: 0.9, columns: 8,
      });
    }
    if (p.tickerBottom) {
      ticker(ctx, x + 22, y + bh - 62, bw - 44, 24, p.tickerBottom, {
        t, speed: -58 * p.speed, size: 13, color: ink, alpha: 0.85, columns: 6,
      });
    }

    // 中心十字（很淡）
    crosshair(ctx, w / 2, h / 2, 46, { color: ink, alpha: 0.28, width: 1 });

    // 噪点刻度：随机小方块，制造"传感器噪声"
    if (p.noise > 0) {
      ctx.globalAlpha = a * 0.5 * p.noise;
      ctx.fillStyle = ink;
      for (let i = 0; i < 26; i++) {
        const nx = x + rng.range(0, bw), ny = y + rng.range(0, bh);
        ctx.fillRect(nx, ny, rng.range(1, 3.5), rng.range(1, 2));
      }
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const statCounter = {
  id: 'stat-counter',
  name: '数字滚动计数',
  category: 'overlay',
  hint: '卡点跳数字：+25% / 12° / 2.3KB / 0%。配 HUD 框用效果最好。',
  params: [
    { key: 'value', label: '目标值', type: 'number', default: 25, min: -99999, max: 99999, step: 0.01 },
    { key: 'from', label: '起始值', type: 'number', default: 0, min: -99999, max: 99999, step: 0.01 },
    { key: 'decimals', label: '小数位', type: 'number', default: 0, min: 0, max: 4, step: 1 },
    { key: 'prefix', label: '前缀', type: 'string', default: '' },
    { key: 'suffix', label: '后缀', type: 'string', default: '%' },
    { key: 'label', label: '标签', type: 'string', default: 'PROBABILITY' },
    { key: 'position', label: '位置', type: 'string', default: '0.70,0.22' },
    { key: 'size', label: '字号', type: 'number', default: 130, min: 24, max: 520, step: 4 },
    { key: 'bar', label: '显示进度条', type: 'bool', default: true },
    { key: 'roll', label: '滚动方式', type: 'select', default: 'count', options: ['count', 'slot', 'scramble'] },
    P.color('white'),
    P.accent('orange'),
    P.beatSync(true),
    P.beatsPerStep(1),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h, t } = env;
    const a = envelope(env.progress, { inFrac: 0.1, outFrac: 0.1 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const rng = trng(env, 'stat');
    const [nx, ny] = String(p.position).split(',').map(Number);
    const x = w * (isNaN(nx) ? 0.7 : nx), y = h * (isNaN(ny) ? 0.22 : ny);
    const size = p.size;
    const rngSeed = 0;

    // 进度：优先跟节拍走，否则用图层归一化进度
    let e;
    if (p.beatSync) {
      const d = Math.max(0.12, env.beat.beatDur * p.beatsPerStep);
      const steps = Math.max(2, Math.round(env.duration / d));
      const stepF = clamp(env.local / env.duration * steps, 0, steps);
      e = clamp(stepF / steps, 0, 1);
      // 卡点式跳变
      e = Math.floor(e * steps) / Math.max(1, steps - 1);
      e = clamp(e, 0, 1);
    } else {
      e = clamp(env.progress / 0.6, 0, 1);
    }
    const eased = 1 - Math.pow(1 - clamp(e, 0, 1), 3);
    const val = lerp(p.from, p.value, eased);

    ctx.save();
    ctx.globalAlpha *= a;
    ctx.textAlign = 'left';

    let shown;
    if (p.roll === 'scramble') {
      const target = fmtNumber(val, { decimals: p.decimals, sign: false, group: true });
      shown = '';
      for (let i = 0; i < target.length; i++) {
        const ch = target[i];
        if (/[0-9]/.test(ch)) shown += rng.next() > clamp(e * 1.6, 0, 1) ? String(rng.int(0, 9)) : ch;
        else shown += ch;
      }
    } else if (p.roll === 'slot') {
      const target = fmtNumber(val, { decimals: p.decimals, group: true });
      shown = target;
    } else {
      shown = fmtNumber(val, { decimals: p.decimals, sign: false, group: true });
    }

    const full = `${p.prefix || ''}${shown}${p.suffix || ''}`;
    const fontOpt = { font: FONTS.condensed, size, weight: 700, color: ink, tracking: -size * 0.02 };
    const tw = measure(ctx, full, fontOpt);

    // 底色条：让白字压在画面上仍然可读（成片里常见做法）
    ctx.globalAlpha *= 0.92;
    ctx.fillStyle = 'rgba(0,0,0,0.0)';
    const pop = p.beatSync ? 1 + 0.05 * Math.max(0, 1 - Math.abs(env.beatPhase) / (env.beat.beatDur * 0.35)) : 1;
    ctx.translate(x, y);
    ctx.scale(pop, pop);
    ctx.translate(-x, -y);

    if (p.label) label(ctx, p.label, x, y - 28, { size: 14, color: ui.dim });
    text(ctx, full, x, y + size, { ...fontOpt, baseline: 'alphabetic', shadow: { color: 'rgba(0,0,0,0.6)', blur: 22, y: 4 } });

    if (p.bar) {
      const bw = Math.max(tw, size * 3.2);
      hbar(ctx, x, y + size + 22, bw, 4, eased, { color: acc, marks: 20 });
      microRow(ctx, [['P', fmtNumber(eased * 100, { decimals: 1 }) + '%'], ['N', String(env.beatIndex)]], x, y + size + 40, { size: 11 });
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const dialGauge = {
  id: 'dial-gauge',
  name: '圆盘仪表',
  category: 'overlay',
  hint: '成片里那个 0%~100% 的圆盘，配百分比和刻度。',
  params: [
    { key: 'value', label: '数值(0-1)', type: 'number', default: 0.68, min: 0, max: 1, step: 0.01 },
    { key: 'position', label: '位置', type: 'string', default: '0.80,0.72' },
    { key: 'radius', label: '半径', type: 'number', default: 62, min: 20, max: 260, step: 2 },
    { key: 'label', label: '标签', type: 'string', default: 'HUMANITY' },
    { key: 'showValue', label: '显示数值', type: 'bool', default: true },
    { key: 'sweep', label: '卡点扫动', type: 'bool', default: true },
    P.color('white'),
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.12, outFrac: 0.12 });
    if (a <= 0.001) return;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const [nx, ny] = String(p.position).split(',').map(Number);
    const cx = w * (isNaN(nx) ? 0.8 : nx), cy = h * (isNaN(ny) ? 0.72 : ny);

    let prog = clamp(env.progress / 0.65, 0, 1);
    if (p.sweep) {
      const d = Math.max(0.1, env.beat.beatDur * 2);
      const steps = Math.max(2, Math.round(env.duration / d));
      prog = clamp(Math.floor((env.local / env.duration) * steps) / (steps - 1), 0, 1);
    }
    prog = 1 - Math.pow(1 - prog, 2);
    const val = p.value * prog;

    ctx.save();
    ctx.globalAlpha *= a;
    dial(ctx, cx, cy, p.radius, val, {
      color: ink, value: p.showValue ? fmtNumber(val * 100, { decimals: 0 }) + '%' : null, size: p.radius * 0.19,
    });
    if (p.label) label(ctx, p.label, cx, cy + p.radius + 14, { align: 'center', size: 12, color: ui.dim });
    ctx.fillStyle = acc;
    ctx.fillRect(cx - 18, cy - p.radius - 16, 36, 2);
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const tickerStrip = {
  id: 'ticker-strip',
  name: '跑马灯条',
  category: 'overlay',
  hint: '独立可摆放的滚动信息条，可放屏幕任意位置，常贴在上下边缘。',
  params: [
    { key: 'text', label: '内容', type: 'string', default: 'THE SINGULARITY IS NEAR  ·  ESCAPE VELOCITY  ·  LOCK IN  ·  FEEL THE AGI' },
    { key: 'position', label: 'X,Y,W [0-1]', type: 'string', default: '0.06,0.06,0.88' },
    { key: 'height', label: '高度', type: 'number', default: 34, min: 16, max: 160, step: 1 },
    { key: 'size', label: '字号', type: 'number', default: 15, min: 8, max: 60, step: 1 },
    { key: 'columns', label: '分列', type: 'number', default: 8, min: 0, max: 24, step: 1 },
    { key: 'fpsRoll', label: '帧率滚动', type: 'bool', default: false },
    P.speed(1),
    P.color('white'),
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { params: p, width: w, height: h, t } = env;
    const a = envelope(env.progress, { inFrac: 0.04, outFrac: 0.06 });
    if (a <= 0.001) return;
    const parts = String(p.position).split(',').map(Number);
    const x = w * (parts[0] ?? 0.06), y = h * (parts[1] ?? 0.06);
    const bw = w * (parts[2] ?? 0.88);
    const bh = p.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const rng = trng(env, 'tick');
    const rng2 = new Rng(Math.floor(t * 12));

    ctx.save();
    ctx.globalAlpha *= a;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, bw, bh);
    ticker(ctx, x, y, bw, bh, p.text, {
      t: p.fpsRoll ? Math.round(t * env.fps) / env.fps : t,
      speed: 96 * p.speed, size: p.size, color: ink, columns: p.columns, direction: 1,
    });
    // 右侧实时码：跟帧号联动，看着像真的
    const code = `${String(env.frame).padStart(4, '0')} ${fakeCode(rng2, 6)}`;
    ctx.globalAlpha *= 1;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x + bw - 132, y, 132, bh);
    label(ctx, code, x + bw - 122, y + 10, { size: 12, color: acc });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const paramTicks = {
  id: 'param-ticks',
  name: '参数刻度簇',
  category: 'overlay',
  hint: '一组小滑杆 + 读数，角落里的"工程感"。成片里到处都是。',
  params: [
    { key: 'position', label: '位置', type: 'string', default: '0.06,0.72' },
    { key: 'width', label: '宽度', type: 'number', default: 260, min: 120, max: 800, step: 10 },
    { key: 'rows', label: '行数', type: 'number', default: 4, min: 1, max: 10, step: 1 },
    { key: 'live', label: '数值跳动', type: 'bool', default: true },
    { key: 'frame', label: '外框', type: 'bool', default: true },
    P.color('white'),
    P.accent('orange'),
  ],
  draw(ctx, env) {
    const { params: p, width: w, height: h } = env;
    const a = envelope(env.progress, { inFrac: 0.1, outFrac: 0.1 });
    if (a <= 0.001) return;
    const [nx, ny] = String(p.position).split(',').map(Number);
    const x = w * (isNaN(nx) ? 0.06 : nx), y = h * (isNaN(ny) ? 0.72 : ny);
    const bw = p.width;
    const rowH = 30;
    const bh = p.rows * rowH + 16;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, palette.orange);
    const seed = trng(env, 'pticks');
    const rng = new Rng(Math.floor(env.t * 8) + Math.floor(seed.next() * 1000));
    const rows = Math.min(p.rows, ROW_NAMES.length);

    ctx.save();
    ctx.globalAlpha *= a;
    if (p.frame) hudPanel(ctx, x, y, bw, bh, { fill: 'rgba(0,0,0,0.45)', tickLen: 8, stroke: 'rgba(255,255,255,0.5)' });
    for (let i = 0; i < rows; i++) {
      const ry = y + 10 + i * rowH;
      const [name, unit, base] = ROW_NAMES[i];
      const v = p.live ? base * (0.82 + rng.next() * 0.36) : base;
      label(ctx, name, x + 12, ry, { size: 11, color: ui.dim });
      const barX = x + 74, barW = bw - 74 - 78;
      hbar(ctx, barX, ry + 3, barW, 5, clamp(v, 0, 1), { color: i === 1 ? acc : ink, marks: 10 });
      label(ctx, `${v.toFixed(3)}${unit}`, x + bw - 12, ry, { size: 11, align: 'right', color: ink });
    }
    ctx.restore();
  },
};

const ROW_NAMES = [
  ['TEMP', '°', 0.62],
  ['TOKENS', 'M', 0.44],
  ['LATENCY', 'ms', 0.71],
  ['ENTROPY', '', 0.33],
  ['FLUX', '/s', 0.58],
  ['DRIFT', '', 0.21],
  ['CHARGE', '%', 0.86],
  ['NOISE', 'dB', 0.49],
  ['GAIN', 'x', 0.67],
  ['RISK', '', 0.77],
];

export default [hudFrame, statCounter, dialGauge, tickerStrip, paramTicks];
