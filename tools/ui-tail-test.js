// 「素材结束了、工程还在走」的回归自检。
//
//   node tools/shot.mjs --url "studio/index.html?preset=slopcore.json" \
//        --js-file tools/ui-tail-test.js --out .out/ui-tail.png
//
// 用户报的现象：视频 2:40 就完了，导出却是 6 分钟，那一截空的还删不掉。
// 这里守三件事：
//   ① 自动模式下剪短素材，工程时长要跟着缩（以前只长不缩）
//   ② 手动设过时长的工程不擅自改，但导出弹窗要明确提醒 + 一键收紧
//   ③ 「清掉素材之后的内容」真能把压在那一段的东西删掉

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

async function img(color, name) {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  const g = c.getContext('2d');
  g.fillStyle = color; g.fillRect(0, 0, 160, 90);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new File([blob], name, { type: 'image/png' });
}
async function exportDur() {
  const out = await MK.renderVideoBlob('mp4', true, { audio: false });
  const url = URL.createObjectURL(out.blob);
  const v = document.createElement('video');
  v.muted = true; v.src = url;
  await new Promise((r) => { v.onloadedmetadata = r; setTimeout(r, 4000); });
  const d = v.duration;
  URL.revokeObjectURL(url);
  return d;
}

// ---- ① 自动模式：剪短素材，时长要跟着缩
S.layers.length = 0; S.fx.length = 0; S.captions.length = 0; S.clips.length = 0;
S.width = 320; S.height = 180; S.fps = 10;
S.duration = 10;
MK.state.durationAuto = true;
const c1 = await MK.addImageFile(await img('#c33', 'v1.png'));
c1.start = 0; c1.dur = 4;
MK.syncClips();                    // 直接改对象之后让时长跟上（界面上拖拽本来就会同步）
await sleep(250);
report.auto = { dur: S.duration, clipsEnd: S.clipsEnd };
report.checks.autoShrinks = Math.abs(S.duration - 4) < 0.05;
report.checks.autoExportMatches = Math.abs(await exportDur() - 4) < 0.15;

// ---- ② 手动设过时长：不擅自改，但弹窗要提醒，并且能一键收紧
S.duration = 10;                       // 相当于用户以前手动设过 10 秒
MK.state.durationAuto = false;
S.add({ template: 'hud-frame', start: 0, end: 10, seed: 'tail1', name: '全片 HUD', params: {} });
S.add({ template: 'title-mark', start: 6, end: 10, seed: 'tail2', name: '片尾标题', params: { title: 'BYE' } });
MK.setTime(1);
await sleep(250);
report.manual = { dur: S.duration, clipsEnd: S.clipsEnd, tail: +(S.duration - S.clipsEnd).toFixed(2) };
report.checks.manualKeptDuration = Math.abs(S.duration - 10) < 0.01;
report.checks.manualExportLonger = Math.abs(await exportDur() - 10) < 0.2;

// 导出弹窗里的那条提醒
document.getElementById('btnExport').click();
await sleep(250);
const warn = document.getElementById('exportWarn');
report.warn = { shown: !!warn && getComputedStyle(warn).display !== 'none', text: warn ? warn.textContent.slice(0, 60) : '' };
report.checks.exportWarnsTail = report.warn.shown && /素材只到/.test(warn.textContent);
const fixBtn = document.getElementById('btnExportTrim');
report.checks.exportHasFix = !!fixBtn;
fixBtn.click();
await sleep(300);
document.getElementById('exportDlg').close();
report.afterFix = { dur: S.duration, auto: MK.state.durationAuto };
report.checks.fixTrims = Math.abs(S.duration - 4) < 0.05;
report.checks.fixExportMatches = Math.abs(await exportDur() - 4) < 0.15;

// ---- ③ 清掉素材之后的内容
S.layers.length = 0; S.captions.length = 0;
S.duration = 10;
MK.state.durationAuto = false;
S.add({ template: 'hud-frame', start: 0, end: 10, seed: 't1', name: '跨过末尾的 HUD', params: {} });
S.add({ template: 'title-mark', start: 6.5, end: 9.5, seed: 't2', name: '末尾标题', params: { title: 'X' } });
S.add({ template: 'dial-gauge', start: 7, end: 9, seed: 't3', name: '末尾仪表', params: {} });
S.captions.push({ start: 8, end: 9, text: '末尾字幕', words: null, speaker: null, style: {} });
await sleep(200);
report.beforeClear = { layers: S.layers.length, caps: S.captions.length };
// confirm 在无头里默认返回 true 是我们自己接管的，这里直接调用并检查结果
const had = window.confirm;
window.confirm = () => true;
const removed = MK.clearBeyond ? MK.clearBeyond() : null;
window.confirm = had;
if (removed === null) {
  // 没暴露的话走按钮（剪辑页没有，用工程页的按钮）
  const b = [...document.querySelectorAll('#rightBody button')].find((x) => /清掉素材之后的内容/.test(x.textContent));
  if (b) b.click();
  await sleep(300);
}
await sleep(200);
report.afterClear = { layers: S.layers.length, caps: S.captions.length, dur: S.duration };
report.checks.clearRemovesTail = S.layers.length < report.beforeClear.layers && S.captions.length === 0;
report.checks.clearTrimsToo = Math.abs(S.duration - 4) < 0.05;

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
return report;
