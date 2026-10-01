// 预览直接操控的自检脚本（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-selftest.js --out .out/ui-selftest.png
//
// 全部用真的 PointerEvent / MouseEvent 打在界面上，走完整交互链路：
//   点选 → 拖动位移 → 拉角缩放（对角钉死）→ 旋转 → 双击改文字
// 最后再核对一遍「引擎渲染出来的真实包围盒」和「界面算出来的选择框」是不是一回事
// （不然手势好使、导出的位置对不上就白搭）。
// 跑完画面停在「选着图层、开着改字浮窗」的状态，正好用来截图确认。

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
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const report = { checks: {} };

// ---------------------------------------------------------------- 准备
await waitFor(() => MK.state.scene.layers.length > 3, 20000);
const S = MK.state.scene;
const ORIG = JSON.parse(JSON.stringify(MK.getScene()));
report.scene = { w: S.width, h: S.height, layers: S.layers.length, dur: S.duration };

const T = 2.0;
MK.setTime(T);
await sleep(150);

const el = document.getElementById('editLayer');
const rect = el.getBoundingClientRect();
const P = (nx, ny) => ({ x: rect.left + nx * rect.width, y: rect.top + ny * rect.height });
function fire(type, target, pt, extra) {
  target.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true,
    pointerId: 7, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
  }, extra || {})));
}

// 挑一个「不是铺满整屏」、且离画面中心最远的图层来折腾
const cands = S.layers
  .filter((L) => L.covers(T))
  .map((L) => ({ L, b: MK.layerBox(L) }))
  .filter((o) => o.b && !(o.b.w > 0.92 && o.b.h > 0.92))
  .sort((a, b) => {
    const da = Math.abs(a.b.x + a.b.w / 2 - 0.5) + Math.abs(a.b.y + a.b.h / 2 - 0.5);
    const db = Math.abs(b.b.x + b.b.w / 2 - 0.5) + Math.abs(b.b.y + b.b.h / 2 - 0.5);
    return db - da;
  });
if (!cands.length) throw new Error('这一刻没有可操控的图层');
const L = cands[0].L;
const box0 = cands[0].b;
report.target = { template: L.template, box: box0 };
const c0 = { x: box0.x + box0.w / 2, y: box0.y + box0.h / 2 };

// ---------------------------------------------------------------- 1. 点选
fire('pointerdown', el, P(c0.x, c0.y));
fire('pointerup', el, P(c0.x, c0.y));
report.checks.pick = MK.selected() === L.id;

// ---------------------------------------------------------------- 1b. Alt+点 = 穿透到下层
const selBeforeAlt = MK.selected();
fire('pointerdown', el, P(c0.x, c0.y), { altKey: true });
fire('pointerup', el, P(c0.x, c0.y), { altKey: true });
const selAfterAlt = MK.selected();
report.altPenetrate = { before: selBeforeAlt, after: selAfterAlt, stack: MK.pickAt(c0.x, c0.y) };
report.checks.altPenetrate = selAfterAlt !== null && selAfterAlt !== selBeforeAlt;
MK.selectLayer(L.id);      // 还原选择，后面还要用 L

// ---------------------------------------------------------------- 1c. 右侧标签页
const TAB_NAMES = ['layer', 'scene', 'beat', 'subs', 'fx'];
const tabInfo = {};
for (const t of TAB_NAMES) {
  MK.rightTab(t);
  await sleep(40);
  const active = document.querySelector('#rightTabs .rtab.active');
  tabInfo[t] = {
    active: active ? active.dataset.tab : null,
    blocks: document.querySelectorAll('#rightBody .group, #rightBody .fx-item').length,
    title: document.getElementById('rightTitle').textContent,
  };
}
report.tabs = tabInfo;
report.checks.tabs = TAB_NAMES.every((t) => tabInfo[t].active === t && tabInfo[t].blocks > 0);
MK.selectLayer(L.id);
await sleep(40);
report.checks.tabsAutoLayer = MK.rightTab() === 'layer';   // 点图层应该自动跳回「图层」页

// ---------------------------------------------------------------- 2. 拖动位移
const dx = 0.06, dy = 0.03;
fire('pointerdown', el, P(c0.x, c0.y));
fire('pointermove', el, P(c0.x + dx, c0.y + dy));
fire('pointerup', el, P(c0.x + dx, c0.y + dy));
const tr1 = L.transform || { x: 0, y: 0, scale: 1, rot: 0 };
const snapX = Math.abs(c0.x + dx - 0.5) < 0.012;
const snapY = Math.abs(c0.y + dy - 0.5) < 0.012;
report.move = { got: { x: tr1.x, y: tr1.y }, want: { x: dx, y: dy }, snapX, snapY };
report.checks.move = (snapX ? near(tr1.x, 0.5 - c0.x, 1e-6) : near(tr1.x, dx, 1e-6))
  && (snapY ? near(tr1.y, 0.5 - c0.y, 1e-6) : near(tr1.y, dy, 1e-6));

// ---------------------------------------------------------------- 3. 拉角缩放
MK.setTransform(-1, null);
const before = MK.layerBox(L);
const pSE = { x: before.x + before.w, y: before.y + before.h };
const handle = document.querySelector('.el-h.el-se');
fire('pointerdown', handle, P(pSE.x, pSE.y));
fire('pointermove', el, P(pSE.x + 0.08, pSE.y + 0.06));
fire('pointerup', el, P(pSE.x + 0.08, pSE.y + 0.06));
const after = MK.layerBox(L);
report.scale = { scale: L.transform.scale, before, after };
report.checks.scale = L.transform.scale > 1.05
  && near(after.x, before.x, 0.004) && near(after.y, before.y, 0.004);   // 对角（左上）钉死

// ---------------------------------------------------------------- 4. 旋转 90°
MK.setTransform(-1, null);
const b2 = MK.layerBox(L);
const c2 = { x: b2.x + b2.w / 2, y: b2.y + b2.h / 2 };
fire('pointerdown', document.querySelector('.el-rot'), P(b2.x + b2.w + 0.05, c2.y));
fire('pointermove', el, P(c2.x, c2.y + b2.h / 2 + 0.05));
fire('pointerup', el, P(c2.x, c2.y + b2.h / 2 + 0.05));
report.rot = L.transform.rot;
report.checks.rot = near(L.transform.rot, 90, 1.5);
MK.setTransform(-1, null);

// ---------------------------------------------------------------- 5. 引擎渲染 == 界面几何
function alphaBBox(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
}
function renderOne(spec) {
  MK.setScene({
    width: S.width, height: S.height, fps: S.fps, duration: 4, bg: null, transparent: true,
    beat: { bpm: 120, offset: 0 }, captions: [], fx: [], layers: [spec],
  });
  MK.setTime(2);
  const cv = MK.off.canvas;
  return alphaBBox(MK.off.ctx, cv.width, cv.height);
}
// 放在正中间，缩放后才不会顶出画布被裁掉（裁了量出来的包围盒就不对了）
const lone = { template: 'stat-counter', start: 0, end: 4, seed: 'tf', name: 'tf', params: { position: '0.5,0.5' } };
const r0 = renderOne(lone);
const trMove = { x: 0.06, y: 0.03, scale: 1.35, rot: 0, px: 0.5, py: 0.5 };
const r1 = renderOne(Object.assign({}, lone, { transform: trMove }));
const want = {
  x: r0.x + trMove.x + (trMove.scale - 1) * (r0.x - trMove.px),
  y: r0.y + trMove.y + (trMove.scale - 1) * (r0.y - trMove.py),
  w: r0.w * trMove.scale, h: r0.h * trMove.scale,
};
const r2 = renderOne(Object.assign({}, lone, { transform: { x: 0, y: 0, scale: 1, rot: 180, px: 0.5, py: 0.5 } }));
const wantFlip = { x: 1 - (r0.x + r0.w), y: 1 - (r0.y + r0.h), w: r0.w, h: r0.h };
report.engine = { plain: r0, moved: r1, want, flipped: r2, wantFlip };
report.checks.engine = !!r0 && !!r1 && !!r2
  && near(r1.x, want.x, 0.003) && near(r1.y, want.y, 0.003)
  && near(r1.w, want.w, 0.005) && near(r1.h, want.h, 0.005)
  && near(r2.x, wantFlip.x, 0.003) && near(r2.y, wantFlip.y, 0.003);

// 把工程还原回去
MK.setScene(ORIG);
await sleep(100);
const S2 = MK.state.scene;

// ---------------------------------------------------------------- 6. 双击改文字
MK.setTime(0.9);
await sleep(120);
const textPick = S2.layers
  .filter((x) => x.covers(0.9) && MK.textParamsOf(x).length)
  .map((x) => ({ x, b: MK.layerBox(x) }))
  .filter((o) => o.b && !(o.b.w > 0.9 && o.b.h > 0.85))
  .sort((a, b) => b.b.w * b.b.h - a.b.w * a.b.h)[0];
report.textCandidates = S2.layers.filter((x) => MK.textParamsOf(x).length).map((x) => x.template);

if (textPick) {
  const at = P(textPick.b.x + textPick.b.w / 2, textPick.b.y + textPick.b.h / 2);
  fire('pointerdown', el, at); fire('pointerup', el, at);
  el.dispatchEvent(new MouseEvent('dblclick', { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true }));
  await sleep(120);

  const sel = S2.layers.find((x) => x.id === MK.selected()) || null;
  const ta = document.querySelector('.el-text-area');
  const open = !!(ta && !ta.closest('.el-text').classList.contains('hidden'));
  const keys = sel ? MK.textParamsOf(sel) : [];
  report.text = { aimedAt: textPick.x.template, selected: sel && sel.template, keys, editorOpen: open };
  if (open && keys.length) {
    const key = keys[0];
    report.text.key = key;
    report.text.before = sel.params[key];
    ta.value = 'DIRECT MANIPULATION';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    report.text.after = sel.params[key];
    report.checks.text = sel.params[key] === 'DIRECT MANIPULATION';
  } else {
    report.checks.text = false;
  }

  // ---------------------------------------------------------------- 7. 特效面板（「画面一直闪」就在这里关）
  MK.selectLayer(null);
  MK.rightTab('fx');                 // 特效现在是自己一个页签
  await sleep(60);
  const fxItems = Array.from(document.querySelectorAll('.fx-item'));
  const flashItem = fxItems.find((it) => /闪白|反相/.test((it.querySelector('b') || {}).textContent || ''));
  const flashSpec = (MK.state.scene.fx || []).find((f) => f.type === 'flash');
  report.fxPanel = { items: fxItems.length, foundFlash: !!flashItem, spec: flashSpec ? Object.assign({}, flashSpec) : null };
  if (flashItem && flashSpec) {
    const r = flashItem.querySelector('input[type=range]');
    const amountBefore = flashSpec.amount;
    r.value = '0.9';
    r.dispatchEvent(new Event('input', { bubbles: true }));
    report.fxPanel.amount = { before: amountBefore, after: flashSpec.amount };
    const click = (t) => {
      const b = Array.from(document.querySelectorAll('.group button')).find((x) => x.textContent === t);
      if (b) b.click();
      return !!b;
    };
    const hadOff = click('全部关掉');
    report.fxPanel.allOff = (MK.state.scene.fx || []).every((f) => f.enabled === false);
    click('全部打开');
    report.fxPanel.allOn = (MK.state.scene.fx || []).every((f) => f.enabled !== false);
    flashSpec.amount = amountBefore;            // 还原，别把演示状态搞花
    report.checks.fxPanel = hadOff && Math.abs(report.fxPanel.amount.after - 0.9) < 1e-9
      && report.fxPanel.allOff && report.fxPanel.allOn;
  } else {
    report.checks.fxPanel = false;
  }

  // ---------------------------------------------------------------- 8. 模板库：点一下不加，拖进画面才加
  const nBefore = S2.layers.length;
  const item = document.querySelector('#templateList .tpl[data-tid="stat-counter"]');
  report.tpl = { itemFound: !!item };
  if (item) {
    item.click();
    await sleep(80);
    report.tpl.clickAdded = S2.layers.length - nBefore;
    report.tpl.barOpen = !document.getElementById('tplBar').classList.contains('hidden');
    report.tpl.highlight = item.classList.contains('sel');

    // 真的走一遍拖放：dragstart → 在预览上 dragover → drop
    const dt = new DataTransfer();
    item.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const dr = document.getElementById('preview').getBoundingClientRect();
    const at = { x: dr.left + dr.width * 0.35, y: dr.top + dr.height * 0.62 };
    const st = document.getElementById('stage');
    st.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
    report.tpl.overFrame = st.classList.contains('tpl-over');
    st.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y }));
    item.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    await sleep(80);

    const born = S2.layers.filter((l) => l.template === 'stat-counter' && l.params && l.params.position).pop();
    const pos = born ? String(born.params.position).split(',').map(Number) : [];
    report.tpl.added = S2.layers.length - nBefore;
    report.tpl.position = born ? born.params.position : null;
    report.checks.tplClickNoAdd = report.tpl.clickAdded === 0;
    report.checks.tplBar = report.tpl.barOpen && report.tpl.highlight;
    report.checks.tplDropAdds = report.tpl.added === 1;
    report.checks.tplDropAt = pos.length >= 2 && Math.abs(pos[0] - 0.35) < 0.02 && Math.abs(pos[1] - 0.62) < 0.02;
    report.checks.tplBarClosed = document.getElementById('tplBar').classList.contains('hidden');
    // 这个测试图层删掉，别影响后面的演示状态
    if (born) MK.state.scene.layers = MK.state.scene.layers.filter((l) => l !== born);
  } else {
    report.checks.tplClickNoAdd = report.checks.tplDropAdds = report.checks.tplDropAt = false;
  }

  // ---------------------------------------------------------------- 10. 并轨（省地方）+ 搜索联动
  const rowsPacked = MK.tlRows();
  const chk = document.getElementById('chkPack');
  chk.click();
  await sleep(80);
  const rowsFlat = MK.tlRows();
  report.pack = { packed: rowsPacked.count, flat: rowsFlat.count, layers: rowsPacked.layers };
  report.checks.packOn = rowsPacked.packed === true && rowsPacked.count < rowsPacked.layers;
  report.checks.packSaves = rowsPacked.count <= Math.ceil(rowsPacked.layers * 0.8);
  report.checks.packToggle = rowsFlat.count === rowsFlat.layers && rowsFlat.packed === false;
  chk.click();                        // 切回并轨
  await sleep(60);

  const sbox = document.getElementById('searchLayer');
  sbox.value = '刻度';
  sbox.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(80);
  report.checks.findLink = MK.state.tlFind === '刻度';
  sbox.value = '';
  sbox.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(60);

  // ---------------------------------------------------------------- 11. 卡点重复动效：整组改
  MK.rightTab('beat');
  await sleep(80);
  const nEvery2 = MK.beatFx.relay('flash-cut', 2);   // 每 2 拍铺
  const nEvery1 = MK.beatFx.relay('flash-cut', 1);   // 改成每拍 → 应该更多
  MK.beatFx.apply('flash-cut', { peak: 0.8, dur: 0.5 });
  const fxList = MK.state.scene.layers.filter((L) => L.template === 'flash-cut');
  const peaks = [...new Set(fxList.map((L) => Number(L.params.peak)) )];
  const durs = [...new Set(fxList.map((L) => +(L.end - L.start).toFixed(2)) )];
  // 末尾那几个会被工程时长截断（0.5 变成 0.22），这也是对的
  const durOk = fxList.every((L) => Math.abs((L.end - L.start) - 0.5) < 0.02
    || Math.abs(L.end - MK.state.scene.duration) < 0.02);
  report.beatFx = { every2: nEvery2, every1: nEvery1, count: fxList.length, peaks, durs, grouped: fxList.every((L) => L.group === 'beat') };
  report.checks.beatFxRelay = nEvery1 > nEvery2 && nEvery2 > 0;
  report.checks.beatFxBulk = peaks.length === 1 && peaks[0] === 0.8 && durOk;
  report.checks.beatFxGrouped = fxList.every((L) => L.group === 'beat');

  // 面板上的三个按钮：全部关掉 / 全部打开 / 清空
  const offBtn = [...document.querySelectorAll('#rightBody .fx-item button')].find((b) => b.textContent === '全部关掉');
  const onBtn = [...document.querySelectorAll('#rightBody .fx-item button')].find((b) => b.textContent === '全部打开');
  if (offBtn) offBtn.click();
  await sleep(60);
  const allOff = MK.state.scene.layers.filter((L) => L.template === 'flash-cut').every((L) => !L.enabled);
  if (onBtn) onBtn.click();
  await sleep(60);
  const allOn = MK.state.scene.layers.filter((L) => L.template === 'flash-cut').every((L) => L.enabled);
  const cleared = MK.beatFx.clear('flash-cut');
  report.checks.beatFxButtons = !!offBtn && !!onBtn && allOff && allOn && cleared === fxList.length;
  report.checks.beatFxCleared = MK.beatFx.list('flash-cut') === 0;

  // 12. 顺手做的三件：渐入整组改 / 随机差异 / 文字类也能整组改
  MK.beatFx.relay('flash-cut', 2);
  MK.beatFx.apply('flash-cut', { peak: 0.5, dur: 0.3 });    // 先给一组确定值
  const baseFx = MK.beatFx.base('flash-cut');
  baseFx.fadeIn = 0.12;                                     // 渐入也归整组管
  MK.beatFx.apply('flash-cut', {});
  const fades = [...new Set(MK.state.scene.layers.filter((L) => L.template === 'flash-cut').map((L) => Number(L.params.fadeIn)))];
  report.fadeIn = fades;
  report.checks.fadeInBulk = fades.length === 1 && Math.abs(fades[0] - 0.12) < 0.001;

  // 随机差异：把 jitter 拉满重铺一遍，各层强度不该再是同一个数
  baseFx.jitter = 1;
  MK.beatFx.relay('flash-cut', 2);
  const peaksJit = MK.state.scene.layers.filter((L) => L.template === 'flash-cut').map((L) => Number(L.params.peak));
  report.jitter = { n: peaksJit.length, uniq: new Set(peaksJit.map((v) => v.toFixed(3))).size };
  report.checks.jitterVaries = peaksJit.length > 3 && report.jitter.uniq > 1;
  baseFx.jitter = 0;                                        // 恢复整齐，后面截图好看
  MK.beatFx.relay('flash-cut', 2);

  // 文字类：把已有的卡点大字重新按频率排一遍（内容保留）
  MK.beatFx.relay('flash-cut', 2);              // 恢复一点闪白，方便后面截图
  const bigTexts = MK.state.scene.layers.filter((L) => L.template === 'kinetic-type');
  const beforeStarts = bigTexts.map((L) => L.start);
  const moved = MK.beatFx.retime('kinetic-type', 8);
  const afterStarts = MK.state.scene.layers.filter((L) => L.template === 'kinetic-type').map((L) => L.start);
  report.retime = { count: bigTexts.length, moved, changed: beforeStarts.join() !== afterStarts.join() };
  report.checks.retimeText = bigTexts.length === 0 || (moved > 0 && report.retime.changed);
  report.checks.subtitleGroup = MK.beatFx.base('subtitle-kinetic') !== null;

  // ---------------------------------------------------------------- 14. 左右两栏可以拉宽
  const Lp = document.querySelector('.panel.left');
  const Rp = document.querySelector('.panel.right');
  const grab = (id, dx) => {
    const g = document.getElementById(id);
    const r = g.getBoundingClientRect();
    const ev = (t, x) => g.dispatchEvent(new PointerEvent(t, {
      clientX: x, clientY: r.top + 200, bubbles: true, cancelable: true,
      pointerId: 9, isPrimary: true, button: 0, buttons: 1,
    }));
    ev('pointerdown', r.left + 3);
    ev('pointermove', r.left + 3 + dx);
    ev('pointerup', r.left + 3 + dx);
  };
  const w0 = [Lp.getBoundingClientRect().width, Rp.getBoundingClientRect().width];
  grab('leftResize', 90);
  await sleep(150);
  const w1 = [Lp.getBoundingClientRect().width, Rp.getBoundingClientRect().width];
  grab('rightResize', -90);
  await sleep(150);
  const w2 = [Lp.getBoundingClientRect().width, Rp.getBoundingClientRect().width];
  report.panels = { before: w0.map(Math.round), afterLeft: w1.map(Math.round), afterRight: w2.map(Math.round) };
  report.checks.panelResize = w1[0] > w0[0] + 60 && w2[1] > w1[1] + 60;
  document.getElementById('leftResize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await sleep(150);
  report.panels.resetLeft = Math.round(Lp.getBoundingClientRect().width);
  report.checks.panelReset = Math.abs(Lp.getBoundingClientRect().width - 250) < 3;

  // ---------------------------------------------------------------- 15. 底色类参数有「透明」开关
  const tplL = MK.addTemplate('terminal-prompt', { x: 0.5, y: 0.5 });
  await sleep(250);
  MK.selectLayer(tplL.id);
  await sleep(250);
  const frow = [...document.querySelectorAll('#rightBody .field')].find((r) => {
    const lb = r.querySelector('label');
    return lb && /底|填充|纸|背景/.test(lb.textContent);
  });
  const fcb = frow && frow.querySelector('input[type=checkbox]');
  if (fcb) { fcb.checked = true; fcb.dispatchEvent(new Event('change', { bubbles: true })); }
  await sleep(200);
  const transFill = tplL.params.fill;
  const chipEl = frow && frow.querySelector('.swatch-tp');
  const chipOn = !!(chipEl && chipEl.style.display !== 'none');
  if (fcb) { fcb.checked = false; fcb.dispatchEvent(new Event('change', { bubbles: true })); }
  await sleep(200);
  report.transparent = { found: !!fcb, after: transFill, chipOn, restored: tplL.params.fill };
  report.checks.transparentOpt = !!fcb && transFill === '' && chipOn && !!tplL.params.fill;
  MK.state.scene.layers = MK.state.scene.layers.filter((l) => l !== tplL);   // 别影响后面的截图
  MK.selectLayer(null);

  // ---------------------------------------------------------------- 收尾：留个好看的演示状态
  // ---------------------------------------------------------------- 13. 模板库：缩略图 + 分类折叠
  await sleep(900);                         // 缩略图是分帧画的，等一下
  const tplItems = [...document.querySelectorAll('#templateList .tpl')];
  let withThumb = 0, drawn = 0;
  for (const el of tplItems) {
    const c = el.querySelector('canvas.tpl-thumb');
    if (!c) continue;
    withThumb++;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 14) > 6 || Math.abs(d[i + 1] - 16) > 6 || Math.abs(d[i + 2] - 19) > 6) n++;
    }
    if (n > c.width * c.height * 0.2) drawn++;
  }
  report.tplLib = { items: tplItems.length, withThumb, drawn };
  report.checks.tplThumbs = tplItems.length > 20 && withThumb === tplItems.length && drawn >= tplItems.length - 1;

  const foldBtn = document.getElementById('btnTplFold');
  foldBtn.click();
  await sleep(300);
  const collapsedN = document.querySelectorAll('#templateList .tpl').length;
  const catsN = document.querySelectorAll('#templateList .tpl-cat').length;
  foldBtn.click();
  await sleep(300);
  const expandedN = document.querySelectorAll('#templateList .tpl').length;
  report.tplFold = { collapsedN, catsN, expandedN };
  report.checks.tplFold = collapsedN === 0 && catsN > 3 && expandedN === tplItems.length;

  // ---------------------------------------------------------------- 收尾：留个好看的演示状态
  // ---------------------------------------------------------------- 9. 时间轴上下滚动
  const tlEl = document.getElementById('timeline');
  tlEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -4000, bubbles: true, cancelable: true }));
  await sleep(60);
  const s0 = MK.tlScroll();
  tlEl.dispatchEvent(new WheelEvent('wheel', { deltaY: 160, bubbles: true, cancelable: true }));
  await sleep(80);
  const s1 = MK.tlScroll();
  report.scroll = { max: s1.max, visible: s1.visible, before: s0.y, after: s1.y, layers: S2.layers.length };
  report.checks.tlScrollable = s1.max > 0;
  report.checks.tlWheel = s1.y > s0.y;

  // 选中"排在最下面那行"的图层 → 应该自动滚到可见区
  // （并轨之后栈序 ≠ 行序，得按真实行号挑，不能拿最后一层当最下面）
  let lastL = S2.layers[0], bestRow = -1;
  for (const L2 of S2.layers) {
    const r = MK.rowOf(L2.id);
    if (r > bestRow) { bestRow = r; lastL = L2; }
  }
  MK.selectLayer(lastL.id);
  await sleep(80);
  const s2 = MK.tlScroll();
  const rowTop = s2.top + bestRow * (s2.rowH + s2.gap) - s2.y;
  const areaTop = s2.top;
  report.scroll.auto = { y: s2.y, bestRow, rowTop, areaTop, visible: s2.visible };
  report.checks.tlAutoScroll = s2.y > 0 && rowTop >= areaTop - 1 && rowTop + s2.rowH <= areaTop + s2.visible + 1;

  // ---------------------------------------------------------------- 收尾：留个好看的演示状态
  if (sel) {
    MK.selectLayer(sel.id);
    MK.setTransform(-1, { x: 0.01, y: 0.015, scale: 1.18, rot: 0, px: 0.5, py: 0.5 });
    MK.openTextEditor(-1);
    // 存工程 / 导出走的是 scene.toJSON()，变换必须在里面（不然改完存下来就丢了）
    const saved = MK.getScene();
    report.checks.roundtrip = saved.layers.some((l) => l.transform && Math.abs(l.transform.scale - 1.18) < 1e-9);
    // 把测试过程中弹的那条提示收掉，截图干净些
    const tst = document.querySelector('.el-toast');
    if (tst) tst.classList.add('hidden');
  }
}

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
// 结果挂在全局上：shot.mjs 会把它读出来打印。
// （不写顶层 return，是为了这个文件本身也能过 node --check）
window.__mkReport = report;
