// ============================================================================
// 标注与版式：手绘圈注 / 地图定位 / 分屏对比 / 章节进度
//
// 手绘那款的线条是"抖着画"的（用图层自己的随机源），所以看着像手画的，
// 而且每一层不一样。
// ============================================================================

import { clamp, smoothstep, easeOutCubic } from '../engine/core.js';
import { FONTS, ui, text, label, measure, fitSize, roundRect } from '../engine/draw.js';
import { color } from './_lib.js';

const TAU = Math.PI * 2;

function nums(s, n = 2, def = [0.5, 0.5]) {
  const a = String(s || '').split(',').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number.isFinite(a[i]) ? a[i] : def[i]);
  return out;
}
function ramp(t, a, b) { return smoothstep(a, b, t); }

/** 给定点列，按进度画到哪算哪 */
function drawPartial(ctx, pts, prog) {
  const total = pts.length - 1;
  const done = clamp(prog, 0, 1) * total;
  const n = Math.floor(done);
  if (n < 1) return false;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i <= n; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  const frac = done - n;
  if (n + 1 <= total && frac > 0) {
    const ax = pts[n][0], ay = pts[n][1], bx = pts[n + 1][0], by = pts[n + 1][1];
    ctx.lineTo(ax + (bx - ax) * frac, ay + (by - ay) * frac);
  }
  ctx.stroke();
  return done >= total;
}

// ---------------------------------------------------------------------------
export const handMark = {
  id: 'hand-mark',
  name: '手绘圈注',
  category: 'focus',
  hint: '手绘感的圈选 / 下划线 / 箭头，会自己画出来。讲解、划重点、指东西都能用。',
  params: [
    { key: 'mode', label: '样式', type: 'select', default: 'circle', options: ['circle', 'underline', 'arrow'] },
    { key: 'region', label: '区域 x,y,w,h', type: 'string', default: '0.34,0.36,0.32,0.26' },
    { key: 'point', label: '箭头指向 x,y', type: 'string', default: '0.62,0.46' },
    { key: 'arrowLen', label: '箭头长度(px)', type: 'number', default: 210, min: 60, max: 700, step: 10 },
    { key: 'color', label: '笔色', type: 'color', default: 'orange' },
    { key: 'width', label: '笔宽', type: 'number', default: 7, min: 1, max: 30, step: 0.5 },
    { key: 'jitter', label: '手抖程度', type: 'number', default: 6, min: 0, max: 30, step: 1 },
    { key: 'double', label: '描两道', type: 'bool', default: true },
    { key: 'inDur', label: '画出来用时(秒)', type: 'number', default: 0.7, min: 0.1, max: 4, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const acc = color(p.color, ui.accent);
    const r0 = nums(p.region, 4, [0.34, 0.36, 0.32, 0.26]);
    const cx = W * (r0[0] + r0[2] / 2), cy = H * (r0[1] + r0[3] / 2);
    const ew = W * r0[2] * 0.5, eh = H * r0[3] * 0.5;
    const rng = env.rng;
    const prog = clamp((env.local - 0.06) / Math.max(0.1, p.inDur), 0, 1);
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));

    const pts = [];
    if (p.mode === 'circle') {
      const N = 46, start = -0.6;
      for (let i = 0; i <= N; i++) {
        const a = start + (i / N) * (TAU * 1.04);        // 稍微画过头，像手画的
        const wob = 1 + (rng.next() * 2 - 1) * (p.jitter / 100);
        pts.push([cx + Math.cos(a) * ew * wob, cy + Math.sin(a) * eh * wob]);
      }
      pts.push([pts[0][0] + 8, pts[0][1] + 5]);
    } else if (p.mode === 'underline') {
      const y = cy + eh;
      const seg = 14;
      for (let i = 0; i <= seg; i++) {
        const k = i / seg;
        pts.push([cx - ew + 2 * ew * k,
                  y + (rng.next() * 2 - 1) * p.jitter * 0.7 + Math.sin(k * Math.PI) * p.jitter * 0.7]);
      }
    } else {
      const pt0 = nums(p.point, 2, [0.62, 0.46]);
      const tx = W * pt0[0], ty = H * pt0[1];
      const ang = (rng.chance(0.5) ? 2.4 : 0.7) + (rng.next() * 2 - 1) * 0.4;
      const sx = tx + Math.cos(ang) * p.arrowLen, sy = ty + Math.sin(ang) * p.arrowLen;
      const mx = (sx + tx) / 2 + (rng.next() * 2 - 1) * p.jitter * 1.4;
      const my = (sy + ty) / 2 + (rng.next() * 2 - 1) * p.jitter * 1.4;
      for (let i = 0; i <= 12; i++) {
        const k = i / 12, ik = 1 - k;
        pts.push([ik * ik * sx + 2 * ik * k * mx + k * k * tx,
                  ik * ik * sy + 2 * ik * k * my + k * k * ty]);
      }
    }

    ctx.save();
    ctx.globalAlpha = out;
    ctx.strokeStyle = acc;
    ctx.lineWidth = Math.max(1, p.width);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const finished = drawPartial(ctx, pts, prog);
    if (p.double) {
      ctx.globalAlpha = out * 0.5;
      ctx.lineWidth = Math.max(1, p.width * 0.7);
      ctx.translate(3, 2);
      drawPartial(ctx, pts, prog * 0.95);
      ctx.translate(-3, -2);
    }
    if (p.mode === 'arrow' && finished) {
      const ex = pts[pts.length - 1][0], ey = pts[pts.length - 1][1];
      const bx = pts[pts.length - 2][0], by = pts[pts.length - 2][1];
      const a = Math.atan2(ey - by, ex - bx);
      const L = p.width * 3.6;
      ctx.globalAlpha = out;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - Math.cos(a - 0.42) * L, ey - Math.sin(a - 0.42) * L);
      ctx.lineTo(ex - Math.cos(a + 0.42) * L, ey - Math.sin(a + 0.42) * L);
      ctx.closePath();
      ctx.fillStyle = acc;
      ctx.fill();
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const locator = {
  id: 'locator',
  name: '地图定位',
  category: 'focus',
  hint: '地图上的定位框 + 地名 + 坐标 + 比例尺 + 指北针。旅行、纪录片、新闻都能用。',
  params: [
    { key: 'place', label: '地名', type: 'string', default: '外滩' },
    { key: 'placeEn', label: '副标 / 外文名', type: 'string', default: 'THE BUND · SHANGHAI' },
    { key: 'coord', label: '坐标', type: 'string', default: '31°14′N 121°29′E' },
    { key: 'region', label: '定位框 x,y,w,h', type: 'string', default: '0.40,0.42,0.20,0.18' },
    { key: 'cardPos', label: '信息卡位置', type: 'select', default: 'br', options: ['tl', 'tr', 'bl', 'br'] },
    { key: 'size', label: '字号', type: 'number', default: 30, min: 12, max: 90, step: 2 },
    { key: 'showScale', label: '比例尺', type: 'bool', default: true },
    { key: 'scaleText', label: '比例尺文字', type: 'string', default: '2 KM' },
    { key: 'showNorth', label: '指北针', type: 'bool', default: true },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.5, min: 0.1, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const rg = nums(p.region, 4, [0.4, 0.42, 0.2, 0.18]);
    const x = W * rg[0], y = H * rg[1], w = W * rg[2], h = H * rg[3];
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.1, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const size = p.size;

    ctx.save();
    ctx.globalAlpha = out;
    const pulse = 1 + 0.03 * Math.sin(env.local * 3.2);
    const bw = w * (0.85 + 0.15 * t) * pulse, bh = h * (0.85 + 0.15 * t) * pulse;
    const bx = x + (w - bw) / 2, by = y + (h - bh) / 2;
    const len = Math.min(bw, bh) * 0.42;
    ctx.strokeStyle = acc;
    ctx.lineWidth = Math.max(1.5, size * 0.1);
    for (const c of [[bx, by, 1, 1], [bx + bw, by, -1, 1], [bx + bw, by + bh, -1, -1], [bx, by + bh, 1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(c[0], c[1] + c[3] * len);
      ctx.lineTo(c[0], c[1]);
      ctx.lineTo(c[0] + c[2] * len, c[1]);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(bx + bw / 2, by + bh / 2, Math.max(2.5, size * 0.16), 0, TAU);
    ctx.fillStyle = acc;
    ctx.fill();

    const pad = size * 0.6;
    const nameSize = size * 1.35, enSize = size * 0.62, coSize = size * 0.6;
    const nameW = measure(ctx, p.place, { font: FONTS.sans, size: nameSize, weight: 700 });
    const enW = measure(ctx, p.placeEn, { font: FONTS.mono, size: enSize, tracking: enSize * 0.18 });
    const coW = measure(ctx, p.coord, { font: FONTS.mono, size: coSize, tracking: coSize * 0.1 });
    const cardW = Math.max(nameW, enW, coW) + pad * 2.6;
    const cardH = nameSize * 1.3 + enSize * 2.1 + coSize * 2.2 + pad;
    const rightSide = p.cardPos === 'tr' || p.cardPos === 'br';
    const lowSide = p.cardPos === 'bl' || p.cardPos === 'br';
    const slide = (1 - t) * 18;
    const cx0 = clamp(rightSide ? Math.max(bx + bw + size, 24) : bx - cardW - size, 24, W - cardW - 24);
    const cy0 = clamp(lowSide ? by + bh - cardH : by, 24, H - cardH - 24);
    const px0 = rightSide ? cx0 + slide : cx0 - slide;
    ctx.globalAlpha = out * ramp(env.local, p.inDur * 0.35, p.inDur);
    ctx.fillStyle = 'rgba(10,10,12,0.86)';
    roundRect(ctx, px0, cy0, cardW, cardH, 3);
    ctx.fill();
    ctx.fillStyle = acc;
    ctx.fillRect(px0, cy0, Math.max(3, size * 0.18), cardH);
    const tx0 = px0 + pad * 1.2;
    text(ctx, p.place, tx0, cy0 + pad * 0.9 + nameSize * 0.82, {
      font: FONTS.sans, size: nameSize, weight: 700, color: ink, align: 'left', baseline: 'alphabetic',
    });
    label(ctx, p.placeEn, tx0, cy0 + pad * 0.9 + nameSize * 0.82 + enSize * 1.8, {
      font: FONTS.mono, size: enSize, color: ink, align: 'left', baseline: 'alphabetic',
      tracking: enSize * 0.18, alpha: 0.7,
    });
    label(ctx, p.coord, tx0, cy0 + cardH - pad * 0.7, {
      font: FONTS.mono, size: coSize, color: acc, align: 'left', baseline: 'alphabetic',
      tracking: coSize * 0.1,
    });

    if (p.showScale) {
      const sw = size * 3.2, sy0 = cy0 + cardH + size * 0.9;
      if (sy0 < H - 16) {
        ctx.globalAlpha = out;
        ctx.strokeStyle = ink;
        ctx.lineWidth = Math.max(1, size * 0.07);
        ctx.beginPath();
        ctx.moveTo(px0, sy0); ctx.lineTo(px0 + sw, sy0);
        ctx.moveTo(px0, sy0 - size * 0.24); ctx.lineTo(px0, sy0 + size * 0.24);
        ctx.moveTo(px0 + sw, sy0 - size * 0.24); ctx.lineTo(px0 + sw, sy0 + size * 0.24);
        ctx.stroke();
        label(ctx, p.scaleText, px0 + sw / 2, sy0 + size * 0.95, {
          font: FONTS.mono, size: size * 0.55, color: ink, align: 'center', baseline: 'alphabetic', alpha: 0.75,
        });
      }
    }
    if (p.showNorth) {
      const nx = W - size * 3, ny = size * 2.4;
      ctx.globalAlpha = out * 0.9;
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1, size * 0.07);
      ctx.beginPath();
      ctx.moveTo(nx, ny + size);
      ctx.lineTo(nx, ny - size);
      ctx.moveTo(nx - size * 0.4, ny - size * 0.4);
      ctx.lineTo(nx, ny - size);
      ctx.lineTo(nx + size * 0.4, ny - size * 0.4);
      ctx.stroke();
      label(ctx, 'N', nx, ny - size * 1.45, {
        font: FONTS.mono, size: size * 0.6, color: ink, align: 'center', baseline: 'alphabetic',
      });
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const splitCompare = {
  id: 'split-compare',
  name: '分屏对比',
  category: 'panel',
  hint: '中间一条分隔线 + 把手，两侧各挂一个标签（原片 / 成片），可以自动扫过去。',
  params: [
    { key: 'dir', label: '方向', type: 'select', default: 'v', options: ['v', 'h'] },
    { key: 'pos', label: '位置[0-1]', type: 'number', default: 0.5, min: 0.05, max: 0.95, step: 0.01 },
    { key: 'auto', label: '自动扫过', type: 'bool', default: false },
    { key: 'sweep', label: '扫过用时(秒)', type: 'number', default: 2.5, min: 0.4, max: 10, step: 0.1 },
    { key: 'dim', label: '压暗一侧', type: 'number', default: 0.3, min: 0, max: 0.85, step: 0.02 },
    { key: 'dimSide', label: '压哪侧', type: 'select', default: 'b', options: ['b', 'a', 'none'] },
    { key: 'labelA', label: '左 / 上标签', type: 'string', default: '原片' },
    { key: 'labelB', label: '右 / 下标签', type: 'string', default: '成片' },
    { key: 'handle', label: '显示把手', type: 'bool', default: true },
    { key: 'size', label: '字号', type: 'number', default: 26, min: 12, max: 70, step: 1 },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '线色', type: 'color', default: 'orange' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.4, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const vertical = p.dir !== 'h';
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    let k = p.pos;
    if (p.auto) k = clamp((env.local - p.inDur * 0.3) / Math.max(0.4, p.sweep), 0, 1);
    const line = vertical ? W * clamp(k, 0.02, 0.98) : H * clamp(k, 0.02, 0.98);
    const size = p.size;

    ctx.save();
    // 一侧压暗
    if (p.dim > 0.001 && p.dimSide !== 'none') {
      ctx.globalAlpha = out * clamp(p.dim, 0, 0.85);
      ctx.fillStyle = '#000';
      if (vertical) {
        if (p.dimSide === 'b') ctx.fillRect(line, 0, W - line, H);
        else ctx.fillRect(0, 0, line, H);
      } else if (p.dimSide === 'b') {
        ctx.fillRect(0, line, W, H - line);
      } else {
        ctx.fillRect(0, 0, W, line);
      }
    }
    // 分隔线
    ctx.globalAlpha = out * t;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(2, size * 0.09);
    ctx.beginPath();
    if (vertical) { ctx.moveTo(line, 0); ctx.lineTo(line, H); }
    else { ctx.moveTo(0, line); ctx.lineTo(W, line); }
    ctx.stroke();
    // 把手
    if (p.handle) {
      const hr = Math.max(16, size * 0.95) * t;
      const hx = vertical ? line : W / 2;
      const hy = vertical ? H / 2 : line;
      ctx.globalAlpha = out;
      ctx.fillStyle = acc;
      ctx.beginPath(); ctx.arc(hx, hy, hr, 0, TAU); ctx.fill();
      ctx.fillStyle = '#0a0a0a';
      const ar = hr * 0.34;
      if (vertical) {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(hx + s * ar * 0.5, hy);
          ctx.lineTo(hx + s * ar * 1.5, hy - ar);
          ctx.lineTo(hx + s * ar * 1.5, hy + ar);
          ctx.closePath();
          ctx.fill();
        }
      } else {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(hx, hy + s * ar * 0.5);
          ctx.lineTo(hx - ar, hy + s * ar * 1.5);
          ctx.lineTo(hx + ar, hy + s * ar * 1.5);
          ctx.closePath();
          ctx.fill();
        }
      }
    }
    // 两个标签
    const chips = vertical
      ? [[p.labelA, line * 0.5, 0], [p.labelB, line + (W - line) * 0.5, 1]]
      : [[p.labelA, 0, 0], [p.labelB, 0, 1]];
    chips.forEach((c, i) => {
      if (!c[0]) return;
      const txt = c[0];
      const tw = measure(ctx, txt, { font: FONTS.sans, size, weight: 600 }) + size * 1.6;
      const ch = size * 2.1;
      let cx0, cy0;
      if (vertical) {
        cx0 = clamp(c[1] - tw / 2, 12, W - tw - 12);
        cy0 = 24;
      } else {
        cx0 = i === 0 ? 24 : W - tw - 24;
        cy0 = clamp(line - (i === 0 ? ch + 16 : -16), 12, H - ch - 12);
      }
      ctx.globalAlpha = out * t;
      ctx.fillStyle = i === 0 ? 'rgba(10,10,12,0.8)' : acc;
      roundRect(ctx, cx0, cy0, tw, ch, 2);
      ctx.fill();
      label(ctx, txt, cx0 + tw / 2, cy0 + ch * 0.68, {
        font: FONTS.sans, size, weight: 600,
        color: i === 0 ? ink : '#0a0a0a', align: 'center', baseline: 'alphabetic',
      });
    });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const chapterBar = {
  id: 'chapter-bar',
  name: '章节进度',
  category: 'panel',
  hint: '底部一条细进度条 + 章节刻度 + 当前章节名，长视频一眼看出"现在到哪了"。',
  params: [
    { key: 'chapters', label: '章节(每行 时间|名字)', type: 'multiline', default: '0|开场\n18|第一次交手\n46|转场\n72|高潮\n98|收尾' },
    { key: 'pos', label: '位置', type: 'select', default: 'bottom', options: ['bottom', 'top'] },
    { key: 'margin', label: '左右边距(px)', type: 'number', default: 120, min: 20, max: 600, step: 10 },
    { key: 'thick', label: '轨道粗细', type: 'number', default: 4, min: 1, max: 20, step: 0.5 },
    { key: 'size', label: '字号', type: 'number', default: 20, min: 10, max: 60, step: 1 },
    { key: 'showName', label: '显示章节名', type: 'bool', default: true },
    { key: 'showTime', label: '显示时间码', type: 'bool', default: true },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '进度色', type: 'color', default: 'orange' },
    { key: 'plate', label: '垫底色(空=无)', type: 'color', default: '#0a0a0c' },
    { key: 'plateOpacity', label: '垫底不透明度', type: 'number', default: 0.6, min: 0, max: 1, step: 0.02 },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.4, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const dur = Math.max(0.1, env.duration);
    const rows = String(p.chapters || '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const i = line.indexOf('|');
      if (i < 0) return { t: null, name: line };
      const t = parseFloat(line.slice(0, i));
      return { t: Number.isFinite(t) ? t : null, name: line.slice(i + 1).trim() };
    });
    if (!rows.length) return;
    // 没写时间的就平均分
    let auto = 0;
    rows.forEach((r) => { if (r.t === null) r.t = (auto++ / Math.max(1, rows.length)) * dur; });
    rows.sort((a, b) => a.t - b.t);

    const size = p.size;
    const m = p.margin;
    const x0 = m, x1 = W - m;
    const barY = p.pos === 'top' ? H * 0.12 : H * 0.88;
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.1, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const prog = clamp(env.t / dur, 0, 1);
    const sx = (tt) => x0 + (x1 - x0) * clamp(tt / dur, 0, 1);
    let cur = 0;
    for (let i = 0; i < rows.length; i++) if (env.t >= rows[i].t) cur = i;

    ctx.save();
    ctx.globalAlpha = out * t;
    if (p.plate) {
      ctx.globalAlpha = out * t * clamp(p.plateOpacity, 0, 1);
      ctx.fillStyle = color(p.plate, '#0a0a0c');
      ctx.fillRect(0, barY - size * 3.1, W, size * 5.4);
      ctx.globalAlpha = out * t;
    }
    // 轨道
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x0, barY - p.thick / 2, (x1 - x0) * t, p.thick);
    // 已播
    ctx.fillStyle = acc;
    ctx.fillRect(x0, barY - p.thick / 2, (x1 - x0) * prog * t, p.thick);
    // 章节刻度
    rows.forEach((r, i) => {
      const x = sx(r.t);
      ctx.fillStyle = i <= cur ? acc : 'rgba(255,255,255,0.45)';
      ctx.fillRect(x - 1, barY - size * 0.75, 2, size * 1.5);
      if (p.showName) {
        label(ctx, r.name, x + size * 0.4, barY - size * 1.05, {
          font: FONTS.mono, size: size * 0.72, color: ink, align: 'left', baseline: 'alphabetic',
          alpha: i === cur ? 1 : 0.5,
        });
      }
    });
    // 播放头
    const px = x0 + (x1 - x0) * prog * t;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(px, barY, Math.max(3, p.thick * 1.5), 0, TAU); ctx.fill();
    // 左：当前章节名；右：时间码
    if (p.showName) {
      text(ctx, rows[cur].name, x0, barY + size * 1.9, {
        font: FONTS.sans, size: size * 1.05, weight: 650, color: ink, align: 'left', baseline: 'alphabetic',
      });
    }
    if (p.showTime) {
      const fps = env.fps || 25;
      const f = Math.max(0, Math.round(env.t * fps));
      const s = Math.floor(f / fps);
      const pad = (v, n = 2) => String(v).padStart(n, '0');
      const txt = `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % fps)}`;
      label(ctx, txt, x1, barY + size * 1.9, {
        font: FONTS.mono, size: size * 0.8, color: ink, align: 'right', baseline: 'alphabetic', alpha: 0.8,
      });
    }
    ctx.restore();
  },
};

export default [handMark, locator, splitCompare, chapterBar];
