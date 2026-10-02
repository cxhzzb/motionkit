// ============================================================================
// 动效引擎 · 核心
// 数学工具 / 确定性随机 / 节拍图 / 图层与场景 / 帧渲染调度
// 纯 JS，无依赖，可在浏览器与 Node 中同时运行。
// ============================================================================

export const TAU = Math.PI * 2;

// ---------------------------------------------------------------- 基础数学
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const mapRange = (v, a, b, c, d) => lerp(c, d, clamp(invLerp(a, b, v), 0, 1));
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};
export const smootherstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

// ---------------------------------------------------------------- 缓动曲线
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
export const ease = (name, t) => (EASINGS[name] || easeOutCubic)(clamp(t, 0, 1));

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
  constructor({ template, start = 0, end = 1, params = {}, seed = null, opacity = 1, blend = 'source-over', enabled = true, name = '', transform = null, group = '', meta = null } = {}) {
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
    this.group = group;                // 来源分组，比如 "beat" = 卡点批量铺出来的
    this.meta = meta;                  // 附加归属（比如"这个转场层挂在哪个片段上"），不用就不落盘
  }
  get duration() { return Math.max(0, this.end - this.start); }
  covers(t) { return this.enabled && t >= this.start && t < this.end; }
  toJSON() {
    const o = { template: this.template, start: this.start, end: this.end, params: this.params, seed: this.seed, opacity: this.opacity, blend: this.blend, enabled: this.enabled, name: this.name, transform: this.transform };
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
 * 有的带宽度 "x,y,w"，全屏 HUD 和转场类压根没有），逐个去改 23 个模板既脆又乱。
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
 * @param {object} deps  { fxRunner, onLayer }
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

    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.globalCompositeOperation = layer.blend || 'source-over';
      // 图层变换：先位移，再绕支点旋转 / 缩放。支点用归一化画布坐标，
      // 所以同一份工程在任意分辨率下渲染出来的相对位置是一致的。
      const tr = layer.transform;
      if (tr) {
        const px = tr.px * width, py = tr.py * height;
        ctx.translate(tr.x * width, tr.y * height);
        ctx.translate(px, py);
        if (tr.rot) ctx.rotate((tr.rot * Math.PI) / 180);
        if (tr.scale !== 1) ctx.scale(tr.scale, tr.scale);
        ctx.translate(-px, -py);
      }
    try {
      tpl.draw(ctx, env);
    } catch (err) {
      if (!deps.silent) console.error(`[template:${layer.template}]`, err);
    }
    ctx.restore();
    deps.onLayer?.(layer, env);
  }

  ctx.restore();

  if (scene.fx && scene.fx.length && deps.fxRunner) {
    deps.fxRunner(ctx, scene, t);
  }
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
