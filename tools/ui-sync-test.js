// 同步面板的自检：真的去点那几个按钮，看后端接口有没有正确响应。
//
// 用法（先让开发服务器跑起来）：
//   node tools/serve.mjs 5199
//   node tools/shot.mjs --url "http://127.0.0.1:5199/studio/index.html" \
//        --js-file tools/ui-sync-test.js --out .out/sync.png
//
// 专门盯一类坑：界面调的接口路径/方法跟后端对不上（表现是 "not found: /api/git/xxx"，
// 但面板只会显示"上传失败"，很容易误以为是网络或密钥问题）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { checks: {} };
const logText = () => (document.getElementById('syncLog').textContent || '');
const tail = (t, n = 400) => t.slice(-n);

// 打开面板
document.getElementById('btnSync').click();
await sleep(1200);
report.open = tail(logText(), 500);

// 点「提交并上传」（没配密钥/没建仓库时应该给出人话提示，而不是 not found）
document.getElementById('syncUpload').click();
for (let i = 0; i < 40; i++) {
  await sleep(400);
  if (/✓ 上传完成|✗/.test(tail(logText(), 120))) break;
}
report.upload = tail(logText(), 700);

// 点「拉取最新」
document.getElementById('syncPull').click();
for (let i = 0; i < 30; i++) {
  await sleep(400);
  if (/已拉取最新|✗/.test(tail(logText(), 120))) break;
}
report.pull = tail(logText(), 400);

// 点「打包给另一台电脑」
document.getElementById('syncPack').click();
for (let i = 0; i < 60; i++) {
  await sleep(500);
  if (/✓ 好了|✗ 打包失败/.test(logText())) break;
}
report.pack = tail(logText(), 400);

const all = [report.open, report.upload, report.pull, report.pack].join('\n');
report.checks.no404 = !/not found: \/api\/git\//.test(all);
report.checks.reachedServer = !/连不上本地服务|没有后端/.test(report.open);
report.checks.uploadHandled = /上传完成|GitHub 还不认|还没有这个仓库|连不上 GitHub|本地服务还是旧版本|还没填仓库地址/.test(report.upload);
report.checks.pullHandled = /已拉取最新|拉取失败|还没填仓库地址|连不上/.test(report.pull);
report.checks.packHandled = /✓ 好了|✗ 打包失败/.test(report.pack);
report.checks.all = Object.keys(report.checks).every((k) => report.checks[k] !== false);
window.__mkReport = report;
