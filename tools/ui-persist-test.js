// 「刷新后工程还在吗」的自检脚本（在浏览器里跑，由 tools/shot.mjs 灌进来）。
//
//   node tools/shot.mjs --js-file tools/ui-persist-test.js --reload --out .out/persist.png
//   node tools/shot.mjs --url dist/studio.html --js-file tools/ui-persist-test.js --reload --out .out/persist2.png
//
// 同一个脚本跑两次：第一次（A）造一个一眼能认出来的工程、等自动保存落盘；
// 页面刷新之后再跑一次（B），核对图层 / 参数 / 变换 / 时长 / BPM / 字幕 / 特效 /
// 播放头 / 素材是不是都接回来了。两阶段之间用 sessionStorage 传一个标记。

// 1×1 的 PNG，用来当"上次拖进来的素材"
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MEDIA_NAME = 'mk-test.png';

const MK = window.MotionKit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('等待超时');
    await sleep(100);
  }
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const PHASE_KEY = 'mk-persist-phase';
const phase = sessionStorage.getItem(PHASE_KEY) || 'A';
const report = { phase, checks: {} };
const MARK = {
  name: 'persist-test', width: 1280, height: 720, fps: 30, duration: 7.5,
  bg: null, transparent: true, beat: { bpm: 137.5, offset: 0.25 },
  captions: [{ start: 0, end: 1.5, text: '刷新以后我还在' }],
  fx: [{ type: 'grain', amount: 0.33 }, { type: 'vignette', amount: 0.21 }],
  layers: [
    {
      template: 'kinetic-type', start: 0, end: 3, seed: 'persist-1', name: '记号层',
      params: { text: 'PERSIST OK' },
      transform: { x: 0.05, y: -0.02, scale: 1.4, rot: 12, px: 0.5, py: 0.5 },
    },
  ],
};

if (phase === 'A') {
  // ---------------- A：造工程，等自动保存 ----------------
  sessionStorage.setItem(PHASE_KEY, 'B');
  MK.setScene(MARK);
  MK.setTime(1.234);

  // 真的往画面上拖一张图（走的是和手工拖放一模一样的路径）
  const bin = atob(PNG_1X1);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], MEDIA_NAME, { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('stage').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await waitFor(() => MK.state.media.videoName === MEDIA_NAME, 4000);
  report.checks.dropped = MK.state.media.videoName === MEDIA_NAME;

  await sleep(2600);                       // 自动保存是 1.2 秒比对一次

  let raw = null;
  try { raw = localStorage.getItem('motionkit.autosave.v1'); } catch (_) {}
  report.checks.saved = !!raw;
  if (raw) {
    const d = JSON.parse(raw);
    report.saved = {
      layers: d.scene.layers.length,
      duration: d.scene.duration,
      bpm: d.scene.beat.bpm,
      t: d.t,
      hasTransform: !!d.scene.layers[0].transform,
      mediaName: d.media && d.media.video ? d.media.video.name : null,
      bytes: raw.length,
    };
  }
} else {
  // ---------------- B：刷新之后，核对是不是都回来了 ----------------
  sessionStorage.removeItem(PHASE_KEY);
  await waitFor(() => MK.state.scene.layers.length > 0, 5000);
  const S = MK.state.scene;
  const L = S.layers[0];

  report.checks.layer = S.layers.length === 1 && L.template === 'kinetic-type' && L.name === '记号层';
  report.checks.text = !!L && L.params.text === 'PERSIST OK';
  report.checks.transform = !!L.transform
    && near(L.transform.x, 0.05) && near(L.transform.y, -0.02)
    && near(L.transform.scale, 1.4) && near(L.transform.rot, 12);
  report.checks.size = near(S.width, 1280) && near(S.height, 720) && near(S.fps, 30) && near(S.duration, 7.5);
  report.checks.beat = near(S.beat.bpm, 137.5) && near(S.beat.offset, 0.25);
  report.checks.caption = S.captions.length === 1 && S.captions[0].text === '刷新以后我还在';
  report.checks.fx = (S.fx || []).length === 2
    && S.fx.some((f) => f.type === 'grain' && near(f.amount, 0.33))
    && S.fx.some((f) => f.type === 'vignette' && near(f.amount, 0.21));
  report.checks.playhead = near(MK.state.t, 1.234, 0.02);
  report.checks.bar = !document.getElementById('restoreBar').classList.contains('hidden');
  // 素材：刷新后应该自己从 IndexedDB 里接回来（file:// 下浏览器可能不给用，那就只认名字）
  await sleep(300);
  let mediaOk = false;
  try {
    await waitFor(() => !!MK.state.media.video, 3000);
    const v = MK.state.media.video;
    mediaOk = MK.state.media.videoName === MEDIA_NAME && !!v && (v.naturalWidth > 0 || v.videoWidth > 0);
  } catch (_) { mediaOk = false; }
  report.checks.media = mediaOk;
  report.media = { name: MK.state.media.videoName, loaded: !!MK.state.media.video };
  report.after = {
    layers: S.layers.length, duration: S.duration, bpm: S.beat.bpm,
    t: MK.state.t, restoreBar: report.checks.bar, media: report.media,
  };
}

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
window.__mkReport = report;
