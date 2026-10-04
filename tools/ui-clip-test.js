// 「素材剪辑时间线」的自检（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-clip-test.js --out .out/ui-clip.png
//
// 覆盖：
//   载入素材 → 时间轴上出现片段 → 拖动挪位置 → 拉边裁剪 → 在播放头切开 →
//   删除 → 复制；以及最要紧的一条：**时间轴上放的红色/蓝色两段，导出 MP4 之后
//   对应时刻的颜色必须对得上**（否则说明片段只是画在时间轴上、没进渲染）。

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

// 干净场景：只留片段，别让模板盖住我们要看的颜色
S.layers.length = 0;
S.fx.length = 0;
S.captions.length = 0;
S.clips.length = 0;
S.width = 640; S.height = 360;
S.duration = 2; S.fps = 10;
await sleep(200);

/** 画一张纯色图，当素材用 */
async function imageFile(color, name) {
  const c = document.createElement('canvas');
  c.width = 320; c.height = 180;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 320, 180);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}

// ---- ① 载入两张图 = 两个片段
const clipA = await MK.addImageFile(await imageFile('#ff0000', 'red.png'));
const clipB = await MK.addImageFile(await imageFile('#0000ff', 'blue.png'));
await sleep(300);
report.clips = S.clips.map((c) => ({ kind: c.kind, start: +c.start.toFixed(2), dur: +c.dur.toFixed(2), name: c.name }));
report.checks.twoClips = S.clips.length === 2;
report.checks.clipKinds = S.clips.every((c) => c.kind === 'image');
report.checks.secondFollowsFirst = Math.abs(S.clips[1].start - S.clips[0].end) < 0.05;
report.checks.durationGrew = S.duration >= 2;   // 图片默认 3 秒一段，工程时长跟着涨

// ---- ② 时间轴上真的画出来了吗（片段有命中区才拖得动）
const rows = MK.clipRows();
report.rows = rows.map((r) => ({ band: r.band, x: Math.round(r.x), w: Math.round(r.w) }));
report.checks.timelineBlocks = rows.length === 2 && rows.every((r) => r.w > 4);
report.checks.bothOnVideoTrack = rows.every((r) => r.band === 'video');

// ---- ③ 拖动第二段：位置要跟着变
const tl = document.getElementById('timeline');
function ptr(type, target, pt, extra) {
  target.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true,
    pointerId: 11, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
  }, extra || {})));
}
/** 量一段现在在屏幕上的位置（每次现取，别用之前缓存的坐标） */
function rowScreen(clip) {
  const r = tl.getBoundingClientRect();
  const g = MK.clipRows().find((x) => x.id === clip.id);
  if (!g) return null;
  const pxPerSec = g.w / Math.max(0.01, clip.dur);
  return { left: r.left, top: r.top, g, pxPerSec, cx: r.left + g.x + g.w / 2, cy: r.top + g.y + g.h / 2 };
}

const m0 = rowScreen(clipB);
// 往左拖（右边可能已经出画布了），拖 0.4 秒那么多像素
const shiftPx = Math.min(0.4 * m0.pxPerSec, m0.cx - m0.left - 10);
const beforeMove = clipB.start;
ptr('pointerdown', tl, { x: m0.cx, y: m0.cy });
ptr('pointermove', tl, { x: m0.cx - shiftPx, y: m0.cy });
await sleep(60);
ptr('pointerup', tl, { x: m0.cx - shiftPx, y: m0.cy }, { buttons: 0 });
await sleep(200);
report.move = {
  before: +beforeMove.toFixed(2), after: +clipB.start.toFixed(2),
  dur: S.duration, tlW: tl.clientWidth, cx: Math.round(m0.cx - m0.left), shift: Math.round(shiftPx),
  g: { x: Math.round(m0.g.x), w: Math.round(m0.g.w) },
};
report.checks.dragMoves = Math.abs(clipB.start - beforeMove) > 0.1;
report.checks.clipSelectedOnClick = MK.state.clipSel === clipB.id;

// ---- ④ 拉右边缘裁剪：时长要变短
const m1 = rowScreen(clipB);
const rightEdge = { x: Math.min(m1.left + m1.g.x + m1.g.w - 2, m1.left + tl.clientWidth - 4), y: m1.cy };
const durBefore = clipB.dur;
ptr('pointerdown', tl, rightEdge);
ptr('pointermove', tl, { x: rightEdge.x - Math.min(60, m1.g.w * 0.3), y: rightEdge.y });
await sleep(60);
ptr('pointerup', tl, { x: rightEdge.x - Math.min(60, m1.g.w * 0.3), y: rightEdge.y }, { buttons: 0 });
await sleep(200);
report.trim = { before: +durBefore.toFixed(2), after: +clipB.dur.toFixed(2) };
report.checks.trimShortens = clipB.dur < durBefore - 0.1;

// ---- ⑤ 在播放头切开
S.clips.length = 0;
const longClip = await MK.addImageFile(await imageFile('#ff0000', 'long.png'));
longClip.start = 0;
longClip.dur = 2;
MK.state.clipSel = longClip.id;
MK.setTime(1.0);
await sleep(150);
document.querySelector('#rightTabs .rtab[data-tab="clip"]').click();
await sleep(200);
const splitBtn = [...document.querySelectorAll('#rightBody button')].find((b) => /在播放头切开/.test(b.textContent));
report.checks.clipPanel = !!splitBtn;
if (splitBtn) {
  splitBtn.click();
  await sleep(250);
  report.splitClips = S.clips.map((c) => ({ start: +c.start.toFixed(2), dur: +c.dur.toFixed(2), in: +c.in.toFixed(2) }));
  report.checks.splitOk = S.clips.length === 2
    && Math.abs(S.clips[0].dur - 1) < 0.12
    && Math.abs(S.clips[1].in - 1) < 0.12;       // 右半段的入点要接上
}

// ---- ⑥ 删除 / 复制
const delBtn = [...document.querySelectorAll('#rightBody button')].find((b) => b.textContent === '删掉');
const nBefore = S.clips.length;
if (delBtn) { delBtn.click(); await sleep(200); }
report.checks.deleteClip = S.clips.length === nBefore - 1;
const remainingClip = S.clips[0];
report.checks.assetKeptWhileStillUsed = !!remainingClip
  && MK.state.assets.has(remainingClip.assetId);
if (remainingClip) {
  MK.state.clipSel = remainingClip.id;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  await sleep(250);
}
report.checks.assetClearedAfterLastClip = !remainingClip
  || (!MK.state.assets.has(remainingClip.assetId) && !MK.state.media.video);

// ---- ⑦ 端到端：红 0~0.5s，蓝 0.5~1.0s，导出 MP4 后颜色要对得上
S.clips.length = 0;
const red = await MK.addImageFile(await imageFile('#ff0000', 'r.png'));
red.start = 0; red.dur = 0.5;
const blue = await MK.addImageFile(await imageFile('#0000ff', 'b.png'));
blue.start = 0.5; blue.dur = 0.5;
S.duration = 1; S.fps = 10;
MK.setTime(0);
await sleep(300);

const out = await MK.renderVideoBlob('mp4', true, { audio: false });
const url = URL.createObjectURL(out.blob);
const v = document.createElement('video');
v.muted = true; v.src = url;
await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 4000); });

/** 取某一时刻画面的主色（缩放采样取平均，避开压缩噪点） */
async function colorAt(t) {
  v.currentTime = t;
  await new Promise((r) => { v.onseeked = r; setTimeout(r, 2000); });
  const c = document.createElement('canvas');
  c.width = 32; c.height = 18;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0, 32, 18);
  const px = g.getImageData(0, 0, 32, 18).data;
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
  const n = px.length / 4;
  return [Math.round(r / n), Math.round(gg / n), Math.round(b / n)];
}
const cEarly = await colorAt(0.15);
const cLate = await colorAt(0.8);
URL.revokeObjectURL(url);
report.colors = { at015: cEarly, at080: cLate, dur: v.duration };
report.checks.exportRedFirst = cEarly[0] > 140 && cEarly[2] < 90;
report.checks.exportBlueSecond = cLate[2] > 140 && cLate[0] < 90;
report.checks.exportDuration = Math.abs(v.duration - 1) <= 0.12;

// 留一张有意思的图：时间轴上有片段
MK.state.clipSel = red.id;
MK.setTime(0.3);
await sleep(200);

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
