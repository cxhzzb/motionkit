// 「直接导出 MP4」的自检（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html" \
//        --js-file tools/ui-export-test.js --out .out/ui-export.png
//
// 不看截图看文件：真录一小段，然后把 Blob 的头几个字节读出来，
// 确认它确实是 MP4（第 4~8 字节是 'ftyp'）而不是"改了个后缀的 webm"。

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
await waitFor(() => MK.state.scene.layers.length > 0, 20000);

// 导出弹窗里得有这个按钮
document.getElementById('btnExport').click();
await sleep(200);
const tile = document.querySelector('#exportDlg button[data-ex="mp4"]');
report.checks.dialogTile = !!tile;
report.tileText = tile ? tile.querySelector('b').textContent : '';
document.getElementById('exportDlg').close();

// 浏览器支不支持（Chrome / Edge 应该有 H.264）
const sup = MK.videoSupport();
report.support = sup;
report.checks.browserMp4 = !!sup.mp4;
report.checks.browserAudio = typeof window.AudioEncoder !== 'undefined';

// 现造一段 1 秒的 WAV（440Hz 正弦）当"音乐"，不用往仓库里塞测试音频
function toneFile(seconds, rate) {
  const n = Math.round(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / rate) * 440 * Math.PI * 2) * 12000, true);
  return new File([buf], 'tone.wav', { type: 'audio/wav' });
}

const S = MK.state.scene;
function resetScene(dur, fps, layers) {
  S.layers.length = 0;
  S.fx.length = 0;            // 特效会往整帧撒噪点，底色判断会被它搅浑
  S.clips.length = 0;         // 这一段测的是"单个素材 + 叠加层"的老路径，别掺片段
  S.width = 1920; S.height = 1080;
  S.duration = dur; S.fps = fps;
  layers.forEach((spec, i) => S.add(Object.assign({ start: 0, end: dur, seed: 'ex-' + i, name: '导出测试' + i }, spec)));
  MK.setTime(0);
}

const head = async (blob, n = 12) => {
  const buf = new Uint8Array(await blob.slice(0, n).arrayBuffer());
  return {
    bytes: [...buf],
    ascii: [...buf].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''),
  };
};
/** 把 blob 交给 <video> 真解一遍，再抽一帧到小画布上数亮度 */
async function inspect(blob, dur) {
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true;
  v.src = url;
  const meta = await new Promise((res) => {
    v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, dur: v.duration });
    v.onerror = () => res(null);
    setTimeout(() => res(null), 5000);
  });
  let bright = 0, maxLum = 0, corner = [0, 0, 0];
  if (meta) {
    try { v.currentTime = Math.max(0.05, dur * 0.3); } catch (_) {}
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 2500); });
    const probe = document.createElement('canvas');
    probe.width = 320; probe.height = 180;
    const pc = probe.getContext('2d');
    pc.drawImage(v, 0, 0, 320, 180);
    const px = pc.getImageData(0, 0, 320, 180).data;
    corner = [px[0], px[1], px[2]];
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
      if (l > maxLum) maxLum = l;
      if (l > 40) bright++;
    }
  }
  URL.revokeObjectURL(url);
  return { meta, bright, maxLum, corner };
}

// ---- ① 老 bug 的回归测试：故意做一个"渲染明显比 1/fps 慢"的工程。
//         实时录制在这种工程上会把时长拖长（2:40 导成 6:00），帧精确的写法不会。
resetScene(1.5, 24, [
  { template: 'kinetic-type', end: 0.9, params: { text: 'MP4 TEST', mode: 'slam', size: 120, position: '0.5,0.5' } },
  { template: 'grid-field', params: { mode: 'break', cols: 18, rows: 11, blocks: 30 } },
  { template: 'ink-scatter', params: { mode: 'ink', count: 20, inkBlobs: 6, lines: 10 } },
]);
await sleep(200);
const t0 = Date.now();
const r = await MK.renderVideoBlob('mp4', false);
const tag = await head(r.blob);
const a = await inspect(r.blob, 1.5);
report.mp4 = {
  mime: r.mime, ext: r.ext, size: r.blob.size, head: tag.ascii, ms: Date.now() - t0,
  projectDur: S.duration, outDur: a.meta && a.meta.dur, size_: a.meta && a.meta.w + 'x' + a.meta.h,
};
report.checks.mp4Blob = r.blob.size > 1000;
report.checks.mp4Container = tag.ascii.slice(4, 8) === 'ftyp';
report.checks.mp4Playable = !!a.meta && a.meta.w === S.width && a.meta.h === S.height;
// ★ 导出多长 = 工程多长（老写法这里会是好几倍）
report.checks.mp4DurationExact = !!a.meta && Math.abs(a.meta.dur - S.duration) <= 0.1;
report.checks.mp4HasPicture = a.bright > 300;

// ---- ② 干净工程：透明区必须压成深色底（不然白字压在浅灰上等于报废）
resetScene(0.5, 10, [
  { template: 'kinetic-type', params: { text: 'ABC', mode: 'slam', size: 120, position: '0.5,0.5' } },
]);
await sleep(200);
const r2 = await MK.renderVideoBlob('mp4', false);
const b = await inspect(r2.blob, 0.5);
report.clean = { corner: b.corner, bright: b.bright, dur: b.meta && b.meta.dur, size: r2.blob.size };
report.checks.mp4BlackBackdrop = b.corner[0] < 60 && b.corner[1] < 60 && b.corner[2] < 60;
report.checks.cleanDurationExact = !!b.meta && Math.abs(b.meta.dur - 0.5) <= 0.08;

// ---- ③ 带声音：丢一段 1 秒正弦进去，导出的 MP4 里应该多一条 soun/mp4a 轨
await MK.loadAudioFile(toneFile(1.0, 48000));
await sleep(300);
report.checks.audioLoaded = !!MK.state.media.audioFile && MK.state.media.audioDur > 0.5;

resetScene(0.5, 10, [
  { template: 'kinetic-type', params: { text: 'ABC', mode: 'slam', size: 120, position: '0.5,0.5' } },
]);
await sleep(200);
const r3 = await MK.renderVideoBlob('mp4', false, { audio: true });
const t3 = await head(r3.blob, 0);      // 只为了拿底层字节
const bytes3 = new Uint8Array(await r3.blob.arrayBuffer());
const latin = Array.from(bytes3, (x) => String.fromCharCode(x)).join('');
const c3 = await inspect(r3.blob, 0.5);
report.withAudio = {
  size: r3.blob.size, label: r3.label, audioFlag: !!r3.audio,
  traks: (latin.match(/trak/g) || []).length,
  soun: latin.includes('soun'), mp4a: latin.includes('mp4a'), esds: latin.includes('esds'),
  dur: c3.meta && c3.meta.dur,
};
report.checks.audioTrackMuxed = (latin.match(/trak/g) || []).length === 2
  && latin.includes('soun') && latin.includes('mp4a') && latin.includes('esds');
report.checks.audioDurationExact = !!c3.meta && Math.abs(c3.meta.dur - 0.5) <= 0.08;
void t3;

// 不勾"带声音"的时候还得是单轨
const r4 = await MK.renderVideoBlob('mp4', false, { audio: false });
const bytes4 = new Uint8Array(await r4.blob.arrayBuffer());
const latin4 = Array.from(bytes4, (x) => String.fromCharCode(x)).join('');
report.checks.audioOffStaysSingle = (latin4.match(/trak/g) || []).length === 1 && !latin4.includes('soun');

// ---- WebM 那条老路也得还在
resetScene(0.5, 10, [
  { template: 'kinetic-type', params: { text: 'ABC', mode: 'slam', size: 120, position: '0.5,0.5' } },
]);
await sleep(150);
const w = await MK.renderVideoBlob('webm', false);
const wtag = await head(w.blob, 4);
report.webm = { mime: w.mime, size: w.blob.size, bytes: wtag.bytes };
// EBML 魔数 1A 45 DF A3
report.checks.webmStillWorks = w.blob.size > 1000
  && wtag.bytes[0] === 0x1a && wtag.bytes[1] === 0x45 && wtag.bytes[2] === 0xdf && wtag.bytes[3] === 0xa3;

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
