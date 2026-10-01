// 「素材拖进来 → 工程时长自动识别 → 时间轴两条轨」的自检。
//
//   node tools/shot.mjs --url "studio/index.html" \
//     --file video=.out/test/clip.mp4 --file audio=.out/test/music.wav \
//     --js-file tools/ui-media-test.js --out .out/tracks.png
//
// 由 shot.mjs 的 --file 把文件塞进 window.__mkFiles，这里造出真的 File 再走拖放路径。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {} };

function fileFrom(key) {
  const f = window.__mkFiles[key];
  const bin = atob(f.b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], f.name, { type: f.type });
}

function drop(file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  document.getElementById('stage').dispatchEvent(new DragEvent('drop', {
    dataTransfer: dt, bubbles: true, cancelable: true,
  }));
}

const MK = window.MotionKit;

// 1. 拖视频进来
drop(fileFrom('video'));
for (let i = 0; i < 40 && !MK.mediaInfo().videoDur; i++) await sleep(200);
report.afterVideo = MK.mediaInfo();
report.checks.videoLoaded = report.afterVideo.videoDur > 0;

// 2. 拖音频进来（要等节拍分析）
drop(fileFrom('audio'));
for (let i = 0; i < 80 && !MK.mediaInfo().audioDur; i++) await sleep(250);
await sleep(600);
report.afterAudio = MK.mediaInfo();
report.checks.audioLoaded = report.afterAudio.audioDur > 0;

// 3. 工程时长应该 = 素材里长的那个
const want = Math.max(report.afterAudio.videoDur, report.afterAudio.audioDur);
report.checks.durationFollows =
  Math.abs(report.afterAudio.sceneDur - want) < 0.05 && report.afterAudio.auto === true;

// 4. 音频要抽出波形（时间轴音频轨用）
report.checks.waveform = report.afterAudio.peaks > 100;

// 5. 手动改时长之后不再自动跟随；点「重新跟随」能回来
MK.state.scene.duration = 5;
MK.state.durationAuto = false;
const manual = MK.mediaInfo();
report.checks.manualSticks = Math.abs(manual.sceneDur - 5) < 0.01 && manual.auto === false;
MK.followMedia(true);
await sleep(150);
report.checks.followBack = Math.abs(MK.mediaInfo().sceneDur - want) < 0.05;

report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
window.__mkReport = report;
