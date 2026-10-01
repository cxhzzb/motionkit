// 字幕换装的自检（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-caption-test.js --out .out/ui-caption.png
//
// 查的是：面板在不在 → 点了按钮每句是不是都挂上了一个模板 →
// 同一个模板会不会连着出现 → 一轮用完之前有没有重复 → 换一批是不是真的换了 →
// 清掉之后干不干净 → 字幕特别多的时候会不会几个模板被反复用、另外几个从不露脸。

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
const byText = (re) => [...document.querySelectorAll('#rightBody button')].find((b) => re.test(b.textContent));
const mine = () => MK.state.scene.layers.filter((L) => L.group === 'caption-reskin');
// 图层名里的 "· 模板名" 才是"这一句用了哪个样子"——同一个模板可以有好几个样子
// （卡点字幕就有 字幕条/等宽/逐词高亮 三种），所以按名字比，不按 template 比。
const looks = () => mine().map((L) => String(L.name).split('·').pop().trim());

await waitFor(() => MK.state.scene.layers.length > 3, 20000);
const S = MK.state.scene;
report.captions = S.captions.length;

// 切到字幕页
document.querySelector('#rightTabs .rtab[data-tab="subs"]').click();
await sleep(200);

report.checks.panel = [...document.querySelectorAll('#rightBody h4')].some((h) => /字幕换装/.test(h.textContent));
report.checks.styles = document.querySelectorAll('#rightBody select').length >= 1;

// ---- ① 给每句换模板
let b = byText(/给每句字幕换模板/);
if (!b) throw new Error('没找到「给每句字幕换模板」按钮');
b.click();
await sleep(400);

const n = S.captions.length;
const first = looks();
report.counts = { captions: n, layers: first.length };
report.checks.oneLayerPerCaption = first.length === n;
report.checks.noAdjacentRepeat = first.every((t, i) => i === 0 || t !== first[i - 1]);

const per = new Map();
for (const t of first) per.set(t, (per.get(t) || 0) + 1);
report.spread = { distinct: per.size, max: Math.max(...per.values()), order: first.join(' → ') };
report.checks.spreadEven = Math.max(...per.values()) <= Math.ceil(n / per.size);

// 默认那条整段「卡点字幕」应该被撤掉，不然和换装层打架
report.checks.removedDefault = !S.layers.some((L) => L.template === 'subtitle-kinetic' && /卡点字幕/.test(L.name || ''));

// 每个换装层都要盖住它对应的那句字幕
const covered = mine().every((L, i) => L.start <= S.captions[i].start + 1e-6 && L.end >= S.captions[i].end - 1e-6);
report.checks.coversCaption = covered;

// ---- ①b 整组改：改一个等于改全部
document.querySelector('#rightTabs .rtab[data-tab="subs"]').click();
await sleep(150);
const grp = [...document.querySelectorAll('#rightBody .group')].find((g) => /整组改/.test(g.querySelector('h4').textContent));
report.checks.groupPanel = !!grp;
if (grp) {
  const numOf = (label) => {
    const f = [...grp.querySelectorAll('.field')].find((x) => x.querySelector('label').textContent.includes(label));
    return f ? f.querySelector('input[type=number]') : null;
  };
  const setNum = (label, v) => {
    const el = numOf(label);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const sizeOf = (L) => (L.template === 'word-grid' ? L.params.fontSize : (L.template === 'series-index' ? undefined : L.params.size));

  const s0 = mine().map(sizeOf);
  setNum('字号', 1.5);
  await sleep(150);
  const s1 = mine().map(sizeOf);
  report.group = { before: s0, after: s1 };
  report.checks.groupSize = s1.every((v, i) => s0[i] === undefined || Math.abs(v - s0[i] * 1.5) < 0.6);

  setNum('上下位置', 0.05);
  await sleep(150);
  report.checks.groupPlace = mine().every((L) => L.transform && Math.abs(L.transform.y - 0.05) < 1e-6);

  setNum('不透明度', 0.5);
  await sleep(150);
  report.checks.groupAlpha = mine().every((L) => Math.abs(L.opacity - 0.5) < 1e-6);

  setNum('尾巴', 0.6);
  await sleep(150);
  report.checks.groupTail = mine().every((L, i) => Math.abs(L.end - Math.min(S.duration, S.captions[i].end + 0.6)) < 0.01
    || L.template === 'subtitle-kinetic');

  [...grp.querySelectorAll('button')].find((b) => /重置整组/.test(b.textContent)).click();
  await sleep(200);
  const s2 = mine().map(sizeOf);
  report.checks.groupReset = s2.every((v, i) => s0[i] === undefined || Math.abs(v - s0[i]) < 0.001)
    && mine().every((L) => !L.transform && Math.abs(L.opacity - 1) < 1e-6);
}

// ---- ①c 单个字幕换模式：换了模板，台词不能丢
const rows = [...document.querySelectorAll('#rightBody .cap-row')];
report.checks.capRows = rows.length === n;
const cap0 = S.captions[0].text;
const sel0 = rows[0].querySelector('select');
// 挑一个"能装台词"的样子（字幕条那种读字幕轨的，参数里本来就没有文本）
const TEXTY = ['卡点大字', '标题定格', '词块宫格', '注释气泡', '跑马灯条', '终端面板', '编号卡片', '胶带标签', '压扁大字', '杂志标题', '摇滚大标题', '系列编号', '索引标注'];
const opt = [...sel0.options].find((o) => TEXTY.includes(o.textContent));
const wantLabel = opt.textContent;
sel0.value = opt.value;
sel0.dispatchEvent(new Event('change', { bubbles: true }));
await sleep(300);
const L0 = mine()[0];
report.singleSwitch = { cap0, layerName: L0.name, params: JSON.stringify(L0.params) };
report.checks.singleSwitchKeepsText = JSON.stringify(L0.params).includes(cap0);
report.checks.singleSwitchChanged = L0.name.includes(wantLabel);

// 图层页那个「模板」下拉也得把台词带过去（这是最容易丢字的地方）
const Lx = mine()[1];
const cap1 = S.captions[1].text;
document.getElementById('tabLayers').click();     // 左栏切到「图层索引」，点一行等于选中那层
await sleep(250);
const rowEl = document.querySelector(`.lrow[data-id="${Lx.id}"]`);
report.checks.layerRowFound = !!rowEl;
if (rowEl) {
  rowEl.click();
  await sleep(300);
  const tf = [...document.querySelectorAll('#rightBody .field')].find((f) => f.querySelector('label').textContent === '模板');
  const tsel = tf && tf.querySelector('select');
  report.checks.layerPanelShown = !!tsel;
  if (tsel) {
    tsel.value = 'title-mark';
    tsel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    report.panelSwitch = { template: Lx.template, params: JSON.stringify(Lx.params) };
    report.checks.panelSwitchKeepsText = Lx.template === 'title-mark' && JSON.stringify(Lx.params).includes(cap1);
  }
}

// 回到字幕页继续后面的检查
document.querySelector('#rightTabs .rtab[data-tab="subs"]').click();
await sleep(150);

// ---- ② 换一批：重新洗牌之后顺序应该和上一批不一样
b = byText(/换一批/);
b.click();
await sleep(150);
byText(/给每句字幕换模板/).click();
await sleep(400);
const second = looks();
report.checks.reshuffled = second.join(',') !== first.join(',') && second.length === n;

// ---- ③ 清掉换装
byText(/清掉换装/).click();
await sleep(250);
report.checks.cleared = mine().length === 0 && S.layers.length > 0;

// ---- ④ 字幕很多的时候：一轮用完之前不许重复，也不要有的模板从没露脸
S.captions = Array.from({ length: 24 }, (_, i) => ({
  start: i * 1.1, end: i * 1.1 + 1.0, text: 'LONG FORM CAPTION ' + (i + 1), words: null, speaker: null, style: {},
}));
document.querySelector('#rightTabs .rtab[data-tab="subs"]').click();
await sleep(200);
byText(/给每句字幕换模板/).click();
await sleep(400);
const big = looks();
const seen = new Set(big);
const rounds = big.length / seen.size;
report.long = { captions: 24, layers: big.length, distinct: seen.size };
report.checks.longNoAdjacentRepeat = big.every((t, i) => i === 0 || t !== big[i - 1]);
report.checks.longNoEarlyRepeat = rounds > 0 && (() => {
  // 每 poolSize 个一组，组内不许重复
  const size = seen.size;
  for (let i = 0; i < big.length; i += size) {
    const chunk = big.slice(i, i + size);
    if (new Set(chunk).size !== chunk.length) return false;
  }
  return true;
})();
// 轮转要平：用得最多的和用得最少的差不超过 1（不会几个反复用、几个从不露脸）
const bigCounts = [...seen].map((t) => big.filter((x) => x === t).length);
report.checks.longBalanced = Math.max(...bigCounts) - Math.min(...bigCounts) <= 1;

// 留一张画面上的样子：停在换装之后的某一帧
MK.setTime(Math.min(S.duration - 0.05, 2.2));
await sleep(200);
document.getElementById('rightBody').scrollTop = 1e6;   // 截图停在「整组改」那一栏
await sleep(150);

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
