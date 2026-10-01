// ============================================================================
// AI 助手面板
//
// 它本身不做任何分析：把素材和用户那 5~6 个选择丢给本地服务
// （tools/serve.mjs 的 /api/agent/run），服务端调 python 跑完整流程，
// 进度以 NDJSON 流回来，最后拿到一份 MotionKit 工程直接载入工作室。
//
// 单文件版（dist/studio.html，file:// 打开）没有服务端，这里会明确告诉用户
// 要改用 `npm run studio`，而不是无声地失败。
// ============================================================================

const $ = (id) => document.getElementById(id);

let ctx = null;         // { getFile, getVideoName, loadScene, getSize, getDuration }
let status = null;      // /api/agent/status 的返回
let lastResult = null;
let running = false;

function log(msg, cls = '') {
  const box = $('agentLog');
  if (box.children.length === 1 && box.querySelector('.dim')) box.innerHTML = '';
  const line = document.createElement('div');
  line.className = 'agent-line ' + cls;
  line.textContent = msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function setBar(p) {
  const foot = $('agentFoot');
  if (p == null) {
    foot.textContent = ctx && ctx.getVideoName && ctx.getVideoName() ? ctx.getVideoName() : '';
    return;
  }
  foot.textContent = '进度 ' + Math.round(p * 100) + '%';
}

function renderStyles(styles) {
  const box = $('agentStyles');
  box.innerHTML = '';
  const auto = { id: 'auto', name: '自动', desc: '按画面亮度和运动量替你挑', ink: '#dddddd', accent: '#888888', plate: '#222222' };
  for (const s of [auto, ...styles]) {
    const b = document.createElement('button');
    b.className = 'style-card' + (s.id === 'auto' ? ' active' : '');
    b.dataset.style = s.id;
    b.innerHTML = '<span class="sw">' +
      '<i style="background:' + s.plate + '"></i>' +
      '<i style="background:' + s.ink + '"></i>' +
      '<i style="background:' + s.accent + '"></i></span>' +
      '<b>' + s.name + '</b><span class="sd">' + (s.desc || '') + '</span>';
    b.addEventListener('click', () => {
      box.querySelectorAll('.style-card').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    box.appendChild(b);
  }
}

function currentStyle() {
  const el = $('agentStyles').querySelector('.style-card.active');
  return el ? el.dataset.style : 'auto';
}

async function refreshStatus() {
  const env = $('agentEnv');
  try {
    const r = await fetch('/api/agent/status');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    status = await r.json();
    const bits = [];
    bits.push(status.python ? ('Python ' + status.python + ' ✓') : 'Python ✗');
    bits.push(status.ffmpeg ? 'ffmpeg ✓' : 'ffmpeg ✗');
    bits.push(status.llm.configured ? ('LLM ' + status.llm.model + ' ✓') : 'LLM 未配置（用本地规则文案）');
    bits.push(status.asrProviders.length ? ('字幕 ' + status.asrProviders.join('/') + ' ✓') : '字幕不可用');
    env.textContent = bits.join(' · ');
    env.className = 'badge ' + (status.ok ? 'ok' : 'bad');
    renderStyles(status.styles || []);
    if (status.defaults) {
      $('agentIntensity').value = status.defaults.intensity;
      $('agentDensity').value = status.defaults.density;
      $('agentIntensityVal').textContent = Number(status.defaults.intensity).toFixed(2);
      $('agentDensityVal').textContent = Number(status.defaults.density).toFixed(2);
    }
  } catch (e) {
    status = null;
    env.textContent = 'AI 助手需要开发模式：npm run studio';
    env.className = 'badge bad';
    log('没有连上本地服务。单文件版（双击 studio.html）不含 Agent 后端。', 'bad');
    log('在工程目录运行  npm run studio ，再打开 http://localhost:5178/studio/index.html', 'dim');
  }
}

function updateSourceLabel() {
  const f = ctx && ctx.getFile && ctx.getFile();
  const box = $('agentSource');
  if (f) {
    box.textContent = '用工作室里已载入的素材：' + f.name + '（' + (f.size / 1048576).toFixed(1) + ' MB）';
    box.classList.add('ok');
  } else {
    box.textContent = '还没载入素材 —— 先用顶部「载入视频 / 图片」放一个视频进来';
    box.classList.remove('ok');
  }
}

/** 接口报错时说人话：404 基本都是"本地服务还是旧版本，没这个接口" */
function apiError(status) {
  if (status === 404) {
    return '本地服务是旧版本（没有这个接口）—— 关掉那个黑窗口，重新双击 启动工作室.bat，然后刷新本页';
  }
  if (status === 413) return '素材太大，本地服务拒收了（换短一点的素材试试）';
  return 'HTTP ' + status;
}

function setRunning(v) {
  running = v;
  $('agentRun').disabled = v;
  $('agentRun').textContent = v ? '生成中…' : '开始生成';
  const f = $('agentFill');
  if (f) { f.disabled = v; f.textContent = v ? '铺满中…' : '⚡ 一键铺满（先铺后改）'; }
}

/** 一键铺满：结果直接载进工作室，剩下的交给人改 */
function onFillResult(r) {
  lastResult = { scene: r.scene, fill: true };
  const counts = {};
  for (const l of r.scene.layers) counts[l.template] = (counts[l.template] || 0) + 1;
  const gaps = (r.gaps || []).length;
  const rows = [
    ['图层', r.scene.layers.length + ' 层'],
    ['时长', Number(r.scene.duration).toFixed(2) + 's'],
    ['空隙', gaps ? (gaps + ' 处') : '无（整条铺满）'],
    ['配色', r.style || ''],
  ];
  $('agentReport').innerHTML =
    '<div class="agent-report-title">铺满结果</div>' +
    rows.map((kv) => '<div class="agent-kv"><b>' + kv[0] + '</b><span>' + kv[1] + '</span></div>').join('') +
    '<div class="agent-report-title">各模板用量</div>' +
    Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => '<div class="agent-dec"><b>' + k + '</b><span>× ' + v + '</span></div>').join('');
  $('agentResult').classList.remove('hidden');
  if (r.scene) {
    ctx.loadScene(r.scene);
    log('已经铺进工作室了 —— 关掉这个窗口就能开始改（删多余的层、双击改字、拖到别处）。', 'ok');
  }
}

/** ⚡ 一键铺满 */
async function runFill() {
  if (running) return;
  if (!status) { log('需要先以开发模式启动（双击 启动工作室.bat）。', 'bad'); return; }
  const file = ctx.getFile && ctx.getFile();
  if (!file) { log('先把视频拖进工作室（或者在上面选素材），再点一键铺满。', 'bad'); return; }

  const brief = {
    style: currentStyle(),
    intensity: Number($('agentIntensity').value),
    width: ctx.getSize ? ctx.getSize().w : 1920,
    height: ctx.getSize ? ctx.getSize().h : 1080,
    fps: ctx.getSize ? ctx.getSize().fps : 30,
    title: $('agentNotes').value.trim().split('\n')[0].slice(0, 28),
  };
  setRunning(true);
  $('agentResult').classList.add('hidden');
  $('agentLog').innerHTML = '';
  log('一键铺满：' + file.name + ' · 风格 ' + brief.style + '（只看素材，不转写不叫大模型）');
  setBar(0.02);

  try {
    const res = await fetch('/api/agent/fill', {
      method: 'POST',
      headers: {
        'x-file-name': encodeURIComponent(file.name),
        'x-brief': encodeURIComponent(JSON.stringify(brief)),
      },
      body: file,
    });
    if (!res.ok || !res.body) throw new Error(apiError(res.status));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const lineTxt = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!lineTxt) continue;
        let msg = null;
        try { msg = JSON.parse(lineTxt); } catch (_) { log(lineTxt, 'dim'); continue; }
        if (msg.type === 'progress') { log(msg.msg); setBar(msg.progress); }
        else if (msg.type === 'log') log(msg.msg, 'dim');
        else if (msg.type === 'error') { log('出错：' + msg.msg, 'bad'); if (msg.detail) log(msg.detail, 'dim'); }
        else if (msg.type === 'result') onFillResult(msg.result || msg);
      }
    }
  } catch (e) {
    log('请求失败：' + e.message, 'bad');
  } finally {
    setRunning(false);
    setBar(null);
  }
}

function onResult(r) {
  lastResult = r;
  const rep = r.report || {};
  const c = rep.counts || {};
  const rows = [
    ['配色', (rep.styleName || r.style) + '（' + r.style + '）'],
    ['规格', rep.size + ' · ' + Number(rep.duration).toFixed(2) + 's'],
    ['图层', (c.layers || 0) + ' 层 · 卡点 ' + (c.impacts || 0) + ' 处 · 转场 ' + (c.transitions || 0) + ' 处'],
    ['字幕', c.captions ? (c.captions + ' 条') : '无'],
    ['文案', (r.llm && r.llm.used) ? ('LLM（' + r.llm.model + '）') : '本地规则'],
    ['挑的片段', Number(r.window.start).toFixed(2) + 's 起 · ' + Number(r.window.duration).toFixed(2) + 's'],
  ];
  const div = $('agentReport');
  div.innerHTML = '<div class="agent-report-title">这次它替你做的决定</div>' +
    rows.map((kv) => '<div class="agent-kv"><b>' + kv[0] + '</b><span>' + kv[1] + '</span></div>').join('') +
    '<div class="agent-report-title">理由</div>' +
    (rep.decisions || []).map((d) => '<div class="agent-dec"><b>' + d.stage + '</b><span>' + d.what + '</span><i>' + d.why + '</i></div>').join('');

  const files = [];
  if (r.files) {
    if (r.files.final) files.push('final.mp4');
    if (r.files.srt) files.push('transcript.srt');
    files.push('scene.json', 'report.md');
    $('agentFiles').textContent = '已写入 ' + files.join(' / ');
  }
  $('agentResult').classList.remove('hidden');
  log('完成。可以点「载入到工作室继续调」。', 'ok');
}

async function runAgent() {
  if (running) return;
  if (!status) { log('需要先以 npm run studio 启动本地服务。', 'bad'); return; }
  const file = ctx.getFile && ctx.getFile();
  if (!file) { log('先载入一个视频再点生成。', 'bad'); return; }

  const target = Number($('agentTarget').value);
  const brief = {
    style: currentStyle(),
    intensity: Number($('agentIntensity').value),
    density: Number($('agentDensity').value),
    captions: $('agentCaptions').value,
    captionStyle: $('agentCaptionStyle').value,
    target: target > 0 ? target : (ctx.getDuration ? ctx.getDuration() : 30),
    width: ctx.getSize ? ctx.getSize().w : 1920,
    height: ctx.getSize ? ctx.getSize().h : 1080,
    fps: ctx.getSize ? ctx.getSize().fps : 30,
    notes: $('agentNotes').value.trim(),
    render: $('agentRender').checked,
    llm: status.llm.configured,
  };
  if (target === 0) brief.clip = 'full';

  setRunning(true);
  $('agentResult').classList.add('hidden');
  $('agentLog').innerHTML = '';
  log('开始：' + file.name + ' · 目标 ' + Number(brief.target).toFixed(0) + 's · 风格 ' + brief.style);

  try {
    const res = await fetch('/api/agent/run', {
      method: 'POST',
      headers: {
        'x-file-name': encodeURIComponent(file.name),
        'x-brief': encodeURIComponent(JSON.stringify(brief)),
      },
      body: file,
    });
    if (!res.ok || !res.body) throw new Error(apiError(res.status));

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const lineTxt = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!lineTxt) continue;
        let msg = null;
        try { msg = JSON.parse(lineTxt); } catch (_) { log(lineTxt, 'dim'); continue; }
        if (msg.type === 'progress') { log(msg.msg); setBar(msg.progress); }
        else if (msg.type === 'log') { log(msg.msg, 'dim'); }
        else if (msg.type === 'error') {
          log('出错：' + msg.msg, 'bad');
          if (msg.detail) log(msg.detail, 'dim');
        } else if (msg.type === 'result') { onResult(msg.result); }
      }
    }
  } catch (e) {
    log('请求失败：' + e.message, 'bad');
  } finally {
    setRunning(false);
    setBar(null);
  }
}

function loadIntoStudio() {
  if (!lastResult || !lastResult.scene) return;
  ctx.loadScene(lastResult.scene);
  log('已载入工程：' + lastResult.scene.layers.length + ' 个图层。', 'ok');
  $('agentDlg').close();
}

export function initAgentPanel(options) {
  ctx = options;
  const open = async () => {
    $('agentDlg').showModal();
    updateSourceLabel();
    if (!status) await refreshStatus();
  };
  $('btnAgent').addEventListener('click', open);
  // 深链：studio/index.html?agent=1 直接弹出面板（截图/自检用得上）
  if (new URLSearchParams(location.search).get('agent') === '1') setTimeout(open, 60);
  $('agentClose').addEventListener('click', () => $('agentDlg').close());
  $('agentRun').addEventListener('click', runAgent);
  if ($('agentFill')) $('agentFill').addEventListener('click', runFill);
  $('agentLoad').addEventListener('click', loadIntoStudio);
  $('agentIntensity').addEventListener('input', (e) => {
    $('agentIntensityVal').textContent = Number(e.target.value).toFixed(2);
  });
  $('agentDensity').addEventListener('input', (e) => {
    $('agentDensityVal').textContent = Number(e.target.value).toFixed(2);
  });
}
