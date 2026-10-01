// 「一键铺满」自检：真的拖素材 → 打开 AI 助手 → 点按钮 → 等结果 → 核对铺满。
//
//   node tools/serve.mjs 5199
//   node tools/shot.mjs --url "http://127.0.0.1:5199/studio/index.html" \
//     --file video=.out/test/mixed.mp4 --js-file tools/ui-fill-test.js --out .out/fill.png

const MK = window.MotionKit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {} };
const logText = () => (document.getElementById('agentLog').textContent || '');

// 1. 拖视频进工作室
const F = window.__mkFiles.video;
const bin = atob(F.b64);
const arr = new Uint8Array(bin.length);
for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
const dt = new DataTransfer();
dt.items.add(new File([arr], F.name, { type: F.type }));
document.getElementById('stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
for (let i = 0; i < 40 && !MK.mediaInfo().videoDur; i++) await sleep(200);
report.video = MK.mediaInfo();
report.checks.videoLoaded = report.video.videoDur > 0;

// 2. 打开 AI 助手，点一键铺满
document.getElementById('btnAgent').click();
await sleep(700);
document.getElementById('agentFill').click();

let done = false;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const t = logText();
  if (/已经铺进工作室了/.test(t) || /出错：|请求失败/.test(t)) { done = true; break; }
}
report.log = logText().slice(-700);
report.checks.ran = done;

// 3. 核对：图层铺出来了、整条时间轴没有空隙
const S = MK.state.scene;
const segs = S.layers.map((l) => [l.start, l.end]).sort((a, b) => a[0] - b[0]);
let cur = 0;
const gaps = [];
for (const [s, e] of segs) { if (s > cur + 0.05) gaps.push([cur, s]); cur = Math.max(cur, e); }
if (cur < S.duration - 0.05) gaps.push([cur, S.duration]);
report.scene = { layers: S.layers.length, duration: S.duration, gaps, templates: [...new Set(S.layers.map((l) => l.template))] };
report.checks.layers = S.layers.length >= 5;
report.checks.noGaps = gaps.length === 0;
report.checks.durationKept = Math.abs(S.duration - report.video.videoDur) < 0.2;
report.checks.multiTemplate = report.scene.templates.length >= 3;
report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
window.__mkReport = report;
