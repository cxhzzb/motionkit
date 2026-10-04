// 网络视频下载入口自检：确认弹窗、输入框和后端回传都接得上。
//
//   node tools/shot.mjs --browser /opt/google/chrome/chrome \
//     --url "http://127.0.0.1:5178/studio/index.html" \
//     --js-file tools/ui-download-test.js --out .out/ui-download.png
//
// 加 ?downloadTestUrl=<编码后的URL> 可以做真实下载并载入的端到端测试。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const report = { checks: {} };

const open = $('btnOpenDownload');
report.checks.buttonExists = !!open;
open.click();
await sleep(80);

const dlg = $('downloadDlg');
report.checks.dialogOpened = dlg.open;
report.checks.inputExists = !!$('downloadUrl');
report.checks.goButtonExists = !!$('btnDownloadGo');

const liveUrl = new URLSearchParams(location.search).get('downloadTestUrl');
$('downloadUrl').value = liveUrl || 'http://127.0.0.1/test.mp4';
$('btnDownloadGo').click();
const expect = liveUrl
  ? (s) => /已下载并载入/.test(s)
  : (s) => /不能下载内网或本机地址/.test(s);
for (let i = 0; i < (liveUrl ? 600 : 80); i++) {
  await sleep(100);
  if (expect($('downloadState').textContent || '')) break;
}

report.state = $('downloadState').textContent;
report.checks.backendResponded = expect(report.state);
report.checks.resultStyled = liveUrl
  ? $('downloadState').classList.contains('ok')
  : $('downloadState').classList.contains('bad');
if (liveUrl) report.checks.videoLoaded = !!window.MotionKit.mediaInfo().video;
report.checks.closeButtonExists = !!$('btnCloseDownload');
dlg.close();
report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
window.__mkReport = report;
