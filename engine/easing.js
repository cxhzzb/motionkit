// ============================================================================
// 动效引擎 · 缓动曲线
// 单独一个文件，是因为「关键帧」模块（engine/keyframes.js）也要用它，
// 而 core.js 反过来要 import 关键帧求值 —— 都放在 core.js 里就成了循环依赖。
// 这些曲线只依赖数学，没有任何其它依赖。
// ============================================================================

export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export const easeLinear = (t) => t;
export const easeInQuad = (t) => t * t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeInCubic = (t) => t * t * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutQuart = (t) => 1 - Math.pow(1 - t, 4);
export const easeOutQuint = (t) => 1 - Math.pow(1 - t, 5);
export const easeInExpo = (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10));
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInOutExpo = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2;
export const easeOutBack = (t, s = 1.70158) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
export const easeInBack = (t, s = 1.70158) => (s + 1) * t * t * t - s * t * t;
export const easeOutElastic = (t, amp = 1, period = 0.3) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return amp * Math.pow(2, -10 * t) * Math.sin(((t - period / 4) * TAU) / period) + 1;
};
export const easeOutBounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};

/** 常用曲线表，模板里可以直接按名字取用 */
export const EASINGS = {
  linear: easeLinear,
  inQuad: easeInQuad, outQuad: easeOutQuad, inOutQuad: easeInOutQuad,
  inCubic: easeInCubic, outCubic: easeOutCubic, inOutCubic: easeInOutCubic,
  outQuart: easeOutQuart, outQuint: easeOutQuint,
  inExpo: easeInExpo, outExpo: easeOutExpo, inOutExpo: easeInOutExpo,
  outBack: easeOutBack, inBack: easeInBack,
  outElastic: easeOutElastic, outBounce: easeOutBounce,
  smooth: (t) => smoothstep(0, 1, t),
};

/** 界面下拉里用的显示名（顺序就是下拉顺序） */
export const EASING_LABELS = [
  ['linear', '线性'],
  ['smooth', '平滑'],
  ['inQuad', '缓入'], ['outQuad', '缓出'], ['inOutQuad', '缓入缓出'],
  ['inCubic', '缓入·强'], ['outCubic', '缓出·强'], ['inOutCubic', '双向·强'],
  ['inExpo', '指数入'], ['outExpo', '指数出'], ['inOutExpo', '指数双向'],
  ['inBack', '回拉入'], ['outBack', '回弹出'],
  ['outElastic', '弹性'], ['outBounce', '弹跳'],
];

export const ease = (name, t) => (EASINGS[name] || easeOutCubic)(clamp(t, 0, 1));
