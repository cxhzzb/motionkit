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

// 摆一个短工程：6 帧，够验证封装就行
const S = MK.state.scene;
S.layers.length = 0;
S.duration = 0.6;
S.fps = 10;
S.add({
  template: 'kinetic-type', start: 0, end: 0.6, seed: 'ex-1', name: '导出测试',
  params: { text: 'MP4 TEST', mode: 'slam', size: 120, position: '0.5,0.5' },
});
MK.setTime(0);
await sleep(200);

const head = async (blob, n = 12) => {
  const buf = new Uint8Array(await blob.slice(0, n).arrayBuffer());
  return {
    bytes: [...buf],
    ascii: [...buf].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join(''),
  };
};

// ---- MP4：真录一段
const t0 = Date.now();
const r = await MK.renderVideoBlob('mp4', false);
const tag = await head(r.blob);
report.mp4 = { mime: r.mime, ext: r.ext, size: r.blob.size, head: tag.ascii, ms: Date.now() - t0 };
report.checks.mp4Blob = r.blob.size > 1000;
report.checks.mp4Container = tag.ascii.slice(4, 8) === 'ftyp';

// 再用 <video> 真读一遍：能读出宽高才算"能播"，不然只是个后缀对的壳
const url = URL.createObjectURL(r.blob);
const v = document.createElement('video');
v.muted = true;
v.src = url;
const meta = await new Promise((res) => {
  v.onloadedmetadata = () => res({ w: v.videoWidth, h: v.videoHeight, dur: v.duration });
  v.onerror = () => res(null);
  setTimeout(() => res(null), 5000);
});
report.playback = meta;
report.checks.mp4Playable = !!meta && meta.w === S.width && meta.h === S.height;

// 录进去的得是画面本身，不是一片黑：抽一帧画到小画布上数亮点
try { v.currentTime = 0.2; } catch (_) {}
await new Promise((res) => { v.onseeked = res; setTimeout(res, 2500); });
const probe = document.createElement('canvas');
probe.width = 64; probe.height = 36;
const pc = probe.getContext('2d');
pc.drawImage(v, 0, 0, 64, 36);
const px = pc.getImageData(0, 0, 64, 36).data;
let maxLum = 0, bright = 0;
const hist = [0, 0, 0, 0, 0];       // <16 / <64 / <128 / <200 / 亮
for (let i = 0; i < px.length; i += 4) {
  const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
  if (l > maxLum) maxLum = l;
  if (l > 40) bright++;
  hist[l < 16 ? 0 : l < 64 ? 1 : l < 128 ? 2 : l < 200 ? 3 : 4]++;
}
report.frameSample = { maxLum, bright, of: px.length / 4, hist, corner: [px[0], px[1], px[2]] };
report.checks.mp4HasPicture = bright > 20;
// 透明区必须压成深色底（不然白字压在浅灰上，等于报废）
report.checks.mp4BlackBackdrop = px[0] < 60 && px[1] < 60 && px[2] < 60;
URL.revokeObjectURL(url);

// ---- WebM 那条老路也得还在
const w = await MK.renderVideoBlob('webm', false);
const wtag = await head(w.blob, 4);
report.webm = { mime: w.mime, size: w.blob.size, bytes: wtag.bytes };
// EBML 魔数 1A 45 DF A3
report.checks.webmStillWorks = w.blob.size > 1000
  && wtag.bytes[0] === 0x1a && wtag.bytes[1] === 0x45 && wtag.bytes[2] === 0xdf && wtag.bytes[3] === 0xa3;

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
