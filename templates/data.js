// ============================================================================
// 数据 / 图表：柱状、折线，从零长出来那种
// 都是"讲解型"画面用的：字幕配数据、汇报配趋势。
// ============================================================================

import { clamp, smoothstep, easeOutCubic } from '../engine/core.js';
import { FONTS, ui, text, label, measure, fitSize, roundRect } from '../engine/draw.js';
import { color } from './_lib.js';

function nums(s, def = [0.5, 0.5]) {
  const a = String(s || '').split(',').map(Number);
  return def.map((d, i) => (Number.isFinite(a[i]) ? a[i] : d));
}
function ramp(t, a, b) { return smoothstep(a, b, t); }

/** "标签|数值" 每行一条 */
function parseRows(s) {
  return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).map((line) => {
    const i = line.lastIndexOf('|');
    if (i < 0) return { name: line, value: 0 };
    const v = parseFloat(line.slice(i + 1));
    return { name: line.slice(0, i).trim(), value: Number.isFinite(v) ? v : 0 };
  });
}

function fmt(v, d = 0) {
  const s = Math.abs(v) >= 10000 ? (v / 10000).toFixed(1).replace(/\.0$/, '') + '万' : v.toFixed(d);
  return s;
}

// ---------------------------------------------------------------------------
export const barChart = {
  id: 'bar-chart',
  name: '柱状图',
  category: 'data',
  hint: '一组柱子从零长出来，带数值和网格。每行写「名字|数值」，讲解、汇报、对比都能用。',
  params: [
    { key: 'title', label: '标题', type: 'string', default: '每周训练量' },
    { key: 'items', label: '数据(每行 名字|数值)', type: 'multiline', default: '周一|32\n周二|58\n周三|41\n周四|76\n周五|95\n周六|63\n周日|28' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.56' },
    { key: 'width', label: '宽度[0-1]', type: 'number', default: 0.62, min: 0.2, max: 1, step: 0.02 },
    { key: 'height', label: '高度[0-1]', type: 'number', default: 0.34, min: 0.1, max: 0.8, step: 0.02 },
    { key: 'size', label: '字号', type: 'number', default: 20, min: 10, max: 60, step: 1 },
    { key: 'gap', label: '柱间距[0-1]', type: 'number', default: 0.34, min: 0.05, max: 0.7, step: 0.02 },
    { key: 'grid', label: '网格线', type: 'number', default: 4, min: 0, max: 8, step: 1 },
    { key: 'stagger', label: '错峰(秒/根)', type: 'number', default: 0.07, min: 0, max: 0.5, step: 0.01 },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '柱子色', type: 'color', default: 'orange' },
    { key: 'plate', label: '垫底色(空=无)', type: 'color', default: '#0a0a0c' },
    { key: 'plateOpacity', label: '垫底不透明度', type: 'number', default: 0.66, min: 0, max: 1, step: 0.02 },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.9, min: 0.1, max: 4, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const rows = parseRows(p.items);
    if (!rows.length) return;
    const [nx, ny] = nums(p.position);
    const bw = W * p.width, bh = H * p.height;
    const x = W * nx - bw / 2, y = H * ny - bh / 2;
    const maxV = Math.max(1e-6, ...rows.map((r) => r.value));
    const size = p.size;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.1, p.inDur)));
    const baseY = y + bh - size * 2.1;

    ctx.save();
    ctx.globalAlpha = out;
    if (p.plate) {
      ctx.globalAlpha = out * clamp(p.plateOpacity, 0, 1) * ramp(env.local, 0, p.inDur * 0.4);
      ctx.fillStyle = color(p.plate, '#0a0a0c');
      const padX = size * 2.2, padY = size * 1.8;
      roundRect(ctx, x - padX, y - padY, bw + padX * 2, bh + padY * 2, 3);
      ctx.fill();
      ctx.globalAlpha = out;
    }
    if (p.title) {
      label(ctx, p.title, x, y + size * 0.9, {
        font: FONTS.sans, size: size * 1.05, color: ink, align: 'left', baseline: 'alphabetic', alpha: 0.92,
      });
    }
    // 网格 + 刻度
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= p.grid; i++) {
      const gy = baseY - (bh - size * 2.1) * (i / Math.max(1, p.grid));
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + bw, gy); ctx.stroke();
      if (i > 0) {
        label(ctx, fmt(maxV * i / Math.max(1, p.grid)), x - size * 0.5, gy + size * 0.3, {
          font: FONTS.mono, size: size * 0.62, color: ink, align: 'right', baseline: 'alphabetic', alpha: 0.5,
        });
      }
    }
    // 柱子
    const slot = bw / rows.length;
    const barW = slot * (1 - clamp(p.gap, 0.05, 0.7));
    rows.forEach((r, i) => {
      const tt = easeOutCubic(clamp((env.local - i * p.stagger) / Math.max(0.12, p.inDur * 0.6), 0, 1));
      if (tt <= 0) return;
      const h = (bh - size * 2.1) * (r.value / maxV) * tt;
      const bx = x + slot * i + (slot - barW) / 2;
      const isMax = r.value >= maxV - 1e-6;
      ctx.fillStyle = isMax ? (acc) : 'rgba(255,255,255,0.22)';
      ctx.fillRect(bx, baseY - h, barW, h);
      if (isMax) { ctx.fillStyle = acc; ctx.fillRect(bx, baseY - h, barW, Math.max(2, size * 0.1)); }
      // 数值
      label(ctx, fmt(r.value), bx + barW / 2, baseY - h - size * 0.5, {
        font: FONTS.mono, size: size * 0.72, color: ink, align: 'center', baseline: 'alphabetic',
        alpha: tt * (isMax ? 1 : 0.75),
      });
      // 名字
      label(ctx, r.name, bx + barW / 2, baseY + size * 1.35, {
        font: FONTS.sans, size: size * 0.78, color: ink, align: 'center', baseline: 'alphabetic', alpha: 0.8,
      });
    });
    // 基线
    ctx.strokeStyle = ink; ctx.globalAlpha = out * 0.7; ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.beginPath(); ctx.moveTo(x, baseY); ctx.lineTo(x + bw, baseY); ctx.stroke();
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const lineChart = {
  id: 'line-chart',
  name: '折线图',
  category: 'data',
  hint: '折线从左往右画出来，末端带数值。数据写成一行逗号分隔，或者每行一个数。',
  params: [
    { key: 'title', label: '标题', type: 'string', default: '播放量趋势' },
    { key: 'values', label: '数据(逗号或换行)', type: 'multiline', default: '12,18,15,26,31,28,44,52,61,58,72,86' },
    { key: 'labels', label: '横轴标签(可空)', type: 'string', default: '1月,4月,7月,10月' },
    { key: 'unit', label: '单位后缀', type: 'string', default: '万' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.56' },
    { key: 'width', label: '宽度[0-1]', type: 'number', default: 0.64, min: 0.2, max: 1, step: 0.02 },
    { key: 'height', label: '高度[0-1]', type: 'number', default: 0.32, min: 0.1, max: 0.8, step: 0.02 },
    { key: 'size', label: '字号', type: 'number', default: 20, min: 10, max: 60, step: 1 },
    { key: 'grid', label: '网格线', type: 'number', default: 3, min: 0, max: 8, step: 1 },
    { key: 'area', label: '填充面积', type: 'bool', default: true },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '线色', type: 'color', default: 'orange' },
    { key: 'plate', label: '垫底色(空=无)', type: 'color', default: '#0a0a0c' },
    { key: 'plateOpacity', label: '垫底不透明度', type: 'number', default: 0.66, min: 0, max: 1, step: 0.02 },
    { key: 'inDur', label: '画线时长(秒)', type: 'number', default: 1.6, min: 0.2, max: 8, step: 0.1 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const vals = String(p.values || '').split(/[\n,，\s]+/).map(Number).filter((v) => Number.isFinite(v));
    if (vals.length < 2) return;
    const [nx, ny] = nums(p.position);
    const bw = W * p.width, bh = H * p.height;
    const x = W * nx - bw / 2, y = H * ny - bh / 2;
    const size = p.size;
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const t = clamp((env.local - 0.15) / Math.max(0.2, p.inDur), 0, 1);
    const maxV = Math.max(...vals), minV = Math.min(0, Math.min(...vals));
    const span = Math.max(1e-6, maxV - minV);
    const baseY = y + bh - size * 2.1;
    const topY = y + size * 2.2;
    const px = (i) => x + (bw * i) / (vals.length - 1);
    const py = (v) => baseY - (baseY - topY) * ((v - minV) / span);

    ctx.save();
    ctx.globalAlpha = out;
    if (p.plate) {
      ctx.globalAlpha = out * clamp(p.plateOpacity, 0, 1) * ramp(env.local, 0, 0.4);
      ctx.fillStyle = color(p.plate, '#0a0a0c');
      const padX = size * 2.2, padY = size * 1.8;
      roundRect(ctx, x - padX, y - padY, bw + padX * 2, bh + padY * 2, 3);
      ctx.fill();
      ctx.globalAlpha = out;
    }
    if (p.title) {
      label(ctx, p.title, x, y + size * 0.9, {
        font: FONTS.sans, size: size * 1.05, color: ink, align: 'left', baseline: 'alphabetic', alpha: 0.92,
      });
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1;
    for (let i = 0; i <= p.grid; i++) {
      const gy = baseY - (baseY - topY) * (i / Math.max(1, p.grid));
      ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x + bw, gy); ctx.stroke();
    }
    // 折线（按进度画到哪算哪）
    const done = t * (vals.length - 1);
    const pts = [];
    for (let i = 0; i < vals.length; i++) {
      if (i <= Math.floor(done)) pts.push([px(i), py(vals[i])]);
    }
    const frac = done - Math.floor(done);
    if (Math.floor(done) + 1 < vals.length && frac > 0) {
      const i = Math.floor(done);
      pts.push([px(i) + (px(i + 1) - px(i)) * frac, py(vals[i]) + (py(vals[i + 1]) - py(vals[i])) * frac]);
    }
    if (pts.length > 1) {
      if (p.area) {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], baseY);
        for (const [ax, ay] of pts) ctx.lineTo(ax, ay);
        ctx.lineTo(pts[pts.length - 1][0], baseY);
        ctx.closePath();
        const g = ctx.createLinearGradient(0, topY, 0, baseY);
        const c1 = color(p.accent, ui.accent);
        g.addColorStop(0, c1 + '55');
        g.addColorStop(1, c1 + '00');
        ctx.fillStyle = g;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [ax, ay] of pts.slice(1)) ctx.lineTo(ax, ay);
      ctx.strokeStyle = acc; ctx.lineWidth = Math.max(1.5, size * 0.13);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.stroke();
      // 末端点 + 数值
      const [ex, ey] = pts[pts.length - 1];
      const lastIdx = Math.min(vals.length - 1, Math.round(done));
      const showV = vals[lastIdx];
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(3, size * 0.24), 0, Math.PI * 2);
      ctx.fillStyle = acc; ctx.fill();
      ctx.beginPath(); ctx.arc(ex, ey, Math.max(6, size * 0.5), 0, Math.PI * 2);
      ctx.strokeStyle = acc; ctx.globalAlpha = out * 0.4; ctx.lineWidth = Math.max(1, size * 0.08); ctx.stroke();
      ctx.globalAlpha = out;
      const lab = fmt(showV) + (p.unit || '');
      const tw = measure(ctx, lab, { font: FONTS.mono, size: size * 0.85 });
      ctx.fillStyle = acc;
      roundRect(ctx, ex - tw / 2 - size * 0.4, ey - size * 2.1, tw + size * 0.8, size * 1.5, 2);
      ctx.fill();
      label(ctx, lab, ex, ey - size * 0.95, {
        font: FONTS.mono, size: size * 0.85, color: '#0a0a0a', align: 'center', baseline: 'alphabetic',
      });
    }
    // 横轴
    const labs = String(p.labels || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (labs.length) {
      labs.forEach((s, i) => {
        const lx = x + (bw * i) / Math.max(1, labs.length - 1);
        label(ctx, s, lx, baseY + size * 1.4, {
          font: FONTS.mono, size: size * 0.68, color: ink, align: 'center', baseline: 'alphabetic', alpha: 0.55,
        });
      });
    }
    ctx.restore();
  },
};

export default [barChart, lineChart];
