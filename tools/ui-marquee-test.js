// 框选 + 批量删除的自检（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-marquee-test.js --out .out/ui-marquee.png
//
// 用四个小圆盘放在四角，然后真的用 PointerEvent 在预览上拉框：
//   拉左上 → 只选中左上那个；拉全屏 → 四个都选中；Delete → 一次删光；
//   Shift 点第二个 → 加选；时间轴上 Shift 拖 → 也是一次多选。

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
const S = MK.state.scene;

const ov = document.getElementById('editLayer');
const rectOf = () => ov.getBoundingClientRect();
const P = (nx, ny) => { const r = rectOf(); return { x: r.left + nx * r.width, y: r.top + ny * r.height }; };
function fire(type, target, pt, extra) {
  target.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true,
    pointerId: 9, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
  }, extra || {})));
}
/** 在预览上拉一个框：从 a 拉到 b（归一化画布坐标） */
async function dragMarquee(a, b, shift) {
  fire('pointerdown', ov, P(a.x, a.y), { shiftKey: !!shift });
  await sleep(60);
  fire('pointermove', window, P((a.x + b.x) / 2, (a.y + b.y) / 2), { shiftKey: !!shift });
  fire('pointermove', window, P(b.x, b.y), { shiftKey: !!shift });
  await sleep(60);
  fire('pointerup', window, P(b.x, b.y), { shiftKey: !!shift, buttons: 0 });
  await sleep(180);
}
const sel = () => MK.state.selected;
const ids = () => [...MK.state.selected];

// ---- 摆四个小圆盘在四角（包围盒小、位置可预测）
S.layers.length = 0;
S.duration = Math.max(S.duration, 10);
const spots = [['0.20,0.20', 'A'], ['0.80,0.20', 'B'], ['0.20,0.80', 'C'], ['0.80,0.80', 'D']];
spots.forEach(([pos, nm], i) => S.add({
  template: 'dial-gauge', start: 0, end: 10, seed: 'mq-' + i, name: '目标 ' + nm,
  params: { position: pos, radius: 60, label: nm, showValue: true, value: 0.5 },
}));
MK.setTime(1.0);
await sleep(300);
document.querySelector('#rightTabs .rtab[data-tab="scene"]').click();
await sleep(120);
report.layers = S.layers.length;

// ---- ① 拉一个左上角的小框：只该选中 A（左上那个）
await dragMarquee({ x: 0.02, y: 0.02 }, { x: 0.55, y: 0.55 });
report.caseA = { selected: sel().size, names: ids().map((id) => S.layers.find((L) => L.id === id).name) };
report.checks.pickOne = sel().size === 1 && report.caseA.names[0] === '目标 A';

// ---- ② 拉全屏：四个都选中
await dragMarquee({ x: 0.01, y: 0.01 }, { x: 0.99, y: 0.99 });
report.checks.marqueeAll = sel().size === 4;

// ---- ③ 主选那一层的参数面板要能打开（框选之后不是"没选中"的状态）
report.checks.primaryLayer = !!MK.state.selection && !!document.querySelector('#rightBody .group');

// ---- ④ 空白单击 = 取消选择（没拖动）
fire('pointerdown', ov, P(0.5, 0.95));
fire('pointerup', window, P(0.5, 0.95), { buttons: 0 });
await sleep(150);
report.checks.clickEmptyClears = sel().size === 0;

// ---- ⑤ Delete 一次删光
await dragMarquee({ x: 0.01, y: 0.01 }, { x: 0.99, y: 0.99 });
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
await sleep(250);
report.checks.deleteAll = S.layers.length === 0 && sel().size === 0;

// ---- ⑥ Shift 点选 = 加选，再 Delete
spots.forEach(([pos, nm], i) => S.add({
  template: 'dial-gauge', start: 0, end: 10, seed: 'mq2-' + i, name: '目标 ' + nm,
  params: { position: pos, radius: 60, label: nm, showValue: true, value: 0.5 },
}));
MK.setTime(1.0);
await sleep(250);
const hits = [P(0.2, 0.2), P(0.8, 0.2)];
fire('pointerdown', ov, hits[0]); fire('pointerup', window, hits[0], { buttons: 0 });
await sleep(150);
fire('pointerdown', ov, hits[1], { shiftKey: true });
fire('pointerup', window, hits[1], { shiftKey: true, buttons: 0 });
await sleep(200);
report.checks.shiftAdds = sel().size === 2;

// ---- ⑦ 时间轴上 Shift 拖 = 框选（空白处起手，不跟拖播放头打架）
const tl = document.getElementById('timeline');
// 界面字号放大之后行变高了，4 行可能装不下 —— 先把时间轴拉高，保证四行都在可见区里
tl.style.height = '420px';
MK.setTime(MK.state.t);
await sleep(150);
const tr = tl.getBoundingClientRect();
const tpt = (x, y) => ({ x: tr.left + x, y: tr.top + y });
const from = tpt(tr.width - 14, tr.height - 24);
const to = tpt(12, 96);
fire('pointerdown', tl, from, { shiftKey: true });
await sleep(60);
fire('pointermove', tl, tpt((from.x + to.x) / 2 - tr.left, (from.y + to.y) / 2 - tr.top), { shiftKey: true });
fire('pointermove', tl, to, { shiftKey: true });
await sleep(60);
fire('pointerup', tl, to, { shiftKey: true, buttons: 0 });
await sleep(250);
report.tl = { selected: sel().size, layers: S.layers.length };
report.checks.timelineMarquee = sel().size === S.layers.length && S.layers.length > 1;

// 留一张"已框选"的画面
document.getElementById('rightBody').scrollTop = 0;
await sleep(150);

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
