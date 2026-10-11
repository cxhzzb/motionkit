// ============================================================================
// 动效引擎 · 核心
// 数学工具 / 确定性随机 / 节拍图 / 图层与场景 / 帧渲染调度
// 纯 JS，无依赖，可在浏览器与 Node 中同时运行。
// ============================================================================

import {
  TAU, clamp, lerp, invLerp, smoothstep, smootherstep, EASINGS, ease,
} from './easing.js';
import { normalizeKeys, valueAt, hasKeys } from './keyframes.js';

// 数学与缓动曲线的实现搬到了 ./easing.js（关键帧模块也要用，放在这里会循环依赖），
// 这里原样再导出一次，老代码 `import { clamp } from '../engine/core.js'` 全都还能用。
export {
  TAU, clamp, lerp, invLerp, smoothstep, smootherstep, EASINGS, ease,
  easeLinear, easeInQuad, easeOutQuad, easeInOutQuad, easeInCubic, easeOutCubic,
  easeInOutCubic, easeOutQuart, easeOutQuint, easeInExpo, easeOutExpo, easeInOutExpo,
  easeOutBack, easeInBack, easeOutElastic, easeOutBounce, EASING_LABELS,
} from './easing.js';
export {
  normalizeKeys, normalizeTrack, hasKeys, isAnimated, evalTrack, valueAt,
  setKey, removeKey, moveKey, setKeyEasing, clearTrack, keyIndexAt, keyCount,
  keyTimes, trackRange, animatedProps, keysOnBeats, isExpr, EXPR_NAMES,
  KEY_PROPS, KEY_PROP_LABELS, KEY_EPS,
} from './keyframes.js';

export const mapRange = (v, a, b, c, d) => lerp(c, d, clamp(invLerp(a, b, v), 0, 1));

// ---------------------------------------------------------------- 缓动曲线
// 实现见 ./easing.js，本文件在开头已 re-export（模板里照旧用 EASINGS / ease）。

/**
 * 卡点脉冲：在周期内的前 width 比例处产生 1 -> 0 的衰减。
 * 用于闪烁、硬切、"pop" 之类跟着鼓点走的动作。
 */
export const pulse = (t, period, width = 0.1, decay = 3) => {
  const p = ((t % period) + period) % period;
  const x = clamp(p / (period * width), 0, 1);
  return Math.pow(1 - x, decay);
};

// ---------------------------------------------------------------- 确定性随机
/** 字符串 -> 32 位整数种子（同一份工程每次导出结果完全一致） */
export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32：小而快的确定性 PRNG */
export class Rng {
  constructor(seed = 1) {
    this.s = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 1;
  }
  next() {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a, b) { return a + this.next() * (b - a); }
  int(a, b) { return Math.floor(this.range(a, b + 1)); }
  pick(arr) { return arr[Math.floor(this.next() * arr.length) % arr.length]; }
  chance(p) { return this.next() < p; }
  sign() { return this.next() < 0.5 ? -1 : 1; }
  /** 以 seed 派生一个子随机源，保证各图层/各帧互不干扰 */
  fork(tag) { return new Rng(hashSeed(String(tag) + ':' + this.s)); }
}

// ---------------------------------------------------------------- 节拍图（卡点）
/**
 * BeatMap 是"卡点"的统一抽象。
 * 三种来源：固定 BPM、音频分析出的节拍数组、手打标记。
 */
export class BeatMap {
  constructor({ bpm = 120, offset = 0, beats = null, duration = Infinity, source = 'bpm' } = {}) {
    this.bpm = bpm;
    this.offset = offset;
    this.duration = duration;
    this.source = source;
    this.beats = Array.isArray(beats) && beats.length ? [...beats].sort((a, b) => a - b) : null;
    this.beatDur = 60 / bpm;
  }

  /** 第 i 拍的时间（秒） */
  at(i) {
    if (this.beats) return this.beats[i] ?? this.beats[this.beats.length - 1];
    return this.offset + i * this.beatDur;
  }

  get length() {
    if (this.beats) return this.beats.length;
    return Math.max(0, Math.floor((this.duration - this.offset) / this.beatDur) + 1);
  }

  /** 离 t 最近的第 i 拍下标 */
  indexAt(t) {
    if (this.beats) {
      let lo = 0, hi = this.beats.length - 1, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.beats[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    }
    return Math.floor((t - this.offset) / this.beatDur);
  }

  /** t 距离最近拍点的时间差（秒，带符号） */
  phase(t) {
    const i = this.indexAt(t);
    const prev = this.at(i), next = this.at(i + 1);
    const mid = prev + (next - prev) / 2;
    return t <= mid ? t - prev : t - next;
  }

  /** 拍内归一化进度 0..1 */
  beatProgress(t) {
    const i = this.indexAt(t);
    const a = this.at(i), b = this.at(i + 1);
    return clamp(invLerp(a, b, t), 0, 1);
  }

  /** 把 t 吸附到 division 分音上（1=整拍, 2=八分, 4=十六分） */
  snap(t, division = 1, threshold = Infinity) {
    const d = this.beatDur / division;
    const snapped = Math.round((t - this.offset) / d) * d + this.offset;
    return Math.abs(snapped - t) <= threshold ? snapped : t;
  }

  /** 区间 (t0, t1] 内所有拍点 */
  hitsIn(t0, t1, division = 1) {
    const out = [];
    const d = this.beatDur / division;
    if (this.beats) {
      for (const b of this.beats) if (b > t0 && b <= t1) out.push(b);
      if (division > 1) for (let k = 0; k < this.beats.length - 1; k++) {
        const a = this.beats[k], b = this.beats[k + 1], n = Math.max(1, Math.round((b - a) / d));
        for (let j = 1; j < n; j++) { const v = a + ((b - a) * j) / n; if (v > t0 && v <= t1) out.push(v); }
      }
      return out.sort((a, b) => a - b);
    }
    let i = Math.ceil((t0 - this.offset) / d);
    for (;; i++) { const v = this.offset + i * d; if (v > t1) break; if (v > t0) out.push(v); }
    return out;
  }

  toJSON() { return { bpm: this.bpm, offset: this.offset, beats: this.beats, duration: this.duration, source: this.source }; }
  static fromJSON(o) { return new BeatMap(o || {}); }
}

// ---------------------------------------------------------------- 合成 / 图层
/**
 * 一个"图层"= 一个模板实例 + 时间区间 + 参数。
 * 模板只负责画自己的东西，时间的解释权全部交给引擎。
 */
export class Layer {
  constructor({ template, start = 0, end = 1, params = {}, seed = null, opacity = 1, blend = 'source-over', enabled = true, name = '', transform = null, group = '', meta = null, keys = null, mask = null } = {}) {
    this.id = Layer._id++;
    this.template = template;          // 模板 id 字符串
    this.start = start;
    this.end = end;
    this.params = params;
    this.seed = seed ?? `${template}#${this.id}`;
    this.opacity = opacity;
    this.blend = blend;
    this.enabled = enabled;
    this.name = name || template;
    this.transform = normalizeTransform(transform);
    this.keys = normalizeKeys(keys);   // 关键帧：{ x: [{t,v,e}], scale: [...], … }（t 是相对图层起点）
    this.mask = normalizeMask(mask);   // 蒙版 / 裁剪（见 normalizeMask）
    this.group = group;                // 来源分组，比如 "beat" = 卡点批量铺出来的
    this.meta = meta;                  // 附加归属（比如"这个转场层挂在哪个片段上"），不用就不落盘
  }
  get duration() { return Math.max(0, this.end - this.start); }
  covers(t) { return this.enabled && t >= this.start && t < this.end; }
  /** 这一层有没有关键帧动画 */
  get animated() { return hasKeys(this.keys); }
  /**
   * 某一时刻的变换 —— 有关键帧的通道按关键帧走，没有的用静态值。
   * t 是**绝对时间**（秒），内部转成相对图层起点，所以图层整体挪动时动画跟着走。
   *
   * 注意：静态值恒等且没有任何关键帧时返回 null，跟老工程保持一致（不多出一堆字段）。
   */
  transformAt(t) {
    const base = this.transform;
    if (!hasKeys(this.keys)) return base;
    const local = t - this.start;
    const b = base || { x: 0, y: 0, scale: 1, rot: 0, px: 0.5, py: 0.5 };
    // 注意：挂了关键帧就总是返回对象，哪怕这一刻算出来正好是恒等（比如位移回到 0）。
    // 返回 null 会让调用方以为"没有变换"，拖动 / 命中测试就对不上了。
    return {
      x: valueAt(this.keys, 'x', local, b.x),
      y: valueAt(this.keys, 'y', local, b.y),
      scale: valueAt(this.keys, 'scale', local, b.scale),
      rot: valueAt(this.keys, 'rot', local, b.rot),
      px: valueAt(this.keys, 'px', local, b.px),
      py: valueAt(this.keys, 'py', local, b.py),
    };
  }
  /** 某一时刻的不透明度（可挂关键帧） */
  opacityAt(t) {
    if (!hasKeys(this.keys)) return this.opacity;
    return clamp(valueAt(this.keys, 'opacity', t - this.start, this.opacity), 0, 1);
  }
  toJSON() {
    const o = { template: this.template, start: this.start, end: this.end, params: this.params, seed: this.seed, opacity: this.opacity, blend: this.blend, enabled: this.enabled, name: this.name, transform: this.transform };
    if (hasKeys(this.keys)) o.keys = this.keys;     // 没动画就不落盘
    if (this.mask) o.mask = this.mask;
    if (this.group) o.group = this.group;   // 没分组就不落盘，免得工程文件里全是空字段
    if (this.meta) o.meta = this.meta;
    return o;
  }
}
Layer._id = 1;

/**
 * 图层变换 —— 预览里直接拖动 / 缩放的落点。
 *
 * 为什么不写进模板参数：模板的定位参数五花八门（有的叫 position 是 "x,y"，
 * 有的带宽度 "x,y,w"，全屏 HUD 和转场类压根没有），逐个去改 50 个模板既脆又乱。
 * 统一挂在图层上，任何模板都能被同一套手柄推着走，而且无头渲染 / 导出走的是
 * 同一个引擎，界面里看到什么就是导出什么。
 *
 *   x, y    位移，画布归一化单位（1 = 整个画幅）
 *   scale   缩放倍数
 *   rot     旋转角度（度）
 *   px, py  支点，也是归一化画布坐标；缩放和旋转都绕着它发生
 */
export function normalizeTransform(tr) {
  if (!tr) return null;
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const o = {
    x: num(tr.x, 0),
    y: num(tr.y, 0),
    scale: tr.scale === undefined ? 1 : num(tr.scale, 1),
    rot: num(tr.rot, 0),
    px: tr.px === undefined ? 0.5 : num(tr.px, 0.5),
    py: tr.py === undefined ? 0.5 : num(tr.py, 0.5),
  };
  // 恒等变换不落盘：老工程文件读进来再存出去不会多出一堆没用的字段
  if (!o.x && !o.y && o.scale === 1 && !o.rot) return null;
  return o;
}

// ---------------------------------------------------------------- 蒙版 / 裁剪
/** 蒙版形状 */
export const MASK_SHAPES = ['rect', 'round', 'ellipse', 'poly'];
export const MASK_SHAPE_LABELS = { rect: '矩形', round: '圆角矩形', ellipse: '椭圆', poly: '多边形' };

/**
 * 蒙版 —— 挂在图层上的"裁剪框"，把这一层画出来的东西裁成一块。
 *
 *   shape   'rect' 直角矩形 | 'round' 圆角矩形 | 'ellipse' 椭圆 | 'poly' 多边形
 *   x, y    裁剪框左上角，归一化画布坐标（0..1）—— 跟 transform 一个单位，换分辨率不走形
 *   w, h    裁剪框尺寸，同样是归一化值
 *   radius  圆角半径（占框短边的比例，0~0.5）—— 'round' 用；画中画圆角就靠它
 *   feather 边缘羽化（占框短边的比例，0~0.5）：0 = 硬边
 *   invert  反选：只裁掉框内（做"挖个洞"用）
 *   points  'poly' 用：[[x,y], …] 归一化画布坐标
 *   stroke  描边：{ width, color } —— width 是占框宽度的比例，画中画的边框
 */
export function normalizeMask(m) {
  if (!m) return null;
  const shape = MASK_SHAPES.includes(m.shape) ? m.shape : 'rect';
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const o = {
    shape,
    x: num(m.x, 0), y: num(m.y, 0),
    w: Math.max(1e-4, num(m.w, 1)), h: Math.max(1e-4, num(m.h, 1)),
  };
  const radius = clamp(num(m.radius, shape === 'round' ? 0.12 : 0), 0, 0.5);
  const feather = clamp(num(m.feather, 0), 0, 0.5);
  if (radius) o.radius = radius;
  if (feather) o.feather = feather;
  if (m.invert) o.invert = true;
  if (Array.isArray(m.points) && m.points.length >= 3) {
    o.points = m.points
      .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      .map((p) => [Number(p[0]), Number(p[1])]);
    if (o.points.length < 3) delete o.points;
  }
  if (shape === 'poly') {
    if (!o.points) o.shape = 'rect';        // 多边形缺点就退回矩形，别画出个空的
    else if (!polyCoversWholeFrame(o.points)) return o;   // 多边形只要不是"正好整幅"就得留下
  }
  if (m.stroke && Number(m.stroke.width) > 0) {
    o.stroke = { width: Math.max(0, num(m.stroke.width, 0)), color: m.stroke.color || '#ffffff' };
  }
  // 整幅裁剪 = 什么都没裁，而且没羽化 / 描边 / 反选 / 圆角 → 不落盘。
  // 注意多边形要单独判断：一个覆盖整幅的三角形，w/h 也是 1，但它**确实在裁**。
  if (!o.invert && !o.radius && !o.feather && !o.stroke && o.x === 0 && o.y === 0 && o.w >= 1 && o.h >= 1) return null;
  return o;
}

/**
 * 这组点是不是正好沿着画幅四边走一圈（也就是"其实什么都没裁"）。
 * 逐条边取中点采样，只要有一条边的中点落在画幅内部，就说明它真的裁掉了东西。
 */
function polyCoversWholeFrame(points) {
  const onEdge = (p) => {
    const [x, y] = p;
    const nearL = Math.abs(x) < 1e-6, nearR = Math.abs(x - 1) < 1e-6;
    const nearT = Math.abs(y) < 1e-6, nearB = Math.abs(y - 1) < 1e-6;
    return ((nearL || nearR) && y >= -1e-6 && y <= 1 + 1e-6)
      || ((nearT || nearB) && x >= -1e-6 && x <= 1 + 1e-6);
  };
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (!onEdge(a) || !onEdge(mid)) return false;
  }
  return true;
}

/**
 * 把一个蒙版描述成"画到 ctx 上的路径"（已经换算成像素）。
 * 抽出来是为了让"裁剪用的 clip()"和"羽化 / 反选用到的离屏 alpha"共用同一份几何。
 */
export function maskPath(ctx, mask, width, height, inset = 0) {
  const x = mask.x * width + inset;
  const y = mask.y * height + inset;
  const w = Math.max(1e-3, mask.w * width - inset * 2);
  const h = Math.max(1e-3, mask.h * height - inset * 2);
  ctx.beginPath();
  if (mask.shape === 'ellipse') {
    ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, TAU);
    return { x, y, w, h };
  }
  if (mask.shape === 'poly' && mask.points) {
    const pts = mask.points;
    ctx.moveTo(pts[0][0] * width, pts[0][1] * height);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * width, pts[i][1] * height);
    ctx.closePath();
    return { x, y, w, h };
  }
  const r = Math.max(0, Math.min(mask.radius || 0, 0.5) * Math.min(w, h));
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else {
    // 老浏览器兜底：手动画圆角
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
  return { x, y, w, h };
}

/** 这个蒙版要不要走"离屏 alpha"那条重路径（羽化 / 反选 / 多边形都得走） */
export const maskNeedsAlpha = (mask) =>
  !!mask && (!!mask.feather || !!mask.invert || mask.shape === 'poly' || !!mask.stroke);

/** 一段字幕（供字幕类模板消费） */
export class Caption {
  constructor({ start, end, text, words = null, speaker = null, style = null }) {
    this.start = start; this.end = end; this.text = text; this.words = words; this.speaker = speaker; this.style = style || {};
  }
}

/**
 * 一个"素材片段"——剪辑轨上的最小单位。
 *
 *   kind      'video' | 'image' | 'audio'
 *   assetId   指向素材库里的那条素材（文件本体不进工程 JSON，只存这个 id）
 *   start     在时间轴上的位置（秒）
 *   in        从素材的第几秒开始取（图片忽略）
 *   dur       在时间轴上占多长（秒）—— 拖动边缘改的就是它
 *   volume    音量 0~1（音频片段用）
 *
 * 同一份素材可以被切成好几段（in/dur 不一样），所以"素材"和"片段"是分开的两层。
 */
export class Clip {
  constructor({
    id = null, kind = 'video', assetId = null, name = '', start = 0, in: inPoint = 0, dur = 1,
    volume = 1, speed = 1, track = 0, scale = null, x = 0, y = 0, opacity = 1,
    grade = null, fadeIn = 0, fadeOut = 0, trans = null,
    denoise = 0, highpass = 0, lowpass = 0, gate = 0, gateRatio = 1, audioGain = 1,
  } = {}) {
    this.id = id || `c${Clip._id++}`;
    this.kind = kind;
    this.assetId = assetId;
    this.name = name;
    this.start = start;
    this.in = inPoint;
    this.dur = dur;
    this.volume = volume;
    this.speed = speed;       // 变速：1 = 原速，2 = 两倍速（时间轴 1 秒吃掉素材 2 秒）
    this.track = track;       // 第几条视频轨：0 = 底轨，往上数字越大越盖在上面
    this.scale = scale;       // null = 铺满画面（cover）；数字 = 占画面宽度的比例（画中画用）
    this.x = x; this.y = y;   // 归一化位移（相对画面）
    this.opacity = opacity;
    this.grade = grade;       // 调色：{brightness,contrast,saturation,hue,blur,grayscale,sepia,invert}
    this.fadeIn = fadeIn;     // 音频淡入 / 淡出（秒）
    this.fadeOut = fadeOut;
    this.trans = trans;     // { template, dur } = 这一段开头和上一段之间有个转场
    // 降噪（只在导出时生效，预览始终是原声）：
    //   denoise   总强度 0..1，开着会按比例缩放下面三项
    //   highpass  高通 Hz，砍低频轰鸣 / 空调声；0 = 关
    //   lowpass   低通 Hz，收高频嘶声；0 = 关
    //   gate      门限 0..1（映射到阈值 dBFS），把安静处的底噪压下去
    //   gateRatio 门限力度（下行扩展比），越大压得越狠
    //   audioGain 压掉底噪后的补偿增益
    this.denoise = denoise;
    this.highpass = highpass;
    this.lowpass = lowpass;
    this.gate = gate;
    this.gateRatio = gateRatio;
    this.audioGain = audioGain;
  }
  get end() { return this.start + this.dur; }
  covers(t) { return t >= this.start && t < this.end; }
  /** 时间轴上的 t 对应素材里的第几秒 */
  /** 时间轴上的 t 对应素材里的第几秒（变速之后的） */
  sourceAt(t) { return this.in + (t - this.start) * (this.speed || 1); }
  /** 这一段在素材里吃掉多少秒 */
  get sourceSpan() { return this.dur * (this.speed || 1); }
  toJSON() {
    const o = { id: this.id, kind: this.kind, assetId: this.assetId, name: this.name, start: this.start, in: this.in, dur: this.dur, volume: this.volume };
    // 默认值不落盘，工程文件干净一点
    if (this.speed !== 1) o.speed = this.speed;
    if (this.track) o.track = this.track;
    if (this.scale !== null) o.scale = this.scale;
    if (this.x) o.x = this.x;
    if (this.y) o.y = this.y;
    if (this.opacity !== 1) o.opacity = this.opacity;
    if (this.grade) o.grade = this.grade;
    if (this.fadeIn) o.fadeIn = this.fadeIn;
    if (this.fadeOut) o.fadeOut = this.fadeOut;
    if (this.trans) o.trans = this.trans;
    if (this.denoise) o.denoise = this.denoise;
    if (this.highpass) o.highpass = this.highpass;
    if (this.lowpass) o.lowpass = this.lowpass;
    if (this.gate) o.gate = this.gate;
    if (this.gateRatio && this.gateRatio !== 1) o.gateRatio = this.gateRatio;
    if (this.audioGain !== 1) o.audioGain = this.audioGain;
    return o;
  }
  static fromJSON(o) { return new Clip(o || {}); }
}
Clip._id = 1;

/**
 * Scene = 一个可渲染的工程。
 * 分辨率、帧率、总时长、图层栈、字幕轨、后期特效栈、节拍图。
 */
export class Scene {
  constructor({
    width = 1920, height = 1080, fps = 24, duration = 10,
    bg = null, layers = [], captions = [], clips = [], fx = [], beat = null, name = 'scene', transparent = true,
  } = {}) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.duration = duration;
    this.bg = bg;                       // null = 透明底（做叠加层用）
    this.layers = layers;
    this.captions = captions;
    this.clips = clips;                 // 素材片段（视频 / 图片 / 音频），见 Clip
    this.fx = fx;                       // 后期特效栈，见 engine/fx.js
    this.beat = beat instanceof BeatMap ? beat : new BeatMap(beat || {});
    this.name = name;
    this.transparent = transparent;
  }

  add(layer) { const l = layer instanceof Layer ? layer : new Layer(layer); this.layers.push(l); return l; }
  addCaption(c) { const x = c instanceof Caption ? c : new Caption(c); this.captions.push(x); return x; }
  addFx(spec) { this.fx.push(typeof spec === 'string' ? { type: spec } : spec); return this; }

  /** 某一时刻处于活动状态的图层（按栈顺序） */
  activeLayers(t) { return this.layers.filter((l) => l.covers(t)); }

  /** 某一时刻活动的字幕（有重叠时取最后一个） */
  activeCaption(t) {
    let hit = null;
    for (const c of this.captions) if (t >= c.start && t < c.end) hit = c;
    return hit;
  }

  /** 某一时刻活动的画面片段（视频 / 图片；有重叠时取后面的那条） */
  activeVisualClip(t) {
    let hit = null;
    for (const c of this.clips) if (c.kind !== 'audio' && c.covers(t)) hit = c;
    return hit;
  }
  /** 某一时刻活动的音频片段 */
  activeAudioClip(t) {
    let hit = null;
    for (const c of this.clips) if (c.kind === 'audio' && c.covers(t)) hit = c;
    return hit;
  }
  /**
   * 某一时刻所有要画的画面片段，从下往上排（track 小的先画）。
   * 多视频轨叠加就靠这个：同一条轨上后面盖前面，轨号大的盖轨号小的。
   */
  visualClipsAt(t) {
    return this.clips
      .filter((c) => c.kind !== 'audio' && c.covers(t))
      .sort((a, b) => (a.track || 0) - (b.track || 0));
  }
  /** 某一时刻所有要发声的音频片段（可能不止一条，交叉淡化时要一起算） */
  audioClipsAt(t) {
    return this.clips.filter((c) => c.kind === 'audio' && c.covers(t));
  }
  /** 所有片段排完之后的结束时间 */
  get clipsEnd() { return this.clips.reduce((m, c) => Math.max(m, c.end), 0); }

  frameIndex(t) { return Math.round(t * this.fps); }
  frameTime(i) { return i / this.fps; }
  get frameCount() { return Math.max(1, Math.round(this.duration * this.fps)); }

  toJSON() {
    return {
      name: this.name, width: this.width, height: this.height, fps: this.fps, duration: this.duration,
      bg: this.bg, transparent: this.transparent, beat: this.beat.toJSON(),
      layers: this.layers.map((l) => l.toJSON()),
      captions: this.captions.map((c) => ({ start: c.start, end: c.end, text: c.text, words: c.words, speaker: c.speaker, style: c.style })),
      clips: this.clips.map((c) => c.toJSON()),
      fx: this.fx,
    };
  }
  static fromJSON(o) {
    const s = new Scene(o);
    s.layers = (o.layers || []).map((l) => new Layer(l));
    s.captions = (o.captions || []).map((c) => new Caption(c));
    s.clips = (o.clips || []).map((c) => new Clip(c));
    s.fx = o.fx || [];
    s.beat = BeatMap.fromJSON(o.beat);
    return s;
  }
}

// ---------------------------------------------------------------- 渲染调度
/** 模板注册表（templates/index.js 会往里注册） */
export const registry = new Map();
export function registerTemplate(def) {
  if (!def || !def.id) throw new Error('模板缺少 id');
  registry.set(def.id, def);
  return def;
}
export function getTemplate(id) { return registry.get(id) || null; }
export function listTemplates(filter) {
  const all = [...registry.values()];
  return filter ? all.filter(filter) : all;
}

/**
 * 渲染某一帧。
 * @param {CanvasRenderingContext2D} ctx  目标 2D 上下文
 * @param {Scene} scene
 * @param {number} t  时间（秒）
 * @param {object} deps  { fxRunner, onLayer, scratch, silent }
 */
export function renderFrame(ctx, scene, t, deps = {}) {
  const { width, height } = scene;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (scene.bg) { ctx.fillStyle = scene.bg; ctx.fillRect(0, 0, width, height); }
  if (typeof deps.before === 'function') deps.before(ctx, scene, t);

  for (const layer of scene.activeLayers(t)) {
    const tpl = getTemplate(layer.template);
    if (!tpl || typeof tpl.draw !== 'function') continue;

    const local = t - layer.start;
    const dur = Math.max(1e-6, layer.duration);
    const progress = clamp(local / dur, 0, 1);
    const rng = new Rng(layer.seed);

    // 关键帧求值的上下文：@beat / @t / @progress 这些表达式靠它
    const kctx = {
      t, local, progress, duration: dur,
      frame: scene.frameIndex(t), fps: scene.fps,
      width, height,
      beatIndex: scene.beat.indexAt(t),
      beatPhase: scene.beat.phase(t),
      beatProgress: scene.beat.beatProgress(t),
    };

    const env = {
      scene, layer, template: tpl,
      t, local, duration: dur, progress,
      width, height,
      params: { ...defaultsOf(tpl), ...layer.params },
      rng,
      beat: scene.beat,
      beatPhase: scene.beat.phase(t),
      beatProgress: scene.beat.beatProgress(t),
      beatIndex: scene.beat.indexAt(t),
      caption: scene.activeCaption(t),
      frame: scene.frameIndex(t),
      fps: scene.fps,
      util: deps.util,
    };

    const tr = layer.transformAt(t);
    const alpha = layer.opacityAt(t);
    const mask = layer.mask;

    // ---- 选中"走哪条路"：
    //  没有蒙版，或只是硬边矩形/椭圆/圆角矩形 → 直接在总画布上裁剪，省一次离屏
    //  有羽化 / 反选 / 多边形 / 描边 → 离屏画一遍，用 alpha 合成（慢一点但准）
    //
    // 两条路**只能走一条**。以前是"总画布上无条件画一遍 + 需要时再在离屏上画一遍"，
    // 结果需要蒙版时总画布上已经留了一份没被裁过的像素，蒙版再怎么削也削不掉它 ——
    // 羽化 / 反选 / 多边形 / 描边全都会静默失效（只剩硬边裁剪那条路看着是对的）。
    const needsAlpha = maskNeedsAlpha(mask);
    const scratch = needsAlpha ? ensureScratch(deps, width, height) : null;
    const useScratch = !!(scratch && scratch.ok);

    // 图层变换：先位移，再绕支点旋转 / 缩放。支点用归一化画布坐标，
    // 所以同一份工程在任意分辨率下渲染出来的相对位置是一致的。
    const applyLayerTransform = (c) => {
      if (!tr) return;
      const px = tr.px * width, py = tr.py * height;
      c.translate(tr.x * width, tr.y * height);
      c.translate(px, py);
      if (tr.rot) c.rotate((tr.rot * Math.PI) / 180);
      if (tr.scale !== 1) c.scale(tr.scale, tr.scale);
      c.translate(-px, -py);
    };

    if (useScratch) {
      // 先单独画到离屏，按蒙版削掉 alpha，再整体贴回总画布
      const sc = scratch.ctx;
      sc.setTransform(1, 0, 0, 1, 0, 0);
      sc.clearRect(0, 0, width, height);
      sc.save();
      applyLayerTransform(sc);
      try {
        tpl.draw(sc, env);
      } catch (err) {
        if (!deps.silent) console.error(`[template:${layer.template}]`, err);
      }
      sc.restore();
      applyMaskAlpha(sc, mask, width, height);

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = layer.blend || 'source-over';
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(scratch.canvas, 0, 0, width, height);
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.globalCompositeOperation = layer.blend || 'source-over';
      applyLayerTransform(ctx);
      if (mask) {
        // 硬边裁剪：直接把模板画进裁剪区
        ctx.save();
        maskPath(ctx, mask, width, height);
        ctx.clip();
      }
      try {
        tpl.draw(ctx, env);
      } catch (err) {
        if (!deps.silent) console.error(`[template:${layer.template}]`, err);
      }
      if (mask) ctx.restore();
      ctx.restore();
    }

    deps.onLayer?.(layer, env);
  }

  ctx.restore();

  if (scene.fx && scene.fx.length && deps.fxRunner) {
    deps.fxRunner(ctx, scene, t);
  }
}

/** 拿一块和画布等大的离屏（优先用调用方给的，避免每帧新建 canvas） */
function ensureScratch(deps, width, height) {
  if (typeof deps.scratch === 'function') {
    const s = deps.scratch(width, height);
    return s ? { ...s, ok: true } : { ok: false };
  }
  const provided = deps.scratch;
  if (provided && provided.canvas && provided.ctx) {
    if (provided.canvas.width !== width || provided.canvas.height !== height) {
      provided.canvas.width = width; provided.canvas.height = height;
    }
    return { ...provided, ok: true };
  }
  return { ok: false };
}

/**
 * 画一圈"羽化边"：从形状边缘往里，铺 n 层由内到外逐渐变淡的描边。
 *
 * 为什么不用一条 createLinearGradient 描边了事：canvas 的描边只有**一个渐变轴**，
 * 只能让跟轴垂直的那两条边有渐变，另两条边还是硬邦邦的；而且 roundRect 会把半径
 * 夹到 min(w,h)/2，负 inset 直接被吃掉、描边画到形状外面再被裁掉 —— 羽化会静默失效。
 * 分层描边四个方向一致，角上也自然。
 */
function featherRing(sc, mask, width, height, feather) {
  const n = 5;
  for (let i = n; i >= 1; i--) {
    const inset = (feather * i) / n;
    sc.save();
    maskPath(sc, mask, width, height);
    sc.clip();                                    // 裁在形状里，羽化不会长到蒙版外面
    maskPath(sc, mask, width, height, inset);      // 一圈比形状小一点的边
    sc.lineWidth = (feather * 2) / n + 1;
    sc.strokeStyle = `rgba(255,255,255,${(1 - i / (n + 1)).toFixed(3)})`;
    sc.stroke();
    sc.restore();
  }
}

/**
 * 把蒙版的形状削进离屏画布的 alpha 通道。
 *   - 硬边：destination-in 填一块白
 *   - 羽化：形状内先填满，再从边缘往内叠几层渐变描边把边削软
 *   - 反选：整幅白，再用 destination-out 把形状挖掉
 *   - 描边：最后用 source-over 画边框（画中画那个圈），外半圈在削蒙版时被切掉
 */
function applyMaskAlpha(sc, mask, width, height) {
  const span = Math.min(mask.w * width, mask.h * height);   // 半径 / 羽化都按短边算，换比例不走形
  const feather = (mask.feather || 0) * span;

  sc.save();
  sc.setTransform(1, 0, 0, 1, 0, 0);

  if (mask.invert) {
    // 反选：整幅留白，把形状挖掉。destination-out 会把已经画好的 alpha 减掉
    sc.globalCompositeOperation = 'source-over';
    sc.fillStyle = '#fff';
    sc.fillRect(0, 0, width, height);
    sc.globalCompositeOperation = 'destination-out';
    maskPath(sc, mask, width, height);
    sc.fillStyle = '#fff';
    sc.fill();
  } else {
    // 形状内部先按原样保留下来
    sc.globalCompositeOperation = 'destination-in';
    maskPath(sc, mask, width, height);
    sc.fillStyle = '#fff';
    sc.fill();
    // 再把边削软
    if (feather > 0.5) {
      sc.globalCompositeOperation = 'destination-out';
      featherRing(sc, mask, width, height, feather);
    }
  }

  // 描边：先于"削蒙版"画，所以外半圈在削的时候被切掉 —— 正好留一条贴在画面内侧的干净边
  if (mask.stroke && mask.stroke.width > 0) {
    sc.globalCompositeOperation = 'source-over';
    const lw = mask.stroke.width * mask.w * width;
    maskPath(sc, mask, width, height);
    sc.lineWidth = lw;
    sc.strokeStyle = mask.stroke.color || '#ffffff';
    sc.stroke();
  }

  sc.restore();
}

/** 取模板参数默认值 */
export function defaultsOf(tpl) {
  if (!tpl) return {};
  if (tpl._defaults) return tpl._defaults;
  const d = {};
  for (const p of tpl.params || []) d[p.key] = p.default;
  Object.defineProperty(tpl, '_defaults', { value: d, enumerable: false });
  return d;
}

// ---------------------------------------------------------------- 画布工具
/** 按设备比例创建画布 */
export function makeCanvas(width, height, dpr = 1) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(Math.round(width * dpr), Math.round(height * dpr))
    : Object.assign(document.createElement('canvas'), { width: Math.round(width * dpr), height: Math.round(height * dpr) });
  const ctx = c.getContext('2d', { alpha: true, willReadFrequently: false });
  ctx.scale(dpr, dpr);
  return { canvas: c, ctx };
}

/** 给 canvas 元素套一个"逻辑尺寸 -> 设备像素"的适配 */
export function fitCanvasToElement(canvas, width, height) {
  const dpr = Math.min(2, (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) || 1);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** 时间格式化：秒 -> 00:00:00.00 */
export function timecode(t, fps = 24, withFrames = false) {
  const s = Math.max(0, t);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  if (!withFrames) return `${hh}:${mm}:${ss}`;
  const ff = String(Math.floor((s % 1) * fps)).padStart(2, '0');
  return `${hh}:${mm}:${ss}.${ff}`;
}
