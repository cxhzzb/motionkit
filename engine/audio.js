// ============================================================================
// 动效引擎 · 卡点分析
// 输入一段音频，输出 BPM / 拍点数组 / 强拍 / 低频能量曲线，
// 这样"卡点"就不是靠肉眼对，而是真正跟音乐走。
// 浏览器里用 Web Audio 解码；Node 里可以用 tools/beatmap.py 得到同样的 JSON。
// ============================================================================

import { BeatMap, clamp } from './core.js';

// ---------------------------------------------------------------- FFT
/** 原地 radix-2 FFT（输入长度必须是 2 的幂） */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// ---------------------------------------------------------------- 工具
function movingAverage(arr, win) {
  const out = new Float32Array(arr.length);
  let sum = 0;
  const half = Math.max(1, Math.floor(win / 2));
  for (let i = 0; i < arr.length + half; i++) {
    if (i < arr.length) sum += arr[i];
    if (i - win >= 0) sum -= arr[i - win];
    const idx = i - half;
    if (idx >= 0) out[idx] = sum / Math.min(win, i + 1);
  }
  return out;
}

function normalize(arr) {
  let max = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > max) max = arr[i];
  if (max <= 0) return arr;
  const o = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) o[i] = arr[i] / max;
  return o;
}

// ---------------------------------------------------------------- 主体
/**
 * 分析 AudioBuffer。
 * @param {AudioBuffer} buffer
 * @param {object} opt { bpmMin, bpmMax, downbeat, sensitivity }
 * @returns {{bpm:number, offset:number, beats:number[], downbeats:number[], env:Float32Array,
 *            envRate:number, bands:{low:Float32Array,mid:Float32Array,high:Float32Array},
 *            bpmConfidence:number, duration:number}}
 */
export function analyzeBuffer(buffer, opt = {}) {
  const {
    fftSize = 1024, hop = 256, bpmMin = 60, bpmMax = 200, sensitivity = 1.0,
  } = opt;

  const sr0 = buffer.sampleRate;
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
  const n0 = buffer.length;

  // 单声道混音
  const mono = new Float32Array(n0);
  for (let i = 0; i < n0; i++) mono[i] = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];

  const envRate = sr0 / hop;
  // 第 f 帧代表的时刻是 f*hop/sr + win/(2*sr)，这半个窗口的常数偏移必须补上，
  // 不然所有拍点会稳定提前 20ms 左右。
  const envOffset = fftSize / (2 * sr0);
  const frames = Math.floor((n0 - fftSize) / hop) + 1;
  if (frames < 8) {
    return { bpm: 120, offset: 0, beats: [0], downbeats: [0], env: new Float32Array([1]), envRate, envOffset, bands: {}, bpmConfidence: 0, duration: n0 / sr0 };
  }

  const win = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / fftSize); // Hann

  const bins = fftSize / 2;
  const fluxLow = new Float32Array(frames);
  const fluxMid = new Float32Array(frames);
  const fluxHigh = new Float32Array(frames);
  const low = new Float32Array(frames);
  const mid = new Float32Array(frames);
  const high = new Float32Array(frames);

  // 频段边界（大约）
  const binOf = (hz) => clamp(Math.round((hz * fftSize) / sr0), 1, bins - 1);
  const bLow0 = binOf(30), bLow1 = binOf(180);
  const bMid0 = binOf(180), bMid1 = binOf(2000);
  const bHigh0 = binOf(2000), bHigh1 = binOf(9000);

  // 每个频段算"段内平均通量"而不是求和：高频 bin 数量多得多，
  // 一旦求和，一个 hi-hat 就能把底鼓压过去，拍点会锁到后半拍。
  const nLow = Math.max(1, bLow1 - bLow0);
  const nMid = Math.max(1, bMid1 - bMid0);
  const nHigh = Math.max(1, bHigh1 - bHigh0);

  let prevMag = new Float32Array(bins);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) { re[i] = mono[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let dl = 0, dm = 0, dh = 0, sl = 0, sm = 0, sh = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      // 对数压缩：让弱的高频能量不至于被低频完全淹没，也不让瞬态幅度主导
      const lm = Math.log1p(mag * 12);
      const d = lm - prevMag[k];
      if (d > 0) {
        if (k >= bLow0 && k < bLow1) dl += d;
        else if (k >= bHigh0 && k < bHigh1) dh += d;
        else dm += d;
      }
      if (k >= bLow0 && k < bLow1) sl += mag;
      else if (k >= bMid0 && k < bMid1) sm += mag;
      else if (k >= bHigh0 && k < bHigh1) sh += mag;
      prevMag[k] = lm;
    }
    fluxLow[f] = dl / nLow;
    fluxMid[f] = dm / nMid;
    fluxHigh[f] = dh / nHigh;
    low[f] = sl; mid[f] = sm; high[f] = sh;
  }

  // 低频（底鼓）主导，中频补充，高频只留一点点
  const combined = new Float32Array(frames);
  const fL = normalize(fluxLow), fM = normalize(fluxMid), fH = normalize(fluxHigh);
  for (let i = 0; i < frames; i++) combined[i] = fL[i] * 0.6 + fM[i] * 0.28 + fH[i] * 0.12;

  const localMean = movingAverage(combined, Math.round(envRate * 0.35));
  const onset = new Float32Array(frames);
  for (let i = 0; i < frames; i++) onset[i] = Math.max(0, combined[i] - localMean[i] * 1.15) * sensitivity;
  const normOnset = normalize(onset);
  const normLow = normalize(low);
  const normMid = normalize(mid);
  const normHigh = normalize(high);

  // ---- 周期估计（自相关） ----
  const minLag = Math.max(2, Math.round((60 / bpmMax) * envRate));
  const maxLag = Math.min(frames - 2, Math.round((60 / bpmMin) * envRate));
  let bestLag = minLag, bestScore = -1;
  const scores = new Float32Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += normOnset[i] * normOnset[i + lag];
    // 偏向 100-140 BPM，避免半拍/双拍歧义
    const bpm = (60 * envRate) / lag;
    const prior = Math.exp(-Math.pow(Math.log2(bpm / 120) / 0.6, 2));
    s *= 0.55 + 0.45 * prior;
    scores[lag] = s;
    if (s > bestScore) { bestScore = s; bestLag = lag; }
  }
  // 抛物线插值提高精度
  let lagRefined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = scores[bestLag - 1], y1 = scores[bestLag], y2 = scores[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-9) lagRefined = bestLag - (0.5 * (y2 - y0)) / denom;
  }
  const period = lagRefined / envRate;               // 秒
  let bpm = 60 / period;
  // 归一化到 70-180 的常用区间
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  const bpmConfidence = clamp(bestScore / (frames * 0.06), 0, 1);

  // ---- 相位（第一拍偏移） ----
  let periodFrames = lagRefined;
  let bestPhase = 0, bestPhaseScore = -1;
  const phaseSteps = Math.max(8, Math.round(periodFrames));
  for (let p = 0; p < phaseSteps; p++) {
    const phase = (p / phaseSteps) * periodFrames;
    let s = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(phase + k * periodFrames);
      if (idx >= frames) break;
      s += normOnset[idx] * (1 + 0.4 * normLow[idx]);
    }
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = phase; }
  }
  const offset = bestPhase / envRate;

  // ---- 生成拍点，并在邻域内吸附到真正的起音点 ----
  const duration = n0 / sr0;
  const frameToTime = (f) => f / envRate + envOffset;
  const timeToFrame = (t) => (t - envOffset) * envRate;

  const buildGrid = (periodF, phaseF) => {
    const out = [];
    let k = Math.floor(-phaseF / periodF);
    for (;; k++) {
      const base = phaseF + k * periodF;
      const t = frameToTime(base);
      if (t > duration) break;
      if (t >= -0.6) out.push(t);
    }
    return out;
  };
  const searchOf = (p) => Math.max(1, Math.round(p * 0.12));
  const snapGrid = (raw, search) => raw.map((t) => {
    const b = Math.round(timeToFrame(t));
    const lo = Math.max(0, b - search), hi = Math.min(frames, b + search + 1);
    if (hi <= lo) return t;
    let bi = lo, bv = -Infinity;
    for (let idx = lo; idx < hi; idx++) {
      const v = normOnset[idx] - 0.25 * (Math.abs(idx - b) / search);
      if (v > bv) { bv = v; bi = idx; }
    }
    return frameToTime(bi);
  });

  // ---- 最小二乘精修 ----
  // 自相关只能精确到一帧，hop 的量化误差会让长曲子里拍点越走越偏；
  // 对 (序号 -> 起音峰位置) 做一次直线拟合，可以把小数周期平出来。
  let pFine = periodFrames, phFine = bestPhase;
  for (let round = 0; round < 3; round++) {
    const sn = snapGrid(buildGrid(pFine, phFine), searchOf(pFine));
    if (sn.length < 4) break;
    let idxs = sn.map((_, i) => i);
    let fr = sn.map(timeToFrame);
    let slope = pFine, intercept = phFine;
    for (let pass = 0; pass < 3; pass++) {
      const n = idxs.length;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < n; i++) { sx += idxs[i]; sy += fr[i]; sxx += idxs[i] * idxs[i]; sxy += idxs[i] * fr[i]; }
      const den = n * sxx - sx * sx;
      if (Math.abs(den) < 1e-9) break;
      slope = (n * sxy - sx * sy) / den;
      intercept = (sy - slope * sx) / n;
      const lim = Math.max(1.5, pFine * 0.3);
      const ki = [], kf = [];
      for (let i = 0; i < n; i++) {
        if (Math.abs(fr[i] - (slope * idxs[i] + intercept)) < lim) { ki.push(idxs[i]); kf.push(fr[i]); }
      }
      if (ki.length === n) break;
      idxs = ki; fr = kf;
    }
    if (!(slope > 0)) break;
    pFine = slope;
    phFine = ((intercept % pFine) + pFine) % pFine;
  }
  if (pFine > 0) {
    periodFrames = pFine; bestPhase = phFine;
    bpm = (60 * envRate) / pFine;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
  }
  const beats = snapGrid(buildGrid(periodFrames, bestPhase), searchOf(periodFrames))
    .map((t) => Math.max(0, t));

  // ---- 强拍（4/4 假设） ----
  let bestShift = 0, bestShiftScore = -1;
  for (let shift = 0; shift < 4; shift++) {
    let s = 0;
    for (let i = shift; i < beats.length; i += 4) {
      s += normLow[clamp(Math.round(timeToFrame(beats[i])), 0, frames - 1)] || 0;
    }
    if (s > bestShiftScore) { bestShiftScore = s; bestShift = shift; }
  }
  const downbeats = beats.filter((_, i) => (i - bestShift) % 4 === 0);

  return {
    bpm, offset: beats.length ? beats[0] : offset, beats, downbeats,
    env: normOnset, envRate, envOffset,
    bands: { low: normLow, mid: normMid, high: normHigh },
    bpmConfidence, duration,
  };
}

/** 用 Web Audio 解码一段音频（File / ArrayBuffer / URL 皆可） */
export async function decodeAudio(src, audioCtx) {
  const ac = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  if (src instanceof ArrayBuffer) buf = src;
  else if (typeof src === 'string') buf = await (await fetch(src)).arrayBuffer();
  else buf = await src.arrayBuffer();
  return { buffer: await ac.decodeAudioData(buf.slice(0)), ctx: ac };
}

/** 一站式：文件 -> { beatMap, env, bands } */
export async function analyzeAudioFile(file, opt = {}) {
  const { buffer, ctx } = await decodeAudio(file);
  const res = analyzeBuffer(buffer, opt);
  const beatMap = new BeatMap({ bpm: res.bpm, offset: res.offset, beats: res.beats, duration: res.duration, source: 'audio' });
  return { ...res, beatMap, audioBuffer: buffer, audioCtx: ctx };
}

/** 从能量包络取某一刻的强度（做音乐联动动画用） */
export function envAt(res, t, band = null) {
  const arr = band ? res.bands[band] : res.env;
  if (!arr) return 0;
  const i = clamp(Math.round(t * res.envRate), 0, arr.length - 1);
  return arr[i] || 0;
}

/** 找出所有"强起音"，用于自动打点/自动切片 */
export function onsets(res, { threshold = 0.42, minGap = 0.12 } = {}) {
  const out = [];
  const e = res.env;
  let last = -Infinity;
  for (let i = 1; i < e.length - 1; i++) {
    if (e[i] > threshold && e[i] >= e[i - 1] && e[i] >= e[i + 1]) {
      const t = i / res.envRate;
      if (t - last >= minGap) { out.push({ t, strength: e[i] }); last = t; }
    }
  }
  return out;
}
