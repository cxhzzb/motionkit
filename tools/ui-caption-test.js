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

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
