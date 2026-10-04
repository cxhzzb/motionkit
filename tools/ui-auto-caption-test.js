// 自动字幕入口自检：用假的后端流验证“识别结果 → 字幕轨 → 字幕页按钮”。
//
//   node tools/shot.mjs --browser /opt/google/chrome/chrome \
//     --url "http://127.0.0.1:5178/studio/index.html" \
//     --js-file tools/ui-auto-caption-test.js --out .out/ui-auto-caption.png

const MK = window.MotionKit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await sleep(60);
  }
};
const report = { checks: {} };
await waitFor(() => MK.state.scene !== undefined, 20000);

const oldFetch = window.fetch;
const oldAlert = window.alert;
const alerts = [];
window.alert = (msg) => alerts.push(String(msg));
window.fetch = async (url, opt) => {
  if (String(url).includes('/api/captions/transcribe')) {
    const lines = [
      JSON.stringify({ type: 'log', progress: 0.4, msg: '本地转写中…' }),
      JSON.stringify({
        type: 'result',
        progress: 1,
        result: {
          provider: 'local',
          error: null,
          segments: [
            { start: 0.2, end: 1.3, text: '第一句自动字幕' },
            { start: 1.5, end: 2.8, text: '第二句自动字幕' },
          ],
        },
      }),
      '',
    ].join('\n');
    return new Response(lines, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  }
  return oldFetch(url, opt);
};

MK.state.media.videoFile = new File(['video'], 'auto-caption.mp4', { type: 'video/mp4' });
report.checks.topButton = !!document.getElementById('btnAutoCaption');
document.getElementById('btnAutoCaption').click();
await waitFor(() => MK.state.scene.captions.length === 2);

MK.rightTab('subs');
await sleep(120);
report.captions = MK.state.scene.captions.map((c) => ({ start: c.start, end: c.end, text: c.text }));
report.checks.captions = report.captions.length === 2
  && report.captions[0].text === '第一句自动字幕'
  && Math.abs(report.captions[1].start - 1.5) < 0.001;
report.checks.subtitleLayer = MK.state.scene.layers.some((L) => L.template === 'subtitle-kinetic');
report.checks.doneAlert = alerts.some((s) => /自动字幕完成/.test(s));
report.checks.exportButton = [...document.querySelectorAll('#rightBody button')]
  .some((b) => b.textContent === '导出 SRT');

window.fetch = oldFetch;
window.alert = oldAlert;
report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] === true);
window.__mkReport = report;
