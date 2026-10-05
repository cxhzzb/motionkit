// 仪器面板预设自检：确认四款新模板能被 studio 正常载入并渲染，没有报错。
//
//   node tools/shot.mjs --url "studio/index.html?preset=instrument-demo.json" \
//     --js-file tools/ui-instrument-test.js --out .out/ui-instrument.png

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MK = window.MotionKit;
const report = { checks: {} };

for (let i = 0; i < 50 && !(MK.state.scene.layers || []).length; i++) await sleep(100);

const ids = MK.state.scene.layers.map((L) => L.template);
report.templates = ids;
report.checks.loaded = ids.length === 4;
report.checks.hasRadar = ids.includes('radar-sweep');
report.checks.hasWaveform = ids.includes('waveform-panel');
report.checks.hasFilm = ids.includes('film-strip');
report.checks.hasGhost = ids.includes('ghost-mark');

// 逐个渲染：模板 draw() 抛错时引擎只 console.error 不中断，这里改成"确实画出了东西"
const painted = {};
for (const id of ['radar-sweep', 'waveform-panel', 'film-strip', 'ghost-mark']) {
  const scene = {
    name: 'probe', width: 640, height: 360, fps: 24, duration: 3,
    transparent: true, bg: null,
    beat: { bpm: 120, offset: 0 },
    layers: [{ template: id, start: 0, end: 3, params: {}, seed: 'probe-' + id, name: id }],
    captions: [], fx: [],
  };
  MK.setScene(scene);
  MK.setTime(1.5);
  const canvas = MK.renderAt(1.5);
  const ctx = canvas.getContext('2d');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
  painted[id] = n;
}
report.paintedPixels = painted;
// 每个模板在半数像素里至少要有 200 个非透明像素，才算"真的画出来了"
report.checks.allPaint = Object.values(painted).every((n) => n > 200);
report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
window.__mkReport = report;
