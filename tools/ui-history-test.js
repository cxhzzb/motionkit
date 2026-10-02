// 时间轴工具栏 + 撤销/重做的自检（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-history-test.js --out .out/ui-history.png
//
// 查什么：
//   ① 工具栏那几个图标按钮在不在、状态对不对（没得撤的时候撤销要是灰的）
//   ② 改一下 → 撤销 → 真的回到改之前（比对整个工程 JSON）
//   ③ 重做 → 又变回去；Ctrl+Z / Ctrl+Shift+Z 也要好使
//   ④ 剪刀 = 在播放头切开、复制 = 接一段、垃圾桶 = 删掉选中的片段

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
const sceneJson = () => JSON.stringify(MK.state.scene.toJSON());

const report = { checks: {} };
await waitFor(() => MK.state.scene.layers.length > 3, 20000);
await sleep(1000);            // 等预设载完、history 记好第一版再动手

// ---- ① 工具栏在不在
const tools = document.getElementById('tlTools');
const btns = tools ? [...tools.querySelectorAll('.tl-btn')] : [];
report.tools = { count: btns.length, titles: btns.map((b) => b.title) };
report.checks.toolbarExists = btns.length >= 5;
report.checks.toolbarIcons = btns.every((b) => b.querySelector('svg'));
const byTitle = (re) => btns.find((b) => re.test(b.title));
report.checks.hasUndoRedoCutCopyDel = !!byTitle(/撤销/) && !!byTitle(/重做/)
  && !!byTitle(/切开/) && !!byTitle(/复制/) && !!byTitle(/删掉/);
report.checks.undoStartsDisabled = byTitle(/撤销/).disabled === true;

// ---- ② 改一下 → 撤销要能回去
// 先用"加一个图层"这种确定性改动（比拖拽好判定）
const before = sceneJson();
const histBefore = MK.historyInfo();
const n0 = MK.state.scene.layers.length;
MK.state.scene.add({ template: 'title-mark', start: 0.5, end: 3, name: '撤销测试', seed: 'undo-1', params: { title: 'UNDO' } });
MK.markIndexDirty ? MK.markIndexDirty() : null;
MK.renderAt(MK.state.t);
await sleep(900);                      // 等 historyTick 记一笔
report.checks.historyRecorded = MK.historyInfo().len >= 2;
report.hist = { before: histBefore, afterEdit: MK.historyInfo() };
report.checks.undoNowEnabled = byTitle(/撤销/).disabled === false;
const after = sceneJson();
report.checks.sceneChanged = after !== before;

byTitle(/撤销/).click();
await sleep(300);
report.checks.undoReverts = sceneJson() === before && MK.state.scene.layers.length === n0;

byTitle(/重做/).click();
await sleep(300);
report.checks.redoRestores = sceneJson() === after;

// ---- ③ 键盘：Ctrl+Z / Ctrl+Shift+Z
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
await sleep(300);
report.checks.ctrlZ = sceneJson() === before;
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
await sleep(300);
report.checks.ctrlShiftZ = sceneJson() === after;

// ---- ④ 剪刀 / 复制 / 垃圾桶
// 摆一段图，把播放头放到中间
const c = document.createElement('canvas');
c.width = 160; c.height = 90;
const g = c.getContext('2d');
g.fillStyle = '#0f8'; g.fillRect(0, 0, 160, 90);
const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
const clip = await MK.addImageFile(new File([blob], 'cut.png', { type: 'image/png' }));
clip.start = 0; clip.dur = 4;
MK.state.clipSel = clip.id;
MK.setTime(2);
await sleep(400);

byTitle(/切开/).click();
await sleep(300);
report.afterCut = MK.state.scene.clips.map((x) => ({ start: +x.start.toFixed(2), dur: +x.dur.toFixed(2), in: +x.in.toFixed(2) }));
report.checks.scissorsSplits = MK.state.scene.clips.length === 2
  && Math.abs(MK.state.scene.clips[1].in - 2) < 0.15;

byTitle(/复制/).click();
await sleep(300);
report.checks.copyAddsClip = MK.state.scene.clips.length === 3;

// Ctrl+D 也复制
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true }));
await sleep(300);
report.checks.ctrlD = MK.state.scene.clips.length === 4;

const nClips = MK.state.scene.clips.length;
byTitle(/删掉/).click();
await sleep(300);
report.checks.trashDeletes = MK.state.scene.clips.length === nClips - 1;

// 吸附开关：点一下变灰、再点回来
const magnet = byTitle(/吸附/);
const on0 = magnet.classList.contains('on');
magnet.click();
await sleep(120);
const on1 = magnet.classList.contains('on');
magnet.click();
await sleep(120);
report.toggle = { on0, on1, on2: magnet.classList.contains('on') };
report.checks.magnetToggles = on0 !== on1 && on1 !== magnet.classList.contains('on');

// 留一张图：时间轴上方那排图标
MK.state.clipSel = MK.state.scene.clips[0] ? MK.state.scene.clips[0].id : null;
MK.setTime(1.2);
await sleep(250);

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
