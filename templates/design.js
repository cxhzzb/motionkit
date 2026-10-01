// ============================================================================
// 设计感模板：杂志标题 / 名字条 / 片尾名单
//
// 和前面那批"终端 HUD"不是一套语言。这三款走排版设计那一路：
// 大留白、细线、克制的动效，适合纪录片、访谈、品牌片、片尾字幕。
// ============================================================================

import { clamp, smoothstep } from '../engine/core.js';
import { FONTS, ui, text, label, measure, fitSize, roundRect } from '../engine/draw.js';
import { color } from './_lib.js';

/** "0.5,0.5" -> {x,y}（和其它模板保持一致的写法） */
function pos(param, dx = 0.5, dy = 0.5) {
  const [x, y] = String(param || '').split(',').map(Number);
  return { x: Number.isFinite(x) ? x : dx, y: Number.isFinite(y) ? y : dy };
}

/** 在 a..b 秒之间把 0 平滑地推到 1 */
function ramp(t, a, b) { return smoothstep(a, b, t); }

// ---------------------------------------------------------------------------
export const editorialTitle = {
  id: 'editorial-title',
  name: '杂志标题',
  category: 'design',
  hint: '大留白 + 细分割线 + 小号大写标签，编辑部那套排版。适合章节卡、纪录片、访谈片头。',
  params: [
    { key: 'title', label: '主标题', type: 'string', default: '夜里的河' },
    { key: 'kicker', label: '上方小标', type: 'string', default: 'CHAPTER ONE' },
    { key: 'note', label: '下方注释', type: 'string', default: '2026 · 纪录片' },
    { key: 'index', label: '编号', type: 'string', default: '01 / 06' },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.5' },
    { key: 'align', label: '对齐', type: 'select', default: 'center', options: ['left', 'center'] },
    { key: 'size', label: '字号', type: 'number', default: 132, min: 20, max: 600, step: 2 },
    { key: 'maxWidth', label: '最大宽度[0-1]', type: 'number', default: 0.78, min: 0.2, max: 1, step: 0.02 },
    { key: 'rule', label: '细分割线', type: 'bool', default: true },
    { key: 'indexPos', label: '编号位置', type: 'select', default: 'right', options: ['right', 'left', 'none'] },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'plate', label: '垫底色(空=无)', type: 'color', default: '' },
    { key: 'plateOpacity', label: '垫底不透明度', type: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.55, min: 0, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.4, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const c = pos(p.position);
    const cx = W * c.x, cy = H * c.y;
    const maxW = W * Math.max(0.2, p.maxWidth);

    const titleSize = fitSize(ctx, p.title, maxW, {
      font: FONTS.sans, size: p.size, weight: 800, tracking: -p.size * 0.02, min: 12,
    });
    const tk = -titleSize * 0.02;
    const tw = measure(ctx, p.title, { font: FONTS.sans, size: titleSize, weight: 800, tracking: tk });
    const kickSize = Math.max(11, Math.round(titleSize * 0.135));
    const noteSize = Math.max(11, Math.round(titleSize * 0.125));
    const kickW = measure(ctx, p.kicker, { font: FONTS.mono, size: kickSize, tracking: kickSize * 0.24 });
    const noteW = measure(ctx, p.note, { font: FONTS.mono, size: noteSize, tracking: noteSize * 0.12 });

    const gapK = Math.round(titleSize * 0.34);
    const gapN = Math.round(titleSize * 0.30);
    const blockW = Math.max(tw, kickW, noteW, titleSize * 0.6);
    const blockH = kickSize + (p.rule ? gapK : 0) + titleSize + gapN + noteSize;
    const top = cy - blockH / 2;
    const left = p.align === 'center' ? cx - blockW / 2 : cx - maxW / 2;
    const tA = p.align === 'center' ? 'center' : 'left';
    const ax = p.align === 'center' ? cx : left;

    const tLine = ramp(env.local, 0, Math.max(0.001, p.inDur * 0.5));
    const tTitle = ramp(env.local, p.inDur * 0.18, Math.max(0.02, p.inDur * 0.78));
    const tMeta = ramp(env.local, p.inDur * 0.5, Math.max(0.03, p.inDur));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));

    if (p.plate) {
      const padX = Math.round(titleSize * 0.42), padY = Math.round(titleSize * 0.34);
      const x0 = (p.align === 'center' ? cx - blockW / 2 : left) - padX;
      const x1 = (p.align === 'center' ? cx + blockW / 2 : left + blockW) + padX;
      ctx.save();
      ctx.globalAlpha = clamp(p.plateOpacity, 0, 1) * out;
      ctx.fillStyle = color(p.plate, '#0a0a0c');
      roundRect(ctx, x0, top - padY, x1 - x0, blockH + padY * 2, 3);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = clamp(tMeta * 0.95, 0, 1) * out;
    if (p.kicker) {
      label(ctx, p.kicker, ax, top + kickSize, {
        font: FONTS.mono, size: kickSize, color: ink, align: tA, baseline: 'alphabetic',
        tracking: kickSize * 0.24, alpha: 0.9,
      });
    }
    if (p.index && p.indexPos !== 'none') {
      const ix = p.indexPos === 'left' ? left : left + blockW;
      label(ctx, p.index, ix, top + kickSize, {
        font: FONTS.mono, size: kickSize, color: acc,
        align: p.indexPos === 'left' ? 'left' : 'right',
        baseline: 'alphabetic', tracking: kickSize * 0.18,
      });
    }
    ctx.restore();

    if (p.rule) {
      const ry = top + kickSize + Math.round(gapK * 0.42);
      const x0 = p.align === 'center' ? cx - blockW / 2 : left;
      const hLine = Math.max(1.5, titleSize * 0.014);
      ctx.save();
      ctx.globalAlpha = out * 0.85;
      ctx.fillStyle = ink;
      ctx.fillRect(x0, ry, blockW * tLine, hLine);
      ctx.globalAlpha = out;
      ctx.fillStyle = acc;
      ctx.fillRect(x0, ry, Math.min(blockW * tLine, titleSize * 0.5), hLine);
      ctx.restore();
    }

    const ty = top + kickSize + (p.rule ? gapK : 0) + titleSize * 0.78 + (1 - tTitle) * titleSize * 0.1;
    ctx.save();
    ctx.globalAlpha = clamp(tTitle, 0, 1) * out;
    text(ctx, p.title, ax, ty, {
      font: FONTS.sans, size: titleSize, weight: 800, color: ink,
      align: tA, baseline: 'alphabetic', tracking: tk,
      shadow: { color: 'rgba(0,0,0,0.45)', blur: titleSize * 0.16, y: titleSize * 0.02 },
    });
    ctx.restore();

    if (p.note) {
      ctx.save();
      ctx.globalAlpha = clamp(tMeta, 0, 1) * out;
      label(ctx, p.note, ax, top + blockH, {
        font: FONTS.mono, size: noteSize, color: ink, align: tA, baseline: 'alphabetic',
        tracking: noteSize * 0.12, alpha: 0.74,
        shadow: { color: 'rgba(0,0,0,0.55)', blur: 8, y: 1 },
      });
      ctx.restore();
    }
  },
};

// ---------------------------------------------------------------------------
export const nameBar = {
  id: 'name-bar',
  name: '名字条',
  category: 'design',
  hint: '电视台那种名字条：色块滑入 + 姓名 + 头衔。访谈、解说、游戏集锦、教学都合适。',
  params: [
    { key: 'name', label: '姓名', type: 'string', default: '张野' },
    { key: 'role', label: '头衔 / 说明', type: 'string', default: '摄影指导 · DIRECTOR OF PHOTOGRAPHY' },
    { key: 'pos', label: '位置', type: 'select', default: 'bl', options: ['bl', 'bc', 'br', 'ml', 'mr'] },
    { key: 'margin', label: '边距', type: 'number', default: 72, min: 0, max: 400, step: 4 },
    { key: 'width', label: '条宽[0-1]', type: 'number', default: 0.40, min: 0.12, max: 1, step: 0.02 },
    { key: 'size', label: '字号', type: 'number', default: 40, min: 12, max: 140, step: 2 },
    { key: 'accent', label: '色块', type: 'color', default: 'orange' },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'plateOpacity', label: '底色不透明度', type: 'number', default: 0.78, min: 0, max: 1, step: 0.02 },
    { key: 'line', label: '下面细线', type: 'bool', default: true },
    { key: 'inDur', label: '入场(秒)', type: 'number', default: 0.42, min: 0.05, max: 3, step: 0.05 },
    { key: 'outDur', label: '出场(秒)', type: 'number', default: 0.3, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const size = p.size;
    const barW = W * clamp(p.width, 0.12, 1);
    const barH = Math.round(size * 2.05);
    const accentW = Math.round(size * 0.34);
    const padX = Math.round(size * 0.62);
    const m = p.margin;

    const right = p.pos === 'br' || p.pos === 'mr';
    const center = p.pos === 'bc';
    const x0 = center ? (W - barW) / 2 : (right ? W - m - barW : m);
    const y0 = (p.pos === 'ml' || p.pos === 'mr') ? (H - barH) / 2 : H - m - barH;

    const t = ramp(env.local, 0, Math.max(0.02, p.inDur));
    const tText = ramp(env.local, p.inDur * 0.55, Math.max(0.03, p.inDur * 1.15));
    const out = Math.max(0.0001, 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration));
    const slide = (1 - t) * size * 0.65;

    ctx.save();
    ctx.globalAlpha = out;
    ctx.translate(x0 - slide, y0);
    ctx.beginPath();
    ctx.rect(0, 0, Math.max(1, barW * clamp(t * 1.35, 0, 1)), barH);
    ctx.clip();

    ctx.globalAlpha = clamp(p.plateOpacity, 0, 1) * out;
    ctx.fillStyle = '#0a0a0c';
    ctx.fillRect(0, 0, barW, barH);
    ctx.fillStyle = acc;
    ctx.fillRect(0, 0, accentW, barH);

    ctx.globalAlpha = clamp(tText, 0, 1) * out;
    const roleSize = Math.max(10, Math.round(size * 0.34));
    text(ctx, p.name, padX + accentW, barH * 0.45, {
      font: FONTS.sans, size, weight: 700, color: ink, align: 'left', baseline: 'alphabetic',
    });
    label(ctx, p.role, padX + accentW, barH * 0.45 + Math.round(size * 0.6), {
      font: FONTS.mono, size: roleSize, color: ink, align: 'left', baseline: 'alphabetic',
      tracking: roleSize * 0.14, alpha: 0.7,
    });
    ctx.restore();

    if (p.line) {
      ctx.save();
      ctx.globalAlpha = out;
      ctx.fillStyle = acc;
      ctx.fillRect(x0 - slide, y0 + barH + 3, barW * clamp(t, 0, 1), Math.max(2, size * 0.055));
      ctx.restore();
    }
  },
};

// ---------------------------------------------------------------------------
export const creditsRoll = {
  id: 'credits-roll',
  name: '片尾名单',
  category: 'design',
  hint: '从下往上滚的片尾名单，左边职位右边名字。每行写「职位|名字」，速度可调。',
  params: [
    { key: 'lines', label: '每行：职位|名字', type: 'multiline', default: '导演|张野\n摄影|李默\n剪辑|王川\n调色|陈小雨\n音乐|——' },
    { key: 'title', label: '顶部标题', type: 'string', default: 'CREW' },
    { key: 'speed', label: '速度(px/秒 @1080p)', type: 'number', default: 58, min: 8, max: 400, step: 2 },
    { key: 'size', label: '字号', type: 'number', default: 30, min: 10, max: 120, step: 2 },
    { key: 'width', label: '内容宽度[0-1]', type: 'number', default: 0.56, min: 0.2, max: 1, step: 0.02 },
    { key: 'position', label: '位置 X,Y', type: 'string', default: '0.5,0.5' },
    { key: 'align', label: '排布', type: 'select', default: 'split', options: ['split', 'left'] },
    { key: 'color', label: '文字色', type: 'color', default: 'white' },
    { key: 'accent', label: '强调色', type: 'color', default: 'orange' },
    { key: 'plate', label: '垫底色(空=无)', type: 'color', default: '' },
    { key: 'plateOpacity', label: '垫底不透明度', type: 'number', default: 0.75, min: 0, max: 1, step: 0.05 },
    { key: 'inDur', label: '淡入(秒)', type: 'number', default: 0.5, min: 0, max: 3, step: 0.05 },
    { key: 'outDur', label: '淡出(秒)', type: 'number', default: 0.6, min: 0, max: 3, step: 0.05 },
  ],
  draw(ctx, env) {
    const p = env.params;
    const W = env.width, H = env.height;
    const ink = color(p.color, ui.paper);
    const acc = color(p.accent, ui.accent);
    const size = p.size;
    const c = pos(p.position);
    const cx = W * c.x;
    const contentW = W * clamp(p.width, 0.2, 1);
    const left = cx - contentW / 2;

    const rows = String(p.lines || '').split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const parts = line.split('|');
      return parts.length > 1
        ? { role: parts[0].trim(), name: parts.slice(1).join('|').trim() }
        : { role: '', name: parts[0].trim() };
    });
    if (!rows.length) return;

    const lh = size * 1.95;
    const total = rows.length * lh;
    const startY = H * 1.02;
    const v = p.speed * (H / 1080);
    const topY = startY - v * env.local;
    const fadeIn = ramp(env.local, 0, Math.max(0.001, p.inDur));
    const fadeOut = 1 - ramp(env.local, Math.max(0, env.duration - p.outDur), env.duration);
    const out = Math.max(0.0001, fadeIn * fadeOut);

    if (p.plate) {
      ctx.save();
      ctx.globalAlpha = clamp(p.plateOpacity, 0, 1) * out;
      ctx.fillStyle = color(p.plate, '#0a0a0c');
      const padX = Math.round(size * 2.2), padY = Math.round(size * 1.6);
      roundRect(ctx, left - padX, topY - lh - padY, contentW + padX * 2, total + padY * 2 + lh, 4);
      ctx.fill();
      ctx.restore();
    }

    if (p.title) {
      const ty = topY - lh * 0.9;
      if (ty > -size && ty < H + size) {
        ctx.save();
        ctx.globalAlpha = out;
        label(ctx, p.title, p.align === 'split' ? left : cx, ty, {
          font: FONTS.mono, size: Math.max(10, Math.round(size * 0.55)), color: acc,
          align: p.align === 'split' ? 'left' : 'center', baseline: 'alphabetic', tracking: size * 0.12,
        });
        ctx.fillStyle = acc;
        ctx.fillRect(left, ty + size * 0.5, contentW, 1.5);
        ctx.restore();
      }
    }

    rows.forEach((r, i) => {
      const y = topY + i * lh;
      if (y < -lh || y > H + lh) return;
      const edge = clamp(Math.min(y, H - y) / (size * 1.4), 0, 1);
      ctx.save();
      ctx.globalAlpha = out * (0.25 + 0.75 * edge);
      if (p.align === 'split') {
        label(ctx, r.role, left, y, {
          font: FONTS.mono, size: Math.max(10, Math.round(size * 0.62)), color: ink,
          align: 'left', baseline: 'alphabetic', tracking: size * 0.1, alpha: 0.74,
          shadow: { color: 'rgba(0,0,0,0.55)', blur: 8, y: 1 },
        });
        text(ctx, r.name, left + contentW, y, {
          font: FONTS.sans, size, weight: 600, color: ink, align: 'right', baseline: 'alphabetic',
          shadow: { color: 'rgba(0,0,0,0.5)', blur: 10, y: 1 },
        });
      } else {
        text(ctx, r.name, left, y, {
          font: FONTS.sans, size, weight: 600, color: ink, align: 'left', baseline: 'alphabetic',
          shadow: { color: 'rgba(0,0,0,0.5)', blur: 10, y: 1 },
        });
        if (r.role) {
          label(ctx, r.role, left, y + size * 0.85, {
            font: FONTS.mono, size: Math.max(10, Math.round(size * 0.55)), color: ink,
            align: 'left', baseline: 'alphabetic', tracking: size * 0.1, alpha: 0.72,
            shadow: { color: 'rgba(0,0,0,0.55)', blur: 8, y: 1 },
          });
        }
      }
      ctx.restore();
    });
  },
};

export default [editorialTitle, nameBar, creditsRoll];
