// ============================================================================
// 同步面板 —— 不敲命令，点按钮就完成：提交、上传到 GitHub、拉取更新、打包给另一台电脑。
//
// 后端在 tools/serve.mjs（开发模式才有）。单文件版（file://）没有后端，
// 面板会直接告诉你去双击 启动工作室.bat。
// ============================================================================

const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const opt = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) };
  const r = await fetch(path, opt);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch (_) { return { ok: false, error: txt.slice(0, 300) || ('HTTP ' + r.status) }; }
}

export function initSyncPanel() {
  const dlg = $('syncDlg');
  if (!dlg) return;
  let busy = false;
  let online = true;

  const log = (s) => {
    const el = $('syncLog');
    el.textContent = (el.textContent ? el.textContent + '\n' : '') + s;
    el.scrollTop = el.scrollHeight;
  };
  const clearLog = () => { $('syncLog').textContent = ''; };
  const setBusy = (b, what) => {
    busy = b;
    for (const id of ['syncSave', 'syncUpload', 'syncPull', 'syncDown', 'syncPack', 'syncMakeKey']) {
      const el = $(id); if (el) el.disabled = b;
    }
    $('syncFoot').textContent = b ? (what || '处理中…') : '';
  };

  function fill(st) {
    if (!st) return;
    $('syncBranch').textContent = st.branch || '—';
    $('syncRemote').textContent = st.remote || '还没设置';
    $('syncDirty').textContent = st.repo
      ? (st.dirty ? st.dirty + ' 个文件等着上传' : (st.hasCommit ? '没有新改动' : '还没有第一次提交'))
      : '—';
    $('syncWho').textContent = st.name ? (st.name + (st.email ? ' <' + st.email + '>' : '')) : '还没设置';
    if (st.name && !$('syncName').value) $('syncName').value = st.name;
    if (st.email && !$('syncEmail').value) $('syncEmail').value = st.email;
    if (st.remote && !$('syncRemoteInput').value) $('syncRemoteInput').value = st.remote;
    const badge = $('syncBadge');
    if (!st.git) { badge.textContent = '这台电脑没装 git'; badge.className = 'badge warn'; }
    else if (!st.repo) { badge.textContent = '这里还不是 git 仓库'; badge.className = 'badge warn'; }
    else if (!st.name || !st.email) { badge.textContent = '先填名字和邮箱'; badge.className = 'badge warn'; }
    else if (!st.remote) { badge.textContent = '先填仓库地址'; badge.className = 'badge warn'; }
    else { badge.textContent = st.dirty ? '有改动待上传' : '已连接'; badge.className = 'badge ok'; }
  }

  async function refresh() {
    const st = await api('/api/git/status');
    if (st && st.error && !st.git) { fill(st); throw new Error(st.error); }
    fill(st);
    return st;
  }

  async function guard(fn, what) {
    if (busy) return;
    setBusy(true, what);
    try { await fn(); } catch (e) { log('✗ ' + e.message); }
    finally { setBusy(false); }
  }

  // ---------------------------------------------------------------- 按钮
  $('syncSave').addEventListener('click', () => guard(async () => {
    const name = $('syncName').value.trim();
    const email = $('syncEmail').value.trim();
    const remote = $('syncRemoteInput').value.trim();
    if (!name || !email) { log('✗ 名字和邮箱都要填——它们会写进每一次提交记录'); return; }
    const r = await api('/api/git/setup', { name, email, remote });
    if (!r.ok) { log('✗ ' + r.error); return; }
    fill(r);
    log('✓ 设置已保存：' + (r.done || []).join(' / ') + (r.remote ? '（' + r.remote + '）' : ''));
    if (r.remote && /^git@github\.com:/.test(r.remote)) log('  提示：地址已自动改成 SSH 形式，这台电脑只有 SSH 能连上 GitHub');
  }, '保存设置…'));

  $('syncUpload').addEventListener('click', () => guard(async () => {
    const msg = $('syncMsg').value.trim();
    const st0 = await refresh();
    if (!st0 || !st0.repo) { log('✗ 这里还不是 git 仓库'); return; }
    if (st0.dirty) {
      log('· 正在提交 ' + st0.dirty + ' 个文件…');
      const c = await api('/api/git/commit', { message: msg });
      if (!c.ok) { log('✗ 提交失败：' + c.error); return; }
      log('✓ ' + (c.skipped || '已提交：' + c.message));
    } else {
      log('· 没有新改动，直接上传');
    }
    log('· 正在上传到 GitHub…（第一次会弹窗让你登录/授权）');
    const p = await api('/api/git/push');
    if (!p.ok) { log('✗ 上传失败：' + (p.error || '').split('\n').slice(0, 6).join('\n')); return; }
    fill(p);
    log('✓ 上传完成');
    log((p.out || '').split('\n').slice(-4).join('\n'));
  }, '上传中…'));

  $('syncPull').addEventListener('click', () => guard(async () => {
    log('· 正在从 GitHub 拉取…');
    const r = await api('/api/git/pull');
    if (!r.ok) { log('✗ 拉取失败：' + (r.error || '').split('\n').slice(0, 6).join('\n')); return; }
    fill(r);
    log('✓ 已拉取最新。改了 studio/ 里的源码的话，刷新一下页面');
  }, '拉取中…'));

  $('syncPack').addEventListener('click', () => guard(async () => {
    log('· 正在打包（不含 projects/ 里的大片）…');
    const r = await api('/api/git/package', {});
    if (!r.ok) { log('✗ 打包失败：' + r.error); return; }
    log('✓ 好了：' + r.file);
    log('  大小 ' + (r.size / 1048576).toFixed(1) + ' MB。把它拷到另一台电脑（微信/网盘/U 盘都行），解压后双击 启动工作室.bat 就能接着开发。');
  }, '打包中…'));

  $('syncDown').addEventListener('click', () => {
    if (!confirm('把远程仓库的内容整个接过来？\n\n会覆盖本机还没上传的改动（已经提交过的不受影响）。\n新电脑第一次用的时候点这个。')) return;
    guard(async () => {
      log('· 正在从远程仓库接内容…');
      const r = await api('/api/git/sync-down');
      if (!r.ok) { log('✗ ' + (r.error || '').split('\n').slice(0, 6).join('\n')); return; }
      fill(r);
      log('✓ 已经和远程仓库一致了。刷新一下页面就是最新的代码');
    }, '接入中…');
  });

  $('syncMakeKey').addEventListener('click', () => guard(async () => {
    log('· 正在生成 SSH 密钥…');
    const r = await api('/api/git/sshkey', {});
    if (!r.ok) { log('✗ 生成失败：' + r.error); return; }
    $('syncPubKey').value = r.pub || '';
    log(r.created ? '✓ 已生成新密钥' : '· 已经有密钥了，直接复制下面那串');
    if (r.sshConfig && r.sshConfig.changed) log('✓ 已把 github.com 指向 SSH 的 443 端口（这台电脑只有这条路通）');
    log('  下一步：把公钥加到 GitHub → Settings → SSH and GPG keys → New SSH key');
  }, '处理中…'));

  $('syncCopyKey').addEventListener('click', async () => {
    const v = $('syncPubKey').value.trim();
    if (!v) { log('· 还没有公钥，点上面那个按钮生成一把'); return; }
    try { await navigator.clipboard.writeText(v); log('✓ 公钥已复制，去 GitHub 粘贴'); }
    catch (_) { $('syncPubKey').select(); log('· 复制不了就手动选中上面那串（已全选）'); }
  });

  $('btnCloseSync').addEventListener('click', () => dlg.close());

  // ---------------------------------------------------------------- 打开
  $('btnSync').addEventListener('click', async () => {
    dlg.showModal();
    clearLog();
    $('syncMsg').value = '';
    log('· 正在检查…');
    try {
      await refresh();
      log('· 这是开发模式，可以直接同步');
    } catch (e) {
      online = false;
      $('syncBadge').textContent = '没有后端';
      $('syncBadge').className = 'badge warn';
      log('✗ ' + (e.message || '连不上本地服务'));
      log('');
      log('同步功能要用开发模式：关掉这个窗口，双击工程根目录的 启动工作室.bat，');
      log('它会自动打开浏览器里的工作室，那时再点这个「同步」按钮。');
      log('（单文件版 dist/studio.html 是纯前端，没有后端，所以没有这个功能）');
      return;
    }
    // 顺便看看有没有 SSH 公钥（只读，不生成）
    const k = await api('/api/git/sshkey');
    if (k && k.exists) $('syncPubKey').value = k.pub || '';
    else if (k && k.ok) $('syncPubKey').value = k.pub || '';
    else log('· 还没有 SSH 公钥。要直接上传的话，展开下面「GitHub 登录用（SSH 公钥）」点一下生成。');
  });

  dlg.addEventListener('close', () => setBusy(false));
  window.addEventListener('afterprint', () => {});
  return { refresh, isOnline: () => online };
}
