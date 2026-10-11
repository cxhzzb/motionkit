// ============================================================================
// 这一轮四条改动的自检
//
//   node tools/shot.mjs --url "studio/index.html" \
//     --js-file tools/ui-audio-beat-test.js --out .out/ui-audio-beat.png
//
// 钉四件事：
//   ① 载入**带音频的视频**要自动分析出卡点（以前只有「载入音频」那条路会分析）
//   ② 卡点吸附要真的吸到拍点上（以前拖片段压根不看卡点）
//   ③ 卡点特效有 8 / 16 / 32 拍（小节级的频率）
//   ④ 音量能超过 1（放大）
// ============================================================================

const MK = window.MotionKit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = {};
const notes = [];
const ok = (name, cond, extra) => {
  checks[name] = !!cond;
  notes.push((cond ? 'ok   ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return !!cond;
};

const SR = 44100;

/**
 * 造一个能测 BPM 的 WAV。
 * 用"每拍一记衰减噪声脉冲 + 一小段低频"的音乐化信号 —— 纯正弦的起音太软，
 * 节拍检测器找不到 onset。BPM 写在脉冲间隔里。
 */
function makeWavBuffer({ secs = 8, bpm = 120, sr = SR } = {}) {
  const n = Math.round(secs * sr);
  const data = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
  const beatDur = 60 / bpm;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // 每拍开头的一记"鼓"：衰减的低频 + 一点噪声
    const inBeat = t % beatDur;
    const env = Math.exp(-inBeat * 26);
    data[i] = env * (0.6 * Math.sin(2 * Math.PI * 70 * t) + 0.25 * rnd())
      + 0.05 * Math.sin(2 * Math.PI * 220 * t);
  }
  // 编码成 16-bit 单声道 WAV
  const bytes = 44 + n * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const wr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); v.setUint32(4, bytes - 8, true); wr(8, 'WAVE');
  wr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, data[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new File([ab], 'probe-120bpm.wav', { type: 'audio/wav' });
}

const result = { checks, report: notes };

// ---------------------------------------------------------------- ① 带音频的素材会分析出卡点
{
  MK.setScene({
    name: 'beat', width: 1920, height: 1080, fps: 24, duration: 8, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 8, source: 'bpm' },
    layers: [], captions: [], fx: [],
  });
  const wav = makeWavBuffer({ secs: 8, bpm: 120 });

  // 走**载入音频**那条路，作为对照组（这条路以前就有）
  await MK.loadAudio(wav, { quiet: true });
  const audioBpm = MK.state.scene.beat.bpm;
  const audioBeats = MK.state.scene.beat.beats ? MK.state.scene.beat.beats.length : 0;
  ok('载入音频：分析出了拍点', audioBeats > 4, audioBeats);
  ok('载入音频：BPM 接近 120', Math.abs(audioBpm - 120) < 12, Math.round(audioBpm * 10) / 10);
  ok('载入音频：拍点来源标成 audio', MK.state.scene.beat.source === 'audio', MK.state.scene.beat.source);
  ok('载入音频：波形也算出来了（时间轴要画）', !!MK.state.media.peaks && MK.state.media.peaks.length > 0,
    MK.state.media.peaks ? MK.state.media.peaks.length : 0);
}

// ---------------------------------------------------------------- ①b 带音频的视频
{
  // 造一个**真的带音轨**的视频：canvas 出画面，Web Audio 出声音，MediaRecorder 合成 webm。
  // 这样测的才是"视频容器里的音轨能不能被 decodeAudioData 解开"这条真路径。
  const mkVideo = async (withAudio) => {
    const cv = document.createElement('canvas');
    cv.width = 160; cv.height = 90;
    const ctx2 = cv.getContext('2d');
    const stream = cv.captureStream(24);
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    if (withAudio) {
      const dst = ac.createMediaStreamDestination();
      // 每拍一记短音，做出一个有 card 点的节奏
      for (let b = 0; b < 16; b++) {
        const at = ac.currentTime + b * 0.5;
        const osc = ac.createOscillator();
        const g = ac.createGain();
        osc.frequency.value = 90;
        g.gain.setValueAtTime(0.9, at);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.18);
        osc.connect(g); g.connect(dst);
        osc.start(at); osc.stop(at + 0.2);
      }
      for (const tr of dst.stream.getAudioTracks()) stream.addTrack(tr);
    }
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    const t0 = performance.now();
    await new Promise((r) => {
      const tick = () => {
        ctx2.fillStyle = '#123'; ctx2.fillRect(0, 0, 160, 90);
        ctx2.fillStyle = '#0ff';
        ctx2.fillRect((performance.now() / 20) % 150, 40, 10, 10);
        if (performance.now() - t0 > 2600) r(); else requestAnimationFrame(tick);
      };
      tick();
    });
    rec.stop();
    await done;
    try { await ac.close(); } catch (_) {}
    for (const tr of stream.getTracks()) { try { tr.stop(); } catch (_) {} }
    return new File(parts, withAudio ? 'with-audio.webm' : 'no-audio.webm', { type: 'video/webm' });
  };

  const canRecord = typeof MediaRecorder !== 'undefined';
  if (!canRecord) {
    ok('（跳过）这个环境没有 MediaRecorder，测不了视频音轨', true);
  } else {
    const vfile = await mkVideo(true);
    MK.setScene({
      name: 'vbeat', width: 1920, height: 1080, fps: 24, duration: 8, transparent: true, bg: null,
      beat: { bpm: 120, offset: 0, duration: 8, source: 'bpm' },
      layers: [], captions: [], fx: [],
    });
    const before = MK.state.scene.beat.source;
    ok('视频载入前：卡点还是默认的手动 BPM', before === 'bpm', before);
    await MK.loadVideo(vfile, { quiet: true });
    const bm = MK.state.scene.beat;
    ok('带音频的视频载入后：卡点来源变成 audio（真的分析过了）', bm.source === 'audio', bm.source);
    ok('带音频的视频：拍点数量够用', !!(bm.beats && bm.beats.length > 4), bm.beats ? bm.beats.length : 0);
    ok('带音频的视频：BPM 是合理值', bm.bpm > 40 && bm.bpm < 220, Math.round(bm.bpm * 10) / 10);
    ok('带音频的视频：视频片段也加进来了', MK.state.scene.clips.length === 1, MK.state.scene.clips.length);

    // 没有音轨的视频不能报错，也不能把已有的卡点清掉
    const nfile = await mkVideo(false);
    MK.setScene({
      name: 'vnoaudio', width: 1920, height: 1080, fps: 24, duration: 8, transparent: true, bg: null,
      beat: { bpm: 133, offset: 0, duration: 8, source: 'bpm' },
      layers: [], captions: [], fx: [],
    });
    await MK.loadVideo(nfile, { quiet: true });
    ok('没音轨的视频：不报错，也不动原来的卡点',
      MK.state.scene.beat.source === 'bpm' && Math.round(MK.state.scene.beat.bpm) === 133,
      { source: MK.state.scene.beat.source, bpm: MK.state.scene.beat.bpm });
    ok('没音轨的视频：片段照样加进来', MK.state.scene.clips.length === 1, MK.state.scene.clips.length);

    // 已经有分析结果时不该重复分析
    MK.setScene({
      name: 'skip', width: 1920, height: 1080, fps: 24, duration: 8, transparent: true, bg: null,
      beat: { bpm: 99, offset: 0, duration: 8, source: 'audio', beats: [0, 0.5, 1, 1.5, 2, 2.5] },
      layers: [], captions: [], fx: [],
    });
    await MK.loadVideo(vfile, { quiet: true, skipIfBeats: true });
    ok('工程里已有分析好的拍点时不重复分析',
      Math.round(MK.state.scene.beat.bpm) === 99, MK.state.scene.beat.bpm);
  }
}

// ---------------------------------------------------------------- ② 卡点吸附
{
  MK.setScene({
    name: 'snap', width: 1920, height: 1080, fps: 24, duration: 10, transparent: true, bg: null,
    // 故意用不整齐的拍点：0.37 起、每 0.5 秒一拍
    beat: { bpm: 120, offset: 0.37, duration: 10, source: 'bpm', beats: null },
    layers: [], captions: [], fx: [],
  });
  const bm = MK.state.scene.beat;
  const beatAt = (i) => bm.at(i);
  document.getElementById('chkSnap').checked = true;

  // 拖到"离某个拍点 0.05 秒"的位置 —— 应该被吸到拍点上
  const target = beatAt(6);
  const near = target + 0.05;
  const snapped = MK.snapClip(near);
  ok('拖片段：靠近拍点会被吸上去', Math.abs(snapped - target) < 1e-6, [near, snapped, target]);
  ok('吸上去之后确实落在拍点集合里',
    bm.hitsIn(snapped - 1e-6, snapped + 1e-6, 4).length > 0 || Math.abs(snapped - target) < 1e-6,
    snapped);

  // 离得远就不该动。注意要跟**最近的**拍点比 —— 120BPM 下拍点每 0.5 秒一个，
  // 随便取个"远"的位置很可能正落在另一个拍点上，那就该吸（不是 bug）。
  const far = target + 1.75;   // 0.25 秒的偏移 = 正好在两个拍点正中间
  const nearBeat = bm.hitsIn(far - 0.3, far + 0.3, 4)
    .reduce((m, b) => (Math.abs(b - far) < Math.abs(m - far) ? b : m), far);
  const farSnapped = MK.snapClip(far);
  if (Math.abs(nearBeat - far) > 0.11) {
    ok('离所有拍点都远时不吸', Math.abs(farSnapped - far) < 1e-6, [far, farSnapped]);
  } else {
    ok('落在别的拍点附近就吸到那个拍点上', Math.abs(farSnapped - nearBeat) < 1e-6, [far, farSnapped, nearBeat]);
  }

  // 关掉吸附框：不该再吸
  document.getElementById('chkSnap').checked = false;
  ok('关掉「吸附卡点」之后不吸', Math.abs(MK.snapClip(near) - near) < 1e-6, MK.snapClip(near));
  document.getElementById('chkSnap').checked = true;

  // 片段边缘仍然要吸（这个以前就有，别被我改坏）
  const asset = { id: 'edge-a', kind: 'video', name: 'e', duration: 3, el: null };
  MK.state.assets.set('edge-a', asset);
  const c1 = MK.addFakeClip('video', 'edge-a', 3);
  const c2 = MK.addFakeClip('video', 'edge-a', 3);
  const first = MK.state.scene.clips[0];
  const second = MK.state.scene.clips[1];
  // 把第二段拖到"离第一段末尾 0.05 秒"的地方
  const edge = first.end + 0.05;
  const snappedEdge = MK.snapClip(edge, second.id);
  ok('片段边缘照样吸（没改坏老行为）', Math.abs(snappedEdge - first.end) < 1e-6, [edge, snappedEdge, first.end]);
  ok('吸附之后两段严丝合缝', Math.abs(snappedEdge - first.end) < 1e-6);
  void c1; void c2;
}

// ---------------------------------------------------------------- ③ 8 / 16 / 32 拍
{
  const opts = MK.beatFreqOptions();
  ok('频率档位包含 8 / 16 / 32 拍', [8, 16, 32].every((n) => opts.includes(n)), opts);

  // 真的按 16 拍铺一遍，看是不是"每 16 拍才一个"
  MK.setScene({
    name: 'freq', width: 1920, height: 1080, fps: 24, duration: 20, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 20, source: 'bpm', beats: null },
    layers: [], captions: [], fx: [],
  });
  const total = MK.state.scene.beat.hitsIn(0, 20, 1).length;
  const r = MK.beatFx.relay('flash-cut', 16);
  const laid = MK.state.scene.layers.length;
  ok('按 16 拍铺：层数约等于总拍数 / 16', Math.abs(laid - Math.ceil(total / 16)) <= 1, [total, laid]);
  ok('铺出来的层都带 beat 分组标记', MK.state.scene.layers.every((L) => L.group === 'beat'));
  void r;

  // 32 拍应该更少
  MK.setScene({
    name: 'freq32', width: 1920, height: 1080, fps: 24, duration: 20, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 20, source: 'bpm', beats: null },
    layers: [], captions: [], fx: [],
  });
  MK.beatFx.relay('flash-cut', 32);
  const laid32 = MK.state.scene.layers.length;
  ok('按 32 拍铺比 16 拍更少', laid32 < laid, [laid, laid32]);

  // 卡点大字的"重排"：retime 是**保留每层原有时长、只重新排位置**，
  // 所以这里铺 4 个短层，按 32 拍重排后应该只剩 1 个还在用、且落在 0 拍上。
  MK.setScene({
    name: 'freqType', width: 1920, height: 1080, fps: 24, duration: 20, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 20, source: 'bpm', beats: null },
    layers: [0, 1, 2, 3].map((i) => ({
      template: 'kinetic-type', start: i * 1.0, end: i * 1.0 + 0.8,
      params: {}, seed: 'kt' + i, name: 'kt' + i, opacity: 1, blend: 'source-over', enabled: true,
    })),
    captions: [], fx: [],
  });
  const beforeType = MK.state.scene.layers.filter((L) => L.template === 'kinetic-type');
  const dur0 = beforeType[0].end - beforeType[0].start;
  MK.beatFx.retime('kinetic-type', 32);
  const kt = MK.state.scene.layers.filter((L) => L.template === 'kinetic-type');
  const active = kt.filter((L) => L.enabled);
  const span = (60 / 120) * 32;      // 120BPM 下 32 拍 = 16 秒
  // 20 秒 / 120BPM = 41 个拍点（含 t=0），每 32 拍取一个 → 下标 0 和 32，即 0s 和 16s
  ok('卡点大字按 32 拍重排：落在 0 拍和 32 拍上',
    active.length === 2 && Math.abs(active[0].start) < 1e-9 && Math.abs(active[1].start - span) < 1e-6,
    kt.map((L) => [L.enabled, L.start, L.end]));
  ok('重排保留每层原有的时长（这是 retime 的语义）',
    active.length >= 1 && Math.abs((active[0].end - active[0].start) - dur0) < 1e-9,
    [dur0, active[0] ? active[0].end - active[0].start : null]);
  ok('32 拍 = 16 秒（120BPM）', Math.abs(span - 16) < 1e-9, span);
}

// ---------------------------------------------------------------- ④ 音量超过 1
{
  ok('音量上限大于 1', MK.volumeMax() > 1, MK.volumeMax());

  MK.setScene({
    name: 'vol', width: 1920, height: 1080, fps: 24, duration: 6, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 6, source: 'bpm' },
    layers: [], captions: [], fx: [],
  });
  MK.addFakeClip('video', 'asset-vol', 4);
  const c = MK.state.scene.clips[0];
  c.volume = 2.5;
  const out = MK.getScene();
  ok('音量 2.5 能存进工程', out.clips[0].volume === 2.5, out.clips[0].volume);
  ok('读回来还是 2.5', (() => { MK.setScene(out); return MK.state.scene.clips[0].volume === 2.5; })());

  // 导出混音时不能被夹到 1（这是"能不能真的放大"的关键）：
  // renderDenoise 跟导出同构 —— 降噪链 → gain(音量 × 补偿)
  const buf = new AudioBuffer({ length: 4800, sampleRate: 48000, numberOfChannels: 1 });
  const ch = buf.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = 0.2 * Math.sin(2 * Math.PI * 440 * i / 48000);
  const plain = await MK.renderDenoise(buf, {});
  const loud = await MK.renderDenoise(buf, { volume: 2.5 });
  const quieter = await MK.renderDenoise(buf, { volume: 0.4 });
  const a = MK.rmsOf(plain, 0.02, 0.08);
  const b = MK.rmsOf(loud, 0.02, 0.08);
  const q = MK.rmsOf(quieter, 0.02, 0.08);
  ok('音量 1 = 原样', Math.abs(a - 0.2 / Math.SQRT2) < 0.01, Math.round(a * 1000) / 1000);
  ok('音量 2.5 真的放大 2.5 倍（没被夹到 1）', Math.abs(b / a - 2.5) < 0.05,
    [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000, Math.round((b / a) * 100) / 100]);
  ok('音量 0.4 真的变小', Math.abs(q / a - 0.4) < 0.02, Math.round((q / a) * 100) / 100);

  // 放大之后超过了 0dBFS 也不该崩（引擎自己夹住）
  const hot = await MK.renderDenoise(buf, { volume: 8 });
  ok('音量拉到 8 也不崩（引擎自己夹波）', Number.isFinite(MK.rmsOf(hot, 0.02, 0.08)) && MK.rmsOf(hot, 0.02, 0.08) > b,
    Math.round(MK.rmsOf(hot, 0.02, 0.08) * 1000) / 1000);
}

result.checks.all = Object.values(checks).every(Boolean);
window.__mkReport = result;
return result;
