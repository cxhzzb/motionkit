// ============================================================================
// 仪器面板类模板：雷达扫描、波形/频谱、胶片条
// 这批都是"把画面当仪器表面"的叠加层：细线、读数、克制的运动。
// ============================================================================

import {
  text, label, measure, hudPanel, roundRect, crosshair, hbar, microRow,
  scanlines, cornerTicks, gridLines, ui, palette, FONTS,
} from '../engine/draw.js';
import { TAU, clamp, lerp, easeOutCubic, timecode } from '../engine/core.js';
import { envelope, color, trng, fakeCode, chars, P } from './_lib.js';

/** "x,y" 或 "x,y,w" 形式的归一化位置参数 */
function posOf(env, raw, defX = 0.5, defY = 0.5) {
  const parts = String(raw || '').split(',').map((s) => Number(String(s).trim()));
  const x = Number.isFinite(parts[0]) ? parts[0] : defX;
  const y = Number.isFinite(parts[1]) ? parts[1] : defY;
  const w = Number.isFinite(parts[2]) ? parts[2] : null;
  return { x, y, w };
}

/** 拿真实音频波形；没有音频时退回确定性伪波形，保证缩略图和纯叠加层也画得出东西 */
function waveSource(env, n, tag) {
  let pk = null;
  try {
    const st = globalThis.MotionKit && globalThis.MotionKit.state;
    pk = st && st.media ? st.media.peaks : null;
  } catch (_) { /* 无头渲染 / 单文件版可能没有这一层 */ }
  const rng = trng(env, tag);
  const out = new Float32Array(n);
  const phase = rng.next() * TAU;
  if (pk && pk.length) {
    // 把整条波形按播放头位置铺开：柱子后面的时间会往左跑
    const t0 = clamp(env.t / Math.max(0.001, env.scene.duration), 0, 1);
    const span = 1 / 3;                       // 窗口 = 全曲的 1/3
    for (let i = 0; i < n; i++) {
      const u = clamp(t0 + (i / n - 0.5) * span, 0, 1);
      out[i] = clamp(pk[Math.min(pk.length - 1, Math.floor(u * pk.length))] || 0, 0, 1);
    }
    return out;
  }
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const v = Math.abs(Math.sin(u * 9.1 + phase)) * 0.55
      + Math.abs(Math.sin(u * 23.7 + phase * 1.7)) * 0.3
      + rng.next() * 0.15;
    out[i] = clamp(v, 0.04, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
export const radarSweep = {
  id: 'radar-sweep',
  name: '雷达扫描',
  category: 'overlay',
  hint: '圆形雷达盘 + 扫描线 + 余晖残影，目标点会随扫描角点亮；左下角带方位读数。',
  params: [
    { key: 'position', label: '圆心 x,y', type: 'string', default: '0.5,0.5' },
    { key: 'radius', label: '半径', type: 'number', default: 300, min: 40, max: 1000, step: 5 },
    { key: 'rpm', label: '转速（圈/分）', type: 'number', default: 18, min: 1, max: 120, step: 1 },
    { key: 'trail', label: '余晖', type: 'number', default: 0.75, min: 0, max: 1, step: 0.05 },
    { key: 'rings', label: '同心圈', type: 'number', default: 3, min: 0, max: 8, step: 1 },
    { key: 'spokes', label: '十字刻度', type: 'bool', default: true },
    { key: 'blips', label: '目标点', type: 'number', default: 5, min: 0, max: 20, step: 1 },
    { key: 'sweepColor', label: '扫描色', type: 'color', default: '#39ff88' },
    { key: 'gridColor', label: '盘面色', type: 'color', default: 'white' },
    { key: 'labelText', label: '左上标签', type: 'string', default: 'PROXIMITY' },
    P.accent('orange'),
    P.speed(1),
  ],

  draw(ctx, env) {
    const { params: p, t } = env;
    const a = envelope(env.progress, { inFrac: 0.07, outFrac: 0.07 });
    if (a <= 0.001) return;
    const acc = color(p.accent, palette.orange);
    const sw = color(p.sweepColor, ui.good);
    const grid = color(p.gridColor, ui.paper);
    const rng = trng(env, 'radar');
    const pts = posOf(env, p.position);
    const cx = env.width * pts.x;
    const cy = env.height * pts.y;
    const r = Math.max(20, p.radius);
    const ang = (t * p.speed * p.rpm / 60) * TAU;
    const alphaOf = (target) => {
      let d = (ang - target) % TAU;
      if (d < 0) d += TAU;
      return Math.pow(1 - d / TAU, 1 + p.trail * 5);
    };

    ctx.save();
    ctx.globalAlpha *= a;

    // 盘面
    ctx.strokeStyle = grid;
    ctx.globalAlpha *= 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
    for (let i = 1; i <= p.rings; i++) {
      ctx.beginPath(); ctx.arc(cx, cy, (r * i) / (p.rings + 1), 0, TAU); ctx.stroke();
    }
    if (p.spokes) {
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const A = (i / 4) * TAU;
        ctx.moveTo(cx + Math.cos(A) * r * 0.06, cy + Math.sin(A) * r * 0.06);
        ctx.lineTo(cx + Math.cos(A) * r, cy + Math.sin(A) * r);
      }
      ctx.stroke();
      // 每 30° 一根短刻度
      for (let i = 0; i < 12; i++) {
        const A = (i / 12) * TAU;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(A) * r * 0.93, cy + Math.sin(A) * r * 0.93);
        ctx.lineTo(cx + Math.cos(A) * r, cy + Math.sin(A) * r);
        ctx.stroke();
      }
    }
    ctx.globalAlpha /= 0.5;

    // 扫描余晖：一段扇形渐变
    const tail = 0.9 + p.trail * 1.5;          // 弧度
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, sw);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, ang - tail, ang);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha *= 0.18 + p.trail * 0.3;
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    // 扫描线本体
    ctx.strokeStyle = sw;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r);
    ctx.stroke();

    // 目标点
    const n = Math.round(p.blips);
    for (let i = 0; i < n; i++) {
      const target = rng.next() * TAU;
      const rr = r * (0.25 + rng.next() * 0.7);
      const glow = alphaOf(target);
      if (glow <= 0.03) continue;
      const bx = cx + Math.cos(target) * rr;
      const by = cy + Math.sin(target) * rr;
      ctx.globalAlpha *= 1;
      ctx.fillStyle = glow > 0.7 ? acc : sw;
      ctx.beginPath(); ctx.arc(bx, by, 3 + glow * 3, 0, TAU); ctx.fill();
      ctx.globalAlpha *= glow;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx, by, 7 + (1 - glow) * 16, 0, TAU); ctx.stroke();
      ctx.globalAlpha /= glow;
    }

    // 圆心 + 十字
    crosshair(ctx, cx, cy, r * 0.16, { color: grid, alpha: 0.6 });
    ctx.fillStyle = sw;
    ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, TAU); ctx.fill();

    // 读数：方位角 + 标签
    const deg = ((ang / TAU) * 360 + 360) % 360;
    label(ctx, p.labelText || 'PROXIMITY', cx - r, cy - r - 26, { color: ui.dim });
    label(ctx, `${deg.toFixed(1).padStart(5, '0')}°`, cx + r, cy - r - 26, { color: sw, align: 'right' });
    label(ctx, `${fakeCode(rng, 2)}-${fakeCode(rng, 3)}`, cx - r, cy + r + 10, { color: 'rgba(255,255,255,0.4)' });
    label(ctx, `GATE ${String(Math.round(p.rpm)).padStart(3, '0')}`, cx + r, cy + r + 10, { color: ui.faint, align: 'right' });

    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const waveformPanel = {
  id: 'waveform-panel',
  name: '波形 / 频谱',
  category: 'overlay',
  hint: '一条跟着音频起伏的波形条（柱状 / 折线 / 面积）。有音频就用真波形，没有就是稳定的伪波形。',
  params: [
    { key: 'position', label: '位置 x,y', type: 'string', default: '0.5,0.78' },
    { key: 'span', label: '宽度', type: 'number', default: 900, min: 120, max: 1900, step: 10 },
    { key: 'height', label: '高度', type: 'number', default: 140, min: 30, max: 600, step: 5 },
    { key: 'bars', label: '柱数', type: 'number', default: 56, min: 8, max: 200, step: 1 },
    { key: 'mode', label: '样式', type: 'select', default: 'bars', options: ['bars', 'line', 'area'] },
    { key: 'mirror', label: '上下对称', type: 'bool', default: true },
    { key: 'panel', label: '画面板底', type: 'bool', default: true },
    { key: 'title', label: '标题', type: 'string', default: 'AUDIO SPECTRUM' },
    { key: 'readout', label: '显示读数', type: 'bool', default: true },
    { key: 'barColor', label: '波形色', type: 'color', default: '#39ff88' },
    P.accent('orange'),
    P.speed(1),
  ],

  draw(ctx, env) {
    const { params: p, t } = env;
    const a = envelope(env.progress, { inFrac: 0.08, outFrac: 0.08 });
    if (a <= 0.001) return;
    const acc = color(p.accent, palette.orange);
    const wave = color(p.barColor, ui.good);
    const pts = posOf(env, p.position, 0.5, 0.78);
    const W = Math.max(60, p.span);
    const H = Math.max(20, p.height);
    const x0 = clamp(env.width * pts.x - W / 2, 0, Math.max(0, env.width - W));
    const y0 = clamp(env.height * pts.y - H / 2, 0, Math.max(0, env.height - H));
    const n = Math.max(8, Math.round(p.bars));
    const data = waveSource(env, n, 'wave');
    // 播放头扫过时整体轻微呼吸，避免"死图"
    const breathe = 0.9 + 0.1 * Math.sin(t * p.speed * 2.1);

    ctx.save();
    ctx.globalAlpha *= a;

    if (p.panel) {
      hudPanel(ctx, x0, y0, W, H, { stroke: 'rgba(255,255,255,0.35)', fill: 'rgba(0,0,0,0.34)', title: p.title || null });
    }

    const padX = p.panel ? 14 : 0;
    const padTop = p.panel ? 14 : 0;
    const padBot = p.panel ? (p.readout ? 24 : 12) : 0;
    const iw = W - padX * 2;
    const ih = H - padTop - padBot;
    const midY = y0 + padTop + ih / 2;
    const step = iw / n;

    // 中线
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + padX, midY + 0.5);
    ctx.lineTo(x0 + padX + iw, midY + 0.5);
    ctx.stroke();

    const barW = Math.max(1, step * 0.62);
    if (p.mode === 'bars') {
      for (let i = 0; i < n; i++) {
        const v = clamp(data[i] * breathe, 0, 1);
        const h = Math.max(1, v * (p.mirror ? ih / 2 : ih));
        const bx = x0 + padX + i * step + (step - barW) / 2;
        // 最右一小段用强调色，像"当前电平"
        const hot = i > n - 6;
        ctx.fillStyle = hot ? acc : wave;
        if (p.mirror) ctx.fillRect(bx, midY - h, barW, h * 2);
        else ctx.fillRect(bx, y0 + padTop + ih - h, barW, h);
      }
    } else {
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = clamp(data[i] * breathe, 0, 1);
        const px = x0 + padX + i * step + step / 2;
        const py = p.mirror ? midY - v * (ih / 2) : y0 + padTop + ih - v * ih;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      if (p.mode === 'area') {
        const lastX = x0 + padX + (n - 1) * step + step / 2;
        ctx.lineTo(lastX, y0 + padTop + ih);
        ctx.lineTo(x0 + padX + step / 2, y0 + padTop + ih);
        ctx.closePath();
        ctx.globalAlpha *= 0.85;
        ctx.fillStyle = wave;
        ctx.globalAlpha *= 0.28;
        ctx.fill();
        ctx.globalAlpha /= 0.28;
        ctx.globalAlpha /= 0.85;
      }
      ctx.strokeStyle = wave;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    if (p.readout) {
      const peak = data.reduce((m, v) => Math.max(m, v), 0) * breathe;
      microRow(ctx, [
        ['PEAK', (peak * 100).toFixed(0) + '%'],
        ['RMS', (peak * 70).toFixed(0) + '%'],
        ['BIN', String(n)],
      ], x0 + padX, y0 + H - 18, { size: 11, keyColor: ui.faint, valueColor: ui.paper });
      label(ctx, timecode(t, env.fps), x0 + W - padX, y0 + H - 18, { size: 11, color: acc, align: 'right' });
    }

    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const filmStrip = {
  id: 'film-strip',
  name: '胶片条',
  category: 'overlay',
  hint: '上下（或左右）一条带齿孔的半透黑条 + 帧号跳动；给画面加"在过片"的实拍质感。',
  params: [
    { key: 'edge', label: '位置', type: 'select', default: 'both', options: ['top', 'bottom', 'both', 'left', 'right'] },
    { key: 'band', label: '条宽', type: 'number', default: 46, min: 12, max: 200, step: 2 },
    { key: 'speed', label: '滚动速度', type: 'number', default: 60, min: 0, max: 400, step: 5 },
    { key: 'counter', label: '帧号读数', type: 'bool', default: true },
    { key: 'flicker', label: '闪烁', type: 'number', default: 0.12, min: 0, max: 0.6, step: 0.02 },
    { key: 'bandColor', label: '条色', type: 'color', default: 'black' },
    { key: 'holeColor', label: '齿孔色', type: 'color', default: 'white' },
    P.accent('orange'),
  ],

  draw(ctx, env) {
    const { params: p, width: w, height: h, t } = env;
    const a = envelope(env.progress, { inFrac: 0.05, outFrac: 0.05 });
    if (a <= 0.001) return;
    const acc = color(p.accent, palette.orange);
    const hole = color(p.holeColor, ui.paper);
    const rng = trng(env, 'film');
    const bw = Math.max(12, p.band);
    const phase = t * p.speed;
    const edges = p.edge === 'both' ? ['top', 'bottom'] : [p.edge];

    ctx.save();
    ctx.globalAlpha *= a;
    // 过片闪烁：整条亮度轻微跳
    const fl = 1 - p.flicker * rng.next();

    for (const e of edges) {
      const horizontal = e === 'top' || e === 'bottom';
      const bx = e === 'left' ? 0 : e === 'right' ? w - bw : 0;
      const by = e === 'top' ? 0 : e === 'bottom' ? h - bw : 0;
      const bwide = horizontal ? w : bw;
      const bhigh = horizontal ? bw : h;

      ctx.fillStyle = color(p.bandColor, '#000000');
      ctx.globalAlpha *= (0.72 + 0.28 * fl);
      ctx.fillRect(bx, by, bwide, bhigh);
      ctx.globalAlpha /= (0.72 + 0.28 * fl);

      // 齿孔：沿长边排
      if (horizontal) {
        ctx.fillStyle = hole;
        ctx.globalAlpha *= 0.85;
        const gap = 26, hw = 13, hh = 8;
        const shift = ((phase % gap) + gap) % gap;
        const hy = by + bhigh / 2 - hh / 2;
        for (let px = -shift; px < w; px += gap) {
          roundRect(ctx, px, hy, hw, hh, 2);
          ctx.fill();
        }
        ctx.globalAlpha /= 0.85;
      } else {
        ctx.fillStyle = hole;
        ctx.globalAlpha *= 0.85;
        const gap = 26, hw = 8, hh = 13;
        const shift = ((phase % gap) + gap) % gap;
        const hx = bx + bw / 2 - hw / 2;
        for (let py = -shift; py < h; py += gap) {
          roundRect(ctx, hx, py, hw, hh, 2);
          ctx.fill();
        }
        ctx.globalAlpha /= 0.85;
      }

      // 边缘细线，让条和画面分得开
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (e === 'top') { ctx.moveTo(0, bhigh + 0.5); ctx.lineTo(w, bhigh + 0.5); }
      else if (e === 'bottom') { ctx.moveTo(0, h - bhigh + 0.5); ctx.lineTo(w, h - bhigh + 0.5); }
      else if (e === 'left') { ctx.moveTo(bw + 0.5, 0); ctx.lineTo(bw + 0.5, h); }
      else { ctx.moveTo(w - bw + 0.5, 0); ctx.lineTo(w - bw + 0.5, h); }
      ctx.stroke();
    }

    // 帧号读数
    if (p.counter) {
      const frame = Math.max(0, Math.round(t * env.fps));
      const roll = String(frame % 100000).padStart(5, '0');
      const onTop = p.edge !== 'bottom';
      const cy = onTop ? 14 : h - bw - 20;
      ctx.save();
      ctx.globalAlpha *= 0.9;
      label(ctx, 'KODA 5219', bw + 18, cy, { size: 12, color: 'rgba(255,255,255,0.7)' });
      label(ctx, `FRAME ${roll}`, w - bw - 18, cy, { size: 12, color: acc, align: 'right' });
      if (p.edge === 'both') {
        label(ctx, `${fakeCode(rng, 4)}-${fakeCode(rng, 4)}`, bw + 18, h - 30, { size: 12, color: 'rgba(255,255,255,0.5)' });
        label(ctx, '24 FPS', w - bw - 18, h - 30, { size: 12, color: 'rgba(255,255,255,0.5)', align: 'right' });
      }
      ctx.restore();
    }

    ctx.restore();
  },
};

export default [radarSweep, waveformPanel, filmStrip];
