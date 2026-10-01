// ============================================================================
// 聚焦 / 标注：把观众的眼睛按到画面里的某一块
//
//   聚焦框   四角括号飞进来 + 框外压暗
//   索引标注 编号圆点 + 引出线 + 标签（多放几个就是 ①②③）
//   索引清单 一块逐条打勾的编号清单，可以跟着拍点推进
//   放大镜   圆形镜片把画面某处放大，镜片里是真的画面
// ============================================================================

import { clamp, smoothstep, easeOutCubic } from '../engine/core.js';
import { FONTS, ui, text, label, measure, fitSize, roundRect } from '../engine/draw.js';
import { color } from './_lib.js';

const TAU = Math.PI * 2;

function nums(s, n = 4, def = [0.3, 0.3, 0.4, 0.4]) {
  const a = String(s || '').split(',').map(Number);
  const out = [];
  for (let i = 0; i < n; i++) out.push(Number.isFinite(a[i]) ? a[i] : def[i]);
  return out;
}
function ramp(t, a, b) { return smoothstep(a, b, t); }

// ---------------------------------------------------------------------------
export const focusBox = {
  id: 'focus-box',
  name: '聚焦框',
  category: 'focus',
  hint: '框住画面某一块：四角括号飞进来、框外压暗，用来聚焦细节。区域可拖可改。',
  params: [
    { key: 'region', label: '区域 x,y,w,h', type: 'string', default: '0.30,0.31,0.40,0.36' },
    { key: 'style', label: '样式', type: 'select', default: 'brackets', options: ['brackets', 'box', 'rounded'] },
    { key: 'dim', label: '框外压暗', type: 'number', default: 0.45, min: 0, max: 0.92, step: 0.02 },
    { key: 'label', label: '标签文字', type: 'string', default: 'DETAIL' },
    { key: 'index', label: '编号', type: 'string', default: '01' },
    { key: 'corner', label: '标签位置', type: 'select', default: 'tl', options: ['tl', 'tr', 'bl', 'br'] },
    { key: 'bracket', label: '括号长度(px)', type: 'number', default: 56, min: 12, max: 220, step: 2 },
    { key: 'lineW', label: '线宽', type: 'number', default: 3, min: 1, max: 12, step: 0.5 },
    { key: 'color', label: '线色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'pulse', label: '呼吸脉冲', type: 'bool', default: false },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.42, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const [rx, ry, rw, rh] = nums(p.region);
    const x = W * clamp(rx, -0.2, 1), y = H * clamp(ry, -0.2, 1);
    const w = Math.max(24, W * clamp(rw, 0.02, 1.4)), h = Math.max(24, H * clamp(rh, 0.02, 1.4));
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const puls = p.pulse ? 0.5 + 0.5 * Math.sin(env.local * 2 * Math.PI / 1.6) : 0;

    // 框外压暗：四条边各画一块，中间那块留亮
    if (p.dim > 0.001) {
      ctx.save();
      ctx.globalAlpha = clamp(p.dim, 0, 0.92) * t * out * (1 - 0.18 * puls);
      ctx.fillStyle = '#000';
      const x2 = x + w, y2 = y + h;
      if (y > 0) ctx.fillRect(0, 0, W, Math.min(y, H));
      if (y2 < H) ctx.fillRect(0, Math.max(0, y2), W, H - Math.max(0, y2));
      if (x > 0) ctx.fillRect(0, Math.max(0, y), Math.min(x, W), Math.max(0, Math.min(h, H - y)));
      if (x2 < W) ctx.fillRect(Math.max(0, x2), Math.max(0, y), W - Math.max(0, x2), Math.max(0, Math.min(h, H - y)));
      ctx.restore();
    }

    const lw = Math.max(1, p.lineW) * (1 + 0.25 * puls);
    const bl = Math.max(8, p.bracket) * t;
    ctx.save();
    ctx.globalAlpha = out;
    ctx.strokeStyle = ink; ctx.lineWidth = lw; ctx.lineCap = 'butt';
    if (p.style === 'box' || p.style === 'rounded') {
      const inset = lw / 2 + (1 - t) * 14;
      ctx.globalAlpha = out * t;
      if (p.style === 'rounded') {
        roundRect(ctx, x + inset, y + inset, w - inset * 2, h - inset * 2, Math.min(18, w * 0.1));
        ctx.stroke();
      } else {
        ctx.strokeRect(x + inset, y + inset, w - inset * 2, h - inset * 2);
      }
    } else {
      // 四角括号：从外面飞进来
      const o = (1 - t) * 16;
      const corners = [
        [x - o, y - o, 1, 1], [x + w + o, y - o, -1, 1],
        [x + w + o, y + h + o, -1, -1], [x - o, y + h + o, 1, -1],
      ];
      for (const [cx, cy, sx, sy] of corners) {
        ctx.beginPath();
        ctx.moveTo(cx, cy + sy * bl);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx + sx * bl, cy);
        ctx.stroke();
      }
    }
    ctx.restore();

    // 标签：编号 + 文字，贴在选定的角
    const chipSize = Math.max(11, Math.round(Math.min(w, h) * 0.11));
    const txt = p.label ? `${p.label}` : '';
    const idx = p.index ? `${p.index}` : '';
    if (txt || idx) {
      const pad = Math.round(chipSize * 0.5);
      const iw = idx ? measure(ctx, idx, { font: FONTS.mono, size: chipSize, tracking: chipSize * 0.16 }) + pad * 2.2 : 0;
      const tw = txt ? measure(ctx, txt, { font: FONTS.mono, size: chipSize, tracking: chipSize * 0.16 }) + pad * 2.4 : 0;
      const boxW = iw + tw, boxH = chipSize * 2.1;
      const cx0 = p.corner === 'tr' || p.corner === 'br' ? x + w - boxW : x;
      const cy0 = p.corner === 'bl' || p.corner === 'br' ? y + h + Math.round(chipSize * 0.5) : y - boxH - Math.round(chipSize * 0.5);
      ctx.save();
      ctx.globalAlpha = out * ramp(env.local, p.inDur * 0.5, p.inDur);
      if (idx) {
        ctx.fillStyle = acc;
        ctx.fillRect(cx0, cy0, iw, boxH);
        label(ctx, idx, cx0 + iw / 2, cy0 + boxH * 0.68, {
          font: FONTS.mono, size: chipSize, color: '#0a0a0a', align: 'center', baseline: 'alphabetic',
          tracking: chipSize * 0.16,
        });
      }
      if (txt) {
        ctx.fillStyle = 'rgba(8,8,10,0.86)';
        ctx.fillRect(cx0 + iw, cy0, tw, boxH);
        label(ctx, txt, cx0 + iw + pad * 1.2, cy0 + boxH * 0.68, {
          font: FONTS.mono, size: chipSize, color: ink, align: 'left', baseline: 'alphabetic',
          tracking: chipSize * 0.16,
        });
      }
      ctx.restore();
    }
  },
};

// ---------------------------------------------------------------------------
export const calloutPin = {
  id: 'callout-pin',
  name: '索引标注',
  category: 'focus',
  hint: '一个编号圆点 + 引出线 + 标签，指住画面里的某个点。多放几层就是 ①②③。',
  params: [
    { key: 'index', label: '编号', type: 'string', default: '1' },
    { key: 'text', label: '标签文字', type: 'string', default: '光源位置' },
    { key: 'point', label: '指向点 x,y', type: 'string', default: '0.62,0.44' },
    { key: 'dir', label: '引出方向', type: 'select', default: 'tr', options: ['tl', 'tr', 'bl', 'br'] },
    { key: 'len', label: '引线长度(px)', type: 'number', default: 190, min: 40, max: 700, step: 5 },
    { key: 'size', label: '字号', type: 'number', default: 30, min: 12, max: 90, step: 2 },
    { key: 'dot', label: '圆点半径', type: 'number', default: 8, min: 2, max: 24, step: 1 },
    { key: 'lineW', label: '线宽', type: 'number', default: 2, min: 1, max: 8, step: 0.5 },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'plate', label: '标签垫底(空=无)', type: 'color', default: '#0a0a0c' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.6, min: 0.1, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const [px, py] = nums(p.point, 2, [0.5, 0.5]);
    const x = W * clamp(px, 0, 1), y = H * clamp(py, 0, 1);
    const right = p.dir === 'tr' || p.dir === 'br';
    const down = p.dir === 'bl' || p.dir === 'br';
    const len = p.len;
    const ease = easeOutCubic(ramp(env.local, 0, Math.max(0.06, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const tDot = easeOutCubic(ramp(env.local, 0, p.inDur * 0.28));
    const tLine = ramp(env.local, p.inDur * 0.18, p.inDur * 0.66);
    const tText = ramp(env.local, p.inDur * 0.5, p.inDur);

    // 圆点：弹一下
    ctx.save();
    ctx.globalAlpha = out;
    const rr = p.dot * tDot * (1 + 0.5 * (1 - tDot));
    ctx.beginPath(); ctx.arc(x, y, rr, 0, TAU);
    ctx.fillStyle = acc; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, rr * 1.9, 0, TAU);
    ctx.strokeStyle = acc; ctx.globalAlpha = out * 0.5 * tDot; ctx.lineWidth = Math.max(1, p.lineW * 0.7); ctx.stroke();
    ctx.restore();

    // 引出线：先斜 45° 再走平
    const kneeX = x + (right ? 1 : -1) * len * 0.42;
    const kneeY = y + (down ? 1 : -1) * len * 0.42;
    const endX = x + (right ? 1 : -1) * len;
    const segs = [[x, y, kneeX, kneeY], [kneeX, kneeY, endX, kneeY]];
    ctx.save();
    ctx.globalAlpha = out;
    ctx.strokeStyle = ink; ctx.lineWidth = Math.max(1, p.lineW);
    const totalLen = Math.hypot(kneeX - x, kneeY - y) + Math.abs(endX - kneeX);
    let drawn = totalLen * tLine;
    for (const [ax, ay, bx, by] of segs) {
      const L = Math.hypot(bx - ax, by - ay);
      if (drawn <= 0) break;
      const f = Math.min(1, drawn / Math.max(1e-6, L));
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ax + (bx - ax) * f, ay + (by - ay) * f);
      ctx.stroke();
      drawn -= L;
    }
    ctx.restore();

    // 编号 + 标签
    const size = p.size;
    const tw = measure(ctx, p.text || '', { font: FONTS.sans, size, weight: 600 });
    const badge = size * 1.5;
    const pad = size * 0.42;
    const bx = right ? endX + pad : endX - pad - badge - (p.text ? tw + pad : 0);
    const by = kneeY - badge * 0.5;
    ctx.save();
    ctx.globalAlpha = out * tText;
    if (p.plate && p.text) {
      ctx.globalAlpha = out * tText * 0.9;
      ctx.fillStyle = color(p.plate, '#0a0a0c');
      roundRect(ctx, bx, by, badge + tw + (p.text ? pad : 0), badge, 2);
      ctx.fill();
      ctx.globalAlpha = out * tText;
    }
    ctx.fillStyle = acc;
    roundRect(ctx, bx, by, badge, badge, 2);
    ctx.fill();
    text(ctx, p.index, bx + badge / 2, by + badge * 0.72, {
      font: FONTS.sans, size: size * 0.95, weight: 700, color: '#0a0a0a', align: 'center', baseline: 'alphabetic',
    });
    if (p.text) {
      text(ctx, p.text, bx + badge + pad * 0.8, by + badge * 0.72, {
        font: FONTS.sans, size, weight: 600, color: ink, align: 'left', baseline: 'alphabetic',
      });
    }
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const indexList = {
  id: 'index-list',
  name: '索引清单',
  category: 'focus',
  hint: '一块编号清单，逐条打勾推进；可以自动往下走。适合分镜、设备清单、要点罗列。',
  params: [
    { key: 'title', label: '标题', type: 'string', default: 'SIGNAL INDEX' },
    { key: 'items', label: '条目(每行一条)', type: 'multiline', default: '摄像头 A\n麦克风 L / R\n时间码同步\n电池 × 4' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.06,0.32' },
    { key: 'width', label: '宽度(px)', type: 'number', default: 420, min: 220, max: 1100, step: 10 },
    { key: 'size', label: '字号', type: 'number', default: 22, min: 12, max: 64, step: 1 },
    { key: 'step', label: '每条推进(秒)', type: 'number', default: 0.9, min: 0.15, max: 5, step: 0.05 },
    { key: 'loop', label: '循环', type: 'bool', default: true },
    { key: 'auto', label: '自动推进', type: 'bool', default: true },
    { key: 'fixed', label: '固定高亮第几条', type: 'number', default: 0, min: 0, max: 40, step: 1 },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'fill', label: '底色(空=无)', type: 'color', default: '#0a0a0c' },
    { key: 'plateOpacity', label: '底色不透明度', type: 'number', default: 0.78, min: 0, max: 1, step: 0.02 },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.4, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const [nx, ny] = nums(p.position, 2, [0.06, 0.32]);
    const rows = String(p.items || '').split('\n').map((s) => s.trim()).filter(Boolean);
    if (!rows.length) return;
    const size = p.size;
    const padX = size * 0.9, padY = size * 0.7;
    const headH = size * 1.9;
    const rowH = size * 1.75;
    const bw = p.width;
    const bh = headH + rowH * rows.length + padY;
    const x = W * clamp(nx, 0, 1), y = H * clamp(ny, 0, 1);
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));

    // 当前推进到第几条
    const idxAll = p.auto ? Math.floor(Math.max(0, env.local - p.inDur * 0.4) / Math.max(0.05, p.step)) : Math.max(0, p.fixed | 0);
    const active = p.loop ? ((idxAll % rows.length) + rows.length) % rows.length : Math.min(rows.length - 1, Math.max(0, idxAll));
    const cellP = p.auto ? clamp(((Math.max(0, env.local - p.inDur * 0.4) / Math.max(0.05, p.step)) % 1), 0, 1) : 1;

    ctx.save();
    ctx.globalAlpha = out;
    ctx.translate(x + (1 - t) * -18, y);
    // 面
    if (p.fill) {
      ctx.globalAlpha = out * clamp(p.plateOpacity, 0, 1) * t;
      ctx.fillStyle = color(p.fill, '#0a0a0c');
      roundRect(ctx, 0, 0, bw, bh, 3); ctx.fill();
    }
    ctx.globalAlpha = out * t;
    ctx.fillStyle = acc;
    ctx.fillRect(0, 0, Math.max(3, size * 0.16), bh);      // 左侧色条
    // 标题
    label(ctx, p.title, padX, headH * 0.68, {
      font: FONTS.mono, size: Math.max(11, Math.round(size * 0.72)), color: ink,
      align: 'left', baseline: 'alphabetic', tracking: size * 0.18, alpha: 0.75,
    });
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(padX, headH * 0.92, bw - padX * 2, 1);

    // 条目
    rows.forEach((s, i) => {
      const on = i === active;
      const appeared = ramp(env.local, p.inDur * 0.3 + i * 0.06, p.inDur * 0.3 + i * 0.06 + 0.22);
      const ry = headH + rowH * (i + 0.68);
      ctx.globalAlpha = out * appeared * (on ? 1 : 0.5);
      if (on) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(padX * 0.4, headH + rowH * i, bw - padX * 0.8, rowH);
      }
      // 序号
      label(ctx, String(i + 1).padStart(2, '0'), padX, ry, {
        font: FONTS.mono, size: Math.max(10, Math.round(size * 0.68)), color: on ? acc : ink,
        align: 'left', baseline: 'alphabetic', tracking: size * 0.1, alpha: on ? 1 : 0.6,
      });
      // 文字
      text(ctx, s, padX + size * 2.1, ry, {
        font: FONTS.sans, size, weight: on ? 650 : 500, color: ink, align: 'left', baseline: 'alphabetic',
      });
      // 当前条的进度条 + 对勾
      if (on) {
        const barW = (bw - padX * 2) * (i < active || !p.auto ? 1 : cellP);
        ctx.fillStyle = acc;
        ctx.fillRect(padX, headH + rowH * (i + 1) - 2, barW, 2);
        const cxk = bw - padX * 1.1, cyk = ry - size * 0.3;
        ctx.strokeStyle = acc; ctx.lineWidth = Math.max(1.5, size * 0.11); ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cxk - size * 0.34, cyk);
        ctx.lineTo(cxk - size * 0.1, cyk + size * 0.26);
        ctx.lineTo(cxk + size * 0.36, cyk - size * 0.3);
        ctx.stroke();
      }
    });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
export const magnifier = {
  id: 'magnifier',
  name: '放大镜',
  category: 'focus',
  hint: '圆形镜片把画面某处放大（镜片里是画面本身），用来强调细节。',
  params: [
    { key: 'center', label: '镜片中心 x,y', type: 'string', default: '0.5,0.46' },
    { key: 'radius', label: '半径(px)', type: 'number', default: 220, min: 40, max: 760, step: 10 },
    { key: 'zoom', label: '放大倍数', type: 'number', default: 2, min: 1.05, max: 5, step: 0.05 },
    { key: 'ring', label: '外圈', type: 'bool', default: true },
    { key: 'crosshair', label: '准星', type: 'bool', default: true },
    { key: 'dim', label: '镜片外压暗', type: 'number', default: 0.18, min: 0, max: 0.8, step: 0.02 },
    { key: 'label', label: '角标文字', type: 'string', default: '×2.0' },
    { key: 'color', label: '线色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.5, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.35, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const [nx, ny] = nums(p.center, 2, [0.5, 0.46]);
    const cx = W * clamp(nx, 0, 1), cy = H * clamp(ny, 0, 1);
    const t = easeOutCubic(ramp(env.local, 0, Math.max(0.05, p.inDur)));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const r = Math.max(12, p.radius * (0.6 + 0.4 * t));
    const z = Math.max(1.05, p.zoom);
    const src = ctx.canvas;                    // 读已经画好的画面（下层 + 素材）

    // 镜片外轻微压暗，眼球自然跟过去
    if (p.dim > 0.001) {
      ctx.save();
      ctx.globalAlpha = clamp(p.dim, 0, 0.8) * out;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.arc(cx, cy, r, 0, TAU, true);
      ctx.fill('evenodd');
      ctx.restore();
    }

    // 镜片内容：把画面同一块放大画进来
    ctx.save();
    ctx.globalAlpha = out;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    const sw = (r * 2) / z, sh = (r * 2) / z;
    try {
      ctx.drawImage(src, cx - sw / 2, cy - sh / 2, sw, sh, cx - r, cy - r, r * 2, r * 2);
    } catch (_) { /* 某些环境不让自绘，退化成只画圈 */ }
    ctx.restore();

    // 外圈 + 准星 + 角标
    ctx.save();
    ctx.globalAlpha = out;
    if (p.ring) {
      ctx.strokeStyle = ink; ctx.lineWidth = Math.max(2, r * 0.02);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
      ctx.strokeStyle = acc; ctx.lineWidth = Math.max(1.5, r * 0.014);
      ctx.beginPath(); ctx.arc(cx, cy, r + r * 0.035, -0.9, 0.5); ctx.stroke();
    }
    if (p.crosshair) {
      const g = r * 0.16, l = r * 0.24;
      ctx.strokeStyle = ink; ctx.globalAlpha = out * 0.85; ctx.lineWidth = Math.max(1, r * 0.01);
      ctx.beginPath();
      ctx.moveTo(cx - g - l, cy); ctx.lineTo(cx - g, cy);
      ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + l, cy);
      ctx.moveTo(cx, cy - g - l); ctx.lineTo(cx, cy - g);
      ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + l);
      ctx.stroke();
    }
    if (p.label) {
      const size = Math.max(11, Math.round(r * 0.13));
      const tw = measure(ctx, p.label, { font: FONTS.mono, size, tracking: size * 0.14 }) + size * 1.6;
      ctx.globalAlpha = out;
      ctx.fillStyle = acc;
      roundRect(ctx, cx - tw / 2, cy + r - size * 0.9, tw, size * 1.9, 2);
      ctx.fill();
      label(ctx, p.label, cx, cy + r + size * 0.42, {
        font: FONTS.mono, size, color: '#0a0a0a', align: 'center', baseline: 'alphabetic', tracking: size * 0.14,
      });
    }
    ctx.restore();
  },
};

export default [focusBox, calloutPin, indexList, magnifier];
