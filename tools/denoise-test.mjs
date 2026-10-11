// ============================================================================
// 音频降噪 引擎级自检（Node，不需要浏览器，也不需要真的播声音）
//
//   node tools/denoise-test.mjs
//
// 验的是"分析和参数解析对不对"；Web Audio 那条链路（高通/低通/门限真的改了声）
// 必须真跑 AudioContext，放在 tools/ui-denoise-test.js 里用无头浏览器验。
// ============================================================================

import { resolveDenoise, analyzeNoise, describeDenoise, DENOISE_RANGE } from '../engine/audio.js';
import { Clip } from '../engine/core.js';

let pass = 0, fail = 0;
const checks = {};
function ok(name, cond, extra) {
  checks[name] = !!cond;
  if (cond) { pass++; console.log(`  ok   ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra !== undefined ? '  ' + JSON.stringify(extra) : ''}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------- 造测试信号
const SR = 48000;
/** 一段正弦 + 可选底噪 */
function tone({ secs = 3, freq = 440, amp = 0.5, noise = 0, sr = SR } = {}) {
  const n = Math.round(secs * sr);
  const out = new Float32Array(n);
  // 固定种子的伪随机，保证每次跑结果一样（不然自检本身就不稳定）
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let i = 0; i < n; i++) {
    out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr) + noise * rnd();
  }
  return out;
}
/** 低频轰鸣（80Hz）+ 中频语音（800Hz） */
function rumbleMix({ secs = 3, low = 0.5, mid = 0.25, noise = 0, sr = SR } = {}) {
  const n = Math.round(secs * sr);
  const out = new Float32Array(n);
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let i = 0; i < n; i++) {
    out[i] = low * Math.sin((2 * Math.PI * 80 * i) / sr)
      + mid * Math.sin((2 * Math.PI * 800 * i) / sr)
      + noise * rnd();
  }
  return out;
}
/** 高频嘶声为主 */
function hissMix({ secs = 3, mid = 0.2, sr = SR } = {}) {
  const n = Math.round(secs * sr);
  const out = new Float32Array(n);
  let seed = 4242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  for (let i = 0; i < n; i++) {
    // 用"相邻差分"造一坨偏高频的噪声（白噪声差分后能量往高频走）
    const a = rnd(), b = rnd();
    out[i] = mid * Math.sin((2 * Math.PI * 900 * i) / sr) + 0.3 * (a - b);
  }
  return out;
}

console.log('\n== 1. resolveDenoise：参数解析与关闭判定 ==');
{
  ok('什么都没设 → null（整条链路跳过）', resolveDenoise({}) === null);
  ok('全是 0 → null', resolveDenoise({ denoise: 0, highpass: 0, lowpass: 0, gate: 0 }) === null);
  ok('只开补偿增益 1.0 → null', resolveDenoise({ audioGain: 1 }) === null);
  ok('denoise 传 undefined 也安全', resolveDenoise({ denoise: undefined, highpass: 0 }) === null);

  const a = resolveDenoise({ denoise: 1, highpass: 100, lowpass: 8000, gate: 0.1, gateRatio: 8, audioGain: 1.2 });
  ok('全开时三项都在', a && a.highpass === 100 && a.lowpass === 8000 && near(a.gate, 0.1) && a.ratio === 8);
  ok('补偿增益保留', near(a.gain, 1.2));

  // denoise 是"总强度"：介于 0~1 之间时按比例缩放三项
  const half = resolveDenoise({ denoise: 0.5, highpass: 200, lowpass: 8000, gate: 0.4, gateRatio: 6 });
  ok('总强度 0.5：高通按比例降', half.highpass === 100, half.highpass);
  ok('总强度 0.5：门限按比例降', near(half.gate, 0.2), half.gate);
  ok('总强度 0.5：低通往 20k 方向收', half.lowpass > 8000 && half.lowpass < 20000, half.lowpass);
  const full = resolveDenoise({ denoise: 1, highpass: 200, lowpass: 8000, gate: 0.4 });
  ok('总强度 1：原样不动', full.highpass === 200 && full.lowpass === 8000 && near(full.gate, 0.4));

  // 越界与脏值
  const clamped = resolveDenoise({ denoise: 5, highpass: 99999, lowpass: 99999, gate: -3, gateRatio: 999 });
  ok('超范围都被夹回', clamped.highpass <= DENOISE_RANGE.highpass.max && clamped.gate === 0 && clamped.ratio <= DENOISE_RANGE.ratio.max,
    [clamped.highpass, clamped.gate, clamped.ratio]);
  ok('NaN / 字符串被当默认值', (() => {
    const r = resolveDenoise({ denoise: 1, highpass: NaN, lowpass: 'abc', gate: null });
    return r === null || (Number.isFinite(r.highpass) && Number.isFinite(r.lowpass));
  })());
  // 低通不能低于高通，否则整段被砍没
  const crossed = resolveDenoise({ denoise: 1, highpass: 300, lowpass: 200 });
  ok('低通低于高通时自动拉开', crossed.lowpass > crossed.highpass * 2, [crossed.highpass, crossed.lowpass]);
}

console.log('\n== 2. analyzeNoise：量得准不准 ==');
{
  // 干净的正弦：没有底噪，SNR 应该很大
  const clean = analyzeNoise(tone({ amp: 0.6, noise: 0 }), SR);
  ok('干净信号能分析出结果', !!clean);
  ok('干净信号 SNR 很高', clean.snr > 40, Math.round(clean.snr));
  ok('干净信号不建议上门限', clean.recommendation.gate === 0, clean.recommendation.gate);
  ok('干净信号 440Hz 属中频，不建议高通', clean.recommendation.highpass === 0, clean.recommendation.highpass);

  // 正弦 + 明显底噪：SNR 应该降下来
  const noisy = analyzeNoise(tone({ amp: 0.5, noise: 0.05 }), SR);
  ok('带底噪的信号 SNR 明显更低', noisy.snr < clean.snr - 20, [Math.round(clean.snr), Math.round(noisy.snr)]);
  ok('带底噪的信号建议上门限', noisy.recommendation.gate > 0, noisy.recommendation.gate);
  ok('门限是有限值且在范围里', noisy.recommendation.gate > 0.02 && noisy.recommendation.gate <= 0.6, noisy.recommendation.gate);

  // 低频轰鸣为主：应该建议高通
  const rumble = analyzeNoise(rumbleMix({ low: 0.6, mid: 0.1 }), SR);
  ok('低频为主的信号建议高通', rumble.recommendation.highpass > 0, rumble.recommendation.highpass);
  ok('低频相对中频确实是高的', rumble.rumbleDb > -7, Math.round(rumble.rumbleDb * 10) / 10);

  // 中频为主：不该误判成低频
  const midOnly = analyzeNoise(tone({ freq: 800, amp: 0.5 }), SR);
  ok('纯中频不会建议高通', midOnly.recommendation.highpass === 0, midOnly.recommendation.highpass);
  ok('纯中频 rumbleDb 很低', midOnly.rumbleDb < -20, Math.round(midOnly.rumbleDb * 10) / 10);

  // 高频嘶声为主：应该建议低通
  const hiss = analyzeNoise(hissMix({ mid: 0.05 }), SR);
  ok('高频为主的信号建议低通', hiss.recommendation.lowpass > 0, hiss.recommendation.lowpass);
  ok('低通的建议频率是可用的', hiss.recommendation.lowpass >= 6000 && hiss.recommendation.lowpass <= 20000, hiss.recommendation.lowpass);
  ok('高频相对中频确实是高的', hiss.hissDb > 2, Math.round(hiss.hissDb * 10) / 10);

  // 边界
  ok('空数组返回 null', analyzeNoise(new Float32Array(0), SR) === null);
  ok('极短音频不炸', (() => { const r = analyzeNoise(new Float32Array(10), SR); return r === null || Number.isFinite(r.snr); })());
  ok('全静音不炸（不产生 NaN）', (() => {
    const r = analyzeNoise(new Float32Array(SR), SR);
    return r && Number.isFinite(r.snr) && Number.isFinite(r.lowShare) && Number.isFinite(r.recommendation.gate);
  })());
  ok('分析结果是纯数据（能 JSON 化）', (() => { JSON.stringify(clean); return true; })());

  // 建议值本身要能被 resolveDenoise 接受（不能给出一个"设了等于没设"的组合）
  const recs = [clean, noisy, rumble, hiss, midOnly].map((r) => r.recommendation);
  ok('所有建议值都能解析', recs.every((r) => resolveDenoise(r) !== null || (!r.highpass && !r.lowpass && !r.gate)));
  ok('建议值不会互相矛盾（低通 > 高通）', recs.every((r) => !r.highpass || !r.lowpass || r.lowpass > r.highpass * 2),
    recs.map((r) => [r.highpass, r.lowpass]));

  ok('describeDenoise 给出可读文案', (() => {
    const s = describeDenoise(noisy);
    return typeof s === 'string' && s.includes('信噪比') && s.split('\n').length >= 2;
  })());
  ok('describeDenoise 对 null 有兜底', describeDenoise(null).length > 0);
}

console.log('\n== 3. Clip：降噪字段能存能读 ==');
{
  const c = new Clip({ kind: 'audio', assetId: 'a1', dur: 3, denoise: 1, highpass: 90, lowpass: 12000, gate: 0.08, gateRatio: 8, audioGain: 1.15 });
  const j = c.toJSON();
  ok('降噪字段进了 JSON', j.denoise === 1 && j.highpass === 90 && j.lowpass === 12000 && near(j.gate, 0.08) && j.gateRatio === 8);
  const back = Clip.fromJSON(j);
  ok('读回来一样', back.denoise === 1 && back.highpass === 90 && back.lowpass === 12000 && near(back.gate, 0.08));
  ok('读回来能直接喂给 resolveDenoise', (() => {
    const d = resolveDenoise(back);
    return d && d.highpass === 90 && d.ratio === 8 && near(d.gain, 1.15, 1e-9);
  })());

  const dflt = new Clip({ kind: 'audio' });
  const dj = dflt.toJSON();
  ok('没开降噪就不落盘这堆字段',
    dj.denoise === undefined && dj.highpass === undefined && dj.lowpass === undefined
    && dj.gate === undefined && dj.gateRatio === undefined && dj.audioGain === undefined,
    Object.keys(dj));
  ok('默认值下 resolveDenoise 返回 null（导出不多跑一遍链路）', resolveDenoise(dflt) === null);
  ok('gateRatio 默认 1 不落盘', new Clip({ kind: 'audio', gateRatio: 1 }).toJSON().gateRatio === undefined);
}

console.log(`\n================ ${pass} 通过 / ${fail} 失败 ================`);
console.log('checks.all = ' + (fail === 0));
if (fail) process.exit(1);
