// 变速 / 多视频轨叠加 / 每段调色 / 音频交叉淡化 的自检。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-adv-test.js --out .out/ui-adv.png

const MK = window.MotionKit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await sleep(80);
  }
};
const report = { checks: {} };
await waitFor(() => MK.state.scene !== undefined, 20000);
const S = MK.state.scene;
S.layers.length = 0;
S.fx.length = 0;
S.captions.length = 0;
S.clips.length = 0;
S.width = 640; S.height = 360;
S.duration = 6; S.fps = 10;
await sleep(200);

async function imageFile(color, name, w = 320, h = 180) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}
function toneFile(seconds, rate) {
  const n = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / rate) * 440 * Math.PI * 2) * 14000, true);
  return new File([buf], 't.wav', { type: 'audio/wav' });
}
/** 从引擎渲染出来的那一帧上取一个点（归一化坐标） */
function pixelAt(t, nx, ny) {
  const c = MK.renderAt(t);
  const ctx = c.getContext('2d');
  const x = Math.max(0, Math.min(c.width - 1, Math.round(nx * c.width)));
  const y = Math.max(0, Math.min(c.height - 1, Math.round(ny * c.height)));
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2]];
}
const near = (a, b, tol = 26) => Math.abs(a - b) <= tol;

// ---- ① 变速：时间轴 1 秒要吃掉素材 2 秒
const aud = await MK.loadAudioFile(toneFile(4, 48000));
void aud;
await sleep(400);
const aClip = MK.state.scene.clips.find((c) => c.kind === 'audio');
aClip.in = 0; aClip.speed = 2; aClip.dur = 1.5;
MK.setTime(1.0);
await sleep(400);
const st = MK.assetState(aClip.assetId);
report.speed = { want: aClip.sourceAt(1.0), got: st && +st.t.toFixed(2), rate: st && st.rate };
report.checks.speedSourceAt = Math.abs(aClip.sourceAt(1.0) - 2) < 0.001;
report.checks.speedSeeksFaster = !!st && Math.abs(st.t - 2) < 0.35;
report.checks.speedPlaybackRate = !!st && near(st.rate, 2, 0.01);

// ---- ② 多视频轨叠加 + 画中画
S.clips.length = 0;
const red = await MK.addImageFile(await imageFile('#ff0000', 'base.png'));
red.start = 0; red.dur = 2; red.track = 0;
const blue = await MK.addImageFile(await imageFile('#0000ff', 'pip.png'));
blue.start = 0; blue.dur = 2; blue.track = 1;
blue.scale = 0.3; blue.x = 0.3; blue.y = 0.3;    // 右下角一小块
MK.setTime(1);
await sleep(300);
const corner = pixelAt(1, 0.15, 0.15);           // 左上：只有底轨
const pip = pixelAt(1, 0.8, 0.8);                // 右下：盖着画中画
report.layers = { corner, pip };
report.checks.trackLayering = near(corner[0], 255) && near(corner[2], 0)
  && near(pip[2], 255) && near(pip[0], 0);

// 不透明度：画中画压到 50%，右下应该变成红蓝混
blue.opacity = 0.5;
await sleep(150);
const mixed = pixelAt(1, 0.8, 0.8);
report.mix = mixed;
report.checks.clipOpacity = mixed[0] > 90 && mixed[2] > 90;
blue.opacity = 1;

// ---- ③ 调色：红 → 反相 → 青
red.grade = { invert: 1 };
await sleep(150);
const inv = pixelAt(1, 0.15, 0.15);
report.grade = { invert: inv };
report.checks.gradeInvert = near(inv[0], 0) && inv[1] > 200 && inv[2] > 200;

red.grade = { grayscale: 1, brightness: 1.1 };
await sleep(150);
const bw = pixelAt(1, 0.15, 0.15);
report.grade2 = { bw };
// 红 → 灰度：三通道要相等（红色的灰度本身就是暗的，所以比的是"相等"而不是"够亮"）
report.checks.gradeGrayscale = Math.abs(bw[0] - bw[1]) < 8 && Math.abs(bw[1] - bw[2]) < 8 && bw[1] > 20;

// 预设按钮在界面上能点到（红那段现在选中）
MK.state.clipSel = red.id;
await sleep(150);
document.querySelector('#rightTabs .rtab[data-tab="clip"]').click();
await sleep(300);
const presetBtns = [...document.querySelectorAll('#rightBody button')].filter((b) => /^(原片|暖调|冷调|高对比|褪色|黑白|磁带|反相)$/.test(b.textContent.trim()));
report.presets = presetBtns.map((b) => b.textContent.trim());
report.checks.gradePresetsUi = presetBtns.length === 8;
presetBtns.find((b) => b.textContent.trim() === '原片').click();
await sleep(250);
report.checks.gradePresetClears = !red.grade && near(pixelAt(1, 0.15, 0.15)[0], 255);

// ---- ④ 音频交叉淡化：两段叠 0.6 秒
S.clips.length = 0;
const asset1 = await MK.loadAudioFile(toneFile(2, 48000));
await sleep(300);
const first = S.clips.find((c) => c.assetId === asset1.id);
first.start = 0; first.dur = 2; first.in = 0;
const asset2 = await MK.loadAudioFile(toneFile(2, 48000));
await sleep(300);
const b = S.clips.find((c) => c.assetId === asset2.id);
b.start = 1.4; b.dur = 2; b.in = 0;              // 和第一段重叠 0.6 秒
await sleep(300);
report.fade = { window: MK.fadeWindow(b.id) };
report.checks.autoCrossfade = report.fade.window.in > 0.5;
const gStart = MK.clipGain(b.id, 1.4);
const gEnd = MK.clipGain(b.id, 2.0);
report.gains = { atStart: +gStart.toFixed(3), atOverlapEnd: +gEnd.toFixed(3) };
report.checks.crossfadeRamps = gStart < 0.15 && gEnd > 0.85;
const gOut = MK.clipGain(first.id, 2.0);
report.gains.out = +gOut.toFixed(3);
report.checks.crossfadeOut = gOut < 0.15;

// 导出的 MP4 里音轨还在（混音这条路不能因为加了包络就断）
const out = await MK.renderVideoBlob('mp4', false, { audio: true });
const bytes = new Uint8Array(await out.blob.arrayBuffer());
const latin = Array.from(bytes, (x) => String.fromCharCode(x)).join('');
report.checks.exportStillHasAudio = latin.includes('soun') && latin.includes('mp4a') && out.blob.size > 5000;

// 留一张图：多轨叠加 + 画中画
S.clips.length = 0;
S.fx.length = 0;
const base = await MK.addImageFile(await imageFile('#1b6fb5', 'base.png'));
base.start = 0; base.dur = 4;
const pip2 = await MK.addImageFile(await imageFile('#b5442a', 'pip.png'));
pip2.start = 0; pip2.dur = 4; pip2.track = 1; pip2.scale = 0.34; pip2.x = 0.3; pip2.y = -0.28;
pip2.grade = { saturation: 1.1, contrast: 1.1 };
S.duration = 4;
MK.state.clipSel = pip2.id;
MK.setTime(1);
await sleep(300);

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
