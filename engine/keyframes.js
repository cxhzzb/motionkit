// ============================================================================
// 动效引擎 · 关键帧
//
// 时间轴 → 数值。图层变换（位移 / 缩放 / 旋转 / 支点）、不透明度，都可以挂关键帧。
//
// 数据结构（跟 After Effects 一个思路，所以能表达"此处定值"和"缓动切换"）：
//
//   layer.keys = {
//     x: [ {t:0, v:-0.4, e:'outCubic'}, {t:1.2, v:0}, {t:2.5, v:0.3} ],
//     opacity: [ {t:0, v:0}, {t:0.4, v:1, hold:true} ],
//   }
//
//   {t, v}        第 t 秒的值是 v；从这一帧到下一帧之间用 e 指定的曲线
//   {t, hold:true} 此处"定值"：这一帧的值沿用到下一个关键帧（不插值，跳变）
//   {t, e:'linear'} 只改"从这一帧往后"的缓动，不产生新的值（纯缓动标记）
//
// t 是**相对图层起点的秒数**，不是绝对时间 —— 所以把图层整体挪到别的时间，
// 里面的动画会跟着一起走（跟"模板参数以 progress 表达"是同一个约定）。
//
// 几个边界，先说清楚免得踩：
//   - 第一个关键帧之前 = 第一个关键帧的值（不外推）
//   - 最后一个关键帧之后 = 最后一个关键帧的值（保持）
//   - 两边时间相同的关键帧，后面的赢（后写的覆盖先写的）
// ============================================================================

import { ease as easeOf, clamp } from './easing.js';

/** 关键帧时间容差：小于这个差就算"同一时刻"（1/4 帧 @60fps） */
export const KEY_EPS = 1 / 240;

// ---------------------------------------------------------------- 表达式
/**
 * 支持 "@名字" 形式的表达式，让数值跟着节拍 / 时间动，
 * 不用铺一大堆关键帧（做"每拍抖一下"这种最省事）。
 *
 *   "@beat"       当前拍序号
 *   "@beatPhase"  离最近拍点的时间差（秒，带符号）
 *   "@beatProg"   拍内进度 0..1
 *   "@t"          绝对时间（秒）
 *   "@local"      相对图层起点的秒数
 *   "@progress"   图层内进度 0..1
 *   "@osc"        正弦振荡（正负 1）
 *   "@sin" / "@cos" 整周期正弦 / 余弦
 *
 * 不认识的名字返回 null，调用方回退到字面值。
 */
function evalExpr(name, ctx) {
  if (!ctx) return null;
  switch (name) {
    case 'beat': return ctx.beatIndex;
    case 'beatPhase': return ctx.beatPhase;
    case 'beatProg': case 'beatProgress': return ctx.beatProgress;
    case 't': return ctx.t;
    case 'local': return ctx.local;
    case 'progress': return ctx.progress;
    case 'frame': return ctx.frame;
    case 'osc': return Math.sin((ctx.local || 0) * Math.PI * 2);
    case 'sin': return Math.sin((ctx.t || 0) * Math.PI * 2);
    case 'cos': return Math.cos((ctx.t || 0) * Math.PI * 2);
    default: return null;
  }
}

/** 是不是 "@xxx" 表达式 */
export const isExpr = (v) => typeof v === 'string' && v.charCodeAt(0) === 64;

/** 已知表达式名，给 UI 做提示 */
export const EXPR_NAMES = ['@beat', '@beatPhase', '@beatProg', '@t', '@local', '@progress', '@osc', '@sin', '@cos'];

// ---------------------------------------------------------------- 归一化
/** 把工程里读进来的轨道理一遍：去非法项、按时间排序、去掉冗余的缓动尾巴 */
export function normalizeTrack(track) {
  if (!Array.isArray(track)) return null;
  const out = [];
  for (const k of track) {
    if (!k || typeof k !== 'object') continue;
    const t = Number(k.t);
    if (!Number.isFinite(t)) continue;
    const e = typeof k.e === 'string' ? k.e : undefined;
    if (k.hold) { out.push({ t, v: Number(k.v) || 0, hold: true }); continue; }
    if (k.v === undefined || k.v === null) {
      if (e) out.push({ t, e });        // 纯缓动标记
      continue;
    }
    const v = isExpr(k.v) ? k.v : Number(k.v);
    if (typeof v !== 'string' && !Number.isFinite(v)) continue;
    const o = { t, v };
    if (e) o.e = e;
    out.push(o);
  }
  // 时间升序；同一时刻后面的覆盖前面的
  out.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const k of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && Math.abs(prev.t - k.t) < KEY_EPS && k.v !== undefined) dedup[dedup.length - 1] = k;
    else dedup.push(k);
  }
  // 末尾的纯缓动标记没有意义
  while (dedup.length && dedup[dedup.length - 1].v === undefined) dedup.pop();
  return dedup.length ? dedup : null;
}

/** 整份 keys 归一化；全空就返回 null（不落盘） */
export function normalizeKeys(keys) {
  if (!keys || typeof keys !== 'object') return null;
  const out = {};
  for (const [prop, track] of Object.entries(keys)) {
    const t = normalizeTrack(track);
    if (t) out[prop] = t;
  }
  return Object.keys(out).length ? out : null;
}

export const hasKeys = (keys) => !!keys && Object.keys(keys).length > 0;
export const isAnimated = (keys, prop) => Array.isArray(keys?.[prop]) && keys[prop].some((k) => k.v !== undefined);

// ---------------------------------------------------------------- 求值
/**
 * 求轨道在 t 秒的值。
 * 没有关键帧 / 求解不出来时返回 fallback（调用方传"静态值"进来）。
 */
export function evalTrack(track, t, fallback = 0, ctx = null) {
  if (!Array.isArray(track) || !track.length) return fallback;

  const evalV = (v) => {
    if (!isExpr(v)) return Number(v);
    const got = evalExpr(String(v).slice(1), ctx);
    return got === null || got === undefined || !Number.isFinite(got) ? fallback : got;
  };

  const first = track[0];
  if (t <= first.t + KEY_EPS) return first.v === undefined ? fallback : evalV(first.v);

  let prev = null;              // 上一个带值的帧 {t, v}
  let ease = null;              // 从 prev 往后生效的缓动
  for (let i = 0; i < track.length; i++) {
    const k = track[i];
    if (k.e !== undefined && k.v === undefined) { ease = k.e; continue; }   // 纯缓动标记
    if (t < k.t - KEY_EPS) {
      if (!prev) return evalV(k.v);
      // prev 是定值帧 → 保持到这一帧为止，不插值
      if (prev.hold) return prev.v;
      const span = k.t - prev.t;
      const u = span <= 0 ? 1 : clamp((t - prev.t) / span, 0, 1);
      const shaped = easeOf(ease || 'outCubic', u);   // 未知曲线名自动退回 outCubic
      return prev.v + (evalV(k.v) - prev.v) * shaped;
    }
    if (Math.abs(t - k.t) <= KEY_EPS) return evalV(k.v);
    prev = { t: k.t, v: evalV(k.v), hold: !!k.hold };
    ease = k.e;
  }
  return prev ? prev.v : fallback;
}

/**
 * 求一个属性的值：有关键帧走关键帧，没有就用静态值。
 * @param {object} keys   layer.keys
 * @param {string} prop   属性名
 * @param {number} t      相对图层起点的秒数
 * @param {number} statik 静态值（没关键帧 / 表达式的兜底）
 */
export function valueAt(keys, prop, t, statik, ctx = null) {
  const track = keys?.[prop];
  if (!Array.isArray(track) || !track.length) return statik;
  return evalTrack(track, t, statik, ctx);
}

// ---------------------------------------------------------------- 编辑
/** 取某一时刻已经存在的关键帧（改写用），没有返回 -1 */
export function keyIndexAt(track, t) {
  if (!Array.isArray(track)) return -1;
  for (let i = 0; i < track.length; i++) {
    if (Math.abs(track[i].t - t) <= KEY_EPS && track[i].v !== undefined) return i;
  }
  return -1;
}

/** 在 t 处写入值；已有关键帧就地改值（保住它的缓动） */
export function setKey(track, t, v, easing) {
  const list = Array.isArray(track) ? track : [];
  const at = keyIndexAt(list, t);
  if (at >= 0) { list[at].v = v; if (easing) list[at].e = easing; return list; }
  const o = { t, v };
  if (easing) o.e = easing;
  list.push(o);
  list.sort((a, b) => a.t - b.t);
  return list;
}

/** 删掉 t 处的关键帧（返回删了几个） */
export function removeKey(track, t) {
  if (!Array.isArray(track)) return 0;
  let n = 0;
  for (let i = track.length - 1; i >= 0; i--) {
    if (Math.abs(track[i].t - t) <= KEY_EPS && track[i].v !== undefined) { track.splice(i, 1); n++; }
  }
  return n;
}

/** 把关键帧整体平移 dt（时间轴上拖着走） */
export function moveKey(track, from, to) {
  const i = keyIndexAt(track, from);
  if (i < 0) return false;
  track[i].t = Math.max(0, to);
  track.sort((a, b) => a.t - b.t);
  return true;
}

/** 改某一帧的缓动（这一帧 → 下一帧之间） */
export function setKeyEasing(track, t, easing) {
  const i = keyIndexAt(track, t);
  if (i < 0) return false;
  if (easing) track[i].e = easing; else delete track[i].e;
  return true;
}

/** 清掉某个属性的关键帧；返回剩下的 keys（空则 null） */
export function clearTrack(keys, prop) {
  if (!keys) return null;
  delete keys[prop];
  return hasKeys(keys) ? keys : null;
}

// ---------------------------------------------------------------- 卡点助手
/**
 * 把关键帧铺到拍点上 —— "每拍动一下"不用手点。
 * @param {number} t0 起点（相对图层起点的秒数）
 * @param {number} t1 终点
 * @param {object} beat BeatMap
 * @param {'ramp'|'step'} mode  ramp=在两个拍点之间平滑过渡，step=跳变（闪）
 */
export function keysOnBeats(t0, t1, beat, values, mode = 'ramp') {
  const hits = beat.hitsIn(t0 - 1e-6, t1, 1);
  // 注意去重：t0=0 而第一拍也正好在 0 时，别在同一个时刻塞两个关键帧
  const list = [];
  const push = (t) => { if (!list.some((v) => Math.abs(v - t) < 1e-6)) list.push(t); };
  if (t0 <= 1e-6) push(0);
  for (const h of hits) push(h);
  list.sort((a, b) => a - b);

  const track = [];
  const n = Math.max(1, values.length);
  for (let i = 0; i < list.length; i++) {
    const k = { t: Math.max(0, list[i]), v: values[i % n] };
    if (i === 0) k.e = 'outCubic';
    if (mode === 'step') k.hold = true;
    track.push(k);
  }
  return track.length ? track : null;
}

/** 关键帧的时间范围，给 UI 画条用；没有返回 null */
export function trackRange(track) {
  if (!Array.isArray(track) || !track.length) return null;
  let a = Infinity, b = -Infinity;
  for (const k of track) { if (k.v === undefined) continue; if (k.t < a) a = k.t; if (k.t > b) b = k.t; }
  return a === Infinity ? null : { from: a, to: b };
}

/** 这份 keys 里所有关键帧的时间（去重升序），时间轴的菱形标记要用 */
export function keyTimes(keys) {
  const set = new Set();
  if (!keys) return [];
  for (const track of Object.values(keys)) {
    if (!Array.isArray(track)) continue;
    for (const k of track) if (k.v !== undefined) set.add(Math.round(k.t * 1000) / 1000);
  }
  return [...set].sort((a, b) => a - b);
}

/** 这个属性有几个关键帧 */
export const keyCount = (keys, prop) =>
  (Array.isArray(keys?.[prop]) ? keys[prop].filter((k) => k.v !== undefined).length : 0);

/** 图层上所有带关键帧的属性名（顺序固定，UI 好读） */
export const KEY_PROPS = ['x', 'y', 'scale', 'rot', 'px', 'py', 'opacity'];
export const KEY_PROP_LABELS = {
  x: '位移 X', y: '位移 Y', scale: '缩放', rot: '旋转',
  px: '支点 X', py: '支点 Y', opacity: '不透明度',
};
export function animatedProps(keys) {
  return KEY_PROPS.filter((p) => isAnimated(keys, p));
}
