// ============================================================================
// 模板公共工具
// 统一的出场/入场包络、锚点定位、配色，保证所有模板"看起来是一家人"。
// ============================================================================

import { Rng, clamp, lerp, smoothstep, easeOutCubic, easeInCubic, EASINGS } from '../engine/core.js';
import { palette, ui } from '../engine/draw.js';

/** 9 宫格锚点 -> 像素坐标 */
export function anchor(env, pos = 'tl', margin = 48) {
  const { width: w, height: h } = env;
  const m = typeof margin === 'number' ? margin : 48;
  const [v, hz] = [pos[0], pos[1]];
  const x = hz === 'l' ? m : hz === 'c' ? w / 2 : w - m;
  const y = v === 't' ? m : v === 'm' ? h / 2 : h - m;
  return { x, y };
}

/** 归一化矩形 -> 像素矩形 */
export function nb(env, x, y, w, h) {
  return { x: env.width * x, y: env.height * y, w: env.width * w, h: env.height * h };
}

/**
 * 入场 / 停留 / 出场 包络，返回 0..1。
 * 大多数模板只需要这一个函数来决定"现在该显示多少"。
 */
export function envelope(progress, { inFrac = 0.08, outFrac = 0.08, inEase = 'outCubic', outEase = 'inCubic' } = {}) {
  const p = clamp(progress, 0, 1);
  let a = 1;
  if (inFrac > 0 && p < inFrac) a = Math.min(a, (EASINGS[inEase] || easeOutCubic)(p / inFrac));
  if (outFrac > 0 && p > 1 - outFrac) a = Math.min(a, (EASINGS[outEase] || easeInCubic)((1 - p) / outFrac));
  return clamp(a, 0, 1);
}

/** 只在前后若干秒做进退场（比按比例更符合剪辑习惯） */
export function envelopeByTime(env, { inDur = 0.18, outDur = 0.18 } = {}) {
  const a = inDur > 0 ? smoothstep(0, inDur, env.local) : 1;
  const b = outDur > 0 ? smoothstep(0, outDur, env.duration - env.local) : 1;
  return clamp(a * b, 0, 1);
}

/** 每个模板都能拿到的独立随机源 */
export function trng(env, tag = '') {
  return new Rng(`${env.layer.seed}|${tag}|${env.template}`);
}

/** 参数色板：允许模板参数里直接写 "accent" / "ink" / "#ff0000" */
export function color(c, fallback = ui.paper) {
  if (!c) return fallback;
  if (c[0] === '#') return c;
  return palette[c] || ui[c] || fallback;
}

/** 通用参数定义片段 */
export const P = {
  pos: (def = 'bl') => ({ key: 'pos', label: '位置', type: 'select', default: def, options: ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'] }),
  margin: (def = 64) => ({ key: 'margin', label: '边距', type: 'number', default: def, min: 0, max: 400, step: 4 }),
  color: (def = 'white') => ({ key: 'color', label: '颜色', type: 'color', default: def }),
  accent: (def = 'orange') => ({ key: 'accent', label: '强调色', type: 'color', default: def }),
  scale: (def = 1) => ({ key: 'scale', label: '缩放', type: 'number', default: def, min: 0.2, max: 3, step: 0.05 }),
  speed: (def = 1) => ({ key: 'speed', label: '速度', type: 'number', default: def, min: 0.1, max: 4, step: 0.05 }),
  beatSync: (def = true) => ({ key: 'beatSync', label: '跟随卡点', type: 'bool', default: def }),
  beatsPerStep: (def = 1) => ({ key: 'beatsPerStep', label: '每步拍数', type: 'number', default: def, min: 0.25, max: 8, step: 0.25 }),
};

/** 把"每步拍数"换算成秒 */
export function stepDur(env, beatsPerStep = 1) {
  const bd = env.beat.beatDur || 0.5;
  return bd * beatsPerStep;
}

/**
 * 拍索引驱动的循环进度：把"当前时间"换算成"第几个卡点格 + 格内进度"。
 * 卡点模板的核心函数。
 */
export function beatCell(env, beatsPerStep = 1, { offset = 0 } = {}) {
  const d = stepDur(env, beatsPerStep);
  const x = (env.t - offset) / d;
  const index = Math.floor(x);
  const frac = x - index;
  return { index, frac, dur: d };
}

/** 数字格式化（计数器用） */
export function fmtNumber(v, { decimals = 0, sign = false, pad = 0, group = false } = {}) {
  let s = Number(v).toFixed(decimals);
  if (group) s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (sign && v > 0) s = '+' + s;
  if (pad) {
    const [i, d] = s.split('.');
    const si = i.padStart(pad, '0');
    s = d ? `${si}.${d}` : si;
  }
  return s;
}

/** 生成一串"假的"读数，用于 HUD 里的乱码/噪点文本 */
export function fakeCode(rng, len = 8, charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789') {
  let s = '';
  for (let i = 0; i < len; i++) s += charset[Math.floor(rng.next() * charset.length)];
  return s;
}

/** 把一段文本按"字"拆开（中英文都照顾） */
export function chars(str) {
  return Array.from(String(str));
}

/** 按词拆（英文按空格，中文按字） */
export function words(str) {
  const out = [];
  const re = /[A-Za-z0-9'’\-]+|\s+|[\u4e00-\u9fa5]|./g;
  let m;
  while ((m = re.exec(String(str)))) out.push(m[0]);
  return out.filter((w) => !/^\s+$/.test(w));
}

export { clamp, lerp, smoothstep, palette, ui };
