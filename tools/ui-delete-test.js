// ============================================================================
// "我只想删一个动效，结果把视频/音频整条删掉了" —— 回归自检
//
//   node tools/shot.mjs --url "studio/index.html" \
//     --js-file tools/ui-delete-test.js --out .out/ui-delete.png
//
// 病因（修之前）：
//   `state.clipSel`（选中的素材片段）和 `state.selection`（选中的图层）是两套
//   互不相干的状态，谁都不清谁。载入视频/音乐会自动选中新片段，之后你再点一个
//   动效图层，图层是选中了，但 clipSel 还留着 —— 而 Delete 键的判断是
//   "有片段选中就删片段"，于是删掉的是底下的视频/音频，连素材一起释放。
//
// 这里要钉住的四条：
//   ① 点了动效图层之后，片段选中必须被撤掉（两种选中互斥）
//   ② 这时按 Delete 删的必须是图层，视频/音频片段一个不少
//   ③ 反过来选中片段按 Delete，删的必须是片段，图层一个不少
//   ④ 误删之后 Ctrl+Z 能把片段**和素材**都救回来
//      （素材的二进制单独存在 IndexedDB，不能一删就立刻抹掉）
// ============================================================================

const MK = window.MotionKit;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = {};
const notes = [];
const ok = (name, cond, extra) => {
  checks[name] = !!cond;
  notes.push((cond ? 'ok   ' : 'FAIL ') + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
  return !!cond;
};

const clipIds = () => MK.state.scene.clips.map((c) => c.id);
const layerIds = () => MK.state.scene.layers.map((L) => L.id);

// 干净的起点：一个视频片段 + 一个音频片段（模拟"已经载入了素材"）
MK.clearLayers();
MK.setScene({
  name: 'del', width: 1920, height: 1080, fps: 24, duration: 6, transparent: true, bg: null,
  beat: { bpm: 120, offset: 0, duration: 6, source: 'bpm' },
  layers: [], captions: [], fx: [],
});
const vClip = MK.addFakeClip('video', 'asset-video-1', 4);
const aClip = MK.addFakeClip('audio', 'asset-audio-1', 4);
ok('准备好了视频 + 音频两个片段', !!vClip && !!aClip && clipIds().length === 2, clipIds());

// 加一个动效图层，并像用户那样点选它（这是触发 bug 的动作）
const L = MK.addLayer({ template: 'title-mark', start: 0, end: 3, name: '我想删的动效', params: { title: 'X' } });
MK.selectLayer(L.id);

// ---------------------------------------------------------------- ① 两种选中互斥
{
  const info = MK.selectionInfo();
  ok('点动效图层之后，片段选中被撤掉了', info.clip === null, info);
  ok('Delete 的目标是图层（不是片段）', MK.deleteTarget() === 'layer', MK.deleteTarget());
}

// ---------------------------------------------------------------- ② 删图层，素材不动
{
  const nClip = clipIds().length;
  const nLayer = layerIds().length;
  const r = MK.pressDelete();
  ok('Delete 删掉的是图层', r.deleted === 'layer' && r.n === 1, r);
  ok('图层少了一个', layerIds().length === nLayer - 1, [nLayer, layerIds().length]);
  ok('视频/音频片段一个都没少', clipIds().length === nClip, [nClip, clipIds().length]);
  ok('两个素材片段还在场景里', clipIds().includes(vClip) && clipIds().includes(aClip), clipIds());
}

// ---------------------------------------------------------------- ③ 选中片段才删片段
{
  MK.setScene({
    name: 'del2', width: 1920, height: 1080, fps: 24, duration: 6, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 6, source: 'bpm' },
    layers: [], captions: [], fx: [],
  });
  const v2 = MK.addFakeClip('video', 'asset-video-2', 4);
  const L1 = MK.addLayer({ template: 'title-mark', start: 0, end: 2, name: '留着', params: { title: 'A' } });
  const L2 = MK.addLayer({ template: 'title-mark', start: 2, end: 4, name: '留着2', params: { title: 'B' } });
  MK.selectClip(v2);
  ok('选中片段之后，Delete 的目标是片段', MK.deleteTarget() === 'clip', MK.deleteTarget());
  const nLayer = layerIds().length;
  const r = MK.pressDelete();
  ok('删掉的是片段', r.deleted === 'clip' && r.n === 1, r);
  ok('片段没了', clipIds().length === 0, clipIds());
  ok('图层一个都没动', layerIds().length === nLayer, [nLayer, layerIds().length]);
}

// ---------------------------------------------------------------- ④ 误删能救回来
{
  MK.setScene({
    name: 'del3', width: 1920, height: 1080, fps: 24, duration: 6, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 6, source: 'bpm' },
    layers: [], captions: [], fx: [],
  });
  // 造一份"真的在内存里的素材"，这样 releaseAssetIfUnused 才会走到回收那一支
  const fakeEl = document.createElement('video');
  MK.state.assets.set('asset-undo-1', {
    id: 'asset-undo-1', kind: 'video', name: '要救回来的视频.mp4',
    el: fakeEl, url: '', duration: 4, width: 1280, height: 720,
  });
  const cid = MK.addFakeClip('video', 'asset-undo-1', 4);
  MK.selectClip(cid);
  const had = MK.purgeState().alive.includes('asset-undo-1');
  ok('素材已在内存里', had, MK.purgeState());

  // 给这一段一个干净的回退基线：把"有片段、有素材"这一刻作为撤销的目标
  MK.historyClear();
  const histBefore = MK.historyInfo();
  ok('删之前这一刻已经进了历史', histBefore.len >= 1, histBefore);
  ok('历史里那一版确实带着这个片段',
    MK.historyDump()[0].clips.includes(cid), MK.historyDump());

  MK.pressDelete();
  const afterDel = MK.purgeState();
  ok('删片段之后，素材从内存里撤下来了', !afterDel.alive.includes('asset-undo-1'), afterDel);
  ok('但进了"待回收"名单（没有立刻抹掉缓存）', afterDel.pending.includes('asset-undo-1'), afterDel);
  ok('宽限期是分钟级的（撤销来得及）', afterDel.graceMs >= 60000, afterDel.graceMs);
  ok('删完之后片段确实没了', !clipIds().includes(cid), clipIds());

  // 撤销：片段要回来
  const undone = MK.undo();
  await sleep(600);
  ok('Ctrl+Z 这一步本身成功了', undone === true, undone);
  ok('Ctrl+Z 把片段救回来了', clipIds().includes(cid), { want: cid, got: clipIds() });
  // 注意：这个假素材从没写过 IndexedDB，"接回内存"那一步它拿不到东西 ——
  // 真素材走的是 restoreAssets() 从 IndexedDB 回读。这里要钉的是
  // **缓存在宽限期内不许被抹掉**（抹掉了就再也回读不出来，撤销等于没救）。
  ok('撤销之后素材不再是"待回收"状态了', !MK.purgeState().pending.includes('asset-undo-1'), MK.purgeState());

  // 宽限期内不回收：缓存必须留着，撤销才救得回来（"过了宽限期才回收"见下一段）
  ok('宽限期内不回收', MK.reapAssets(0) === 0);
}

// ---------------------------------------------------------------- ④b 宽限期过了才真回收
{
  MK.setScene({
    name: 'del3b', width: 1920, height: 1080, fps: 24, duration: 6, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 6, source: 'bpm' },
    layers: [], captions: [], fx: [],
  });
  MK.state.assets.set('asset-grace-1', {
    id: 'asset-grace-1', kind: 'video', name: '过期就回收.mp4',
    el: document.createElement('video'), url: '', duration: 3,
  });
  const gid = MK.addFakeClip('video', 'asset-grace-1', 3);
  MK.selectClip(gid);
  MK.pressDelete();
  ok('刚删完在"待回收"里', MK.purgeState().pending.includes('asset-grace-1'), MK.purgeState());
  ok('宽限期内不回收', MK.reapAssets(0) === 0);
  const grace = MK.purgeState().graceMs + 1000;
  ok('过了宽限期就真的回收掉', MK.reapAssets(grace) === 1, MK.purgeState());
}

// ---------------------------------------------------------------- ⑤ 点图层不该把音频也撤掉
{
  MK.setScene({
    name: 'del4', width: 1920, height: 1080, fps: 24, duration: 6, transparent: true, bg: null,
    beat: { bpm: 120, offset: 0, duration: 6, source: 'bpm' },
    layers: [], captions: [], fx: [],
  });
  const a3 = MK.addFakeClip('audio', 'asset-audio-3', 4);
  const v3 = MK.addFakeClip('video', 'asset-video-3', 4);
  // 用户的操作序列：先点片段（列表里点一下），再点动效图层
  MK.selectClip(a3);
  const L3 = MK.addLayer({ template: 'title-mark', start: 0, end: 2, name: '动效', params: { title: 'C' } });
  MK.selectLayer(L3.id);
  ok('先点片段再点图层：片段选中也让位了', MK.selectionInfo().clip === null, MK.selectionInfo());
  MK.pressDelete();
  ok('音频片段还在', clipIds().includes(a3), clipIds());
  ok('视频片段还在', clipIds().includes(v3), clipIds());
}

const report = { checks, report: notes };
report.checks.all = Object.values(checks).every(Boolean);
window.__mkReport = report;
return report;
