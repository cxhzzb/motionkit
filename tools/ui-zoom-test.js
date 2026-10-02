// 时间轴缩放/横向滚动 + 片段转场 的自检（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-zoom-test.js --out .out/ui-zoom.png

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
S.duration = 20; S.fps = 10;
await sleep(200);

const tl = document.getElementById('timeline');
const tlr = tl.getBoundingClientRect();
function ptr(type, target, pt, extra) {
  target.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true,
    pointerId: 21, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
  }, extra || {})));
}
const tlRect = () => tl.getBoundingClientRect();
const atX = (x, y) => ({ x: tlRect().left + x, y: tlRect().top + y });

// ---- ① 缩放
MK.tlZoomFit();
await sleep(150);
const v0 = MK.tlView();
report.zoom0 = { zoom: v0.zoom, span: +v0.span.toFixed(2) };
report.checks.fitShowsAll = v0.zoom === 1 && Math.abs(v0.span - S.duration) < 0.2;

const zoomIn = [...document.querySelectorAll('#tlTools .tl-btn')].find((b) => /放大时间轴/.test(b.title));
zoomIn.click(); await sleep(120);
zoomIn.click(); await sleep(120);
const v1 = MK.tlView();
report.zoom1 = { zoom: +v1.zoom.toFixed(3), span: +v1.span.toFixed(2) };
report.checks.zoomInWorks = v1.zoom > 1.4 && v1.span < S.duration * 0.8;

// 放大之后，同一个像素位置对应的时间变了（说明真的"放大"而不是只改了个数字）
const probeX = 200;
ptr('pointerdown', tl, atX(probeX, 60));
ptr('pointerup', tl, atX(probeX, 60), { buttons: 0 });
await sleep(150);
const tZoomed = MK.state.t;
MK.tlZoomFit();
await sleep(120);
ptr('pointerdown', tl, atX(probeX, 60));
ptr('pointerup', tl, atX(probeX, 60), { buttons: 0 });
await sleep(150);
const tFit = MK.state.t;
report.probe = { zoomed: +tZoomed.toFixed(2), fit: +tFit.toFixed(2) };
// 放大之后同一个像素位置对应的时间应该变了（放大是以画面中心为锚点的，所以大小都可能）
report.checks.zoomChangesMapping = Math.abs(tZoomed - tFit) > 0.5;

// ---- ② 横向滚动：放大后 Shift+滚轮应该能看到后面的时间
zoomIn.click(); await sleep(100);
zoomIn.click(); await sleep(100);
const before = MK.tlView();
const wheelAt = { clientX: tlRect().left + 300, clientY: tlRect().top + 60, deltaY: 120, shiftKey: true, bubbles: true, cancelable: true };
tl.dispatchEvent(new WheelEvent('wheel', wheelAt));
await sleep(150);
const after = MK.tlView();
report.scroll = { before: +before.start.toFixed(2), after: +after.start.toFixed(2), span: +after.span.toFixed(2) };
report.checks.shiftWheelScrolls = after.start > before.start + 0.05;

// 滚到头也不会越过工程末尾
MK.state.tlStart = 9999;
await sleep(120);
const clamped = MK.tlView();
report.checks.scrollClamped = clamped.start <= clamped.maxStart + 1e-6
  && clamped.start + clamped.span <= S.duration + 0.2;
MK.tlZoomFit();
await sleep(120);
report.checks.fitResets = MK.tlView().zoom === 1 && MK.tlView().start === 0;

// ---- ③ 转场：两段紧挨的图，接缝处应该有个小方块
async function imageFile(color, name) {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 160, 90);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}
const a = await MK.addImageFile(await imageFile('#c00', 'a.png'));
a.start = 0; a.dur = 2;
const b = await MK.addImageFile(await imageFile('#08c', 'b.png'));
b.start = 2; b.dur = 2;
sleep(0);
MK.setTime(1);
await sleep(300);
report.marks = MK.transMarks();
report.checks.markAtCut = MK.transMarks().length === 1;

// 点那个小方块 → 转场弹窗
const mark = MK.transMarks()[0];
ptr('pointerdown', tl, atX(mark.x + mark.w / 2, mark.y + mark.h / 2));
await sleep(250);
const dlg = document.getElementById('transDlg');
report.checks.dialogOpens = !!dlg && dlg.open === true;
const choices = [...document.querySelectorAll('#transGrid .ex')];
report.choices = choices.length;
report.checks.dialogListsTransitions = choices.length >= 8;

// 选"闪白硬切"（这个最好验证：转场那一瞬间画面会明显变亮）
const flash = choices.find((x) => /闪白/.test(x.textContent));
const beforeTrans = MK.renderAt(2.0).getContext('2d').getImageData(0, 0, 1, 1).data;
flash.click();
await sleep(400);
report.trans = {
  onClip: !!b.trans, template: b.trans && b.trans.template,
  layers: MK.transLayers(),
  dur: b.trans && b.trans.dur,
};
report.checks.transitionApplied = !!b.trans && MK.transLayers().length === 1;
const L0 = MK.transLayers()[0];
report.checks.transitionCentered = !!L0 && Math.abs((L0.start + L0.end) / 2 - 2) < 0.02;
report.checks.transitionFollowsClip = !!L0 && Math.abs(L0.end - L0.start - b.trans.dur) < 0.02;

// 转场那一帧应该比前后都亮（闪白）
function lumAt(t) {
  const c = MK.renderAt(t);
  const px = c.getContext('2d').getImageData(0, 0, Math.max(1, Math.round(c.width / 8)), Math.max(1, Math.round(c.height / 8))).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
  return sum / (px.length / 4);
}
const lumOutside = lumAt(1.2);
const lumCut = lumAt(2.0);
report.lum = { outside: Math.round(lumOutside), atCut: Math.round(lumCut) };
report.checks.transitionVisible = lumCut > lumOutside + 20;
void beforeTrans;

// 转场层跟着片段走：把 b 拖到右边，转场层中心也要跟着挪
b.start = 3;
MK.renderAt(2);            // 渲染一帧就会同步（界面上拖动也是走这条路）
await sleep(150);
report.afterMove = MK.transLayers();
report.checks.transitionFollowsMove = MK.transLayers().length === 1
  && Math.abs(MK.transLayers()[0].start - 2.75) < 0.05;
void a;

// ---- ④ 去掉转场
document.getElementById('btnTransDel').click();
await sleep(250);
report.checks.transitionRemoved = !b.trans && MK.transLayers().length === 0;

// 留一张"放大 + 有转场"的图
MK.setTime(2);
await sleep(200);
report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
