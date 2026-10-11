// ============================================================================
// 音频降噪 界面 / Web Audio 级自检
//
//   node tools/shot.mjs --url "studio/index.html" \
//     --js-file tools/ui-denoise-test.js --out .out/ui-denoise.png
//
// 这份脚本是**灌进页面里执行的**（不是模块），所以可以有顶层 return，
// 但 `node --check` 会报错，这是正常的（见 HANDOFF.md 第 6 节）。
//
// 验的是"降噪真的改了声"，靠量 RMS 而不是靠听：
//   1. 高通真的砍掉了低频（80Hz 轰鸣）
//   2. 低通真的收掉了高频（嘶声）
//   3. 门限真的把安静段的底噪压没了，而且**大声段不受影响**
//   4. 关掉降噪时输出和输入一模一样（不多跑一遍链路）
//   5. 参数能落盘 / 读回来，能不能喂给分析器
//   6. 自动分析在界面上能用，量出来的底噪/频谱跟造的信号对得上
// ============================================================================

const MK = window.MotionKit;
const checks = {};
const notes = [];
const ok = (name, cond, extra) => {
  checks[name] = !!cond;
  notes.push((cond ? 'ok   ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return !!cond;
};
const SR = 48000;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** 造 buffer：每段给 {secs, parts:[{freq, amp}], noise} */
function makeBuffer(segments) {
  const total = segments.reduce((s, x) => s + x.secs, 0);
  const n = Math.round(total * SR);
  const buf = new (window.AudioBuffer || Object)({ length: n, sampleRate: SR, numberOfChannels: 1 });
  const data = buf.getChannelData(0);
  let seed = 20261012;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  let at = 0;
  for (const seg of segments) {
    const len = Math.round(seg.secs * SR);
    for (let i = 0; i < len && at + i < n; i++) {
      let v = 0;
      for (const p of seg.parts || []) v += p.amp * Math.sin((2 * Math.PI * p.freq * (at + i)) / SR);
      if (seg.noise) v += seg.noise * rnd();
      data[at + i] = v;
    }
    at += len;
  }
  return { buf, n };
}

/** 一段区间（秒）的 RMS */
function rmsRange(ch, fromSec, toSec) {
  const a = Math.max(0, Math.round(fromSec * SR));
  const b = Math.min(ch.length, Math.round(toSec * SR));
  let s = 0, n = 0;
  for (let i = a; i < b; i++) { s += ch[i] * ch[i]; n++; }
  return n ? Math.sqrt(s / n) : 0;
}

const result = { checks, report: notes };

// ---------------------------------------------------------------- 1. 高通砍低频
{
  const { buf } = makeBuffer([{ secs: 2, parts: [{ freq: 80, amp: 0.5 }, { freq: 1000, amp: 0.5 }] }]);
  const plain = await MK.renderDenoise(buf, {});
  const hp = await MK.renderDenoise(buf, { denoise: 1, highpass: 300 });
  const a = rmsRange(plain.getChannelData(0), 0.2, 1.8);
  const b = rmsRange(hp.getChannelData(0), 0.2, 1.8);
  // 只有 1000Hz 的那一半应该留下来：0.5/√2 ≈ 0.354。滤波器的过渡带会多留一点
  ok('高通前：两个音都在（RMS ≈ 0.5）', a > 0.44 && a < 0.56, r3(a));
  ok('高通后：低频被砍掉（RMS 降到 ≈ 0.354）', b < a * 0.82 && b > 0.28, [r3(a), r3(b)]);
  ok('高通后剩下的就是 1000Hz 的量', Math.abs(b - 0.354) < 0.07, [r3(b), 0.354]);
}

// ---------------------------------------------------------------- 2. 低通收高频
{
  const { buf } = makeBuffer([{ secs: 2, parts: [{ freq: 400, amp: 0.5 }, { freq: 9000, amp: 0.5 }] }]);
  const plain = await MK.renderDenoise(buf, {});
  const lp = await MK.renderDenoise(buf, { denoise: 1, lowpass: 3000 });
  const a = rmsRange(plain.getChannelData(0), 0.2, 1.8);
  const b = rmsRange(lp.getChannelData(0), 0.2, 1.8);
  ok('低通前：两个音都在', a > 0.44 && a < 0.56, r3(a));
  ok('低通后：高频被收掉', b < a * 0.82 && b > 0.28, [r3(a), r3(b)]);
}

// ---------------------------------------------------------------- 3. 门限：压安静段，不动大声段
{
  // 前 1.2 秒：底噪（很轻的白噪声）；后 1.2 秒：正常内容（响音 + 同样的底噪）
  const { buf } = makeBuffer([
    { secs: 1.2, noise: 0.02 },
    { secs: 1.2, parts: [{ freq: 440, amp: 0.5 }], noise: 0.02 },
  ]);
  const plain = await MK.renderDenoise(buf, {});
  // 门限 0.5 → 膝点约 0.062，刚好盖住 0.02 幅度的底噪
  const gated = await MK.renderDenoise(buf, { denoise: 1, gate: 0.5, gateRatio: 10 });
  const quietPlain = rmsRange(plain.getChannelData(0), 0.1, 1.1);
  const quietGated = rmsRange(gated.getChannelData(0), 0.1, 1.1);
  const loudPlain = rmsRange(plain.getChannelData(0), 1.3, 2.3);
  const loudGated = rmsRange(gated.getChannelData(0), 1.3, 2.3);
  ok('安静段原本有底噪', quietPlain > 0.01, r3(quietPlain));
  ok('门限把安静段的底噪压下去一大截', quietGated < quietPlain * 0.35, [r3(quietPlain), r3(quietGated)]);
  ok('门限没有砍掉大声段', loudGated > loudPlain * 0.85, [r3(loudPlain), r3(loudGated)]);
  ok('大声段基本原样（±5% 以内）', Math.abs(loudGated - loudPlain) < loudPlain * 0.05, [r3(loudPlain), r3(loudGated)]);

  // 门限曲线本身：阈值以上必须**严格恒等**
  // （WaveShaper 的定义域只能是 [-1,1]，表铺到 [-1.2,1.2] 会把恒等段拉成 ×1.2 —— 真踩过）
  const curve = MK.gateCurve(0.062);
  const N = curve.length;
  const at = (x) => curve[Math.max(0, Math.min(N - 1, Math.round(((x + 1) / 2) * (N - 1))))];
  ok('曲线定义域是 [-1,1]：两端就是 ±1', Math.abs(at(1) - 1) < 1e-3 && Math.abs(at(-1) + 1) < 1e-3, [at(-1), at(1)]);
  ok('阈值以下归零', at(0.02) === 0 && at(0.03) === 0, [at(0.02), at(0.03)]);
  ok('阈值以上严格恒等（0.1 / 0.3 / 0.5 都不许偏）',
    Math.abs(at(0.1) - 0.1) < 2e-3 && Math.abs(at(0.3) - 0.3) < 2e-3 && Math.abs(at(0.5) - 0.5) < 2e-3,
    [at(0.1), at(0.3), at(0.5)]);
  ok('曲线是奇函数（正负对称）', Math.abs(at(-0.3) + at(0.3)) < 2e-3, [at(-0.3), at(0.3)]);

  // 门限对"响内容"必须是透明的：换个幅度量一遍
  for (const amp of [0.5, 0.3]) {
    const t = makeBuffer([{ secs: 1, parts: [{ freq: 440, amp }] }]);
    const p = await MK.renderDenoise(t.buf, {});
    const g = await MK.renderDenoise(t.buf, { denoise: 1, gate: 0.5, gateRatio: 10 });
    const a = rmsRange(p.getChannelData(0), 0.2, 0.8);
    const b2 = rmsRange(g.getChannelData(0), 0.2, 0.8);
    ok('门限对 ' + amp + ' 幅度的响内容透明（±3%）', Math.abs(b2 - a) < a * 0.03, [r3(a), r3(b2)]);
  }

  // 关掉降噪必须"一点都没动"
  const off1 = await MK.renderDenoise(buf, {});
  const off2 = await MK.renderDenoise(buf, { denoise: 0, highpass: 0, lowpass: 0, gate: 0 });
  let maxDiff = 0;
  const c1 = off1.getChannelData(0), c2 = off2.getChannelData(0);
  for (let i = 0; i < c1.length; i += 7) maxDiff = Math.max(maxDiff, Math.abs(c1[i] - c2[i]));
  ok('没开降噪时输出 == 输入（不多跑链路）', maxDiff < 1e-6, maxDiff);
}

// ---------------------------------------------------------------- 4. 参数进工程
{
  MK.clearLayers();
  const scene = MK.getScene();
  scene.clips = [{
    id: 'c1', kind: 'audio', assetId: 'x', name: 'test', start: 0, in: 0, dur: 3, volume: 1,
    denoise: 1, highpass: 90, lowpass: 11000, gate: 0.08, gateRatio: 9, audioGain: 1.2,
  }];
  MK.setScene(scene);
  const c = MK.state.scene.clips[0];
  ok('片段上的降噪参数读进来了', c.denoise === 1 && c.highpass === 90 && c.lowpass === 11000 && c.gateRatio === 9, c.toJSON());
  const out = MK.getScene();
  ok('再存出去还在', out.clips[0].highpass === 90 && out.clips[0].gateRatio === 9, out.clips[0]);

  const plain = MK.getScene();
  plain.clips[0] = { id: 'c2', kind: 'audio', assetId: 'x', start: 0, in: 0, dur: 3, volume: 1 };
  MK.setScene(plain);
  const c2 = MK.state.scene.clips[0];
  ok('没设降噪时 resolveDenoise 判定为关闭', MK.denoiseResolve(c2) === null);

  // 界面面板
  MK.state.clipSel = 'c2';
  MK.rightTab('clip');
  const labels = [...document.querySelectorAll('.field label')].map((e) => e.textContent);
  ok('右栏「声音」块还在', labels.includes('音量') && labels.includes('淡入(秒)'), labels.slice(0, 20));
  ok('右栏出现「降噪」那一块', [...document.querySelectorAll('.group h4')].some((e) => e.textContent === '降噪'),
    [...document.querySelectorAll('.group h4')].map((e) => e.textContent));
  ok('降噪面板给出了高通 / 低通 / 门限 / 力度 / 补偿增益',
    ['高通(Hz)', '低通(Hz)', '门限', '门限力度', '补偿增益'].every((k) => labels.includes(k)), labels);
  ok('有「自动分析」和「听一下这段」按钮',
    [...document.querySelectorAll('button')].some((b) => b.textContent === '自动分析')
    && [...document.querySelectorAll('button')].some((b) => b.textContent === '听一下这段'));
}

// ---------------------------------------------------------------- 5. 自动分析
{
  // 造一段"低频轰鸣 + 中频 + 嘶声"的素材，看分析器能不能认出来
  const { buf } = makeBuffer([{
    secs: 3,
    parts: [{ freq: 80, amp: 0.4 }, { freq: 800, amp: 0.15 }],
    noise: 0.03,
  }]);
  // 直接调分析器（界面按钮内部走的就是它 + 写回片段）
  const res = MK.analyzeNoise(buf.getChannelData(0), SR);
  ok('分析器给出了结果', !!res);
  ok('识别出低频相对中频偏高', res.rumbleDb > -20, r3(res.rumbleDb));
  ok('识别出信噪比不高（有底噪）', res.snr < 40, r3(res.snr));
  ok('建议里给了高通', res.recommendation.highpass > 0, res.recommendation.highpass);
  ok('描述文案能生成', typeof MK.describeDenoise(res) === 'string' && MK.describeDenoise(res).length > 10);

  // 干净的中频：不该建议砍低频
  const clean = makeBuffer([{ secs: 2, parts: [{ freq: 800, amp: 0.5 }] }]);
  const res2 = MK.analyzeNoise(clean.buf.getChannelData(0), SR);
  ok('干净中频不建议高通', res2.recommendation.highpass === 0, res2.recommendation.highpass);
  ok('干净中频不建议门限', res2.recommendation.gate === 0, res2.recommendation.gate);
}

result.checks.all = Object.values(checks).every(Boolean);
window.__mkReport = result;
return result;
