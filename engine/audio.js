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

// ============================================================================
// 音频降噪
//
// 现场收音的噪声就三类，分开治最有效（这也是剪辑软件里那几条常用滤镜）：
//
//   低频轰鸣 / 空调声 / 手持抖动  → **高通**，把 80~150Hz 以下的整个砍掉
//   高频嘶声 / 底噪"沙"          → **低通**，把 6~12kHz 以上的砍掉
//   整段的稳定底噪（电流声、房间声）→ **门限（下行扩展）**，安静的地方压下去
//
// 第 1、2 条 Web Audio 有现成节点（BiquadFilter），第 3 条没有"噪声门"这个节点，
// 用一个极高压缩比的 DynamicsCompressor 近似：它本来只往下压超过阈值的部分，
// 但在 ratio 极大时，输入略低于阈值的东西也会被压掉一大截 —— 对"把安静处的底噪
// 压没"这件事是够用的（参数量级跟专业噪声门不同，所以 UI 上标的是"门限"而不是 dB）。
// ============================================================================

/** 降噪参数的合法范围；UI 的滑块和这里共用一份，免得两处对不上 */
export const DENOISE_RANGE = {
  amount: { min: 0, max: 1, step: 0.02, def: 0 },
  highpass: { min: 0, max: 400, step: 5, def: 0 },      // Hz，0 = 关
  lowpass: { min: 0, max: 20000, step: 100, def: 0 },    // Hz，0 = 关
  gate: { min: 0, max: 1, step: 0.01, def: 0 },          // 门限，0 = 关
  ratio: { min: 1, max: 20, step: 0.5, def: 1 },         // 门限的力度
  gain: { min: 0, max: 4, step: 0.05, def: 1 },          // 补偿增益
};

const dn = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampRange = (spec, v) => clamp(dn(v, spec.def), spec.min, spec.max);

/**
 * 把 clip 上的降噪参数理成一份"确定的"设置。
 * 全部是关闭状态（或者有降噪效果但幅度等于没做）时返回 null —— 调用方据此完全跳过这条链路。
 */
export function resolveDenoise(src) {
  if (!src && src !== 0) return null;
  const o = {
    amount: clampRange(DENOISE_RANGE.amount, src.denoise),
    highpass: clampRange(DENOISE_RANGE.highpass, src.highpass),
    lowpass: clampRange(DENOISE_RANGE.lowpass, src.lowpass),
    gate: clampRange(DENOISE_RANGE.gate, src.gate),
    ratio: clampRange(DENOISE_RANGE.ratio, src.gateRatio),
    gain: clampRange(DENOISE_RANGE.gain, src.audioGain === undefined ? 1 : src.audioGain),
  };
  // "幅度"参数按比例缩一档：amount 是个总强度，压着它下面三项走
  if (o.amount > 0 && o.amount < 1) {
    if (o.highpass > 0) o.highpass = Math.round(o.highpass * o.amount);
    if (o.lowpass > 0) o.lowpass = Math.round(20000 - (20000 - o.lowpass) * o.amount);
    if (o.gate > 0) o.gate = o.gate * o.amount;
  }
  // 低通低于高通就成了"全砍掉"，夹一下保持可听
  if (o.highpass > 0 && o.lowpass > 0 && o.lowpass <= o.highpass * 2) {
    o.lowpass = Math.min(20000, o.highpass * 2 + 500);
  }
  const idle = o.highpass <= 0 && o.lowpass <= 0 && o.gate <= 0 && Math.abs(o.gain - 1) < 1e-3;
  return idle ? null : o;
}

/** 分帧取 RMS（50ms 一帧），降噪分析和"噪声底"估算都用它 */
function frameRms(data, sampleRate, frameMs = 50) {
  const n = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const out = [];
  for (let at = 0; at + n <= data.length; at += n) {
    let s = 0;
    for (let i = at; i < at + n; i++) s += data[i] * data[i];
    out.push(Math.sqrt(s / n));
  }
  return out;
}

/** 取分位数（q = 0..1），输入会被排序 */
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[i];
}


/**
 * 一段信号"有多像噪声"：谱平坦度（几何平均 / 算术平均）。
 *
 * 这是把"有内容的信号"和"底噪"分开的关键 —— 光比 RMS 分位数是不够的：
 * 一段稳定的正弦（或持续的音乐）分位数几乎一样，会被误判成"全是底噪"。
 * 正弦的谱是几根尖峰 → 平坦度接近 0；白噪声谱是平的 → 接近 1。
 * 乘上整体电平就得到"噪声成分有多大"的估计。
 */
function spectralFlatness(data) {
  const N = 1024;
  const re = new Float64Array(N), im = new Float64Array(N);
  const maxFrames = 8;
  const step = Math.max(N, Math.floor(data.length / maxFrames));
  let sumLog = 0, sumLin = 0, bins = 0, used = 0;
  for (let at = 0; at + N <= data.length && used < maxFrames; at += step, used++) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = (data[at + i] || 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = Math.hypot(re[k], im[k]) / N + 1e-12;
      sumLog += Math.log(p);
      sumLin += p;
      bins++;
    }
  }
  if (!bins || sumLin <= 0) return 0;
  return clamp(Math.exp(sumLog / bins) / (sumLin / bins), 0, 1);
}

/**
 * 站在"要降噪"的角度看一段音频，给出一份建议设置。
 *
 *   noiseFloor  底噪的电平 —— 由"整段电平 × 噪声成分占比"估出来
 *   loudLevel   整体电平（RMS 中位数）
 *   snr         两者之比（dB）
 *   rumbleDb    低频相对中频高出多少 dB —— 偏高说明有低频轰鸣
 *   hissDb      高频相对中频高出多少 dB —— 偏高说明有嘶声
 *
 * 频段比较用**相对关系**而不是"占比"：占比会被幅度淹没（一段 80Hz 的轰鸣
 * 能量上就能占掉大半，光看占比分不出"轰鸣"和"低频本来就是这段的主体"）。
 */
export function analyzeNoise(data, sampleRate) {
  if (!data || data.length < 256) return null;
  const frames = frameRms(data, sampleRate);
  if (!frames.length) return null;
  const sorted = [...frames].sort((a, b) => a - b);
  const loudLevel = quantile(sorted, 0.5);
  if (!(loudLevel > 1e-7)) {
    // 整段几乎无声：没有什么可降的
    return {
      noiseFloor: 0, loudLevel, snr: 99, floorRatio: 0, lowShare: 0, highShare: 0,
      rumbleDb: 0, hissDb: 0, flatness: 0, frames: frames.length,
      recommendation: { denoise: 0, highpass: 0, lowpass: 0, gate: 0, gateRatio: 1, audioGain: 1 },
    };
  }

  // ---- 底噪：整段电平 × 噪声成分占比（谱平坦度） ----
  const flatness = spectralFlatness(data);
  // 开个 0.75 次方：平坦度本身有波动，直接乘容易把"干净的正弦"算出一堆底噪
  const noiseShare = Math.pow(flatness, 0.75);
  const noiseFloor = clamp(loudLevel * noiseShare, 0, loudLevel);
  const snr = 20 * Math.log10((loudLevel + 1e-9) / (noiseFloor + 1e-9));
  const floorRatio = clamp(noiseFloor / (loudLevel + 1e-9), 0, 1);

  // ---- 频谱：抓最响的几帧做 256 点 FFT，按低/中/高聚合 ----
  const N = 256;
  const re = new Float64Array(N), im = new Float64Array(N);
  const starts = [];
  const thresh = Math.max(loudLevel * 0.6, 1e-6);
  for (let at = 0; at + N <= data.length && starts.length < 12; at += N * 4) {
    let s = 0;
    for (let i = 0; i < N; i++) s += data[at + i] * data[at + i];
    if (Math.sqrt(s / N) >= thresh) starts.push(at);
  }
  if (!starts.length) starts.push(0);
  const bands = { low: 0, mid: 0, high: 0 };
  for (const at of starts) {
    for (let i = 0; i < N; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      re[i] = (data[at + i] || 0) * w;
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const f = (k * sampleRate) / N;
      const mag = Math.hypot(re[k], im[k]);
      if (f < 200) bands.low += mag;
      else if (f < 3000) bands.mid += mag;
      else bands.high += mag;
    }
  }
  const db = (a, b) => 20 * Math.log10((a + 1e-9) / (b + 1e-9));
  const rumbleDb = db(bands.low, bands.mid);     // 低频比中频高多少
  const hissDb = db(bands.high, bands.mid);      // 高频比中频高多少
  const total = bands.low + bands.mid + bands.high + 1e-9;

  const rec = { denoise: 1, highpass: 0, lowpass: 0, gate: 0, gateRatio: 6, audioGain: 1 };
  // 低频轰鸣：低频已经跟中频一个量级了（差不到 7dB）就该砍
  if (rumbleDb > -7) rec.highpass = rumbleDb > 2 ? 120 : 80;
  // 高频嘶声：高频跟中频接近（差不到 2dB）才收，免得把正常的明亮音色也闷掉
  if (hissDb > 2) rec.lowpass = hissDb > 8 ? 7000 : 11000;
  // 底噪离正常电平不远才值得上门限
  if (snr < 30 && floorRatio > 0.02) {
    rec.gate = clamp(floorRatio * 1.6, 0.03, 0.6);
    rec.gateRatio = snr < 14 ? 14 : 8;
  }
  // 门限压掉底噪之后整体会显得轻，稍微补一点
  if (rec.gate > 0.1) rec.audioGain = 1.15;

  return {
    noiseFloor, loudLevel, snr, floorRatio,
    lowShare: bands.low / total, highShare: bands.high / total,
    rumbleDb, hissDb, flatness,
    frames: frames.length, recommendation: rec,
  };
}

/** 把建议设置整理成一份可读的说明（界面上的提示文案直接用） */
export function describeDenoise(a) {
  if (!a) return '这段没有可分析的声音。';
  const bits = [];
  bits.push('整体电平约 ' + (a.loudLevel * 1000).toFixed(1) + '‰　　估计底噪约 ' + (a.noiseFloor * 1000).toFixed(1) + '‰');
  bits.push('信噪比 ' + a.snr.toFixed(1) + ' dB'
    + (a.snr >= 30 ? '（挺干净）' : a.snr >= 16 ? '（有一点底噪）' : '（底噪偏大）'));
  bits.push('低频比中频 ' + a.rumbleDb.toFixed(1) + ' dB' + (a.recommendation.highpass ? ' → 建议开高通' : ''));
  bits.push('高频比中频 ' + a.hissDb.toFixed(1) + ' dB' + (a.recommendation.lowpass ? ' → 建议开低通' : ''));
  if (a.recommendation.gate > 0) bits.push('建议门限 ' + a.recommendation.gate.toFixed(2));
  return bits.join('\n');
}

// ---------------------------------------------------------------- 降噪的音频链路
//
// 为什么不用 DynamicsCompressor 当噪声门：压缩器是**按比例**往下压，安静处的
// 底噪只能被压小几个 dB，压不掉（实测安静段 RMS 只降了约 10%，听感上等于没做）。
// 而且把它的阈值调低去"够到"底噪时，正常内容会被一起压瘪（实测大声段掉了 60%）。
// 真正的门需要"低于阈值直接归零"，Web Audio 里只有 WaveShaper 能做逐样本的
// 非线性映射 —— 它不引入延迟，"瞬时归零"这件事是稳的。
//
// 所以门限**只用 WaveShaper 一个节点**：软膝曲线本身已经避免咔哒声，
// 后面不再串压缩器（串了反而会把正常内容压瘪）。
//
// 注意它是逐样本的，瞬态上会有一点点门限痕迹 —— 这正是噪声门本来的代价。

/**
 * 门限曲线（WaveShaper 用的查找表）。
 *
 *   |x| <= knee*0.6           → 0（安静，完全不出声）
 *   knee*0.6 ~ knee*1.6       → smoothstep 平滑过渡（软膝，避免"咔"的一声）
 *   |x| >= knee*1.6           → **原样通过**（阈值以上必须完全透明）
 *
 * 阈值以上必须是恒等映射：门限只管"安静处要不要出声"，
 * 顺手把正常内容也变一点电平和音色就是 bug。
 *
 * ⚠️ 曲线的定义域**必须正好是 [-1, 1]**：WaveShaperNode 把输入 x 直接按
 * `index = (x+1)/2*(N-1)` 取表，它不会按表的"语义范围"去缩放 —— 它假定这张表
 * 覆盖的就是 [-1, 1]。所以千万别为了"给超过 0dBFS 留余量"而把表铺到 [-1.2, 1.2]，
 * 那等于把整条曲线横向拉伸，恒等段会变成 x*1.2（实测响内容整体偏大 20%）。
 * 输入超过 ±1 的部分 WaveShaper 自己会夹住（表两端就是端点值）。
 */
export function gateCurve(knee) {
  const N = 8192;
  const c = new Float32Array(N);
  const k = Math.max(1e-5, knee);
  const lo = k * 0.6, hi = k * 1.6;
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;          // 正好覆盖 [-1, 1]
    const a = Math.abs(x);
    if (a <= lo) { c[i] = 0; continue; }
    if (a >= hi) { c[i] = x; continue; }      // 恒等：一点都不动
    const t = (a - lo) / (hi - lo);
    c[i] = x * (t * t * (3 - 2 * t));
  }
  return c;
}

/**
 * 往 AudioContext 上接一条降噪链。
 * @returns {{ node: AudioNode, denoise: object|null }} 末尾那个节点（没开降噪就是入参本身）
 */
export function buildDenoiseChain(ctx, sourceNode, opts) {
  const d = resolveDenoise(opts);
  if (!d) return { node: sourceNode, denoise: null };
  let node = sourceNode;
  if (d.highpass > 0) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = d.highpass;
    hp.Q.value = 0.707;                 // 巴特沃斯，不做共振峰
    node.connect(hp); node = hp;
  }
  if (d.lowpass > 0) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = d.lowpass;
    lp.Q.value = 0.707;
    node.connect(lp); node = lp;
  }
  if (d.gate > 0) {
    // 门限 0..1 → 膝点（按幅度）。0.3 大约盖住 -30dBFS 的底噪，1.0 到 -18dBFS。
    // 映射给得比较陡，因为典型底噪就在 -40~-30dBFS 这一档，
    // 太保守的话用户会觉得"开了降噪跟没开一样"（实测过：膝点 0.016 只能把底噪压掉一半）。
    const knee = 0.003 + d.gate * 0.12;
    if (typeof ctx.createWaveShaper === 'function') {
      const ws = ctx.createWaveShaper();
      ws.curve = gateCurve(knee);
      // 不开 oversample：实测 '2x' 会额外引入电平偏移，而门限对阈值以上本该完全透明
      ws.oversample = 'none';
      node.connect(ws); node = ws;
    }
  }
  return { node, denoise: d };
}
