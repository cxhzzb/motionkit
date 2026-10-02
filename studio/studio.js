// ============================================================================
// MotionKit 工作室
// 预览 / 参数 / 卡点 / 字幕 / 导出，全部跑在浏览器里，零依赖。
// 同时对外暴露 window.MotionKit，供 tools/render.mjs 无头调用。
// ============================================================================

import {
  Scene, Layer, Caption, Clip, BeatMap, renderFrame, makeCanvas, timecode,
  clamp, lerp, Rng, registerTemplate,
} from '../engine/core.js';
import * as Draw from '../engine/draw.js';
import * as FX from '../engine/fx.js';
import { runFx } from '../engine/fx.js';
import { analyzeAudioFile, analyzeBuffer, envAt, onsets } from '../engine/audio.js';
import { parseSubtitles, toSRT, splitForKinetic, estimateWordTimings } from '../engine/srt.js';
import { makeZip, createZipWriter, downloadBlob, canvasToPngBytes } from '../engine/zip.js';
import { muxMp4 } from '../engine/mp4.js';
import { registerAll, listTemplates, CATEGORIES, byCategory } from '../templates/index.js';
import { initAgentPanel } from './agent-panel.js';
import { initSyncPanel } from './sync-panel.js';

registerAll();

// ---------------------------------------------------------------- 状态
const state = {
  scene: new Scene({ width: 1920, height: 1080, fps: 24, duration: 10, transparent: true }),
  selection: null,          // 选中的图层 id
  selected: new Set(),      // 多选：一起选中的图层 id（框选 / Shift 点选）。selection 是其中的"主选"
  playing: false,
  t: 0,
  lastFrameTs: 0,
    media: {
      video: null, audio: null, videoName: '', audioName: '',
      videoFile: null, audioFile: null, videoMeta: null, audioMeta: null,   // 后几个给「自动保存 / 导出音轨」用
      videoDur: 0, audioDur: 0, peaks: null,               // 素材时长 + 音频波形（时间轴那两条轨用）
    },
  analysis: null,
  layerSeq: 0,
  assets: new Map(),      // 素材库：assetId -> { id, kind, name, file, url, el, duration, w, h, buffer, peaks }
  clipSel: null,          // 选中的片段 id（时间轴上那些块）
  suppressMedia: false,   // 导出"只要叠加层"时临时把底片藏掉
  muted: false,          // 预览总静音（走带栏那个喇叭）
    tplPick: null,         // 模板库里点选中的模板（只是选中，拖着往画面里放才会加图层）
    tplCollapsed: {},      // 模板库哪些分类是折叠的
    durationAuto: true,    // 工程时长是否跟着素材走（手动改过时长就关掉）
    tlScroll: 0,           // 时间轴图层区的上下滚动量（层数多的时候用）
    tlPack: true,          // 并轨：时间上不重叠的图层共用一行（省地方）
    tlFind: '',            // 图层索引里的搜索词，时间轴也跟着高亮
};
state.scene.addFx({ type: 'chromatic', amount: 0, enabled: false });

const off = makeCanvas(state.scene.width, state.scene.height, 1);      // 渲染用（1:1）

// ---------------------------------------------------------------- DOM
const $ = (id) => document.getElementById(id);
const preview = $('preview');
const stage = $('stage');
const tl = $('timeline');
const tlCtx = tl.getContext('2d');
let previewCtx = preview.getContext('2d');

// ---------------------------------------------------------------- 渲染
function renderAt(t) {
  const s = state.scene;
  syncTransitionLayers();     // 转场层永远跟着片段走（片段怎么改的都会被这里兜住）
  if (off.canvas.width !== s.width || off.canvas.height !== s.height) {
    off.canvas.width = s.width; off.canvas.height = s.height;
  }
  off.ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderFrame(off.ctx, s, t, {
    before: (ctx, sc, tt) => drawMedia(ctx, sc, tt),
    fxRunner: (ctx, sc, tt) => runFx(ctx, sc, tt, sc.fx, {}),
    silent: false,
  });
  return off.canvas;
}

/** 视频 / 图片作为"最底层"，模板再往上叠 */
function drawMedia(ctx, sc, t) {
  if (state.suppressMedia) return;
  // 有片段：按时间轴找此刻该显示的那些（多条轨就一层层往上画）
  if (sc.clips.length) {
    const tr = activeTransitionAt(t);
    const list = sc.visualClipsAt(t).filter((c) => {
      if (!tr) return true;
      if ((c.track || 0) !== (tr.clip.track || 0)) return true;      // 别的轨不受转场影响
      return c === (t < tr.center ? tr.prev : tr.clip);              // 这一轨在中点换段
    });
    for (const c of list) drawClipMedia(ctx, sc, c);
    return;
  }
  // 老工程：没有片段，退回单个素材
  const v = state.media.video;
  if (!v) return;
  if (v.tagName === 'IMG') {
    drawCover(ctx, v, sc.width, sc.height);
    return;
  }
  if (v.readyState < 2) return;
  drawCover(ctx, v, sc.width, sc.height);
}

/** 调色参数 → canvas 的 filter 字符串 */
function gradeFilter(g) {
  if (!g) return '';
  const parts = [];
  const on = (v, d) => (v === undefined || v === null ? d : v);
  if (on(g.brightness, 1) !== 1) parts.push('brightness(' + g.brightness + ')');
  if (on(g.contrast, 1) !== 1) parts.push('contrast(' + g.contrast + ')');
  if (on(g.saturation, 1) !== 1) parts.push('saturate(' + g.saturation + ')');
  if (on(g.hue, 0)) parts.push('hue-rotate(' + g.hue + 'deg)');
  if (on(g.blur, 0)) parts.push('blur(' + g.blur + 'px)');
  if (on(g.grayscale, 0)) parts.push('grayscale(' + g.grayscale + ')');
  if (on(g.sepia, 0)) parts.push('sepia(' + g.sepia + ')');
  if (on(g.invert, 0)) parts.push('invert(' + g.invert + ')');
  return parts.join(' ');
}

/**
 * 画一条画面片段：位置 / 缩放 / 不透明度 / 调色都在这里生效。
 *   scale = null  → 铺满画面（cover，老行为）
 *   scale = 0.35  → 占画面宽度的 35%（画中画），位置由 x / y 偏
 */
function drawClipMedia(ctx, sc, c) {
  const a = assetById(c.assetId);
  if (!a || !a.el) return;
  const isImg = a.kind === 'image';
  if (!isImg && a.el.readyState < 2) return;
  const sw = a.el.videoWidth || a.el.naturalWidth || sc.width;
  const sh = a.el.videoHeight || a.el.naturalHeight || sc.height;
  if (!sw || !sh) return;
  const filter = gradeFilter(c.grade);
  const op = clamp(c.opacity === undefined ? 1 : c.opacity, 0, 1);
  ctx.save();
  if (filter) ctx.filter = filter;
  if (op < 1) ctx.globalAlpha *= op;
  const cx = (0.5 + (c.x || 0)) * sc.width;
  const cy = (0.5 + (c.y || 0)) * sc.height;
  let dw, dh;
  if (c.scale === null || c.scale === undefined) {
    const k = Math.max(sc.width / sw, sc.height / sh);       // cover
    dw = sw * k; dh = sh * k;
  } else {
    dw = sc.width * c.scale;
    dh = dw * (sh / sw);
  }
  try { ctx.drawImage(a.el, cx - dw / 2, cy - dh / 2, dw, dh); } catch (_) {}
  ctx.restore();
}
function drawCover(ctx, el, w, h) {
  const sw = el.videoWidth || el.naturalWidth || w;
  const sh = el.videoHeight || el.naturalHeight || h;
  if (!sw || !sh) return;
  const scale = Math.max(w / sw, h / sh);
  const dw = sw * scale, dh = sh * scale;
  ctx.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function blit() {
  const s = state.scene;
  const box = preview.parentElement.getBoundingClientRect();
  const availW = Math.max(120, box.width - 32), availH = Math.max(80, box.height - 32);
  const scale = Math.min(availW / s.width, availH / s.height);
  const dw = Math.max(2, Math.round(s.width * scale)), dh = Math.max(2, Math.round(s.height * scale));
  if (preview.width !== dw || preview.height !== dh) {
    preview.width = dw; preview.height = dh;
    previewCtx = preview.getContext('2d');
  }
  previewCtx.clearRect(0, 0, dw, dh);
  previewCtx.drawImage(off.canvas, 0, 0, dw, dh);
  drawPreviewMarks(dw, dh);
  $('dropHint').classList.toggle('hidden', !!state.media.video);
  layoutEditOverlay();
}

/**
 * 预览上的多选标记：除了"主选"（那个带手柄的 DOM 选择框），
 * 其余一起选中的图层用细虚线描一圈；正在拉的框选矩形也画在这。
 */
function drawPreviewMarks(dw, dh) {
  if (!previewCtx) return;
  const strokeBox = (b, color, dash, width, fill) => {
    if (!b || b.w <= 0 || b.h <= 0) return;
    const x = b.x * dw, y = b.y * dh, w = b.w * dw, h = b.h * dh;
    if (fill) { previewCtx.fillStyle = fill; previewCtx.fillRect(x, y, w, h); }
    previewCtx.setLineDash(dash);
    previewCtx.lineWidth = width;
    previewCtx.strokeStyle = color;
    previewCtx.strokeRect(x + 0.5, y + 0.5, w, h);
    previewCtx.setLineDash([]);
  };

  for (const L of selectedLayers()) {
    if (L.id === state.selection) continue;          // 主选已经有 DOM 选择框了
    if (!L.covers(state.t)) continue;
    strokeBox(layerBoxFor(L), 'rgba(0,229,255,0.9)', [4, 3], 1.5, 'rgba(0,229,255,0.08)');
  }
  if (marquee) strokeBox(marqueeRect(marquee), 'rgba(255,255,255,0.95)', [5, 4], 1, 'rgba(255,75,31,0.12)');
}

function marqueeRect(m) {
  return { x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), w: Math.abs(m.x1 - m.x0), h: Math.abs(m.y1 - m.y0) };
}

/** 框选的矩形碰到了哪几层（只认此刻画面上真有的层，所见即所选） */
function layersInMarquee(m) {
  const r = marqueeRect(m);
  const out = [];
  for (const L of state.scene.layers) {
    if (!L.covers(state.t)) continue;
    const b = layerBoxFor(L);
    if (!b) continue;
    if (b.x + b.w < r.x || b.x > r.x + r.w || b.y + b.h < r.y || b.y > r.y + r.h) continue;
    out.push(L);
  }
  return out;
}

// ---------------------------------------------------------------- 主循环
let rafId = 0;
function loop(ts) {
  rafId = requestAnimationFrame(loop);
  const dt = state.lastFrameTs ? Math.min(0.25, (ts - state.lastFrameTs) / 1000) : 0;
  state.lastFrameTs = ts;
  const clockEl = state.media.audio || state.media.video;
  const dur = state.scene.duration;

  if (state.playing) {
    if (state.scene.clips.length) {
      // 有片段：时间轴自己走（片段是一段一段接起来的，不能拿某个元素的 currentTime 当钟）
      state.t += dt;
      syncMediaTo(state.t, true);
    } else if (clockEl && clockEl.tagName === 'VIDEO' || clockEl && clockEl.tagName === 'AUDIO') {
      state.t = clockEl.currentTime;
    } else {
      state.t += dt;
    }
    if (state.t >= dur) {
      if ($('chkLoop').checked) { setTime(0); state.t = 0; }
      else { state.t = dur; pause(); }
    }
    // 放大之后播放头跑出可见区，时间轴自己跟着滚
    if ((state.tlZoom || 1) > 1.01) {
      const V = tlView();
      if (state.t < V.start || state.t > V.start + V.span * 0.9) {
        state.tlStart = clamp(state.t - V.span * 0.25, 0, V.maxStart);
      }
    }
  }

  renderAt(state.t);
  blit();
  drawEditOverlay();
  updateTransport();
  drawTimeline();
  tickLayerIndex();
}

function updateTransport() {
  $('tcNow').textContent = timecode(state.t, state.scene.fps, true);
  $('tcTotal').textContent = timecode(state.scene.duration, state.scene.fps, true);
  if (!scrubbing) $('scrub').value = String(Math.round((state.t / Math.max(0.001, state.scene.duration)) * 1000));
  $('btnPlay').textContent = state.playing ? '❚❚' : '▶';
  updateToolButtons();      // 撤销 / 切开 / 复制 / 删除 的可用状态跟着选择走

  // 走带栏的「⚡ 闪白」：画面一直闪的时候，一抬眼就能关掉，不用翻右侧面板
  const flashes = (state.scene.fx || []).filter((s) => s.type === 'flash' || s.type === 'invert');
  const chip = $('flashChip');
  if (chip) {
    chip.style.display = flashes.length ? '' : 'none';
    if (flashes.length) $('chkFlash').checked = flashes.some((s) => s.enabled !== false);
  }
}

function setTime(t) {
  const v = clamp(t, 0, state.scene.duration);
  state.t = v;
  syncMediaTo(v, false);
  if (!state.playing) { renderAt(v); blit(); updateTransport(); drawTimeline(); }
}

/**
 * 把素材元素对齐到时间轴上的某一刻。
 *
 * 有片段时：只让"此刻该出现的那一条"在放，别的都暂停 —— 切换片段就是在这里发生的。
 * 没有片段（老工程）：还是原来那套，直接 seek 那两个元素。
 */
function syncMediaTo(t, playing) {
  const sc = state.scene;
  if (!sc.clips.length) {
    for (const el of [state.media.video, state.media.audio]) {
      if (el && el.tagName !== 'IMG') { try { el.currentTime = t; } catch (_) {} }
    }
    return;
  }
  const active = new Map();
  for (const c of sc.visualClipsAt(t)) active.set(c.assetId, c);   // 多条视频轨一起放
  for (const c of sc.audioClipsAt(t)) if (!active.has(c.assetId)) active.set(c.assetId, c);
  for (const a of state.assets.values()) {
    const el = a.el;
    if (!el || el.tagName === 'IMG') continue;
    const c = active.get(a.id);
    if (!c) { if (!el.paused) el.pause(); continue; }
    const want = c.sourceAt(t);
    if (Math.abs(el.currentTime - want) > 0.3) { try { el.currentTime = want; } catch (_) {} }
    const sp = clamp(c.speed || 1, 0.1, 8);
    if (Math.abs((el.playbackRate || 1) - sp) > 0.01) { try { el.playbackRate = sp; } catch (_) {} }
    const vol = state.muted ? 0 : clamp(clipGainAt(c, t), 0, 1);
    if (Math.abs(el.volume - vol) > 0.005) el.volume = vol;
    el.muted = state.muted;
    if (playing) { if (el.paused) el.play().catch(() => {}); }
    else if (!el.paused) el.pause();
  }
}
function play() {
  state.playing = true;
  if (state.scene.clips.length) { syncMediaTo(state.t, true); return; }
  // 视频和音乐都要放：以前只 play 了其中一个，结果"有音乐时画面是卡住的"。
  for (const el of [state.media.video, state.media.audio]) {
    if (!el || el.tagName === 'IMG') continue;
    el.play().catch(() => {
      // 浏览器拦未静音的自动播放时，退回静音播放，至少画面会走
      try { el.muted = true; el.play().catch(() => {}); } catch (_) {}
      applyAudio();
    });
  }
}
function pause() {
  state.playing = false;
  if (state.scene.clips.length) { syncMediaTo(state.t, false); return; }
  for (const el of [state.media.video, state.media.audio]) if (el && el.tagName !== 'IMG') el.pause();
}
function togglePlay() { state.playing ? pause() : play(); }

/**
 * 预览声音。
 *
 * 规则：
 *  · 只载入了视频 → 视频自带的声音正常放（这才是"导入的视频要有声音"）
 *  · 另外载入了音乐 → 视频原声自动静掉，只放那支音乐（否则两轨会撞在一起）
 *  · 喇叭按钮 = 总静音，一键全静
 */
function applyAudio() {
  // 有片段：每段的音量自己说了算（剪辑页里有滑杆），这里只管总静音
  if (state.scene.clips.length) {
    for (const a of state.assets.values()) {
      if (!a.el || a.el.tagName === 'IMG') continue;
      a.el.muted = state.muted;
      if (a.el.tagName === 'AUDIO') a.el.volume = state.muted ? 0 : 1;
    }
    const b2 = $('btnMute');
    if (b2) {
      b2.textContent = state.muted ? '🔇' : '🎵';
      b2.title = state.muted ? '预览已静音（点击恢复）' : '按片段的音量播放（剪辑页可调）';
    }
    return;
  }
  const v = state.media.video, a = state.media.audio;
  if (v && v.tagName === 'VIDEO') v.muted = state.muted || !!a;
  if (a) a.muted = state.muted;
  const btn = $('btnMute');
  if (btn) {
    btn.textContent = state.muted ? '🔇' : (a ? '🎵' : '🔊');
    btn.title = state.muted
      ? '预览已静音（点击恢复）'
      : (a ? '正在放载入的音乐，视频原声已静掉' : '预览声音开');
  }
}

// ---------------------------------------------------------------- 时间轴绘制
let scrubbing = false;
let drag = null;
let dragClip = null;        // 正在拖的素材片段（挪位置 / 拉边裁剪）

function tlGeom() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = tl.clientWidth, h = tl.clientHeight;
  if (tl.width !== Math.round(w * dpr) || tl.height !== Math.round(h * dpr)) {
    tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr);
  }
  tlCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}
const RULER_H = 22;
const ROW_H = 22;
const ROW_GAP = 3;
// 媒体轨：视频在上、音频在下（跟剪辑软件的习惯一致），下面是图层、最底下是字幕
const MEDIA_TOP = RULER_H + 4;
const VID_H = 26;
const AUD_H = 30;
const TRACK_TOP = MEDIA_TOP + VID_H + 3 + AUD_H + 7;
let rowMap = new Map();
let clipRowMap = new Map();      // clipId -> { band, x, w, y, h }（时间轴上的命中区）
let transMarkMap = new Map();    // clipId -> { x, w, y, h }（两个片段中间那个转场小方块）

/** 相邻两段中间的小方块：点一下就能加 / 换 / 去掉转场（剪映那个位置） */
function drawTransitionMarks(list, y, h, sx) {
  const sorted = list.slice().sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i], prev = sorted[i - 1];
    if (Math.abs(prev.end - c.start) > 0.08) continue;      // 中间有缝就不给转场
    const cx = sx(c.start);
    const cy = y + h / 2;
    const w = 13, hh = h - 6;
    const has = !!c.trans;
    tlCtx.save();
    tlCtx.beginPath();
    roundRectPath(tlCtx, cx - w / 2, cy - hh / 2, w, hh, 3);
    tlCtx.fillStyle = has ? 'rgba(255,120,60,0.95)' : 'rgba(12,14,18,0.85)';
    tlCtx.fill();
    tlCtx.strokeStyle = has ? '#ffd0b0' : 'rgba(255,255,255,0.5)';
    tlCtx.lineWidth = 1;
    tlCtx.stroke();
    tlCtx.fillStyle = has ? '#2a0f04' : 'rgba(255,255,255,0.75)';
    tlCtx.font = '700 10px ' + getComputedStyle(document.body).getPropertyValue('--sans');
    tlCtx.textAlign = 'center';
    tlCtx.textBaseline = 'middle';
    tlCtx.fillText('⋈', cx, cy + 0.5);
    tlCtx.textAlign = 'left';
    tlCtx.restore();
    transMarkMap.set(c.id, { x: cx - w / 2 - 2, w: w + 4, y: cy - hh / 2, h: hh });
  }
}

const CLIP_COLOR = {
  video: { fill: 'rgba(0,229,255,0.20)', line: 'rgba(0,229,255,0.80)', text: '#d6f6ff' },
  image: { fill: 'rgba(120,230,140,0.20)', line: 'rgba(120,230,140,0.80)', text: '#dcffe4' },
  audio: { fill: 'rgba(255,204,0,0.18)', line: 'rgba(255,204,0,0.80)', text: '#ffeeb8' },
};

/** 媒体轨上的一条：缩略图 / 波形 + 名字 + 选中态 + 左右的裁剪把手 */
function drawClipBlock(c, bx, y, bw, h, isAudio, isSel, track) {
  const col = CLIP_COLOR[c.kind] || CLIP_COLOR.video;
  const a = assetById(c.assetId);
  tlCtx.save();
  tlCtx.beginPath();
  roundRectPath(tlCtx, bx, y, bw, h, 3);
  tlCtx.fillStyle = col.fill;
  tlCtx.fill();
  tlCtx.clip();

  // 底：视频/图片铺缩略图，音频铺波形
  if (a && a.el && a.kind !== 'audio' && a.el.readyState >= 2) {
    const sw = a.el.videoWidth || a.el.naturalWidth || 16;
    const sh = a.el.videoHeight || a.el.naturalHeight || 9;
    const sc2 = Math.max(bw / sw, h / sh);
    const dw = sw * sc2, dh = sh * sc2;
    tlCtx.globalAlpha = 0.55;
    try { tlCtx.drawImage(a.el, bx + (bw - dw) / 2, y + (h - dh) / 2, dw, dh); } catch (_) {}
    tlCtx.globalAlpha = 1;
  } else if (isAudio && a && a.peaks && a.peaks.length && a.duration) {
    const midY = y + h / 2;
    const pk = a.peaks;
    const per = a.duration / pk.length;
    const x0b = bx;
    tlCtx.fillStyle = 'rgba(255,204,0,0.72)';
    for (let x = 0; x < bw; x += 2) {
      const src = c.in + (x / bw) * c.dur;              // 这一列对应素材里的第几秒
      const i = Math.floor(src / per);
      if (i < 0 || i >= pk.length) continue;
      const hh = Math.max(0.8, pk[i] * (h - 6) * 0.5);
      tlCtx.fillRect(x0b + x, midY - hh, 1.4, hh * 2);
    }
  }
  tlCtx.restore();

  // 名字（压在左上）
  const label = (c.kind === 'image' ? '图片 ' : c.kind === 'audio' ? '音频 ' : '') + (c.name || '');
  tlCtx.font = '600 10.5px ' + getComputedStyle(document.body).getPropertyValue('--sans');
  const tw = Math.min(bw - 12, tlCtx.measureText(label).width + 8);
  if (tw > 14) {
    tlCtx.fillStyle = 'rgba(0,0,0,0.55)';
    tlCtx.fillRect(bx + 3, y + 2, tw, 13);
    tlCtx.fillStyle = col.text;
    tlCtx.save();
    tlCtx.beginPath(); tlCtx.rect(bx + 3, y + 2, tw, 13); tlCtx.clip();
    tlCtx.fillText(label, bx + 6, y + 12);
    tlCtx.restore();
  }

  // 轨号 / 变速 标一下，一眼看得出这条不是原速底轨
  const tags = [];
  if (track) tags.push('轨' + (track + 1));
  if ((c.speed || 1) !== 1) tags.push((c.speed).toFixed(2).replace(/0$/, '') + '×');
  if (c.grade) tags.push('调色');
  if (tags.length) {
    tlCtx.font = '700 9.5px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    const txt = tags.join(' ');
    const tw2 = tlCtx.measureText(txt).width + 8;
    if (bw > tw2 + 20) {
      tlCtx.fillStyle = 'rgba(255,120,60,0.92)';
      roundRectPath(tlCtx, bx + bw - tw2 - 3, y + 2, tw2, 12, 2);
      tlCtx.fill();
      tlCtx.fillStyle = '#2a0f04';
      tlCtx.fillText(txt, bx + bw - tw2 + 1, y + 11);
    }
  }

  // 边框 / 选中态 / 裁剪把手
  tlCtx.beginPath();
  roundRectPath(tlCtx, bx + 0.5, y + 0.5, Math.max(1, bw - 1), h - 1, 3);
  tlCtx.strokeStyle = isSel ? '#ffffff' : col.line;
  tlCtx.lineWidth = isSel ? 2 : 1;
  tlCtx.stroke();
  if (isSel) {
    tlCtx.fillStyle = '#ffffff';
    tlCtx.fillRect(bx, y, 4, h);              // 左把手（拖 = 改入点 / 起点）
    tlCtx.fillRect(bx + bw - 4, y, 4, h);     // 右把手（拖 = 改长度）
  }
}

function drawClipTrack(band, y, h, x0, x1, sx) {
  tlCtx.fillStyle = band === 'audio' ? 'rgba(255,204,0,0.05)' : 'rgba(0,229,255,0.055)';
  tlCtx.fillRect(x0, y, x1 - x0, h);
  const list = state.scene.clips.filter((c) => clipBand(c.kind) === band);
  if (list.length) {
    tlCtx.save();
    tlCtx.beginPath(); tlCtx.rect(x0, y, x1 - x0, h); tlCtx.clip();   // 放大后片段会超出可见区
    for (const c of list) {
      const bx = sx(c.start);
      const bw = Math.max(6, sx(c.end) - bx);
      // 轨号越大越靠上一点，时间上重叠的两条就能看出来是两条轨
      const tOff = band === 'video' ? Math.min(7, (c.track || 0) * 3) : 0;
      const cy = y + 2 + tOff, ch = h - 4 - tOff;
      drawClipBlock(c, bx, cy, bw, ch, band === 'audio', c.id === state.clipSel, c.track || 0);
      clipRowMap.set(c.id, { band, x: bx, w: bw, y: cy, h: ch });
    }
    tlCtx.restore();
    if (band === 'video') drawTransitionMarks(list, y, h, sx);
    return;
  }
  // 没有片段：老工程还有单个素材的话，把它当一整条画出来（读起来和以前一样）
  const legacy = band === 'audio' ? state.media.audio : state.media.video;
  if (legacy) {
    const dur = band === 'audio' ? (state.media.audioDur || 0) : (state.media.videoDur || 0);
    const bw = Math.max(6, sx(Math.min(dur || state.scene.duration, state.scene.duration)) - sx(0));
    tlCtx.fillStyle = band === 'audio' ? 'rgba(255,204,0,0.22)' : 'rgba(0,229,255,0.22)';
    roundRectPath(tlCtx, sx(0), y + 2, bw, h - 4, 3);
    tlCtx.fill();
    // 老工程那支音乐的波形，别因为改成片段轨就丢了
    if (band === 'audio' && state.media.peaks && state.media.peaks.length) {
      tlCtx.save();
      tlCtx.beginPath(); roundRectPath(tlCtx, sx(0), y + 2, bw, h - 4, 3); tlCtx.clip();
      const pk = state.media.peaks;
      const per = (state.media.audioDur || state.scene.duration) / pk.length;
      tlCtx.fillStyle = 'rgba(255,204,0,0.72)';
      for (let x = sx(0); x < sx(0) + bw; x += 2) {
        const i = Math.floor(((x - sx(0)) / bw) * (state.media.audioDur || state.scene.duration) / per);
        if (i < 0 || i >= pk.length) continue;
        const hh = Math.max(0.8, pk[i] * (h - 10) * 0.5);
        tlCtx.fillRect(x, y + h / 2 - hh, 1.4, hh * 2);
      }
      tlCtx.restore();
    }
    tlCtx.strokeStyle = band === 'audio' ? 'rgba(255,204,0,0.75)' : 'rgba(0,229,255,0.75)';
    tlCtx.lineWidth = 1; tlCtx.stroke();
    tlCtx.fillStyle = band === 'audio' ? '#ffe9a8' : '#cdf3ff';
    tlCtx.font = '600 11px ' + getComputedStyle(document.body).getPropertyValue('--sans');
    tlCtx.save();
    tlCtx.beginPath(); tlCtx.rect(sx(0) + 4, y, Math.max(10, bw - 8), h); tlCtx.clip();
    tlCtx.fillText((band === 'audio' ? '音频  ' : '') + (band === 'audio' ? state.media.audioName : state.media.videoName || '')
      + '  ' + dur.toFixed(2) + 's', sx(0) + 7, y + h / 2 + 4);
    tlCtx.restore();
    return;
  }
  tlCtx.fillStyle = '#4a505b';
  tlCtx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  tlCtx.fillText(band === 'audio'
    ? '音频轨 · 未载入（拖一首歌进来会自动分析卡点）'
    : '视频轨 · 未载入（把视频 / 图片拖进画面区）', x0 + 8, y + h / 2 + 4);
}

function drawTimeline() {
  if (!tl.clientWidth) return;
  const { w, h } = tlGeom();
  const s = state.scene;
  const x0 = 8, x1 = w - 8;
  const V = tlView();
  const sx = (t) => V.x0 + (t - V.start) * V.pxPerSec;
  const bg = '#121317';
  tlCtx.clearRect(0, 0, w, h);
  tlCtx.fillStyle = bg; tlCtx.fillRect(0, 0, w, h);

  // 标尺
  tlCtx.fillStyle = '#0e0f12';
  tlCtx.fillRect(0, 0, w, RULER_H);
  // 刻度按"看得见的那一段"来定，放大之后才不会还是 5 秒一根
  const step = niceStep(V.span, (x1 - x0) / 90);
  tlCtx.strokeStyle = '#2a2d34'; tlCtx.lineWidth = 1;
  tlCtx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  tlCtx.textBaseline = 'middle';
  const firstTick = Math.floor(V.start / step) * step;
  for (let t = firstTick; t <= V.start + V.span + 1e-6; t += step) {
    if (t < 0) continue;
    const x = sx(t);
    if (x < x0 - 20 || x > x1 + 20) continue;
    tlCtx.beginPath(); tlCtx.moveTo(x + 0.5, 0); tlCtx.lineTo(x + 0.5, h); tlCtx.stroke();
    tlCtx.fillStyle = '#5c626d';
    tlCtx.fillText(fmtShort(t), x + 4, RULER_H / 2);
  }

  // 拍点
  const bm = s.beat;
  const beats = bm.hitsIn(Math.max(0, V.start), Math.min(s.duration, V.start + V.span), 1);
  const strong = new Set(bm.hitsIn(Math.max(0, V.start), Math.min(s.duration, V.start + V.span), 0.25)
    .filter((_, i) => i % 4 === 0).map((v) => +v.toFixed(4)));
  for (const b of beats) {
    const x = sx(b);
    const isStrong = strong.has(+b.toFixed(4));
    tlCtx.fillStyle = isStrong ? 'rgba(0,229,255,0.55)' : 'rgba(255,255,255,0.14)';
    tlCtx.fillRect(x - 0.5, RULER_H, 1, h - RULER_H);
  }

  // 图层
  // ---- 媒体轨：视频 / 图片 / 音频，每个片段一块 ----
  const monoS = getComputedStyle(document.body).getPropertyValue('--mono');
  const vidY = MEDIA_TOP;
  const audY = MEDIA_TOP + VID_H + 3;
  clipRowMap = new Map();
  transMarkMap = new Map();
  drawClipTrack('video', vidY, VID_H, x0, x1, sx);
  drawClipTrack('audio', audY, AUD_H, x0, x1, sx);

  // ---- 图层（可上下滚动）----
  const capY = h - ROW_H - 4;
  const areaTop = TRACK_TOP, areaBot = capY - 4;
  const rows = tlRows();
  const contentH = rows.count * (ROW_H + ROW_GAP) - ROW_GAP;
  const maxScroll = Math.max(0, contentH - (areaBot - areaTop));
  state.tlScroll = clamp(state.tlScroll || 0, 0, maxScroll);
  const rowsEl = $('tlRows');
  if (rowsEl) rowsEl.textContent = `${rows.count} 行 / ${s.layers.length} 层`;
  rowMap = new Map();
  tlCtx.save();
  tlCtx.beginPath();
  tlCtx.rect(x0, areaTop, x1 - x0, Math.max(0, areaBot - areaTop));
  tlCtx.clip();
  const find = (state.tlFind || '').trim().toLowerCase();
  s.layers.forEach((L, i) => {
    const y = TRACK_TOP + rows.place.get(L.id) * (ROW_H + ROW_GAP) - state.tlScroll;
    if (y + ROW_H < areaTop - 2 || y > areaBot + 2) return;
    const bx = sx(L.start), bw = Math.max(3, sx(L.end) - sx(L.start));
    rowMap.set(L.id, { y, x: bx, w: bw });
    const tpl = listTemplates().find((t) => t.id === L.template);
    const isSel = isSelected(L.id);        // 框选 / Shift 加选都算选中
    const isMain = L.id === state.selection;
    const hit = !find || (tpl ? tpl.name : L.template).toLowerCase().includes(find)
      || String(L.template).toLowerCase().includes(find) || String(L.name || '').toLowerCase().includes(find);
    tlCtx.fillStyle = !L.enabled ? '#2a2d34' : isMain ? '#ff4b1f' : isSel ? '#c8341a' : 'rgba(255,75,31,0.55)';
    tlCtx.globalAlpha = (!find || hit) ? 1 : 0.22;     // 搜索时，没中的层淡下去
    roundRectPath(tlCtx, bx, y, bw, ROW_H, 3); tlCtx.fill();
    tlCtx.globalAlpha = 1;
    tlCtx.fillStyle = isMain ? '#1a0a04' : '#e9ecf1';
    tlCtx.font = '600 11px ' + getComputedStyle(document.body).getPropertyValue('--sans');
    const nm = (tpl ? tpl.name : L.template) + '  ' + L.start.toFixed(2) + 's→' + L.end.toFixed(2) + 's';
    tlCtx.save(); tlCtx.beginPath(); tlCtx.rect(bx + 6, y, bw - 12, ROW_H); tlCtx.clip();
    tlCtx.fillText(nm, bx + 7, y + ROW_H / 2 + 0.5);
    tlCtx.restore();
    if (isMain) {
      tlCtx.fillStyle = '#ffffff';
      tlCtx.fillRect(bx - 2, y, 4, ROW_H);
      tlCtx.fillRect(bx + bw - 2, y, 4, ROW_H);
    }
    if (find && hit && !isSel) {      // 搜到的层描个亮边，一眼能找到
      tlCtx.strokeStyle = '#00e5ff'; tlCtx.lineWidth = 1.5;
      roundRectPath(tlCtx, bx + 0.75, y + 0.75, Math.max(2, bw - 1.5), ROW_H - 1.5, 3);
      tlCtx.stroke();
    }
  });
  // 正在拉的框选
  if (tlMarquee) {
    const mx0 = Math.min(tlMarquee.x0, tlMarquee.x1), mx1 = Math.max(tlMarquee.x0, tlMarquee.x1);
    const my0 = Math.min(tlMarquee.y0, tlMarquee.y1), my1 = Math.max(tlMarquee.y0, tlMarquee.y1);
    tlCtx.fillStyle = 'rgba(255,75,31,0.14)';
    tlCtx.fillRect(mx0, my0, mx1 - mx0, my1 - my0);
    tlCtx.setLineDash([5, 4]);
    tlCtx.strokeStyle = 'rgba(255,255,255,0.9)';
    tlCtx.lineWidth = 1;
    tlCtx.strokeRect(mx0 + 0.5, my0 + 0.5, mx1 - mx0, my1 - my0);
    tlCtx.setLineDash([]);
  }
  tlCtx.restore();

  // 图层区的滚动条（层数多到装不下时出现）
  if (maxScroll > 1) {
    const trackH = areaBot - areaTop;
    tlCtx.fillStyle = 'rgba(255,255,255,0.07)';
    tlCtx.fillRect(x1 - 3, areaTop, 3, trackH);
    const thumbH = Math.max(20, trackH * (trackH / contentH));
    const thumbY = areaTop + (trackH - thumbH) * (state.tlScroll / maxScroll);
    tlCtx.fillStyle = 'rgba(255,255,255,0.38)';
    roundRectPath(tlCtx, x1 - 3, thumbY, 3, thumbH, 1.5);
    tlCtx.fill();
  }

  // 字幕轨
  if (capY > TRACK_TOP) {
    tlCtx.fillStyle = 'rgba(255,255,255,0.04)';
    tlCtx.fillRect(x0, capY, x1 - x0, ROW_H);
    for (const c of s.captions) {
      const bx = sx(c.start), bw = Math.max(3, sx(c.end) - sx(c.start));
      tlCtx.fillStyle = 'rgba(57,255,136,0.75)';
      roundRectPath(tlCtx, bx, capY + 2, bw, ROW_H - 4, 2); tlCtx.fill();
    }
  }

  // 播放头
  const px = sx(state.t);
  tlCtx.fillStyle = '#ffffff';
  tlCtx.fillRect(px - 0.5, 0, 1.5, h);
  tlCtx.beginPath(); tlCtx.moveTo(px - 5, 0); tlCtx.lineTo(px + 5, 0); tlCtx.lineTo(px, 8); tlCtx.closePath(); tlCtx.fill();
}

/** 图层区能滚多远（层数装不下时 > 0） */
/**
 * 时间轴的行分配。
 *   并轨模式（默认）：时间上不重叠的图层共用一行 —— 一个动效一行太浪费，
 *   13 层经常能压到 3~4 行，不用滚动就看全。
 *   关掉就是原来的"一层一行"，方便按栈序对照。
 */
function tlRows() {
  const ls = state.scene.layers;
  if (state.tlPack === false) {
    const place = new Map();
    ls.forEach((L, i) => place.set(L.id, i));
    return { place, count: Math.max(1, ls.length) };
  }
  const ends = [];
  const place = new Map();
  const sorted = ls.slice().sort((a, b) => a.start - b.start || a.end - b.end);
  for (const L of sorted) {
    let r = ends.findIndex((e) => L.start >= e - 0.001);
    if (r < 0) { ends.push(L.end); r = ends.length - 1; }
    else ends[r] = Math.max(ends[r], L.end);
    place.set(L.id, r);
  }
  return { place, count: Math.max(1, ends.length) };
}

function tlScrollMax() {
  const h = tl.clientHeight;
  const capY = h - ROW_H - 4;
  const areaH = Math.max(0, (capY - 4) - TRACK_TOP);
  const contentH = tlRows().count * (ROW_H + ROW_GAP) - ROW_GAP;
  return Math.max(0, contentH - areaH);
}

/** 滚轮滚图层区 */
function tlScrollBy(dy) {
  const max = tlScrollMax();
  if (max <= 0) return false;
  const next = clamp((state.tlScroll || 0) + dy, 0, max);
  if (next === state.tlScroll) return false;
  state.tlScroll = next;
  drawTimeline();
  return true;
}

/** 选中某层时把它滚进可见区（不然点了下面那层也不知道在哪） */
function scrollLayerIntoView(id) {
  const rows = tlRows();
  const i = rows.place.has(id) ? rows.place.get(id) : -1;
  if (i < 0) return;
  const h = tl.clientHeight;
  const capY = h - ROW_H - 4;
  const areaTop = TRACK_TOP, areaH = Math.max(1, (capY - 4) - TRACK_TOP);
  const y = i * (ROW_H + ROW_GAP);
  const cur = state.tlScroll || 0;
  if (y < cur) state.tlScroll = y;
  else if (y + ROW_H > cur + areaH) state.tlScroll = y + ROW_H - areaH;
  state.tlScroll = clamp(state.tlScroll, 0, tlScrollMax());
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function niceStep(duration, target) {
  const raw = duration / Math.max(1, target);
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return steps.find((s) => s >= raw) || 300;
}
function fmtShort(t) {
  if (t < 60) return t.toFixed(t % 1 ? 2 : 0) + 's';
  return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
}

// ---------------------------------------------------------------- 时间轴交互
// ---------------------------------------------------------------- 撤销 / 重做
/**
 * 撤销栈。
 *
 * 记法和自动保存是同一个思路：每 350ms 比一次工程内容，变了就把这一版压栈
 * （比在每个改参数的地方插钩子可靠 —— 那种做法迟早漏掉几个入口）。
 *
 * 两个细节：
 *   · 拖动 / 框选过程中不记，一次拖拽只留一条历史；
 *   · 松手后 800ms 内的小改动并进上一条，免得打字打十个字留下十条历史。
 */
const HISTORY_MAX = 60;
const history = { list: [], at: -1, last: '', lastAt: 0 };
function busyEditing() { return !!(pdrag || dragClip || marquee || tlMarquee || drag || scrubbing); }

function historyReset() {
  history.list = [];
  history.at = 0;
  try { history.last = JSON.stringify(state.scene.toJSON()); } catch (_) { history.last = ''; }
  history.list.push(history.last);
  history.lastAt = Date.now();
  updateToolButtons();
}

function historyTick() {
  if (busyEditing()) return;
  let json = '';
  try { json = JSON.stringify(state.scene.toJSON()); } catch (_) { return; }
  if (json === history.last) return;
  const now = Date.now();
  if (now - history.lastAt < 800 && history.at > 0) {
    history.list[history.at] = json;          // 并进上一条
  } else {
    history.list = history.list.slice(0, history.at + 1);
    history.list.push(json);
    if (history.list.length > HISTORY_MAX) history.list.shift();
    history.at = history.list.length - 1;
  }
  history.last = json;
  history.lastAt = now;
  updateToolButtons();
}

function historyStep(delta) {
  const to = history.at + delta;
  if (to < 0 || to >= history.list.length) return false;
  history.at = to;
  history.last = history.list[to];
  history.lastAt = Date.now();
  restoreHistory(history.list[to]);
  updateToolButtons();
  toast(delta < 0 ? '撤销一步' : '重做一步');
  return true;
}

/** 把某一版工程装回去（时间轴位置和片段选中尽量保住） */
function restoreHistory(json) {
  const t = state.t;
  const clipSel = state.clipSel;
  state.scene = Scene.fromJSON(JSON.parse(json));
  state.selection = null;
  state.selected = new Set();
  state.clipSel = state.scene.clips.some((c) => c.id === clipSel) ? clipSel : null;
  syncTransitionLayers();
  markIndexDirty();
  resize(); drawTimeline(); renderRight(); renderAt(t); blit();
  autosaveNow(true);
}

function duplicateSelectedClip() {
  const c = selectedClip();
  if (!c) { toast('先点一个片段'); return null; }
  const copy = new Clip(Object.assign({}, c.toJSON(), { id: null, start: c.end }));
  state.scene.clips.push(copy);
  state.clipSel = copy.id;
  clipsFitDuration(); syncTransitionLayers(); markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  toast('复制了一段');
  return copy;
}

// ---------------------------------------------------------------- 时间轴工具栏
const TL_ICONS = {
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  cut: '<circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="18" r="2.6"/><path d="M7.9 16.1 19 4"/><path d="M16.1 16.1 5 4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M10 11v6M14 11v6"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z"/><path d="M6 8h4M14 8h4"/>',
  zoomIn: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/><path d="M11 8.5v5M8.5 11h5"/>',
  zoomOut: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.3-4.3"/><path d="M8.5 11h5"/>',
  fit: '<path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4"/>',
};

let btnUndo = null, btnRedo = null, btnSplit = null, btnCopy = null, btnClipDel = null, btnSnap = null;
let btnZoomIn = null, btnZoomOut = null, btnZoomFit = null, tlZoomLabel = null;

function iconBtn(icon, title, onClick) {
  const b = document.createElement('button');
  b.className = 'tl-btn';
  b.title = title;
  b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round">' + TL_ICONS[icon] + '</svg>';
  b.addEventListener('click', onClick);
  return b;
}

function buildTimelineTools() {
  const bar = $('tlTools');
  if (!bar) return;
  bar.textContent = '';
  const sep = () => { const s = document.createElement('span'); s.className = 'tl-sep'; return s; };

  btnUndo = iconBtn('undo', '撤销（Ctrl+Z）', () => historyStep(-1));
  btnRedo = iconBtn('redo', '重做（Ctrl+Shift+Z）', () => historyStep(1));
  bar.appendChild(btnUndo); bar.appendChild(btnRedo);
  bar.appendChild(sep());

  btnSplit = iconBtn('cut', '在播放头切开选中的片段（S）', () => splitClipAt(state.t));
  btnCopy = iconBtn('copy', '复制选中的片段接在后面（Ctrl+D）', () => duplicateSelectedClip());
  btnClipDel = iconBtn('trash', '删掉选中的片段，没选片段时删图层（Del）', () => {
    if (selectedClip()) deleteSelectedClip();
    else deleteSelectedLayers();
  });
  bar.appendChild(btnSplit); bar.appendChild(btnCopy); bar.appendChild(btnClipDel);
  bar.appendChild(sep());

  state.clipSnap = state.clipSnap !== false;
  btnSnap = iconBtn('magnet', '拖动片段时吸附播放头 / 相邻边缘', () => {
    state.clipSnap = !state.clipSnap;
    updateToolButtons();
  });
  bar.appendChild(btnSnap);

  bar.appendChild(sep());
  btnZoomOut = iconBtn('zoomOut', '缩小时间轴（Ctrl/Alt + 滚轮也行）', () => tlZoomStep(-1));
  btnZoomIn = iconBtn('zoomIn', '放大时间轴（Ctrl/Alt + 滚轮也行）', () => tlZoomStep(1));
  btnZoomFit = iconBtn('fit', '整条铺满', () => tlZoomFit());
  tlZoomLabel = document.createElement('span');
  tlZoomLabel.className = 'tl-hint';
  tlZoomLabel.style.marginLeft = '2px';
  bar.appendChild(btnZoomOut); bar.appendChild(btnZoomIn); bar.appendChild(btnZoomFit);
  bar.appendChild(tlZoomLabel);

  const grow = document.createElement('span');
  grow.className = 'grow';
  bar.appendChild(grow);
  const hint = document.createElement('span');
  hint.className = 'tl-hint';
  hint.textContent = '拖片段挪位置 · 拖两边白条裁剪 · S 切开';
  bar.appendChild(hint);
  updateToolButtons();
}

function updateToolButtons() {
  if (btnUndo) btnUndo.disabled = history.at <= 0;
  if (btnRedo) btnRedo.disabled = history.at >= history.list.length - 1;
  const c = selectedClip();
  if (btnSplit) btnSplit.disabled = !c || state.t <= c.start + 0.05 || state.t >= c.end - 0.05;
  if (btnCopy) btnCopy.disabled = !c;
  if (btnClipDel) btnClipDel.disabled = !c && !state.selection && !state.selected.size;
  if (btnSnap) btnSnap.classList.toggle('on', state.clipSnap !== false);
  const V = tlView();
  if (btnZoomOut) btnZoomOut.disabled = V.zoom <= 1.001;
  if (btnZoomFit) btnZoomFit.disabled = V.zoom <= 1.001;
  if (tlZoomLabel) tlZoomLabel.textContent = V.zoom <= 1.001 ? '整条' : Math.round(V.zoom * 100) + '%';
}

/** 像素 → 秒（不做卡点吸附；拖片段时用这个，不然每一动都被吸走） */
/**
 * 时间轴的"取景框"：缩放 + 横向滚动。
 *
 *   tlZoom = 1 表示整条铺满（默认，和以前一样）；放大后只显示其中一段，
 *   tlStart 是左边缘的时间。滚轮 / 工具按钮 / 播放头都会动它。
 */
function tlView() {
  const w = Math.max(1, tl.clientWidth - 16);
  const dur = Math.max(0.1, state.scene.duration);
  const zoom = clamp(state.tlZoom || 1, 1, 400);
  const pxPerSec = (w / dur) * zoom;
  const span = w / pxPerSec;
  const maxStart = Math.max(0, dur - span);
  const start = clamp(state.tlStart || 0, 0, maxStart);
  state.tlStart = start;
  return { x0: 8, x1: 8 + w, w, dur, zoom, pxPerSec, span, start, maxStart };
}

/** 以某个时间点为中心缩放（滚轮缩放用） */
function tlZoomAt(factor, anchorT) {
  const before = tlView();
  const t = anchorT === undefined ? before.start + before.span / 2 : anchorT;
  state.tlZoom = clamp(before.zoom * factor, 1, 400);
  const after = tlView();
  // 让锚点在屏幕上的位置尽量不动
  state.tlStart = clamp(t - (t - before.start) * (after.span / before.span), 0, after.maxStart);
  drawTimeline();
  updateToolButtons();
}

function tlZoomStep(delta) {
  const v = tlView();
  tlZoomAt(delta > 0 ? 1.4 : 1 / 1.4, v.start + v.span / 2);
}

function tlZoomFit() {
  state.tlZoom = 1;
  state.tlStart = 0;
  drawTimeline();
  updateToolButtons();
}

function tlTimeAtRaw(clientX) {
  const r = tl.getBoundingClientRect();
  const V = tlView();
  const t = V.start + ((clientX - r.left) - V.x0) / V.pxPerSec;
  return clamp(t, 0, state.scene.duration);
}

/** 一根手指头大概几个像素 = 几秒（吸附容差用） */
function tlPxToTime(px) {
  return px / tlView().pxPerSec;
}

/** 拖片段时吸一下：播放头 / 时间轴两头 / 别的片段边缘 */
function snapClipTime(t, ignoreId) {
  if (state.clipSnap === false) return t;
  const tol = tlPxToTime(7);
  let best = t, bestD = tol;
  const cands = [0, state.scene.duration, state.t];
  for (const o of state.scene.clips) {
    if (o.id === ignoreId) continue;
    cands.push(o.start, o.end);
  }
  for (const v of cands) {
    const d = Math.abs(v - t);
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** 鼠标落在哪条媒体轨上（视频轨 / 音频轨） */
function mediaBandAt(y) {
  if (y >= MEDIA_TOP + VID_H + 3 && y < MEDIA_TOP + VID_H + 3 + AUD_H) return 'audio';
  if (y >= MEDIA_TOP && y < MEDIA_TOP + VID_H) return 'video';
  return null;
}

/** 拖动片段：挪位置 / 拉左右边缘裁剪 */
function applyClipDrag(e) {
  const c = clipById(dragClip.id);
  if (!c) return;
  const dt = tlTimeAtRaw(e.clientX) - dragClip.t0;
  const c0 = dragClip.c0;
  const srcDur = clipSourceDur(c);
  const MIN = 0.1;
  if (dragClip.mode === 'move') {
    c.start = Math.max(0, snapClipTime(c0.start + dt, c.id));
  } else if (dragClip.mode === 'trim-r') {
    const want = snapClipTime(c0.start + c0.dur + dt, c.id) - c0.start;
    // 不能超过素材本身（变速之后能铺得更长 / 更短）
    const cap = srcDur ? Math.max(MIN, (srcDur - c.in) / clamp(c.speed || 1, 0.1, 8)) : Infinity;
    c.dur = clamp(want, MIN, Math.min(cap, 3600));
  } else {
    let ns = snapClipTime(c0.start + dt, c.id);
    let nin = c0.in + (ns - c0.start);
    const right = c0.start + c0.dur;
    if (nin < 0) { ns -= nin; nin = 0; }              // 素材开头到头了
    if (ns < 0) { ns = 0; }                            // 时间轴开头到头了
    if (right - ns < MIN) ns = right - MIN;
    c.start = ns;
    c.in = Math.max(0, nin);
    c.dur = right - ns;
  }
  clipsFitDuration();
  syncTransitionLayers();          // 切口跟着片段走
  drawTimeline(); renderAt(state.t); blit();
  if (rightTab === 'clip') renderRight();
}

/** 在播放头切开选中的片段（左右各留一半，素材入点接上） */
function splitClipAt(t) {
  const c = selectedClip();
  if (!c) { toast('先在时间轴上点一个片段，再切'); return null; }
  if (t <= c.start + 0.05 || t >= c.end - 0.05) { toast('播放头不在这个片段里面'); return null; }
  const right = new Clip({
    kind: c.kind, assetId: c.assetId, name: c.name,
    start: t, in: c.in + (t - c.start), dur: c.end - t, volume: c.volume,
  });
  c.dur = t - c.start;
  state.scene.clips.push(right);
  state.clipSel = right.id;
  syncTransitionLayers();
  markIndexDirty(); drawTimeline(); renderAt(state.t); blit(); renderRight();
  toast('在 ' + t.toFixed(2) + 's 切开');
  return right;
}

function deleteSelectedClip() {
  const c = selectedClip();
  if (!c) return 0;
  state.scene.clips = state.scene.clips.filter((x) => x.id !== c.id);
  state.clipSel = null;
  syncTransitionLayers();
  drawTimeline(); renderAt(state.t); blit(); renderRight();
  toast('删掉片段');
  return 1;
}

function tlTimeAt(clientX) {
  let t = tlTimeAtRaw(clientX);
  if ($('chkSnap').checked && state.scene.beat) {
    const snapped = state.scene.beat.snap(t, 4, 0.12);
    t = snapped;
  }
  return clamp(t, 0, state.scene.duration);
}

tl.addEventListener('pointerdown', (e) => {
  const r = tl.getBoundingClientRect();
  const y = e.clientY - r.top;
  const mx = e.clientX - r.left;
  // 媒体轨上的片段：点选 / 拖动 / 拉边裁剪
  const band = mediaBandAt(y);
  if (band) {
    // 先看有没有点在"转场小方块"上（它压在片段接缝处，比点片段优先）
    const mark = [...transMarkMap].find(([, g]) => mx >= g.x && mx <= g.x + g.w
      && y >= g.y && y <= g.y + g.h);
    if (mark) {
      openTransitionDialog(clipById(mark[0]));
      return;
    }
    const hit = [...clipRowMap].find(([, g]) => g.band === band && mx >= g.x - 3 && mx <= g.x + g.w + 3);
    if (hit) {
      const [id, g] = hit;
      const c = clipById(id);
      state.clipSel = id;                 // 选片段
      state.selection = null;             // 图层那边让位
      state.selected = new Set();
      rightTab = 'clip';
      const edgeL = mx - g.x, edgeR = g.x + g.w - mx;
      dragClip = {
        id, t0: tlTimeAtRaw(e.clientX),
        mode: edgeL < 6 ? 'trim-l' : edgeR < 6 ? 'trim-r' : 'move',
        c0: { start: c.start, in: c.in, dur: c.dur },
      };
      try { tl.setPointerCapture(e.pointerId); } catch (_) {}
      renderRight(); drawTimeline();
      return;
    }
    // 点了媒体轨的空白：取消选中 + 播放头挪过去
    state.clipSel = null;
    scrubbing = true;
    setTime(tlTimeAt(e.clientX));
    try { tl.setPointerCapture(e.pointerId); } catch (_) {}
    renderRight(); drawTimeline();
    return;
  }
  // Shift + 空白处拖动 = 框选（一块区域里的图层一起选上，然后 Delete 删掉）
  const hitRow = [...rowMap].some(([, g]) => y >= g.y && y <= g.y + ROW_H && mx >= g.x - 2 && mx <= g.x + g.w + 2);
  if (!hitRow && e.shiftKey) {
    tlMarquee = { x0: mx, y0: y, x1: mx, y1: y, keep: e.shiftKey ? new Set(state.selected) : new Set(), moved: false };
    try { tl.setPointerCapture(e.pointerId); } catch (_) {}
    drawTimeline();
    return;
  }
  // 命中图层？
  for (const [id, g] of rowMap) {
    if (y >= g.y && y <= g.y + ROW_H && e.clientX - r.left >= g.x - 2 && e.clientX - r.left <= g.x + g.w + 2) {
      const L = state.scene.layers.find((x) => x.id === id);
      const edge = (e.clientX - r.left) - g.x;
      if (edge < 6) drag = { id, mode: 'resize-l', orig: L.start };
      else if (edge > g.w - 6) drag = { id, mode: 'resize-r', orig: L.end };
      else drag = { id, mode: 'move', grab: tlTimeAt(e.clientX) - L.start, origStart: L.start, origEnd: L.end };
      // Shift 点杆子 = 加选（多选之后一次性删掉），否则还是单选
      const mode = e.shiftKey ? 'add' : (e.metaKey || e.ctrlKey) ? 'toggle' : undefined;
      selectLayer(id, mode);
      if (mode) { try { tl.setPointerCapture(e.pointerId); } catch (_) {} return; }   // 加选时别顺手把杆子拖走
      try { tl.setPointerCapture(e.pointerId); } catch (_) {}
      return;
    }
  }
  // 否则设置播放头
  scrubbing = true;
  setTime(tlTimeAt(e.clientX));
  try { tl.setPointerCapture(e.pointerId); } catch (_) {}
});

tl.addEventListener('pointermove', (e) => {
  if (tlMarquee) {
    const r = tl.getBoundingClientRect();
    tlMarquee.x1 = e.clientX - r.left;
    tlMarquee.y1 = e.clientY - r.top;
    if (Math.abs(tlMarquee.x1 - tlMarquee.x0) > 2 || Math.abs(tlMarquee.y1 - tlMarquee.y0) > 2) tlMarquee.moved = true;
    drawTimeline();
    return;
  }
  if (dragClip) { applyClipDrag(e); return; }
  if (scrubbing) { setTime(tlTimeAt(e.clientX)); return; }
  if (!drag) return;
  const L = state.scene.layers.find((x) => x.id === drag.id);
  if (!L) return;
  const t = tlTimeAt(e.clientX);
  if (drag.mode === 'move') {
    const dur = drag.origEnd - drag.origStart;
    L.start = clamp(t - drag.grab, 0, state.scene.duration - dur);
    L.end = L.start + dur;
  } else if (drag.mode === 'resize-l') {
    L.start = clamp(t, 0, L.end - 0.04);
  } else {
    L.end = clamp(t, L.start + 0.04, state.scene.duration);
  }
  drawTimeline(); renderAt(state.t); blit();
});

const endDrag = () => {
  if (dragClip) {
    dragClip = null;
    sortClips();
    clipsFitDuration();
    drawTimeline(); renderAt(state.t); blit();
    if (rightTab === 'clip') renderRight();
    return;
  }
  if (tlMarquee) {
    const m = tlMarquee;
    tlMarquee = null;
    if (m.moved) {
      const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1);
      const y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
      const hit = [];
      for (const [id, g] of rowMap) {
        if (g.y + ROW_H < y0 || g.y > y1) continue;
        if (g.x + g.w < x0 || g.x > x1) continue;
        hit.push(id);
      }
      const keep = [...m.keep].filter((id) => state.scene.layers.some((L) => L.id === id));
      state.selected = new Set([...keep, ...hit]);
      state.selection = hit[0] || keep[0] || null;
      if (state.selection != null) rightTab = 'layer';
      renderRight();
      if (state.selected.size > 1) toast(`框选了 ${state.selected.size} 层 —— Delete 删除`);
    }
    drawTimeline();
  }
  drag = null; scrubbing = false;
};
tl.addEventListener('pointerup', endDrag);
tl.addEventListener('pointercancel', endDrag);
// 滚轮：上下翻图层（层数多的时候时间轴装不下）
tl.addEventListener('wheel', (e) => {
  // Ctrl / Alt + 滚轮 = 以鼠标位置为中心缩放（剪辑软件的习惯）
  if (e.ctrlKey || e.altKey || e.metaKey) {
    e.preventDefault();
    tlZoomAt(e.deltaY < 0 ? 1.25 : 1 / 1.25, tlTimeAtRaw(e.clientX));
    return;
  }
  // Shift + 滚轮 = 左右平移（放大之后才有得平移）
  if (e.shiftKey) {
    const V = tlView();
    if (V.zoom > 1.01) {
      e.preventDefault();
      const step = Math.max(0.05, V.span * 0.12) * (e.deltaY > 0 ? 1 : -1);
      state.tlStart = clamp(V.start + step, 0, V.maxStart);
      drawTimeline();
      return;
    }
  }
  const dy = e.deltaY > 0 ? Math.max(14, Math.abs(e.deltaY) * 0.6) : -Math.max(14, Math.abs(e.deltaY) * 0.6);
  if (tlScrollBy(dy)) e.preventDefault();
}, { passive: false });

// 左右两栏宽度可拖（模板库太窄、参数栏想宽点，都能自己调；双击复位）
{
  const layoutEl = document.querySelector('.layout');
  const DEFAULT_L = 250, DEFAULT_R = 320;
  const MIN_L = 190, MAX_L = 720, MIN_R = 240, MAX_R = 820;
  const setW = (name, w) => {
    layoutEl.style.setProperty(name, Math.round(w) + 'px');
    blit(); drawTimeline();          // 中间的画布和时间轴要跟着重新量
  };
  try {
    const l = Number(localStorage.getItem('motionkit.leftW') || 0);
    const r = Number(localStorage.getItem('motionkit.rightW') || 0);
    if (l >= MIN_L && l <= MAX_L) layoutEl.style.setProperty('--left-w', l + 'px');
    if (r >= MIN_R && r <= MAX_R) layoutEl.style.setProperty('--right-w', r + 'px');
  } catch (_) {}

  const bind = (gripId, varName, dir, min, max, key, def) => {
    const grip = $(gripId);
    if (!grip) return;
    const cur = () => {
      const v = getComputedStyle(layoutEl).getPropertyValue(varName).trim();
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : def;
    };
    let st = null;
    grip.addEventListener('pointerdown', (e) => {
      st = { x: e.clientX, w: cur() };
      grip.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    grip.addEventListener('pointermove', (e) => {
      if (!st) return;
      setW(varName, clamp(st.w + dir * (e.clientX - st.x), min, max));
    });
    const end = () => {
      if (!st) return;
      st = null;
      grip.classList.remove('dragging');
      try { localStorage.setItem(key, String(Math.round(cur()))); } catch (_) {}
      blit(); drawTimeline();
    };
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => {
      setW(varName, def);
      try { localStorage.setItem(key, String(def)); } catch (_) {}
    });
  };
  bind('leftResize', '--left-w', 1, MIN_L, MAX_L, 'motionkit.leftW', DEFAULT_L);
  bind('rightResize', '--right-w', -1, MIN_R, MAX_R, 'motionkit.rightW', DEFAULT_R);
}

// 拖动时间轴顶端那条：调整高度（图层多的时候拉高点）
{
  const grip = $('tlResize');
  let rz = null;
  const saved = Number(localStorage.getItem('motionkit.tlHeight') || 0);
  if (saved >= 120 && saved <= 700) tl.style.height = saved + 'px';
  grip.addEventListener('pointerdown', (e) => {
    rz = { y: e.clientY, h: tl.clientHeight };
    grip.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!rz) return;
    const h = clamp(rz.h - (e.clientY - rz.y), 120, 700);
    tl.style.height = h + 'px';
    drawTimeline();
  });
  const end = () => {
    if (!rz) return;
    rz = null;
    try { localStorage.setItem('motionkit.tlHeight', String(tl.clientHeight)); } catch (_) {}
    drawTimeline();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------- 模板库
// 交互：点一下只是"选中"，不会往工程里塞东西；要加图层必须从这儿**拖到右边画面里**。
// 落点会被写进模板自己的 position 参数，所以拖到哪儿就摆在哪儿。
const TPL_MIME = 'application/x-motionkit-template';

function buildTemplateList(filter = '') {
  const box = $('templateList');
  box.innerHTML = '';
  const cats = byCategory();
  const f = filter.trim().toLowerCase();
  for (const [cat, tpls] of Object.entries(cats)) {
    const shown = tpls.filter((t) => !f || (t.name + t.id + (t.hint || '')).toLowerCase().includes(f));
    if (!shown.length) continue;
    const collapsed = !f && !!state.tplCollapsed[cat];     // 搜索时强制展开，别把结果藏起来
    const h = document.createElement('div');
    h.className = 'tpl-cat' + (collapsed ? ' collapsed' : '');
    h.innerHTML = `<span class="caret">${collapsed ? '▸' : '▾'}</span>`
      + `<span>${CATEGORIES[cat] || cat}</span><span class="cnt">${shown.length}</span>`;
    h.title = collapsed ? '点开这一组' : '收起这一组';
    h.addEventListener('click', () => {
      state.tplCollapsed[cat] = !state.tplCollapsed[cat];
      try { localStorage.setItem('motionkit.tplCollapsed', JSON.stringify(state.tplCollapsed)); } catch (_) {}
      buildTemplateList($('searchTpl').value || '');
    });
    box.appendChild(h);
    if (collapsed) continue;
    for (const t of shown) {
      const d = document.createElement('div');
      d.className = 'tpl' + (state.tplPick === t.id ? ' sel' : '');
      d.dataset.tid = t.id;
      d.draggable = true;
      const cv = document.createElement('canvas');
      cv.className = 'tpl-thumb';
      cv.width = 176; cv.height = 100;
      const body = document.createElement('div');
      body.className = 'tpl-body';
      body.innerHTML = `<b>${t.name}</b><span>${t.hint || ''}</span><div class="tag">${t.category} · ${t.id}</div>`;
      d.appendChild(cv); d.appendChild(body);
      queueThumb(t, cv);
      d.addEventListener('click', () => pickTemplate(t));
      d.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(TPL_MIME, t.id);
        e.dataTransfer.setData('text/plain', t.id);
        e.dataTransfer.effectAllowed = 'copy';
        d.classList.add('dragging');
        pickTemplate(t);
      });
      d.addEventListener('dragend', () => {
        d.classList.remove('dragging');
        stage.classList.remove('tpl-over');
        moveDropMark(null);
      });
      box.appendChild(d);
    }
  }
}

// ---------------------------------------------------------------- 模板缩略图
// 用引擎真渲一遍再缩小（默认参数、入场结束那一刻），所以"看到的就是拿到的"。
// 分帧慢慢填，避免一次性卡住界面。
let tplScratch = null;
let thumbQueue = [];
let thumbScheduled = false;
const thumbCache = new Map();      // 已经渲过的模板 → 小画布（换分类后不用重渲）

function queueThumb(t, cv) {
  if (thumbCache.has(t.id)) { paintThumbFrom(t.id, cv); return; }
  thumbQueue.push({ t, cv });
  if (!thumbScheduled) {
    thumbScheduled = true;
    requestAnimationFrame(() => { thumbScheduled = false; pumpThumbs(); });
  }
}

function pumpThumbs() {
  const batch = thumbQueue.splice(0, 2);
  for (const it of batch) paintThumb(it.t, it.cv);
  if (thumbQueue.length) {
    thumbScheduled = true;
    requestAnimationFrame(() => { thumbScheduled = false; pumpThumbs(); });
  }
}

function paintThumbFrom(id, cv) {
  const src = thumbCache.get(id);
  if (!src) return;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, cv.width, cv.height);
  c.fillStyle = '#0e1013';
  c.fillRect(0, 0, cv.width, cv.height);
  c.drawImage(src, 0, 0, cv.width, cv.height);
}

/** 缩略图底下垫的"合成画面"：有明暗、有结构，转场/调色类模板才作用得出来 */
function drawThumbBase(c, W, H) {
  const g = c.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#22293a');
  g.addColorStop(0.55, '#2b2436');
  g.addColorStop(1, '#3a2b2f');
  c.fillStyle = g;
  c.fillRect(0, 0, W, H);
  // 一点亮块，让故障/像素化/放大这类效果看得出来
  const blocks = [[0.10, 0.52, 0.16, 0.34, 'rgba(120,200,255,0.30)'],
                  [0.34, 0.30, 0.20, 0.44, 'rgba(255,190,120,0.26)'],
                  [0.62, 0.58, 0.14, 0.30, 'rgba(255,120,190,0.24)'],
                  [0.78, 0.24, 0.12, 0.26, 'rgba(150,255,200,0.20)']];
  for (const b of blocks) {
    c.fillStyle = b[4];
    c.fillRect(W * b[0], H * b[1], W * b[2], H * b[3]);
  }
  c.fillStyle = 'rgba(255,255,255,0.05)';
  c.fillRect(0, H * 0.46, W, H * 0.012);
}

function paintThumb(t, cv) {
  try {
    const s = state.scene;
    const W = Math.max(320, Math.round(s.width));
    const H = Math.max(180, Math.round(s.height));
    if (!tplScratch) tplScratch = makeCanvas(W, H, 1);
    if (tplScratch.canvas.width !== W || tplScratch.canvas.height !== H) {
      tplScratch.canvas.width = W; tplScratch.canvas.height = H;
    }
    const ctx = tplScratch.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 单层场景 + 默认参数，取"入场已经结束"的时刻
    const mini = Scene.fromJSON({
      width: W, height: H, fps: s.fps, duration: 3,
      bg: null, transparent: true, fx: [],
      beat: { bpm: 120, offset: 0, duration: 3 },
      // 给字幕类模板一点内容，不然缩略图是空的
      captions: [
        { start: 0.4, end: 1.6, text: '示例字幕' },
        { start: 1.7, end: 3, text: '第二句' },
      ],
      layers: [{ template: t.id, start: 0, end: 3, seed: 'thumb-' + t.id, name: t.name, params: {} }],
    });
    // 垫一张"合成画面"：转场类模板是把当前帧抓下来做变形，底下空的话它们什么都画不出来
    renderFrame(ctx, mini, 2.2, {
      silent: true,
      before: (c, sc) => drawThumbBase(c, sc.width, sc.height),
    });
    // 缓存一张小图（回填时用）
    const small = document.createElement('canvas');
    small.width = cv.width; small.height = cv.height;
    const sc = small.getContext('2d');
    sc.fillStyle = '#0e1013';
    sc.fillRect(0, 0, small.width, small.height);
    sc.drawImage(tplScratch.canvas, 0, 0, small.width, small.height);
    thumbCache.set(t.id, small);
    paintThumbFrom(t.id, cv);
  } catch (_) {
    const c = cv.getContext('2d');
    c.fillStyle = '#0e1013'; c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = '#4a505b'; c.font = '10px monospace';
    c.fillText('预览失败', 6, cv.height / 2 + 3);
  }
}

/** 点一下只是选中，并把"拖到画面里"的提示挂出来 */
function pickTemplate(t) {
  state.tplPick = t ? t.id : null;
  for (const el of document.querySelectorAll('#templateList .tpl')) {
    el.classList.toggle('sel', !!t && el.dataset.tid === t.id);
  }
  const bar = $('tplBar');
  if (!bar) return;
  if (!t) { bar.classList.add('hidden'); return; }
  $('tplBarText').innerHTML = `把 <b>${escapeHtml(t.name)}</b> 拖到画面里放下（放哪儿就摆哪儿）`;
  bar.dataset.tid = t.id;
  bar.classList.remove('hidden');
}

function moveDropMark(e) {
  const mark = $('tplDropMark');
  if (!mark) return;
  if (!e) { mark.classList.remove('on'); return; }
  const sr = stage.getBoundingClientRect();
  const r = preview.getBoundingClientRect();
  mark.style.left = (clamp(e.clientX, r.left, r.right) - sr.left) + 'px';
  mark.style.top = (clamp(e.clientY, r.top, r.bottom) - sr.top) + 'px';
  mark.classList.add('on');
}

/** 拖到画面上松手：按落点算归一化坐标，塞进模板的 position 参数 */
function dropTemplateOnStage(t, e) {
  const r = preview.getBoundingClientRect();
  const at = {
    x: clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1),
    y: clamp((e.clientY - r.top) / Math.max(1, r.height), 0, 1),
  };
  const L = addLayerFromTemplate(t, at);
  pickTemplate(null);
  toast(`已加入「${t.name}」`);
  return L;
}

/** 落点 → 模板的 position 参数（没有这个参数的模板，比如全屏 HUD、转场，就按默认来） */
function placeParamsAt(t, at) {
  const p = (t.params || []).find((x) => x.key === 'position');
  if (!p || !at) return {};
  const parts = String(p.default || '0.5,0.5').split(',');
  const out = [clamp(at.x, 0.03, 0.97).toFixed(3), clamp(at.y, 0.03, 0.97).toFixed(3)];
  if (parts.length > 2) out.push(parts[2].trim());     // "x,y,w" 这种三段式，宽度保持默认
  return { position: out.join(',') };
}

function addLayerFromTemplate(t, at) {
  const s = state.scene;
  const dur = t.category === 'transition' ? 0.4 : 3;
  const start = clamp(
    $('chkSnap').checked ? s.beat.snap(state.t, 4, 0.2) : state.t,
    0, Math.max(0, s.duration - dur),
  );
  const L = s.add({
    template: t.id, start, end: Math.min(s.duration, start + dur),
    seed: `${t.id}-${++state.layerSeq}`, name: t.name,
    params: placeParamsAt(t, at),
  });
  selectLayer(L.id);
  markIndexDirty();
  renderAt(state.t); blit();
  return L;
}

// ---------------------------------------------------------------- 右侧参数面板
// 分页签：图层 / 工程 / 卡点 / 字幕 / 特效。点图层时会自动切到「图层」页 ——
// 东西多的时候，切页签比在一条长滚动条里翻快得多。
const RIGHT_TABS = ['layer', 'clip', 'scene', 'beat', 'subs', 'fx'];
let rightTab = 'scene';

function setRightTab(tab) {
  if (!RIGHT_TABS.includes(tab)) return;
  rightTab = tab;
  const b = $('rightBody');
  if (b) b.scrollTop = 0;
  renderRight();
}

function renderRight() {
  const body = $('rightBody');
  body.innerHTML = '';
  const L = selectedLayer();
  for (const tb of document.querySelectorAll('#rightTabs .rtab')) {
    tb.classList.toggle('active', tb.dataset.tab === rightTab);
  }
  const cnt = $('fxCount');
  if (cnt) cnt.textContent = String((state.scene.fx || []).length);
  $('rightTitle').textContent = {
    layer: L ? `图层参数 · ${L.name || L.template}` : '图层参数',
    clip: selectedClip() ? `片段 · ${selectedClip().name || selectedClip().kind}` : '剪辑',
    scene: '工程设置 · 画面 / 文件',
    beat: '卡点',
    subs: '字幕',
    fx: '特效（后期栈）',
  }[rightTab] || '工程设置';

  if (rightTab === 'layer') rightPanelLayer(body, L);
  else if (rightTab === 'clip') rightPanelClip(body);
  else if (rightTab === 'beat') rightPanelBeat(body);
  else if (rightTab === 'subs') rightPanelSubs(body);
  else if (rightTab === 'fx') rightPanelFx(body);
  else rightPanelScene(body);
}

/** 图层页：选中的那层的属性 + 模板参数 */
function rightPanelLayer(body, L) {
  if (!L) {
    const g = group('图层参数');
    const e = document.createElement('div');
    e.className = 'empty';
    e.style.whiteSpace = 'pre-line';
    e.textContent = '还没有选中图层。\n在预览里点一下画面上的东西，或者在时间轴 / 图层索引里点一条，就能在这里调它。';
    g.appendChild(e);
    g.appendChild(btn('打开图层索引', () => setIndexTab('layers')));
    body.appendChild(g);
    return;
  }
  {
    const t = listTemplates().find((x) => x.id === L.template);
    // 多选（框选 / Shift 点选）时先给一块整组的信息和删除入口
    if (state.selected.size > 1) {
      const gm = group('已选 ' + state.selected.size + ' 层');
      const note = document.createElement('div');
      note.className = 'fx-note';
      note.textContent = '下面是"主选"那一层的参数。'
        + '框选（预览里空白处拖 / 时间轴上 Shift 拖）或 Shift 点选可以一次选多层，Delete 一次删掉。';
      gm.appendChild(note);
      const row = document.createElement('div');
      row.className = 'btn-row';
      row.appendChild(btn('删除这 ' + state.selected.size + ' 层', () => {
        if (confirm('删掉选中的 ' + state.selected.size + ' 层？')) deleteSelectedLayers();
      }, 'danger'));
      row.appendChild(btn('只留主选那层', () => { selectLayer(state.selection); }));
      row.appendChild(btn('取消选择', () => { selectLayer(null); }));
      gm.appendChild(row);
      body.appendChild(gm);
    }
    const g0 = group('图层');
    g0.appendChild(field('模板', () => {
      const sel = document.createElement('select');
      for (const tt of listTemplates()) {
        const o = document.createElement('option'); o.value = tt.id; o.textContent = tt.name;
        if (tt.id === L.template) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => switchLayerTemplate(L, sel.value));
      return sel;
    }));
    g0.appendChild(numField('开始(秒)', L.start, 0, state.scene.duration, 0.01, (v) => { L.start = Math.min(v, L.end - 0.04); drawTimeline(); }));
    g0.appendChild(numField('结束(秒)', L.end, 0, state.scene.duration, 0.01, (v) => { L.end = Math.max(v, L.start + 0.04); drawTimeline(); }));
    g0.appendChild(numField('不透明度', L.opacity, 0, 1, 0.01, (v) => { L.opacity = v; }));
    g0.appendChild(checkField('启用', L.enabled, (v) => { L.enabled = v; drawTimeline(); }));
    const actions = document.createElement('div');
    actions.className = 'btn-row';
    actions.appendChild(btn('吸附到卡点', () => snapLayerToBeat(L)));
    actions.appendChild(btn('复制', () => {
        // 深拷贝：否则复制出来的层和原层共用同一份 params / transform 对象
        const spec = JSON.parse(JSON.stringify(L.toJSON()));
        spec.seed = (L.seed || L.template) + '-c' + (++state.layerSeq);
        const c = new Layer(spec);
        state.scene.layers.push(c); selectLayer(c.id);
        markIndexDirty(); renderAt(state.t); blit();
    }));
    actions.appendChild(btn('复位变换', () => {
      L.transform = null; markIndexDirty(); renderAt(state.t); blit(); renderRight();
    }));
    actions.appendChild(btn('删除', () => {
      state.scene.layers = state.scene.layers.filter((x) => x.id !== L.id);
        selectLayer(null);
    }, 'danger'));
    g0.appendChild(actions);
    body.appendChild(g0);

    const g1 = group('模板参数');
    const tr = L.transform;
    if (tr && (tr.x || tr.y || tr.scale !== 1 || tr.rot)) {
      const h = document.createElement('div');
      h.className = 'fx-note';
      h.textContent = '预览里摆过位置：位移 '
        + tr.x.toFixed(3) + ' , ' + tr.y.toFixed(3)
        + '　缩放 ×' + tr.scale.toFixed(2)
        + (tr.rot ? '　旋转 ' + Math.round(tr.rot) + '°' : '')
        + '（可以直接在预览里接着拖）';
      g1.appendChild(h);
    }
    for (const p of (t && t.params) || []) {
      g1.appendChild(paramField(p, L.params, () => {
        renderAt(state.t); blit();
        invalidateLayerBox(L.id);     // 参数变了，屏幕上的位置要重新量
      }));
    }
    body.appendChild(g1);
  }
}

/** 工程页：画面尺寸 / 帧率 / 时长 + 载入的素材信息 */
function rightPanelScene(body) {
  {
    const g = group('画面');
    g.appendChild(numField('宽', state.scene.width, 64, 8192, 1, (v) => { state.scene.width = Math.round(v); resize(); }));
    g.appendChild(numField('高', state.scene.height, 64, 8192, 1, (v) => { state.scene.height = Math.round(v); resize(); }));
    g.appendChild(numField('帧率', state.scene.fps, 1, 120, 1, (v) => { state.scene.fps = Math.round(v); }));
    const mediaNote = () => {
      const v = state.media.video ? (state.media.videoDur ? state.media.videoDur.toFixed(2) + 's' : '静态图') : '未载入';
      const a = state.media.audioDur ? state.media.audioDur.toFixed(2) + 's' : '未载入';
      return `视频 ${v} · 音频 ${a}\n`
        + (state.durationAuto ? '工程时长跟着素材走（谁长算谁）' : '时长是手动设的');
    };
    let durNote = null;
    g.appendChild(numField('时长(秒)', state.scene.duration, 0.1, 3600, 0.1, (v) => {
      state.durationAuto = false;                 // 手动改过就不再跟素材跑
      state.scene.duration = Math.max(0.1, v);
      if (state.scene.beat) state.scene.beat.duration = state.scene.duration;
      if (durNote) durNote.textContent = mediaNote();
      drawTimeline();
    }));
    durNote = document.createElement('div');
    durNote.className = 'fx-note';
    durNote.style.whiteSpace = 'pre-line';
    durNote.textContent = mediaNote();
    g.appendChild(durNote);
    g.appendChild(btn('重新跟随素材时长', () => {
      state.durationAuto = true;
      if (!applyAutoDuration()) { if (durNote) durNote.textContent = mediaNote(); }
      renderRight();
    }));
    g.appendChild(colorField('背景色', state.scene.bg || '', (v) => { state.scene.bg = v || null; }, true));
    g.appendChild(btn('重置为默认', () => {
      state.scene.width = 1920; state.scene.height = 1080; state.scene.fps = 24; resize();
    }));
    body.appendChild(g);

    const gd = group('文件');
    const info = document.createElement('div');
    info.className = 'empty';
    info.textContent = `视频：${state.media.videoName || '未载入'}\n音频：${state.media.audioName || '未载入'}\n图层：${state.scene.layers.length} · 字幕：${state.scene.captions.length}`;
    info.style.whiteSpace = 'pre-line';
    gd.appendChild(info);
    body.appendChild(gd);
  }
}

/** 卡点页 */
function rightPanelBeat(body) {
  {
    const gb = group('卡点');
    gb.appendChild(numField('BPM', state.scene.beat.bpm, 30, 300, 0.01, (v) => {
      state.scene.beat = new BeatMap({ bpm: v, offset: state.scene.beat.offset, duration: state.scene.duration, source: 'manual' });
      updateBeatInfo(); drawTimeline();
    }));
    gb.appendChild(numField('偏移(秒)', state.scene.beat.offset, -5, 5, 0.01, (v) => {
      state.scene.beat.offset = v; drawTimeline();
    }));
    const ba = document.createElement('div');
    ba.className = 'btn-row';
    ba.appendChild(btn('一键铺满闪白（每拍）', () => { beatFxRelay('flash-cut', 1); renderRight(); }));
    ba.appendChild(btn('每 2 拍一个推近', () => { beatFxRelay('zoom-punch', 2); renderRight(); }));
    gb.appendChild(ba);
    const hint = document.createElement('div');
    hint.className = 'fx-note';
    hint.textContent = `当前工程有 ${state.scene.beat.hitsIn(0, state.scene.duration, 1).length} 个拍点`
      + `（BPM ${state.scene.beat.bpm.toFixed(1)}）。下面那一栏可以把铺出来的动效整组改。`;
    gb.appendChild(hint);
    body.appendChild(gb);
    body.appendChild(buildBeatFxGroup());
  }
}

/**
 * 调色预设：点一下就套一组参数，之后还能自己拖滑杆微调。
 * 走的是 canvas 的 ctx.filter，所以预览 / 导出 / 无头渲染完全一致。
 */
const GRADE_PRESETS = [
  { id: 'none', name: '原片', g: null },
  { id: 'warm', name: '暖调', g: { brightness: 1.05, contrast: 1.06, saturation: 1.12, hue: -8 } },
  { id: 'cool', name: '冷调', g: { brightness: 0.98, contrast: 1.08, saturation: 0.95, hue: 16 } },
  { id: 'punch', name: '高对比', g: { contrast: 1.3, saturation: 1.12, brightness: 1.02 } },
  { id: 'fade', name: '褪色', g: { contrast: 0.86, saturation: 0.72, brightness: 1.08 } },
  { id: 'bw', name: '黑白', g: { grayscale: 1, contrast: 1.12 } },
  { id: 'vhs', name: '磁带', g: { saturation: 0.92, contrast: 1.1, blur: 0.7, sepia: 0.18 } },
  { id: 'invert', name: '反相', g: { invert: 1 } },
];

function gradePresetOf(c) {
  const g = c.grade;
  if (!g) return 'none';
  const hit = GRADE_PRESETS.find((p) => p.g && JSON.stringify(p.g) === JSON.stringify(g));
  return hit ? hit.id : '';
}

function applyGradePreset(c, id) {
  const p = GRADE_PRESETS.find((x) => x.id === id);
  c.grade = p && p.g ? Object.assign({}, p.g) : null;
  markIndexDirty(); renderAt(state.t); blit(); renderRight();
}

/** 调色滑杆：值等于默认值时就把这一项删掉，省得 grade 里全是 1 */
function gradeField(g, key, label, def, min, max, step) {
  const cur = g[key] === undefined ? def : g[key];
  return numField(label, cur, min, max, step, (v) => {
    const c = selectedClip();
    if (!c) return;
    const grade = Object.assign({}, c.grade || {});
    if (Math.abs(v - def) < 1e-6) delete grade[key]; else grade[key] = v;
    c.grade = Object.keys(grade).length ? grade : null;
    renderAt(state.t); blit();
  });
}

/**
 * 剪辑页：时间轴上选中的那个片段。
 *
 * 素材（文件）和片段（时间轴上的块）是两层：同一份素材可以切几刀变成几个片段，
 * 各自的入点 / 长度都不一样。这里改的是"这一个片段"，不是素材本身。
 */
function rightPanelClip(body) {
  const c = selectedClip();
  const g0 = group('素材片段');

  const row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(btn('载入视频 / 图片', () => $('fileVideo').click()));
  row.appendChild(btn('载入音频', () => $('fileAudio').click()));
  g0.appendChild(row);

  if (!c) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.style.whiteSpace = 'pre-line';
    e.textContent = '在时间轴的视频轨 / 音频轨上点一个片段，就能在这里改它。\n'
      + '拖动片段 = 挪位置；拖左右两边的白条 = 裁剪长度；按 S = 在播放头切开。';
    g0.appendChild(e);
  } else {
    const a = assetById(c.assetId);
    const info = document.createElement('div');
    info.className = 'empty';
    info.style.whiteSpace = 'pre-line';
    info.textContent = (c.kind === 'audio' ? '音频' : c.kind === 'image' ? '图片' : '视频') + ' · ' + (c.name || '') + '\n'
      + (a ? '素材时长 ' + (a.kind === 'image' ? '静态图' : (a.duration || 0).toFixed(2) + 's') : '⚠ 素材没接上')
      + '　·　时间轴上 ' + c.start.toFixed(2) + 's → ' + c.end.toFixed(2) + 's';
    g0.appendChild(info);

    g0.appendChild(numField('起点(秒)', c.start, 0, Math.max(1, state.scene.duration), 0.01, (v) => {
      c.start = Math.max(0, v); clipsFitDuration(); drawTimeline(); renderAt(state.t); blit();
    }));
    g0.appendChild(numField('时长(秒)', c.dur, 0.1, Math.max(1, state.scene.duration), 0.01, (v) => {
      const cap = clipSourceDur(c);
      const sp = clamp(c.speed || 1, 0.1, 8);
      c.dur = clamp(v, 0.1, cap ? Math.max(0.1, (cap - c.in) / sp) : 3600);
      clipsFitDuration(); drawTimeline(); renderAt(state.t); blit();
    }));
    if (c.kind !== 'image') {
      g0.appendChild(numField('入点(秒)', c.in, 0, Math.max(0.1, (clipSourceDur(c) || 60) - 0.1), 0.01, (v) => {
        const cap = clipSourceDur(c);
        c.in = clamp(v, 0, cap ? Math.max(0, cap - 0.1) : 3600);
        if (cap) c.dur = Math.min(c.dur, Math.max(0.1, (cap - c.in) / clamp(c.speed || 1, 0.1, 8)));
        drawTimeline(); renderAt(state.t); blit();
      }));
    }

    const acts = document.createElement('div');
    acts.className = 'btn-row';
    acts.appendChild(btn('在播放头切开', () => splitClipAt(state.t)));
    acts.appendChild(btn('复制一段接在后面', () => duplicateSelectedClip()));
    acts.appendChild(btn('删掉', () => deleteSelectedClip(), 'danger'));
    g0.appendChild(acts);

    // 转场：接缝处那个小方块点一下也能开，这里再给个明面上的入口
    const prev = prevClipOf(c);
    const tro = document.createElement('div');
    tro.className = 'btn-row';
    if (prev && Math.abs(prev.end - c.start) < 0.08) {
      tro.appendChild(btn(c.trans ? '换转场（' + templateName(c.trans.template) + '）' : '加转场（接缝处）',
        () => openTransitionDialog(c)));
      if (c.trans) tro.appendChild(btn('去掉转场', () => clearTransition(c)));
    } else {
      const e2 = document.createElement('div');
      e2.className = 'empty';
      e2.style.padding = '4px 0';
      e2.textContent = prev ? '和上一段之间有空隙，贴紧了才能加转场' : '这一段前面没有紧挨着的片段';
      tro.appendChild(e2);
    }
    g0.appendChild(tro);

    // ---- 画面：轨道 / 画中画 / 不透明度 ----
    if (c.kind !== 'audio') {
      const gT = group('画面位置（多轨叠加 / 画中画）');
      gT.appendChild(selectField('轨道', String(c.track || 0), [
        { value: '0', label: '轨 1 · 底轨（铺满）' },
        { value: '1', label: '轨 2 · 往上叠' },
        { value: '2', label: '轨 3 · 再往上' },
        { value: '3', label: '轨 4' },
      ], (v) => { c.track = Number(v); markIndexDirty(); drawTimeline(); renderAt(state.t); blit(); }));
      const note2 = document.createElement('div');
      note2.className = 'fx-note';
      note2.textContent = '同一条轨上后面盖前面，号码大的盖号码小的。想做画中画：下面把缩放拉到 0.3 左右，再挪位置。';
      gT.appendChild(note2);
      gT.appendChild(numField('缩放（1 = 铺满）', c.scale === null || c.scale === undefined ? 1 : c.scale, 0.1, 1.5, 0.01, (v) => {
        c.scale = Math.abs(v - 1) < 1e-6 ? null : v;
        renderAt(state.t); blit();
      }));
      gT.appendChild(numField('左右位置', c.x || 0, -0.5, 0.5, 0.005, (v) => { c.x = v; renderAt(state.t); blit(); }));
      gT.appendChild(numField('上下位置', c.y || 0, -0.5, 0.5, 0.005, (v) => { c.y = v; renderAt(state.t); blit(); }));
      gT.appendChild(numField('不透明度', c.opacity === undefined ? 1 : c.opacity, 0, 1, 0.02, (v) => {
        c.opacity = v; renderAt(state.t); blit();
      }));
      body.appendChild(gT);
    }

    // ---- 变速 ----
    if (c.kind !== 'image') {
      const gS = group('变速');
      gS.appendChild(numField('速度 ×', c.speed || 1, 0.25, 4, 0.05, (v) => {
        c.speed = v; drawTimeline(); renderAt(state.t); blit(); syncMediaTo(state.t, false);
      }));
      const quick = document.createElement('div');
      quick.className = 'btn-row';
      for (const sp of [0.5, 1, 1.5, 2, 4]) {
        quick.appendChild(btn(sp + '×', () => {
          c.speed = sp; renderRight(); drawTimeline(); renderAt(state.t); blit(); syncMediaTo(state.t, false);
        }));
      }
      gS.appendChild(quick);
      const n = document.createElement('div');
      n.className = 'fx-note';
      n.textContent = '素材里 ' + (clipSourceDur(c) || 0).toFixed(2) + ' 秒，按 ' + (c.speed || 1).toFixed(2)
        + '× 放，时间轴上最长能铺 ' + (((clipSourceDur(c) || 0) - c.in) / (c.speed || 1)).toFixed(2) + ' 秒。';
      gS.appendChild(n);
      body.appendChild(gS);
    }

    // ---- 调色 ----
    if (c.kind !== 'audio') {
      const gC = group('调色 / 滤镜');
      const pre = document.createElement('div');
      pre.className = 'btn-row';
      pre.style.flexWrap = 'wrap';
      const cur = gradePresetOf(c);
      for (const p of GRADE_PRESETS) {
        const b = btn(p.name, () => applyGradePreset(c, p.id));
        if (p.id === cur) b.classList.add('on');
        pre.appendChild(b);
      }
      gC.appendChild(pre);
      const g = c.grade || {};
      gC.appendChild(gradeField(g, 'brightness', '亮度', 1, 0.4, 1.8, 0.02));
      gC.appendChild(gradeField(g, 'contrast', '对比度', 1, 0.4, 2, 0.02));
      gC.appendChild(gradeField(g, 'saturation', '饱和度', 1, 0, 2, 0.02));
      gC.appendChild(gradeField(g, 'hue', '色相(度)', 0, -180, 180, 1));
      gC.appendChild(gradeField(g, 'blur', '模糊(px)', 0, 0, 20, 0.1));
      const gc = document.createElement('div');
      gc.className = 'btn-row';
      gc.appendChild(btn('清掉调色', () => applyGradePreset(c, 'none')));
      gC.appendChild(gc);
      body.appendChild(gC);
    }

    // ---- 声音（音频 / 视频都能调） ----
    if (c.kind !== 'image') {
      const gA = group('声音');
      gA.appendChild(numField('音量', c.volume === undefined ? 1 : c.volume, 0, 1, 0.02, (v) => {
        c.volume = v; syncMediaTo(state.t, false);
      }));
      gA.appendChild(numField('淡入(秒)', c.fadeIn || 0, 0, 3, 0.05, (v) => {
        c.fadeIn = v; syncMediaTo(state.t, false);
      }));
      gA.appendChild(numField('淡出(秒)', c.fadeOut || 0, 0, 3, 0.05, (v) => {
        c.fadeOut = v; syncMediaTo(state.t, false);
      }));
      const wn = document.createElement('div');
      wn.className = 'fx-note';
      const w = fadeWindow(c);
      wn.textContent = (w.in > (c.fadeIn || 0) + 0.01 || w.out > (c.fadeOut || 0) + 0.01)
        ? '和相邻音频段重叠了，接缝处自动交叉淡化 ' + Math.max(w.in, w.out).toFixed(2) + ' 秒。'
        : '两段音频叠在一起放，接缝会自动交叉淡化（不用另外设）。';
      gA.appendChild(wn);
      body.appendChild(gA);
    }
  }
  body.appendChild(g0);

  const g1 = group('全部片段（' + state.scene.clips.length + '）');
  if (!state.scene.clips.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '还没有素材。上面「载入视频 / 图片」，或者把文件拖进画面区。';
    g1.appendChild(e);
  } else {
    const listBox = document.createElement('div');
    listBox.className = 'cap-list';
    state.scene.clips.slice().sort((x, y) => x.start - y.start).forEach((x, i) => {
      const r = document.createElement('div');
      r.className = 'cap-row';
      const tx = document.createElement('div');
      tx.className = 'cap-tx';
      const icon = x.kind === 'audio' ? '♪' : x.kind === 'image' ? '▣' : '▶';
      tx.textContent = z2(i + 1) + ' ' + icon + ' ' + (x.name || '') + '　' + x.start.toFixed(1) + '→' + x.end.toFixed(1) + 's';
      tx.title = tx.textContent;
      tx.style.cursor = 'pointer';
      tx.addEventListener('click', () => {
        state.clipSel = x.id;
        rightTab = 'clip';
        setTime(x.start + x.dur / 2);
        renderRight(); drawTimeline();
      });
      const del = document.createElement('button');
      del.textContent = '×';
      del.className = 'fx-del';
      del.title = '删掉这一段';
      del.addEventListener('click', () => { state.clipSel = x.id; deleteSelectedClip(); });
      r.appendChild(tx); r.appendChild(del);
      listBox.appendChild(r);
    });
    g1.appendChild(listBox);
  }
  body.appendChild(g1);
}

/** 字幕页 */
function rightPanelSubs(body) {
  {
    const gc = group('字幕');
    const cinfo = document.createElement('div');
    cinfo.className = 'empty';
    cinfo.textContent = state.scene.captions.length
      ? `当前 ${state.scene.captions.length} 条字幕（时间轴上绿色那条就是它）`
      : '还没有字幕。导入 SRT / VTT / ASS 就会自动挂一个卡点字幕图层。';
    gc.appendChild(cinfo);
    const row = document.createElement('div');
    row.className = 'btn-row';
    row.appendChild(btn('导入 SRT / ASS / VTT', () => $('fileSubs').click()));
    row.appendChild(btn('切成短句（适合弹字）', () => {
      state.scene.captions = state.scene.captions
        .flatMap((c) => splitForKinetic([c], { maxChars: 12 }))
        .map((c) => new Caption(c));
      drawTimeline();
    }));
    row.appendChild(btn('清空字幕', () => { state.scene.captions = []; drawTimeline(); }, 'danger'));
    gc.appendChild(row);
    body.appendChild(gc);
  }
  body.appendChild(buildCaptionReskinGroup());
  body.appendChild(buildCaptionGroupGroup());
}

// ---------------------------------------------------------------- 字幕换装
/**
 * 换模板时把"这句话"搬过去。
 *
 * 模板参数是各写各的：同一个 id 改名会丢东西 —— 字幕条的字在字幕轨上、
 * 卡点大字的字在 text、编号卡片的在 items、终端的在 lines。直接换 id 的话
 * 新模板读不到参数，画面上那句台词就没了。所以换之前先把文本抠出来，
 * 换完写进新模板对应的那个参数里。
 */
const TEXT_KEYS = ['text', 'lines', 'items', 'content', 'label', 'product', 'name', 'note', 'title', 'chapters'];

/** 新模板把"一句台词"放哪个参数里（不在表里 = 这个模板不放台词） */
const TEXT_SLOT = {
  'kinetic-type': 'text', 'word-grid': 'text', 'note-bubble': 'text', 'ticker-strip': 'text',
  'type-stack': 'text', 'callout-pin': 'text', 'rock-title': 'text', 'gig-poster': 'title',
  'title-mark': 'title', 'editorial-title': 'title',
  'terminal-prompt': 'lines', 'credits-roll': 'lines', 'look-card': 'items', 'index-list': 'items',
  'tape-label': 'label', 'shipping-label': 'product', 'name-bar': 'name',
  'series-index': 'note', 'stat-counter': 'label', 'dial-gauge': 'label', 'magnifier': 'label',
  'focus-box': 'label', 'split-compare': 'labelA', 'letterbox-push': 'caption',
  'subtitle-kinetic': null,   // 台词来自字幕轨，不用搬
};

/** 从图层参数里抠出台词。优先级按"这个键更像正文"排，title 排后面（编号卡片的 title 只是前缀） */
function readLayerText(L) {
  for (const k of TEXT_KEYS) {
    const v = L.params && L.params[k];
    if (typeof v === 'string' && v.trim()) return cleanCarriedText(v);
  }
  return '';
}

/** 去掉搬运路上的装饰：终端面板的 "> "、跑马灯的序号前缀 */
function cleanCarriedText(s) {
  return String(s).split('\n')
    .map((ln) => ln.replace(/^\s*>\s?/, '').replace(/^\s*\d{2}\s{2,}/, '').trim())
    .filter(Boolean).join('\n').trim();
}

/** 图层压着的那几句字幕（一条盖住整条轨时，最多取前 6 句当多行） */
function captionTextForLayer(L) {
  const caps = state.scene.captions || [];
  if (!caps.length) return '';
  const hit = caps.filter((c) => c.start >= L.start - 0.35 && c.end <= L.end + 0.35);
  if (!hit.length) return '';
  return hit.slice(0, 6).map((c) => c.text).join('\n');
}

/** 字幕类图层（换装出来的 / 字幕轨那条 / 名字里带字幕的）才允许回字幕轨找台词 */
function isCaptionLayer(L) {
  return L.group === 'caption-reskin' || L.template === 'subtitle-kinetic' || /字幕/.test(L.name || '');
}

/**
 * 换模板：台词、位置、颜色、字号这些能对上的参数都跟着走。
 * extra 是新样式自己算好的参数（换装池切换单个样子时用），优先级最高。
 */
function switchLayerTemplate(L, tpl, extra, label) {
  if (!L || L.template === tpl) return;
  const src = readLayerText(L) || (isCaptionLayer(L) ? captionTextForLayer(L) : '');
  const spec = listTemplates().find((t) => t.id === tpl);
  const keys = new Set(((spec && spec.params) || []).map((p) => p.key));
  const keep = {};
  // 字号不跟着走：各模板的字号不是一个量纲（字幕条 44、卡点大字 118），
  // 搬过去只会把版式弄坏 —— 这点和「整组改」用倍数是一个道理。
  for (const k of ['position', 'color', 'accent', 'speed']) {
    if (keys.has(k) && L.params && L.params[k] !== undefined && L.params[k] !== '') keep[k] = L.params[k];
  }
  L.template = tpl;
  L.params = Object.assign(keep, extra || {});
  const slot = TEXT_SLOT[tpl];
  if (src && slot) L.params[slot] = src;
  if (/^字幕换装 /.test(L.name || '')) L.name = L.name.replace(/·.*$/, '· ' + (label || (spec ? spec.name : tpl)));
  invalidateLayerBox(L.id);
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();

  if (src && slot) toast('台词跟着搬过来了：' + (src.length > 16 ? src.slice(0, 16) + '…' : src));
  else if (src && slot === null) toast('这个模板不放台词，台词还在字幕轨上');
}

/** 字幕页里单独给第 i 句换个样子（池子里的第 poolIdx 个） */
function switchCaptionLook(i, poolIdx) {
  const caps = state.scene.captions;
  const L = captionLayerFor(i);
  const pool = captionLookPool(state.captionReskin.tier);
  const look = pool[Number(poolIdx)];
  if (!L || !caps[i] || !look) return;
  switchLayerTemplate(L, look.tpl, look.params(caps[i], i, caps.length), look.label);
  renderRight();
}

/** 第 i 句台词是哪个图层在演（按时间重叠最多的那个找，删过层也不会错位） */
function captionLayerFor(i) {
  const c = state.scene.captions[i];
  if (!c) return null;
  let best = null, bestOv = 0;
  for (const L of captionGroupList()) {
    const ov = Math.min(L.end, c.end) - Math.max(L.start, c.start);
    if (ov > bestOv) { bestOv = ov; best = L; }
  }
  return best;
}

/**
 * 字幕换装：让每一句台词交给一个「已有的设计模板」来演。
 *
 * 为什么这么做：一条 subtitle-kinetic 从头铺到尾，四十分钟都是同一个样子，
 * 而引擎里本来就有二十几个能装下一句台词的模板。这里把它们做成一个池子，
 * 一句一个轮着发 —— 尽量不重复，也不会连着两句撞同一个。
 *
 * tier 分三档，UI 里就是「字幕感 / 混合 / 海报感」：
 *   sub    贴着成片字幕的观感（黑条、等宽、逐词高亮、气泡、跑马灯、终端、编号卡、胶带）
 *   mid    再加能当"一句话"的中等强度版式（卡点大字、标题定格、词块宫格、索引标注、名字条、吊牌、压扁大字）
 *   poster 全屏海报级（杂志标题、摇滚大标题、系列编号）—— 一次别用太多，会盖住画面
 */
const CAPTION_LOOKS = [
  // ---- tier 'sub'
  { tpl: 'subtitle-kinetic', label: '字幕条', tier: 'sub',
    params: (c) => ({ style: 'bar', position: '0.5,0.86', size: 44, maxWidth: 0.78, plate: true, pop: true }) },
  { tpl: 'subtitle-kinetic', label: '等宽字幕', tier: 'sub',
    params: (c) => ({ style: 'mono', position: '0.5,0.88', size: 34, maxWidth: 0.8, plate: true, pop: true }) },
  { tpl: 'subtitle-kinetic', label: '逐词高亮', tier: 'sub',
    params: (c) => ({ style: 'karaoke', position: '0.5,0.86', size: 46, maxWidth: 0.8, plate: true, pop: false }) },
  { tpl: 'note-bubble', label: '注释气泡', tier: 'sub',
    params: (c, i) => ({ text: c.text, position: ['0.08,0.72', '0.54,0.74', '0.08,0.28', '0.56,0.30'][i % 4], width: 520, size: 22 }) },
  { tpl: 'ticker-strip', label: '跑马灯条', tier: 'sub',
    params: (c, i) => ({ text: z2(i + 1) + '   ' + c.text, position: '0.06,0.78,0.88', height: 34, size: 17, speed: 1 }) },
  { tpl: 'terminal-prompt', label: '终端面板', tier: 'sub',
    params: (c, i) => ({ title: 'CAPTION ' + z2(i + 1), lines: '> ' + c.text, position: i % 2 ? '0.48,0.62' : '0.07,0.60', width: 520, size: 20, charDelay: 0.018 }) },
  { tpl: 'look-card', label: '编号卡片', tier: 'sub',
    params: (c, i) => ({ title: 'LINE', startIndex: i + 1, items: c.text, position: i % 2 ? '0.50,0.60' : '0.07,0.58', width: 520, size: 22, stagger: 1, hold: true }) },
  { tpl: 'tape-label', label: '胶带标签', tier: 'sub', maxLen: 16,
    params: (c, i) => ({ label: cutText(c.text, 16), note: 'LINE ' + z2(i + 1), position: i % 2 ? '0.5,0.78' : '0.5,0.24', size: 40, angle: i % 2 ? 4 : -4, inDur: 0.3, outDur: 0.25 }) },
  // ---- tier 'mid'
  { tpl: 'kinetic-type', label: '卡点大字', tier: 'mid',
    params: (c) => ({ text: c.text, mode: 'slam', position: '0.5,0.56', size: 118, fit: true, maxWidth: 0.8, ghost: true, beatsPerStep: 2 }) },
  { tpl: 'title-mark', label: '标题定格', tier: 'mid',
    params: (c, i) => ({ title: c.text, kicker: 'LINE ' + z2(i + 1), note: '', position: '0.5,0.50', size: 118, fit: true, maxWidth: 0.82, rule: true }) },
  { tpl: 'word-grid', label: '词块宫格', tier: 'mid',
    params: (c) => ({ text: c.text, cols: 4, position: '0.5,0.54', cellW: 300, cellH: 84, fontSize: 34, beatsPerStep: 1 }) },
  { tpl: 'callout-pin', label: '索引标注', tier: 'mid', maxLen: 16,
    params: (c, i) => ({ index: String(i + 1), text: cutText(c.text, 16), point: '0.62,0.44', dir: ['tr', 'bl', 'tl', 'br'][i % 4], len: 190, size: 26, plate: '#0a0a0c', inDur: 0.35, outDur: 0.25 }) },
  { tpl: 'name-bar', label: '名字条', tier: 'mid', maxLen: 12,
    params: (c, i) => ({ name: cutText(c.text, 12), role: 'LINE ' + z2(i + 1), pos: ['bl', 'br', 'ml', 'mr'][i % 4], margin: 72, width: 0.42, size: 38, inDur: 0.3, outDur: 0.25 }) },
  { tpl: 'shipping-label', label: '吊牌', tier: 'mid', maxLen: 18,
    params: (c, i) => ({ product: cutText(c.text, 18), sku: 'LINE-' + z2(i + 1), care: '', position: i % 2 ? '0.62,0.30' : '0.08,0.32', width: 340, rotate: i % 2 ? 3 : -3 }) },
  { tpl: 'type-stack', label: '压扁大字', tier: 'mid',
    params: (c, i) => ({ text: c.text, mode: i % 2 ? 'inline' : 'stack', position: '0.5,0.56', size: 96, maxWidth: 0.7, align: 'center', period: true, inDur: 0.4, outDur: 0.3 }) },
  { tpl: 'type-stack', label: '竖排大字', tier: 'mid', maxLen: 12,
    params: (c) => ({ text: c.text, mode: 'vertical', position: '0.5,0.54', size: 84, align: 'center', period: true, inDur: 0.4, outDur: 0.3 }) },
  // ---- tier 'poster'
  { tpl: 'editorial-title', label: '杂志标题', tier: 'poster',
    params: (c, i, n) => ({ title: c.text, kicker: 'LINE ' + z2(i + 1), note: '', index: z2(i + 1) + ' / ' + z2(n), position: '0.5,0.5', align: 'center', size: 110, maxWidth: 0.78, rule: true, plate: '', inDur: 0.4, outDur: 0.3 }) },
  { tpl: 'rock-title', label: '摇滚大标题', tier: 'poster',
    params: (c, i) => ({ text: c.text, sub: 'LINE ' + z2(i + 1), tag: '', position: '0.5,0.5', size: 132, maxWidth: 0.78, rotate: -1.4, band: true, inDur: 0.4, outDur: 0.3 }) },
  { tpl: 'series-index', label: '系列编号', tier: 'poster',
    params: (c, i) => ({ index: z2(i + 1), note: c.text, from: '', to: '', arrow: false, page: '/' + z2(i + 1), title: '', paper: false, frame: false, inDur: 0.4, outDur: 0.3 }) },
];

state.captionReskin = { tier: 'mid', lead: 0.15, tail: 0.35, replace: true, plan: null };

const z2 = (n) => String(n).padStart(2, '0');
const cutText = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function captionLookPool(tier) {
  const keep = { sub: ['sub'], mid: ['sub', 'mid'], poster: ['sub', 'mid', 'poster'] }[tier] || ['sub', 'mid'];
  return CAPTION_LOOKS.filter((k) => keep.includes(k.tier));
}

/** Fisher–Yates，rnd 传 Math.random 或带种子的随机函数 */
function shuffledCopy(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 排"第几句用池子里第几个样子"。
 *
 * 两条规矩：
 *   1) 用量少的先用 —— 一轮用完之前不会重复，也不会出现某几个反复用、另外几个从不露脸；
 *   2) 连着两句不许撞样子。
 * 外加一条：样子自己会声明"我这行最长放得下几个字"（maxLen）。长句子自动跳过
 * 胶带标签 / 名字条 / 吊牌 / 竖排这种装不下的，免得台词被截成半句或者冲出画面。
 */
function planCaptionLooks(captions, pool, rnd) {
  const rankOf = [];
  shuffledCopy(pool.map((_, i) => i), rnd).forEach((j, k) => { rankOf[j] = k; });   // 平局时的先后
  const used = pool.map(() => 0);
  const plan = [];
  for (let i = 0; i < captions.length; i++) {
    const len = String((captions[i] && captions[i].text) || '').length;
    let best = -1;
    for (let j = 0; j < pool.length; j++) {
      if (pool[j].maxLen && len > pool[j].maxLen) continue;
      if (i > 0 && j === plan[i - 1]) continue;
      if (best < 0 || used[j] < used[best] || (used[j] === used[best] && rankOf[j] < rankOf[best])) best = j;
    }
    if (best < 0) best = pool.findIndex((k) => !k.maxLen || len <= k.maxLen);   // 可用样子实在太少
    if (best < 0) best = 0;
    plan.push(best);
    used[best]++;
  }
  return plan;
}

/** 这一批要用的模板（顺序固定，面板每次重画都读它，不会自己乱跳） */
function captionPlanLooks() {
  const p = state.captionReskin;
  const pool = captionLookPool(p.tier);
  const caps = state.scene.captions;
  const n = caps.length;
  const stale = !p.plan || p.plan.n !== n || p.plan.tier !== p.tier || !p.plan.picks;
  if (stale) p.plan = { n, tier: p.tier, picks: planCaptionLooks(caps, pool, Math.random) };
  return p.plan.picks.map((i) => pool[i]).filter(Boolean);
}

function applyCaptionReskin() {
  const s = state.scene;
  const p = state.captionReskin;
  if (!s.captions.length) { alert('还没有字幕。先「导入 SRT / ASS / VTT」，再来换装。'); return; }
  const looks = captionPlanLooks();
  if (!looks.length) return;

  s.layers = s.layers.filter((L) => L.group !== 'caption-reskin');            // 上一轮换装先撤掉
  if (p.replace) {
    // 导入字幕时自动挂的那条整段「卡点字幕」：换装之后留着只会和换装层打架
    s.layers = s.layers.filter((L) => !(L.template === 'subtitle-kinetic' && /卡点字幕/.test(L.name || '')));
  }

  const n = s.captions.length;
  s.captions.forEach((c, i) => {
    const look = looks[i % looks.length];
    // 字幕类模板自己按字幕时间做起落，多给的提前量反而会两句同时亮
    const sub = look.tpl === 'subtitle-kinetic';
    const a = Math.max(0, sub ? c.start : c.start - p.lead);
    const b = Math.min(s.duration, sub ? c.end : c.end + p.tail);
    s.add({
      template: look.tpl,
      start: +a.toFixed(3),
      end: +Math.max(a + 0.2, b).toFixed(3),
      seed: 'cap-' + (++state.layerSeq),
      name: '字幕换装 ' + z2(i + 1) + ' · ' + look.label,
      group: 'caption-reskin',
      params: look.params(c, i, n),
    });
  });

  captionGroupCaptureBase();     // 整组改的基准值：刚铺好的这一版
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  const used = new Set(s.layers.filter((L) => L.group === 'caption-reskin').map((L) => L.template));
  toast(`换装完成：${n} 句台词 · ${used.size} 个不同模板`);
}

function clearCaptionReskin() {
  const before = state.scene.layers.length;
  state.scene.layers = state.scene.layers.filter((L) => L.group !== 'caption-reskin');
  const gone = before - state.scene.layers.length;
  state.captionGroup.base = {};
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  if (gone) toast(`清掉 ${gone} 个换装图层`);
}

function buildCaptionReskinGroup() {
  const g = group('字幕换装（每句一个模板）');
  const p = state.captionReskin;
  const captions = state.scene.captions;
  const mine = state.scene.layers.filter((L) => L.group === 'caption-reskin');

  const note = document.createElement('div');
  note.className = 'fx-note';
  note.textContent = '把每一句台词交给一个已有的设计模板来演：池子轮着发，'
    + '一轮用完之前不会重复，也不会连着两句撞同一个。不满意就「换一批」重新洗牌。';
  g.appendChild(note);

  g.appendChild(selectField('换装风格', p.tier, [
    { value: 'sub', label: '字幕感 · 稳' },
    { value: 'mid', label: '混合 · 推荐' },
    { value: 'poster', label: '海报感 · 夸张' },
  ], (v) => { p.tier = v; p.plan = null; renderRight(); }));

  g.appendChild(checkField('去掉原来那条整段「卡点字幕」', p.replace, (v) => { p.replace = v; }));

  const row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(btn('给每句字幕换模板', () => applyCaptionReskin()));
  row.appendChild(btn('换一批（重新洗牌）', () => { p.plan = null; renderRight(); }));
  row.appendChild(btn('清掉换装', () => clearCaptionReskin(), 'danger'));
  g.appendChild(row);

  const info = document.createElement('div');
  info.className = 'empty';
  info.style.whiteSpace = 'pre-line';
  if (!captions.length) {
    info.textContent = '还没有字幕。导入 SRT / ASS / VTT 之后，这里会列出一句台词配哪个模板。';
  } else {
    const looks = captionPlanLooks();
    const counts = new Map();
    for (const l of looks) counts.set(l.label, (counts.get(l.label) || 0) + 1);
    const most = Math.max(...counts.values());
    info.textContent = `共 ${captions.length} 句 · 用到 ${counts.size} 个不同样子 · 最多的用了 ${most} 次\n`
      + (mine.length
        ? `画面上已经是换装过的 ${mine.length} 层 —— 下面每句都能单独换个样子，台词不会丢`
        : '点上面的按钮铺上去之后，下面每句都能单独换样子');
  }
  g.appendChild(info);

  // 每句一行：想单独改哪句就改哪句，换过去台词照搬
  const pool = captionLookPool(p.tier);
  if (mine.length && captions.length) {
    const listBox = document.createElement('div');
    listBox.className = 'cap-list';
    captions.forEach((c, i) => {
      const L = captionLayerFor(i);
      const row = document.createElement('div');
      row.className = 'cap-row';
      const tx = document.createElement('div');
      tx.className = 'cap-tx';
      tx.textContent = z2(i + 1) + ' ' + c.text;
      tx.title = c.text;
      const sel = document.createElement('select');
      const cur = L ? String(L.name).split('·').pop().trim() : '';
      let matched = false;
      pool.forEach((look, j) => {
        const o = document.createElement('option');
        o.value = String(j);
        o.textContent = look.label;
        if (!matched && look.label === cur) { o.selected = true; matched = true; }
        sel.appendChild(o);
      });
      if (!matched) {
        // 当前这个样子不在这档池子里（比如换过档 / 手动换过模板），补一个出来免得显示错
        const o = document.createElement('option');
        o.value = '-1';
        o.textContent = (cur || L.template) + '（当前）';
        o.selected = true;
        sel.insertBefore(o, sel.firstChild);
      }
      sel.addEventListener('change', () => {
        if (sel.value === '-1') return;
        switchCaptionLook(i, Number(sel.value));
      });
      row.appendChild(tx);
      row.appendChild(sel);
      listBox.appendChild(row);
    });
    g.appendChild(listBox);
  }
  return g;
}

// ---------------------------------------------------------------- 字幕换装：整组改
/**
 * 换装出来的每一句都是一个独立图层（40 句就是 40 层），一层层调太烦。
 * 这里改一个等于改全部 —— 和「卡点重复动效」那套是一个路子。
 *
 * 字号给的是**倍数**不是绝对值：池子里各模板的原始字号差着好几倍
 * （字幕条 44、卡点大字 118），统一设成 60 只会把一半样子弄坏。
 * 位置走的是图层自带的 transform（引擎统一处理），所以 19 种样子通吃。
 */
state.captionGroup = { scale: 1, dx: 0, dy: 0, opacity: 1, base: {} };

function captionGroupList() { return state.scene.layers.filter((L) => L.group === 'caption-reskin'); }

/** 这个模板用哪个参数当"字号"（没有单一字号的返回 null，整组改会跳过它） */
function captionSizeKey(tpl) {
  if (tpl === 'word-grid') return 'fontSize';
  if (tpl === 'series-index') return null;
  return 'size';
}

/** 换装之后把基准值记下来：整组改都是相对基准算的，不是叠着改 */
function captionGroupCaptureBase() {
  const g = state.captionGroup;
  g.base = {};
  g.scale = 1; g.dx = 0; g.dy = 0; g.opacity = 1;
  for (const L of captionGroupList()) {
    const key = captionSizeKey(L.template);
    const tr = L.transform || { x: 0, y: 0 };
    g.base[L.id] = { key, size: key ? (L.params[key] ?? 40) : null, x: tr.x || 0, y: tr.y || 0 };
  }
}

function captionBaseOf(L) {
  const g = state.captionGroup;
  if (!g.base[L.id]) {
    const key = captionSizeKey(L.template);
    const tr = L.transform || { x: 0, y: 0 };
    g.base[L.id] = { key, size: key ? (L.params[key] ?? 40) : null, x: tr.x || 0, y: tr.y || 0 };
  }
  return g.base[L.id];
}

/** what: { size, place, alpha, time } —— 只动点名的那几样，其余保持原样 */
function captionGroupApply(what) {
  const g = state.captionGroup;
  const caps = state.scene.captions;
  const list = captionGroupList();
  list.forEach((L, i) => {
    const b = captionBaseOf(L);
    if (what.size && b.key) L.params[b.key] = Math.round(b.size * g.scale * 10) / 10;
    if (what.place) {
      const x = +(b.x + g.dx).toFixed(4);
      const y = +(b.y + g.dy).toFixed(4);
      L.transform = (x || y) ? { x, y, scale: 1, rot: 0, px: 0.5, py: 0.5 } : null;
    }
    if (what.alpha) L.opacity = g.opacity;
    if (what.time && caps[i]) {
      const sub = L.template === 'subtitle-kinetic';   // 字幕类自己按字幕时间做起落
      const a = Math.max(0, sub ? caps[i].start : caps[i].start - state.captionReskin.lead);
      const b2 = Math.min(state.scene.duration, sub ? caps[i].end : caps[i].end + state.captionReskin.tail);
      L.start = +a.toFixed(3);
      L.end = +Math.max(a + 0.2, b2).toFixed(3);
    }
    invalidateLayerBox(L.id);
  });
  drawTimeline(); renderAt(state.t); blit();
  return list.length;
}

function buildCaptionGroupGroup() {
  const g = group('字幕换装（整组改）');
  const list = captionGroupList();

  if (!list.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '还没换装过。上面点一下「给每句字幕换模板」，这里就会出现整组改的开关。';
    g.appendChild(e);
    return g;
  }

  const note = document.createElement('div');
  note.className = 'fx-note';
  note.textContent = `当前 ${list.length} 个换装图层，改一个等于改全部。`
    + '字号给的是倍数（各模板原始字号差着好几倍）；位置走图层变换，19 种样子通吃。'
    + '单独拖过的那层会被整组位置覆盖，这是故意的。';
  g.appendChild(note);

  const cg = state.captionGroup;
  g.appendChild(numField('字号 ×', cg.scale, 0.4, 2.5, 0.05, (v) => { cg.scale = v; captionGroupApply({ size: true }); }));
  g.appendChild(numField('上下位置', cg.dy, -0.35, 0.35, 0.005, (v) => { cg.dy = v; captionGroupApply({ place: true }); }));
  g.appendChild(numField('左右位置', cg.dx, -0.35, 0.35, 0.005, (v) => { cg.dx = v; captionGroupApply({ place: true }); }));
  g.appendChild(numField('不透明度', cg.opacity, 0, 1, 0.02, (v) => { cg.opacity = v; captionGroupApply({ alpha: true }); }));
  g.appendChild(numField('提前量(秒)', state.captionReskin.lead, 0, 1, 0.05, (v) => {
    state.captionReskin.lead = v;
    captionGroupApply({ time: true });
  }));
  g.appendChild(numField('尾巴(秒)', state.captionReskin.tail, 0, 1, 0.05, (v) => {
    state.captionReskin.tail = v;
    captionGroupApply({ time: true });
  }));

  const row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(btn('重置整组', () => {
    cg.scale = 1; cg.dx = 0; cg.dy = 0; cg.opacity = 1;
    captionGroupApply({ size: true, place: true, alpha: true });
    renderRight();
    toast('字号 / 位置 / 不透明度已回到基准');
  }));
  row.appendChild(btn('全部关掉', () => {
    captionGroupList().forEach((L) => { L.enabled = false; });
    drawTimeline(); renderAt(state.t); blit();
  }));
  row.appendChild(btn('全部打开', () => {
    captionGroupList().forEach((L) => { L.enabled = true; });
    drawTimeline(); renderAt(state.t); blit();
  }));
  row.appendChild(btn('删掉整组', () => clearCaptionReskin(), 'danger'));
  g.appendChild(row);
  return g;
}

/** 特效页：整段画面的后期栈（「画面一直闪」就在这儿关） */
function rightPanelFx(body) {
  body.appendChild(buildFxGroup());
}

/**
 * 「卡点重复动效」整组控制。
 * 一键铺出来的闪白/推近动不动十几个，一层层删太烦 —— 这里改一个等于改全部。
 */
function buildBeatFxGroup() {
  const g = group('重复动效（整组改）');
  const note = document.createElement('div');
  note.className = 'fx-note';
  note.textContent = '一键铺出来的闪白 / 推近 / 卡点大字都在这里整组改：'
    + '强度、时长、渐入、随机差异立刻作用到全部；改频率会按新频率重排，不用一层层删或加。';
  g.appendChild(note);

  for (const def of BEAT_FX) {
    const list = beatFxList(def.tpl);
    const base = beatFxBase(def.tpl);
    const box = document.createElement('div');
    box.className = 'fx-item' + (list.length ? '' : ' off');
    const head = document.createElement('div');
    head.className = 'fx-head';
    const nm = document.createElement('b');
    nm.textContent = `${def.label}（${list.length} 个）`;
    head.appendChild(nm);
    box.appendChild(head);
    const bump = () => { nm.textContent = `${def.label}（${beatFxList(def.tpl).length} 个）`; };

    box.appendChild(numField(def.keyLabel || '强度', base.peak, def.min, def.max, def.step, (v) => {
      base.peak = v;
      beatFxApplyAll(def.tpl);
    }));
    for (const ex of def.extras || []) {
      box.appendChild(numField(ex.label, base[ex.key] !== undefined ? base[ex.key] : ex.def,
        ex.min, ex.max, ex.step, (v) => { base[ex.key] = v; beatFxApplyAll(def.tpl); }));
    }
    if (def.dur) {
      box.appendChild(numField('单次时长(秒)', base.dur, 0.05, 1.5, 0.01, (v) => {
        base.dur = v;
        beatFxApplyAll(def.tpl);
      }));
    }
    if (def.mode === 'relay') {
      box.appendChild(numField('随机差异', base.jitter || 0, 0, 1, 0.05, (v) => {
        base.jitter = v;
        beatFxApplyAll(def.tpl);
      }));
    }
    if (def.mode === 'relay' || def.mode === 'retime') {
      box.appendChild(field('频率', () => {
        const s = document.createElement('select');
        for (const [v, t] of [['1', '每个拍点'], ['2', '每 2 拍'], ['4', '每 4 拍'], ['8', '每 8 拍']]) {
          const o = document.createElement('option');
          o.value = v; o.textContent = t;
          if (String(state.beatFxEvery[def.tpl] || def.every || 2) === v) o.selected = true;
          s.appendChild(o);
        }
        s.addEventListener('change', () => {
          const n = Number(s.value);
          if (def.mode === 'relay') beatFxRelay(def.tpl, n); else beatFxRetime(def.tpl, n);
          renderRight();
        });
        return s;
      }));
    }

    const row = document.createElement('div');
    row.className = 'btn-row';
    if (def.mode !== 'none') {
      row.appendChild(btn(def.mode === 'relay' ? (list.length ? '按当前设置重铺' : '按当前设置铺上') : '按频率重排',
        () => {
          const n = Number(state.beatFxEvery[def.tpl] || def.every || 2);
          if (def.mode === 'relay') beatFxRelay(def.tpl, n); else beatFxRetime(def.tpl, n);
          renderRight();
        }));
    }
    row.appendChild(btn('全部关掉', () => {
      beatFxList(def.tpl).forEach((L) => { L.enabled = false; });
      drawTimeline(); renderAt(state.t); blit(); bump();
    }));
    row.appendChild(btn('全部打开', () => {
      beatFxList(def.tpl).forEach((L) => { L.enabled = true; });
      drawTimeline(); renderAt(state.t); blit(); bump();
    }));
    row.appendChild(btn('清空', () => {
      const n = beatFxList(def.tpl).length;
      if (!n) return;
      if (!confirm(`确定删掉全部 ${n} 个「${def.label}」？\n（删了之后还能用上面的按钮重新铺一遍）`)) return;
      beatFxClear(def.tpl); renderRight();
    }, 'danger'));
    box.appendChild(row);
    g.appendChild(box);
  }
  return g;
}

function group(title) {
  const d = document.createElement('div');
  d.className = 'group';
  const h = document.createElement('h4');
  h.textContent = title;
  d.appendChild(h);
  return d;
}

// ---------------------------------------------------------------- 特效面板
// 特效是"整段画面的后期栈"，叠在所有图层之上。成片里最常见的"一直在闪"就是
// 这里的 flash（跟着拍点闪白）——以前只能手改 JSON，现在给个界面。
const FX_DEFS = {
  flash: { label: '闪白（跟着拍点闪）', amount: 0.18, min: 0, max: 1, step: 0.01, extra: 'flash' },
  grain: { label: '颗粒', amount: 0.12, min: 0, max: 0.6, step: 0.01 },
  scanlines: { label: '扫描线', amount: 0.16, min: 0, max: 0.6, step: 0.01, extra: 'scanlines' },
  chromatic: { label: '色差', amount: 4, min: 0, max: 40, step: 0.5 },
  vignette: { label: '暗角', amount: 0.35, min: 0, max: 1, step: 0.01 },
  bloom: { label: '辉光', amount: 0.35, min: 0, max: 1, step: 0.01 },
  glitch: { label: '故障切片', amount: 0.35, min: 0, max: 2, step: 0.01 },
  halftone: { label: '半调网点', amount: 0.4, min: 0, max: 1, step: 0.01 },
  pixelate: { label: '像素化', amount: 8, min: 0, max: 60, step: 1 },
  vhs: { label: 'VHS', amount: 0.5, min: 0, max: 1, step: 0.01 },
  datamosh: { label: '数据摩什', amount: 0.4, min: 0, max: 1, step: 0.01 },
  letterbox: { label: '遮幅', amount: 0.5, min: 0, max: 1, step: 0.01 },
  bleach: { label: '漂白', amount: 0.4, min: 0, max: 1, step: 0.01 },
  invert: { label: '反相闪光（同样是闪，慎用）', amount: 0, min: 0, max: 1, step: 0.01, extra: 'flash' },
};

const FX_FREQ = [
  ['1', '每个拍点'], ['2', '每 2 拍'], ['4', '每 4 拍（强拍）'],
];

function rebuildFx() { renderAt(state.t); blit(); }

function buildFxGroup() {
  const g = group('特效（后期栈）');
  const fx = state.scene.fx || (state.scene.fx = []);

  const note = document.createElement('div');
  note.className = 'fx-note';
  note.textContent = '叠在所有图层之上的整段处理。画面一直闪，基本就是这里的「闪白」。';
  g.appendChild(note);

  if (!fx.length) {
    const e = document.createElement('div');
    e.className = 'fx-note';
    e.textContent = '当前没有任何特效。';
    g.appendChild(e);
  }

  fx.forEach((spec, idx) => {
    const def = FX_DEFS[spec.type] || { label: spec.type, amount: 0.5, min: 0, max: 1, step: 0.01 };
    const box = document.createElement('div');
    box.className = 'fx-item' + (spec.enabled === false ? ' off' : '');

    const head = document.createElement('div');
    head.className = 'fx-head';
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = spec.enabled !== false;
    on.title = '关掉这一条特效';
    on.addEventListener('change', () => {
      spec.enabled = on.checked;
      box.classList.toggle('off', !on.checked);
      rebuildFx();
    });
    const nm = document.createElement('b');
    nm.textContent = def.label;
    const del = document.createElement('button');
    del.className = 'fx-del';
    del.textContent = '×';
    del.title = '删除这条特效';
    del.addEventListener('click', () => {
      state.scene.fx.splice(idx, 1);
      renderRight(); rebuildFx();
    });
    head.appendChild(on); head.appendChild(nm); head.appendChild(del);
    box.appendChild(head);

    box.appendChild(numField('强度', spec.amount ?? def.amount, def.min, def.max, def.step, (v) => {
      spec.amount = v;
      spec.enabled = spec.enabled === false ? false : true;
      rebuildFx();
    }));

    if (def.extra === 'flash') {
      box.appendChild(numField('单次时长(秒)', spec.duration ?? 0.06, 0.01, 0.5, 0.005, (v) => {
        spec.duration = v; rebuildFx();
      }));
      box.appendChild(field('频率', () => {
        const s = document.createElement('select');
        const every = String(spec.every ?? 1);
        for (const [val, label] of FX_FREQ) {
          const o = document.createElement('option');
          o.value = val; o.textContent = label; o.selected = val === every;
          s.appendChild(o);
        }
        s.addEventListener('change', () => { spec.every = Number(s.value); rebuildFx(); });
        return s;
      }));
    }
    if (def.extra === 'scanlines') {
      box.appendChild(numField('行距(px)', spec.step ?? 3, 1, 12, 1, (v) => {
        spec.step = v; rebuildFx();
      }));
    }
    if (spec.type === 'chromatic') {
      box.appendChild(checkField('随时间抖动', spec.animated === true, (v) => {
        spec.animated = v; rebuildFx();
      }));
    }
    g.appendChild(box);
  });

  const row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(btn('全部关掉', () => {
    for (const s of state.scene.fx) s.enabled = false;
    renderRight(); rebuildFx();
  }));
  row.appendChild(btn('全部打开', () => {
    for (const s of state.scene.fx) s.enabled = true;
    renderRight(); rebuildFx();
  }));
  g.appendChild(row);

  g.appendChild(field('新增特效', () => {
    const wrap = document.createElement('div');
    wrap.className = 'fx-add';
    const s = document.createElement('select');
    for (const [id, d] of Object.entries(FX_DEFS)) {
      const o = document.createElement('option');
      o.value = id; o.textContent = d.label;
      s.appendChild(o);
    }
    const b = btn('添加', () => {
      const id = s.value;
      const d = FX_DEFS[id] || { amount: 0.5 };
      const spec = { type: id, amount: d.amount };
      if (d.extra === 'flash') { spec.duration = 0.06; spec.hits = 'beats'; spec.every = 2; }
      if (id === 'chromatic') spec.animated = true;
      if (id === 'scanlines') spec.step = 3;
      state.scene.fx.push(spec);
      renderRight(); rebuildFx();
    });
    wrap.appendChild(s); wrap.appendChild(b);
    return wrap;
  }));

  return g;
}
function field(labelText, make) {
  const d = document.createElement('div');
  d.className = 'field';
  const l = document.createElement('label'); l.textContent = labelText;
  d.appendChild(l); d.appendChild(make());
  return d;
}
function numField(labelText, value, min, max, step, onInput) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;align-items:center;flex:1 1 auto;min-width:0';
  const r = document.createElement('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value;
  const n = document.createElement('input'); n.type = 'number'; n.min = min; n.max = max; n.step = step; n.value = value;
  n.style.flex = '0 0 74px';
  r.addEventListener('input', () => { n.value = r.value; onInput(parseFloat(r.value)); renderAt(state.t); blit(); });
  n.addEventListener('input', () => { r.value = n.value; onInput(parseFloat(n.value) || 0); renderAt(state.t); blit(); });
  wrap.appendChild(r); wrap.appendChild(n);
  return field(labelText, () => wrap);
}
/**
 * 这个颜色参数是不是"底色"性质的？
 * 底色留空＝透明；但闪光色（fillColor）之类留空会被模板回退成默认色，
 * 那样"透明"就会闪成黑的，所以排除掉。
 */
function isBackgroundParam(key) {
  const k = String(key || '');
  if (/^paperColor$/i.test(k)) return true;
  if (/(color|colour)$/i.test(k)) return false;
  return /(plate|fill|bg|paper|backdrop)/i.test(k);
}

/**
 * 颜色参数。
 * allowTransparent=true 时多给一个「透明」勾选 —— 底色类参数（垫底色 / 纸色 / 填充）
 * 清空文字框就是透明，但没人猜得到，所以给个明面上的开关。
 */
function colorField(labelText, value, onChange, allowTransparent) {
  return field(labelText, () => {
    const holder = document.createElement('div');
    holder.style.cssText = 'display:flex;gap:6px;flex:1 1 auto;min-width:0';
    const c = document.createElement('input'); c.type = 'color';
    c.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
    const t = document.createElement('input'); t.type = 'text'; t.value = value || ''; t.placeholder = '空 = 透明';
    let last = c.value;
    const apply = (v) => { t.value = v; onChange(v); renderAt(state.t); blit(); };
    c.addEventListener('input', () => { last = c.value; apply(c.value); });
    t.addEventListener('change', () => {
      const v = t.value.trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) last = v;
      apply(v);
    });
    holder.appendChild(c); holder.appendChild(t);
    if (allowTransparent) {
      const chip = document.createElement('div');
      chip.className = 'swatch-tp';
      chip.title = '透明';
      chip.style.display = 'none';
      holder.insertBefore(chip, c);
      const box = document.createElement('label');
      box.className = 'mini nowrap';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !value;
      cb.title = '勾上＝这一层不要底色（透明）';
      const sync = () => {
        cb.checked = !t.value.trim();
        c.disabled = cb.checked;
        t.disabled = cb.checked;
        c.classList.toggle('is-transparent', cb.checked);
        c.style.display = cb.checked ? 'none' : '';
        chip.style.display = cb.checked ? '' : 'none';
        t.placeholder = cb.checked ? '透明' : '空 = 透明';
      };
      cb.addEventListener('change', () => {
        if (cb.checked) { t.value = ''; onChange(''); }
        else { apply(last); }
        sync();
        renderAt(state.t); blit();
      });
      t.addEventListener('input', sync);
      sync();
      box.appendChild(cb);
      box.appendChild(document.createTextNode('透明'));
      const tip = document.createElement('span');
      tip.textContent = 'ⓘ';
      tip.title = '勾上之后这一层不带底色，可以直接压在视频上';
      tip.style.cssText = 'color:#8b929e;cursor:help;margin-left:2px';
      box.appendChild(tip);
      holder.appendChild(box);
    }
    return holder;
  });
}
function checkField(labelText, value, onChange) {
  return field(labelText, () => {
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = !!value;
    c.addEventListener('change', () => { onChange(c.checked); renderAt(state.t); blit(); });
    return c;
  });
}
function textField(labelText, value, onChange, multiline) {
  return field(labelText, () => {
    const el = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) el.type = 'text';
    el.value = value ?? '';
    el.addEventListener('input', () => { onChange(el.value); renderAt(state.t); blit(); });
    return el;
  });
}
/** 下拉框。options 是 [{value,label}]，也可以直接给字符串数组 */
function selectField(labelText, value, options, onChange) {
  return field(labelText, () => {
    const s = document.createElement('select');
    for (const o of options) {
      const v = typeof o === 'string' ? o : o.value;
      const op = document.createElement('option');
      op.value = v;
      op.textContent = typeof o === 'string' ? o : o.label;
      if (v === value) op.selected = true;
      s.appendChild(op);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  });
}
function btn(text, onClick, cls = '') {
  const b = document.createElement('button');
  b.textContent = text; if (cls) b.className = cls;
  b.addEventListener('click', onClick);
  return b;
}

/** 通用参数控件按 type 分发 */
function paramField(p, bag, onChange) {
  const get = () => (bag[p.key] !== undefined ? bag[p.key] : p.default);
  switch (p.type) {
    case 'number': return numField(p.label, get(), p.min ?? 0, p.max ?? 100, p.step ?? 0.1, (v) => { bag[p.key] = v; onChange(); });
    case 'bool': return checkField(p.label, get(), (v) => { bag[p.key] = v; onChange(); });
      case 'color': return colorField(p.label, get(), (v) => { bag[p.key] = v; onChange(); },
        isBackgroundParam(p.key));   // 底色类才给「透明」开关
    case 'multiline': return textField(p.label, get(), (v) => { bag[p.key] = v; onChange(); }, true);
    case 'select': return field(p.label, () => {
      const s = document.createElement('select');
      for (const o of p.options) { const op = document.createElement('option'); op.value = o; op.textContent = o; if (o === get()) op.selected = true; s.appendChild(op); }
      s.addEventListener('change', () => { bag[p.key] = s.value; onChange(); });
      return s;
    });
    default: return textField(p.label, get(), (v) => { bag[p.key] = v; onChange(); });
  }
}

function snapLayerToBeat(L) {
  const bm = state.scene.beat;
  L.start = clamp(bm.snap(L.start, 4, 0.25), 0, state.scene.duration);
  L.end = clamp(bm.snap(L.end, 4, 0.25), L.start + 0.04, state.scene.duration);
  drawTimeline(); renderAt(state.t); blit();
}

/** 卡点铺满：在每个（第 N 个）拍点上叠一个短图层 */
/**
 * 卡点重复动效：一键铺 / 一键改 / 一键清。
 * 这些动效一铺就是十几个，一个个删太烦 —— 所以它们带 group="beat" 标记，
 * 「卡点」页签里能整组改（强度、时长、频率、开关、清空）。
 */
const BEAT_FX = [
  {
    tpl: 'flash-cut', label: '闪白硬切', key: 'peak', keyLabel: '强度',
    min: 0, max: 1, step: 0.02, peak: 0.42, dur: 0.26, mode: 'relay', every: 2,
    extras: [{ key: 'fadeIn', label: '渐入(秒)', min: 0.02, max: 0.6, step: 0.01, def: 0.45 }],
  },
  {
    tpl: 'zoom-punch', label: '冲击推近', key: 'amount', keyLabel: '强度',
    min: 0, max: 2, step: 0.05, peak: 0.35, dur: 0.3, mode: 'relay', every: 2,
    extras: [
      { key: 'rotate', label: '旋转(度)', min: 0, max: 6, step: 0.1, def: 1.2 },
      { key: 'blur', label: '拖影', min: 0, max: 40, step: 1, def: 10 },
    ],
  },
  { tpl: 'kinetic-type', label: '卡点大字', key: 'size', keyLabel: '字号', min: 24, max: 300, step: 2, peak: 120, dur: 1.6, mode: 'retime', every: 8 },
  { tpl: 'subtitle-kinetic', label: '卡点字幕', key: 'size', keyLabel: '字号', min: 12, max: 160, step: 2, peak: 46, dur: null, mode: 'none' },
];
state.beatFxEvery = { 'flash-cut': 2, 'zoom-punch': 2, 'kinetic-type': 8 };
state.beatFxBase = {};   // 每组的基础值（强度/时长/附加参数/随机差异），随机化都绕它算

function beatFxDef(tpl) { return BEAT_FX.find((d) => d.tpl === tpl) || null; }

/** 某一类的全部图层（同一个模板就算一类，不管当初是铺出来的还是手动放的） */
function beatFxList(tpl) { return state.scene.layers.filter((L) => L.template === tpl); }

/** 每组的基础值：第一次用到时从已有图层的第一个取值，取不到就用默认 */
function beatFxBase(tpl) {
  const def = beatFxDef(tpl);
  if (!def) return null;
  if (!state.beatFxBase[tpl]) {
    const L0 = beatFxList(tpl)[0];
    const b = { peak: def.peak, dur: def.dur, jitter: 0 };
    for (const ex of def.extras || []) b[ex.key] = ex.def;
    if (L0) {
      if (L0.params[def.key] !== undefined) b.peak = L0.params[def.key];
      if (def.dur) b.dur = +(L0.end - L0.start).toFixed(3);
      for (const ex of def.extras || []) if (L0.params[ex.key] !== undefined) b[ex.key] = L0.params[ex.key];
    }
    state.beatFxBase[tpl] = b;
  }
  return state.beatFxBase[tpl];
}

/** 把基础值（±随机差异）铺到整组上：强度/时长/渐入/随机差异都走这里 */
function beatFxApplyAll(tpl, quiet) {
  const def = beatFxDef(tpl);
  const base = beatFxBase(tpl);
  if (!def || !base) return 0;
  const j = clamp(base.jitter || 0, 0, 1);
  const list = beatFxList(tpl);
  for (const L of list) {
    const r1 = Math.random() * 2 - 1, r2 = Math.random() * 2 - 1;
    L.params[def.key] = +Math.max(0, base.peak * (1 + r1 * j * 0.4)).toFixed(3);
    for (const ex of def.extras || []) {
      const v = (base[ex.key] !== undefined ? base[ex.key] : ex.def) * (1 + r2 * j * 0.3);
      L.params[ex.key] = +Math.max(ex.min, Math.min(ex.max, v)).toFixed(3);
    }
    if (def.dur) L.end = Math.min(state.scene.duration, L.start + Math.max(0.05, base.dur * (1 + r1 * j * 0.35)));
  }
  drawTimeline();
  if (!quiet) { renderAt(state.t); blit(); }
  return list.length;
}

/** 只改强度/时长（自检和外部脚本用）：给确定值，顺手把随机差异清零 */
function beatFxApply(tpl, { peak, dur } = {}) {
  const base = beatFxBase(tpl);
  if (!base) return;
  if (peak !== undefined) base.peak = peak;
  if (dur !== undefined) base.dur = dur;
  base.jitter = 0;
  beatFxApplyAll(tpl);
}

/** 清空某一类 */
function beatFxClear(tpl) {
  const before = state.scene.layers.length;
  state.scene.layers = state.scene.layers.filter((L) => L.template !== tpl);
  const n = before - state.scene.layers.length;
  if (state.selection && !state.scene.layers.some((L) => L.id === state.selection)) {
    state.selection = null;
    state.selected = new Set();
  }
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  return n;
}

/** 按频率重铺（先清掉旧的，再按当前设置铺一遍）—— 闪白/推近这类瞬态动效用 */
function beatFxRelay(tpl, everyN) {
  const def = beatFxDef(tpl);
  if (!def) return 0;
  const base = beatFxBase(tpl);
  beatFxClear(tpl);
  state.beatFxEvery[tpl] = Math.max(1, everyN | 0);
  autoBeatLayers(tpl, state.beatFxEvery[tpl], { peak: base.peak, dur: base.dur });
  beatFxApplyAll(tpl, true);
  return beatFxList(tpl).length;
}

/** 只重新排时间、保留各自内容 —— 文字类（卡点大字/字幕）用这个 */
function beatFxRetime(tpl, everyN) {
  const def = beatFxDef(tpl);
  if (!def) return 0;
  const list = beatFxList(tpl).slice().sort((a, b) => a.start - b.start);
  if (!list.length) return 0;
  const dur = list[0].end - list[0].start;
  const beats = state.scene.beat.hitsIn(0, state.scene.duration, 1).filter((_, i) => i % everyN === 0);
  list.forEach((L, i) => {
    const b = beats[i];
    if (b === undefined) { L.enabled = false; return; }   // 拍点不够就把多出来的关掉
    L.enabled = true;
    L.start = b;
    L.end = Math.min(state.scene.duration, b + dur);
  });
  state.beatFxEvery[tpl] = Math.max(1, everyN | 0);
  drawTimeline(); renderRight(); renderAt(state.t); blit();
  return Math.min(list.length, beats.length);
}

function autoBeatLayers(templateId, everyN = 1, extra = null) {
  const s = state.scene;
  const tpl = listTemplates().find((t) => t.id === templateId);
  const def = BEAT_FX.find((d) => d.tpl === templateId);
  const dur = (extra && extra.dur) || Math.max(0.12, s.beat.beatDur * 0.5);
  const beats = s.beat.hitsIn(0, s.duration, 1).filter((_, i) => i % everyN === 0);
  for (const b of beats) {
    s.add({
      template: templateId, start: b, end: Math.min(s.duration, b + dur),
      seed: `${templateId}-${++state.layerSeq}`, name: tpl ? tpl.name : templateId,
      params: (extra && extra.peak !== undefined && def) ? { [def.key]: extra.peak } : {},
      group: 'beat',
    });
  }
  if (state.beatFxEvery) state.beatFxEvery[templateId] = everyN;
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
}

function updateBeatInfo() {
  const bm = state.scene.beat;
  const a = state.analysis;
  $('beatInfo').textContent = a
    ? `${bm.bpm.toFixed(2)} BPM · 置信度 ${(a.bpmConfidence * 100).toFixed(0)}% · ${bm.beats ? bm.beats.length : 0} 拍`
    : `${bm.bpm.toFixed(2)} BPM（手动）`;
}

function resize() {
  off.canvas.width = state.scene.width;
  off.canvas.height = state.scene.height;
  renderAt(state.t); blit();
}

// ---------------------------------------------------------------- 素材载入
/** 把音频抽成一条对称波形（0..1），给时间轴的音频轨画 */
function computePeaks(buffer, buckets = 480) {
  try {
    const ch = buffer.getChannelData(0);
    const out = new Float32Array(buckets);
    const per = Math.max(1, Math.floor(ch.length / buckets));
    let mx = 1e-6;
    for (let i = 0; i < buckets; i++) {
      let peak = 0;
      const s0 = i * per, s1 = Math.min(ch.length, s0 + per);
      for (let j = s0; j < s1; j++) { const v = ch[j] < 0 ? -ch[j] : ch[j]; if (v > peak) peak = v; }
      out[i] = peak;
      if (peak > mx) mx = peak;
    }
    for (let i = 0; i < buckets; i++) out[i] = Math.min(1, out[i] / mx);
    return out;
  } catch (_) { return null; }
}

/**
 * 工程时长跟着素材走：视频和音频谁长算谁。
 * 手动改过「时长」之后就不再自动改（state.durationAuto = false），
 * 面板上有「重新跟随素材时长」可以切回来。
 */
function applyAutoDuration(quiet) {
  if (!state.durationAuto) return false;
  // 有片段就只跟片段走（片段才是时间轴上的真相）；老工程没有片段才看单个素材
  const d = state.scene.clips.length
    ? state.scene.clipsEnd
    : Math.max(state.media.videoDur || 0, state.media.audioDur || 0);
  if (!d || d < 0.1) return false;
  const nd = Math.round(d * 100) / 100;
  if (Math.abs(nd - state.scene.duration) < 0.005) return false;
  state.scene.duration = nd;
  if (state.scene.beat) state.scene.beat.duration = nd;
  drawTimeline();
  if (rightTab === 'scene') renderRight();
  if (!quiet) toast(`工程时长跟着素材走：${nd.toFixed(2)} 秒`);
  return true;
}

// ---------------------------------------------------------------- 素材库 & 片段
/**
 * 素材库 = 拖进来的那些文件；片段 = 时间轴上的块。
 *
 * 分开是有意的：同一份素材可以被切成好几段（各自的入点和长度），
 * 就像剪映里一段视频切三刀是三个片段、但素材只有一个。
 * 文件本体存 IndexedDB，工程 JSON 里只留 assetId + 时间信息。
 */
let assetSeq = 0;

function assetById(id) { return state.assets.get(id) || null; }

/** 把文件变成一条素材（带好对应的媒体元素，预览和导出都直接用） */
async function addAsset(file, kind) {
  const id = 'a' + (++assetSeq) + '-' + Date.now().toString(36);
  const url = URL.createObjectURL(file);
  const a = { id, kind, name: file.name, file, url, el: null, duration: 0, w: 0, h: 0, buffer: null, peaks: null };
  if (kind === 'image') {
    const img = new Image();
    img.src = url;
    await new Promise((res) => { img.onload = res; img.onerror = res; setTimeout(res, 5000); });
    a.el = img; a.w = img.naturalWidth || 0; a.h = img.naturalHeight || 0;
  } else {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video');
    el.src = url;
    el.preload = 'auto';
    if (kind === 'video') { el.playsInline = true; el.loop = false; }
    await new Promise((res) => { el.onloadedmetadata = res; el.onerror = res; setTimeout(res, 8000); });
    a.el = el;
    a.duration = Number.isFinite(el.duration) ? el.duration : 0;
    a.w = el.videoWidth || 0; a.h = el.videoHeight || 0;
  }
  state.assets.set(id, a);
  persistAsset(a);
  return a;
}

/** 解码音频（画波形 / 导出混音都要用），只解一次 */
async function assetBuffer(a) {
  if (!a || a.kind === 'image') return null;
  if (a.buffer) return a.buffer;
  try {
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000);
    a.buffer = await ctx.decodeAudioData(await a.file.arrayBuffer());
    if (!a.peaks) a.peaks = computePeaks(a.buffer);
  } catch (e) {
    console.warn('素材解码失败：' + a.name, e);
    a.buffer = null;
  }
  return a.buffer;
}

/** 片段落在哪条轨上 */
function clipBand(kind) { return kind === 'audio' ? 'audio' : 'video'; }
function clipTrackY(kind) { return clipBand(kind) === 'audio' ? MEDIA_TOP + VID_H + 3 : MEDIA_TOP; }
function clipTrackH(kind) { return clipBand(kind) === 'audio' ? AUD_H : VID_H; }

/**
 * 加一个片段。默认接在同一条轨的最后面；视频/图片整段放进来
 * （图片给 3 秒，之后拖右边缘改长度），音频也是整段。
 */
function addClip(asset, opts = {}) {
  const band = clipBand(asset.kind);
  const same = state.scene.clips.filter((c) => clipBand(c.kind) === band);
  const at = opts.start !== undefined ? opts.start : same.reduce((m, c) => Math.max(m, c.end), 0);
  const dur = opts.dur !== undefined ? opts.dur
    : (asset.kind === 'image' ? 3 : Math.max(0.2, asset.duration || 3));
  const c = new Clip({
    kind: asset.kind, assetId: asset.id, name: asset.name,
    start: Math.max(0, at), in: opts.in || 0, dur, volume: 1,
  });
  state.scene.clips.push(c);
  clipsFitDuration();      // 新片段排到时长外面了，工程就跟着变长
  return c;
}

function clipById(id) { return state.scene.clips.find((c) => c.id === id) || null; }
function selectedClip() { return clipById(state.clipSel); }
function sortClips() { state.scene.clips.sort((a, b) => a.start - b.start); }

// ---------------------------------------------------------------- 转场
/**
 * 转场挂在"后一段"上：clip.trans = { template, dur }，
 * 时间上一半在前一段、一半在后一段（切口为中心，剪映也是这么算的）。
 *
 * 渲染上不搞两路合成 —— 引擎里那 10 个转场模板本来就是"盖在切口上的一层效果"，
 * 所以做法是：转场区间内，画面在中点换段（前半段 A、后半段 B），转场模板盖在上面
 * 把这一下遮住。模板本身是一个真的图层（group = 'clip-trans'），
 * 所以参数面板、时间轴、导出全都照常，还能单独调它的参数。
 */
function transitionTemplates() { return listTemplates().filter((t) => (t.category || '') === 'transition'); }
function templateName(id) {
  const t = listTemplates().find((x) => x.id === id);
  return t ? t.name : id;
}

/** 同一轨上、紧挨在这个片段前面的那一段 */
function prevClipOf(c) {
  const band = clipBand(c.kind);
  let best = null;
  for (const x of state.scene.clips) {
    if (x.id === c.id || clipBand(x.kind) !== band) continue;
    if (x.end <= c.start + 0.001 && (!best || x.end > best.end)) best = x;
  }
  return best;
}

/** 这个转场占的时间区间；没转场、或者前面没有可接的片段就返回 null */
function transWindow(c) {
  if (!c || !c.trans) return null;
  const prev = prevClipOf(c);
  if (!prev) return null;
  const dur = Math.max(0.1, c.trans.dur || 0.5);
  const cut = c.start;
  return { prev, clip: c, center: cut, start: cut - dur / 2, end: cut + dur / 2, dur };
}

function transLayerOf(clipId) {
  return state.scene.layers.find((L) => L.group === 'clip-trans' && L.meta && L.meta.clipId === clipId) || null;
}

/** 让转场层跟着片段走：片段挪了、裁了、删了，转场都要跟 */
function syncTransitionLayers() {
  // 没有转场就什么都不做（这个函数每帧都会被叫一次，见 renderAt）
  if (!state.scene.clips.some((c) => c.trans) && !state.scene.layers.some((L) => L.group === 'clip-trans')) return;
  const keep = new Set();
  for (const c of state.scene.clips) {
    const w = transWindow(c);
    const L = transLayerOf(c.id);
    if (!w) { if (L) state.scene.layers = state.scene.layers.filter((x) => x !== L); continue; }
    keep.add(c.id);
    const name = '转场 · ' + (w.prev.name || '上一段') + ' → ' + (c.name || '下一段');
    if (L) {
      L.start = +w.start.toFixed(3);
      L.end = +w.end.toFixed(3);
      L.template = c.trans.template;
      L.name = name;
    } else {
      state.scene.add({
        template: c.trans.template, start: +w.start.toFixed(3), end: +w.end.toFixed(3),
        seed: 'trans-' + c.id, name, group: 'clip-trans', meta: { clipId: c.id },
      });
    }
  }
  // 片段没了 / 转场撤了，留下的空壳层要清掉
  state.scene.layers = state.scene.layers.filter((L) => L.group !== 'clip-trans'
    || (L.meta && L.meta.clipId && keep.has(L.meta.clipId)));
}

function applyTransition(clip, template, dur) {
  if (!clip) return false;
  const prev = prevClipOf(clip);
  if (!prev) { toast('这一段前面没有紧挨着的片段，接不上转场'); return false; }
  clip.trans = { template, dur: clamp(dur || 0.5, 0.1, 3) };
  syncTransitionLayers();
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  toast('转场：' + templateName(template));
  return true;
}

function clearTransition(clip) {
  if (!clip || !clip.trans) return false;
  clip.trans = null;
  syncTransitionLayers();
  markIndexDirty(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  toast('去掉转场');
  return true;
}

/** 此刻正处在哪个转场里 */
function activeTransitionAt(t) {
  for (const c of state.scene.clips) {
    if (!c.trans) continue;
    const w = transWindow(c);
    if (w && t >= w.start && t < w.end) return w;
  }
  return null;
}

// ---- 转场选择弹窗（点相邻两段中间那个小方块打开） ----
let transTarget = null;
state.transDur = 0.5;

function openTransitionDialog(clip) {
  if (!clip) return;
  const prev = prevClipOf(clip);
  if (!prev) { toast('这一段前面没有紧挨着的片段'); return; }
  transTarget = clip;
  const dlg = $('transDlg');
  if (!dlg) return;
  $('transWho').textContent = (prev.name || '上一段') + ' → ' + (clip.name || '下一段');
  const grid = $('transGrid');
  grid.textContent = '';
  for (const t of transitionTemplates()) {
    const b = document.createElement('button');
    b.className = 'ex' + (clip.trans && clip.trans.template === t.id ? ' sel' : '');
    b.innerHTML = '<b>' + escapeHtml(t.name) + '</b><span>' + escapeHtml(t.hint || '') + '</span>';
    b.addEventListener('click', () => {
      applyTransition(clip, t.id, state.transDur);
      openTransitionDialog(clip);          // 重画一下，把选中态挪过来
    });
    grid.appendChild(b);
  }
  const row = $('transDurRow');
  row.textContent = '';
  row.appendChild(numField('转场时长(秒)', clip.trans ? clip.trans.dur : state.transDur, 0.2, 2, 0.1, (v) => {
    state.transDur = v;
    if (clip.trans) { clip.trans.dur = v; syncTransitionLayers(); drawTimeline(); renderAt(state.t); blit(); }
  }));
  $('transInfo').textContent = clip.trans
    ? '当前：' + templateName(clip.trans.template) + ' · ' + clip.trans.dur.toFixed(1) + 's'
    : '还没加转场（现在是硬切）';
  $('btnTransDel').disabled = !clip.trans;
  dlg.showModal();
}

{
  const dlg = $('transDlg');
  if (dlg) {
    $('btnTransClose').addEventListener('click', () => dlg.close());
    $('btnTransDel').addEventListener('click', () => {
      clearTransition(transTarget);
      dlg.close();
    });
  }
}

/** 某个片段的素材总长（图片没有上限，返回 0 表示随便拉） */
function clipSourceDur(c) {
  const a = assetById(c.assetId);
  return a && a.kind !== 'image' ? (a.duration || 0) : 0;
}

/**
 * 这一段的淡入 / 淡出到底多长。
 * 音频片段还会自动交叉淡化：和同轨上别的音频段重叠多少，就淡化多少 ——
 * 这样把两段音乐叠一点，接缝处不会有"啪"的一声。
 */
function fadeWindow(c) {
  let fin = Math.max(0, c.fadeIn || 0);
  let fout = Math.max(0, c.fadeOut || 0);
  if (c.kind === 'audio') {
    for (const o of state.scene.clips) {
      if (o.id === c.id || o.kind !== 'audio') continue;
      const ov = Math.min(c.end, o.end) - Math.max(c.start, o.start);
      if (ov <= 0.01) continue;
      if (o.start < c.start) fin = Math.max(fin, ov);
      if (o.end > c.end) fout = Math.max(fout, ov);
    }
  }
  const cap = c.dur / 2;
  return { in: Math.min(fin, cap), out: Math.min(fout, cap) };
}

/** 某一刻这一段的实际音量（音量 × 淡入淡出 × 交叉淡化） */
function clipGainAt(c, t) {
  let g = clamp(c.volume === undefined ? 1 : c.volume, 0, 1);
  const w = fadeWindow(c);
  const local = t - c.start;
  if (w.in > 0) g *= clamp(local / w.in, 0, 1);
  if (w.out > 0) g *= clamp((c.dur - local) / w.out, 0, 1);
  return clamp(g, 0, 1);
}

/** 片段排到哪儿、工程时长就跟到哪儿（用户手动改过时长就不跟了） */
function clipsFitDuration() {
  const end = state.scene.clipsEnd;
  if (!end) return false;
  if (end > state.scene.duration + 0.001) {
    state.scene.duration = Math.ceil(end * 100) / 100;
    if (state.scene.beat) state.scene.beat.duration = state.scene.duration;
    return true;
  }
  return false;
}

async function loadVideoFile(file, opts = {}) {
  const kind = /^image\//.test(file.type) ? 'image' : 'video';
  state.media.videoFile = file;          // AI 助手要把原始文件上传给本地服务
  state.media.videoMeta = { name: file.name, type: file.type, size: file.size };
  persistMedia('video', file);           // 刷新后还能接回来（老路径）
  const asset = await addAsset(file, kind);
  // 老路径：state.media.video 还指着"当前素材"，别的代码（AI 助手、滤镜）还在看它
  state.media.video = asset.el;
  state.media.videoName = file.name;
  state.media.videoDur = asset.duration || 0;
  applyAudio();
  $('dropHint').classList.add('hidden');
  if (!opts.noClip) {
    // 第 2 段之后接在前一段后面（剪映那种"往后摞"），第一段落在时间轴开头
    const at = opts.start !== undefined ? opts.start : undefined;
    state.clipSel = addClip(asset, { start: at }).id;
  }
  clipsFitDuration();
  if (!opts.keepDuration) applyAutoDuration(!opts.quiet);
  resize(); drawTimeline(); renderRight(); renderAt(state.t); blit();
  return asset;
}

async function loadAudioFile(file, opts = {}) {
  const asset = await addAsset(file, 'audio');
  const a = asset.el;
  state.media.audio = a; state.media.audioName = file.name;
  state.media.audioFile = file;          // 导出 MP4 时要拿它重新解码出音轨
  state.media.audioMeta = { name: file.name, type: file.type, size: file.size };
  state.media.audioDur = asset.duration || state.media.audioDur;
  persistMedia('audio', file);
  if (!opts.noClip) {
    state.clipSel = addClip(asset, { start: opts.start }).id;
  }
  clipsFitDuration();
  a.muted = state.muted;
  applyAudio();          // 载入音乐后视频原声自动让位
  if (opts.analyze === false) return asset;   // 恢复上次工程：拍点图已经存在工程里了，别再分析一遍
  showBusy('正在分析节拍…', 0);
  try {
    const res = await analyzeAudioFile(file, { sensitivity: 1.0 });
    state.analysis = res;
    state.media.audioDur = res.duration || (res.audioBuffer ? res.audioBuffer.duration : 0);
    state.media.peaks = res.audioBuffer ? computePeaks(res.audioBuffer) : null;
    state.scene.beat = new BeatMap({
      bpm: res.bpm, offset: res.offset, beats: res.beats, duration: state.scene.duration, source: 'audio',
    });
    // 字幕如果有，用包络做词级时间估算
    state.scene.captions = state.scene.captions.map((c) => {
      const words = estimateWordTimings(c, res);
      return new Caption({ ...c, words });
    });
    updateBeatInfo();
    applyAutoDuration(opts.quiet === true);   // 时长跟着素材走
    drawTimeline(); renderRight();
    hideBusy();
  } catch (err) {
    hideBusy();
    alert('音频分析失败：' + err.message + '\n（仍然可以用手动 BPM 卡点）');
  }
}

function loadSubtitleFile(file) {
  const r = new FileReader();
  r.onload = async () => {
    const items = parseSubtitles(r.result);
    if (!items.length) { alert('没解析出字幕，检查一下文件格式'); return; }
    state.scene.captions = items.map((c) => new Caption(c));
    if (state.analysis) {
      state.scene.captions = state.scene.captions.map((c) => new Caption({ ...c, words: estimateWordTimings(c, state.analysis) }));
    }
    // 自动补一条卡点字幕图层
    if (!state.scene.layers.some((l) => l.template === 'subtitle-kinetic')) {
      state.scene.add({ template: 'subtitle-kinetic', start: 0, end: state.scene.duration, seed: 'subs-' + (++state.layerSeq), name: '卡点字幕' });
    }
    drawTimeline(); renderRight();
    alert(`导入 ${items.length} 条字幕`);
  };
  r.readAsText(file, 'utf-8');
}

// ---------------------------------------------------------------- Busy 指示
function showBusy(text, p) {
  $('busy').classList.remove('hidden');
  $('busyText').textContent = text;
  $('busy').querySelector('.bar i').style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
}
function hideBusy() { $('busy').classList.add('hidden'); }

// ---------------------------------------------------------------- 导出
async function frameCount() { return Math.max(1, Math.round(state.scene.duration * state.scene.fps)); }

function seekTo(t) {
  const sc = state.scene;
  // 有片段：此刻该出现的每一条都 seek 到它在素材里的位置（多轨叠加就是好几条）
  const jobs = sc.clips.length
    ? sc.visualClipsAt(t).map((c) => ({ el: (assetById(c.assetId) || {}).el, want: c.sourceAt(t) }))
    : [{ el: state.media.video, want: t }];
  return Promise.all(jobs.map((j) => new Promise((res) => {
    const v = j.el;
    if (!v || v.tagName === 'IMG' || v.readyState < 1) { res(); return; }
    if (Math.abs(v.currentTime - j.want) < 1 / (sc.fps * 2) && v.readyState >= 2) { res(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', finish); res(); };
    v.addEventListener('seeked', finish);
    try { v.currentTime = j.want; } catch (_) {}
    setTimeout(finish, 500);
  })));
}

function exportScene({ includeMedia, transparentBg }) {
  const s = state.scene;
  const json = s.toJSON();
  json.includeMedia = !!includeMedia;
  return json;
}

/** 渲染某一帧（导出用，会先等待视频 seek 到位） */
async function renderFrameForExport(i, includeMedia) {
  const s = state.scene;
  const t = s.frameTime(i);
  if (includeMedia) await seekTo(t);
  state.suppressMedia = !includeMedia;      // 只要叠加层时把底片藏掉
  const c = renderAt(t);
  state.suppressMedia = false;
  return c;
}

async function exportPngSequence(includeMedia) {
  const total = await frameCount();
  const s = state.scene;
  const names = [];
  const pad = String(total).length;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const zipName = `motionkit_${stamp}_${s.width}x${s.height}_${s.fps}fps.zip`;

  // 优先走"边渲染边落盘"，避免上百帧 PNG 撑爆内存
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: zipName, types: [{ description: 'ZIP 序列', accept: { 'application/zip': ['.zip'] } }] });
    } catch (_) { return; }
    const writable = await handle.createWritable();
    const zip = createZipWriter((bytes) => writable.write(bytes));
    for (let i = 0; i < total; i++) {
      const c = await renderFrameForExport(i, includeMedia);
      const png = await canvasToPngBytes(c);
      await zip.add(`frame_${String(i).padStart(pad, '0')}.png`, png);
      showBusy(`导出 PNG 序列 ${i + 1}/${total}`, (i + 1) / total);
      if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await zip.finish();
    await writable.close();
    hideBusy();
    return;
  }

  // 退化方案：内存里打包
  const files = [];
  for (let i = 0; i < total; i++) {
    const c = await renderFrameForExport(i, includeMedia);
    const png = await canvasToPngBytes(c);
    files.push({ name: `frame_${String(i).padStart(pad, '0')}.png`, data: png });
    showBusy(`导出 PNG 序列 ${i + 1}/${total}`, (i + 1) / total);
    if (i % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const zip = makeZip(files);
  downloadBlob(zip, zipName);
  hideBusy();
}

/**
 * 挑一个当前浏览器能录的封装 / 编码。
 * MP4 优先 H.264：Chrome / Edge 从 111 起自带，Firefox、Safari 目前没有，
 * 那种情况会退回 WebM，并把话说明白（不然用户拿到一个 .mp4 后缀打不开的文件更糟）。
 */
const VIDEO_FORMATS = {
  mp4: {
    ext: 'mp4', label: 'MP4（H.264）', bits: 24_000_000,
    mimes: ['video/mp4', 'video/mp4;codecs=avc1.4d0028', 'video/mp4;codecs=avc1'],
  },
  webm: {
    ext: 'webm', label: 'WebM', bits: 40_000_000,
    mimes: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
  },
};

function pickVideoMime(want) {
  const rec = window.MediaRecorder;
  if (!rec) return null;
  const list = (VIDEO_FORMATS[want] || VIDEO_FORMATS.webm).mimes;
  for (const m of list) { try { if (rec.isTypeSupported(m)) return m; } catch (_) {} }
  return null;
}

/**
 * MP4（H.264）走 WebCodecs：逐帧编码 + 自己封装。
 *
 * 为什么不用 MediaRecorder 录 MP4：它是按"墙上时钟"打时间戳的，渲染一帧比 1/fps 慢，
 * 时长就被拖长（2:40 的工程能录成 6:00）。这里每一帧的时间戳是 i/fps，导出多长就是多长，
 * 而且不用等实时 —— 渲染多快就多快。
 */
async function renderMp4Blob(includeMedia, withAudio) {
  if (typeof window.VideoEncoder === 'undefined') {
    const e = new Error('这个浏览器没有 WebCodecs（VideoEncoder），用 Chrome / Edge 打开就能直接出 MP4。');
    e.code = 'unsupported';
    throw e;
  }
  const s = state.scene;
  const fps = s.fps;
  const total = await frameCount();

  // H.264 的 level 要配得上分辨率（4K 用 4.0 会直接被拒）
  const mbPerSec = Math.ceil(s.width / 16) * Math.ceil(s.height / 16) * fps;
  const level = mbPerSec <= 245760 ? '28' : mbPerSec <= 522240 ? '32' : '33';
  // 码率按像素率给：1080p30 大约 15 Mbps（画面是文字/线条，够清楚）。
  // 别给太高：编码样本会在内存里攒到导出结束，长片很吃内存。
  const bitrate = Math.min(60_000_000, Math.max(4_000_000, Math.round(s.width * s.height * fps * 0.25)));
  const configs = [`avc1.6400${level}`, `avc1.4d00${level}`, `avc1.42E0${level}`];

  let picked = null;
  for (const codec of configs) {
    const cfg = { codec, width: s.width, height: s.height, bitrate, framerate: fps, avc: { format: 'avc' } };
    try {
      const sup = await VideoEncoder.isConfigSupported(cfg);
      if (sup && sup.supported) { picked = sup.config || cfg; break; }
    } catch (_) { /* 换下一个 */ }
  }
  if (!picked) {
    const e = new Error('这台机器的 H.264 编码器不接受 ' + s.width + '×' + s.height + ' 这个尺寸');
    e.code = 'unsupported';
    throw e;
  }

  const samples = [];
  let description = null;
  let encError = null;
  const enc = new VideoEncoder({
    output: (chunk, meta) => {
      const cfg = meta && meta.decoderConfig;
      if (cfg && cfg.description && !description) description = new Uint8Array(cfg.description);
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      samples.push({ data: buf, key: chunk.type === 'key' });
    },
    error: (e) => { encError = e; },
  });
  enc.configure(picked);

  const keyEvery = Math.max(1, Math.round(fps * 2));      // 每 2 秒一个关键帧，方便拖进度条
  const frameDurUs = Math.round(1e6 / fps);
  for (let i = 0; i < total; i++) {
    if (encError) break;
    const c = await renderFrameForExport(i, includeMedia);
    const frame = new VideoFrame(c, { timestamp: Math.round((i * 1e6) / fps), duration: frameDurUs });
    enc.encode(frame, { keyFrame: i % keyEvery === 0 });
    frame.close();
    showBusy(`编码 MP4 ${i + 1}/${total}`, (i + 1) / total);
    // 背压：编码队列积太多就先让出一会儿，别把内存吃光
    while (enc.encodeQueueSize > 12) await new Promise((r) => setTimeout(r, 4));
    if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));   // 界面别卡死
  }
  await enc.flush();
  enc.close();
  if (encError) throw encError;

  // 音轨：勾了"带声音"而且真的载入了音频才编
  let audio = null;
  const hasSound = state.scene.clips.length
    ? state.scene.clips.some((c) => c.kind === 'audio' || c.kind === 'video')
    : !!state.media.audioFile;
  if (withAudio && hasSound) {
    showBusy('编码音轨…', 0.75);
    try {
      audio = await encodeAudioTrack((s.duration * total) / fps);
    } catch (e) {
      console.warn('音轨编码失败，这次只出画面：', e);
      audio = null;
    }
  }

  const data = muxMp4({ width: s.width, height: s.height, fps, samples, description, audio });
  return {
    blob: new Blob([data], { type: 'video/mp4' }), mime: 'video/mp4', ext: 'mp4',
    label: audio ? 'MP4（H.264 + AAC）' : 'MP4（H.264）',
    audio: !!audio,
  };
}

/**
 * 把载入的音乐编成 AAC 音轨（给 MP4 用）。
 * 返回 { sampleRate, channels, samples, description, bitrate }，交给 engine/mp4.js 封装。
 */
/**
 * 把时间轴上所有带声音的片段混成一条 AudioBuffer。
 * 用 OfflineAudioContext 离线渲染，所以不受播放速度影响，导出多快都行。
 */
async function mixClipAudio(limitSec) {
  const list = state.scene.clips.filter((c) => c.kind === 'audio' || c.kind === 'video');
  if (!list.length) return null;
  const SR = 48000;
  const total = Math.max(1, Math.ceil(Math.min(limitSec, state.scene.clipsEnd) * SR));
  const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, total, SR);
  let used = 0;
  for (const c of list) {
    const a = assetById(c.assetId);
    if (!a) continue;
    const buf = await assetBuffer(a);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const sp = clamp(c.speed || 1, 0.1, 8);
    src.playbackRate.value = sp;
    const gain = ctx.createGain();
    // 音量包络：音量 + 淡入淡出 + 和相邻段重叠处的自动交叉淡化
    const vol = state.muted ? 0 : clamp(c.volume === undefined ? 1 : c.volume, 0, 1);
    const w = fadeWindow(c);
    const A = Math.max(0, c.start);
    const B = Math.max(A + 0.01, c.end);
    const tiny = 0.0001;
    gain.gain.setValueAtTime(w.in > 0 ? tiny : vol, A);
    if (w.in > 0) gain.gain.linearRampToValueAtTime(vol, Math.min(B, A + w.in));
    if (w.out > 0) {
      gain.gain.setValueAtTime(vol, Math.max(A, B - w.out));
      gain.gain.linearRampToValueAtTime(tiny, B);
    }
    src.connect(gain); gain.connect(ctx.destination);
    const off = Math.min(c.in, Math.max(0, buf.duration - 0.01));
    const dur = Math.min(c.dur * sp, Math.max(0, buf.duration - off));   // start() 的时长按素材算
    if (dur <= 0.01) continue;
    src.start(Math.max(0, c.start), off, dur);
    used++;
    showBusy('混合音轨…', 0.6 + 0.15 * (used / list.length));
  }
  if (!used) return null;
  return ctx.startRendering();
}

async function encodeAudioTrack(limitSec) {
  const file = state.media.audioFile;
  if (typeof window.AudioEncoder === 'undefined') return null;

  // 先把时间轴上的声音混成一条：
  //  · 有片段 → 每段按 start/in/dur/volume 摆到自己的位置上（视频片段自带的声音也算进去）
  //  · 没有片段（老工程）→ 就用那一支音乐
  let buf = null;
  if (state.scene.clips.length) {
    buf = await mixClipAudio(limitSec);
  } else if (file) {
    const ctx0 = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 48000);
    buf = await ctx0.decodeAudioData(await file.arrayBuffer());
  }
  if (!buf) return null;
  const sampleRate = buf.sampleRate;
  const channels = Math.min(2, buf.numberOfChannels);
  const bitrate = 192_000;
  const cfg = { codec: 'mp4a.40.2', sampleRate, numberOfChannels: channels, bitrate };
  let picked = null;
  try {
    const sup = await AudioEncoder.isConfigSupported(cfg);
    if (sup && sup.supported) picked = sup.config || cfg;
  } catch (_) {}
  if (!picked) return null;

  const totalFrames = Math.max(1, Math.round(Math.min(buf.duration, limitSec) * sampleRate));
  const planes = [];
  for (let ch = 0; ch < channels; ch++) planes.push(buf.getChannelData(ch));
  const chunks = [];
  let description = null;
  let encErr = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const c = meta && meta.decoderConfig;
      if (c && c.description && !description) description = new Uint8Array(c.description);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const frames = chunk.duration ? Math.round((chunk.duration * sampleRate) / 1e6) : 1024;
      chunks.push({ data, frames: Math.max(1, frames) });
    },
    error: (e) => { encErr = e; },
  });
  enc.configure(picked);

  const BLOCK = 8192;
  for (let at = 0; at < totalFrames; at += BLOCK) {
    if (encErr) break;
    const n = Math.min(BLOCK, totalFrames - at);
    const data = new Float32Array(n * channels);
    for (let ch = 0; ch < channels; ch++) data.set(planes[ch].subarray(at, at + n), ch * n);
    const ad = new AudioData({
      format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((at / sampleRate) * 1e6), data,
    });
    enc.encode(ad);
    ad.close();
    showBusy(`编码音轨 ${Math.round((at / totalFrames) * 100)}%`, (at / totalFrames) * 0.5);
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
  }
  await enc.flush();
  enc.close();
  if (encErr) throw encErr;
  if (!chunks.length || !description) return null;
  return { sampleRate, channels, samples: chunks, description, bitrate };
}

/**
 * 把工程录成一个视频 Blob（画面层；MP4 可以带音轨）。
 */
async function renderVideoBlob(want, includeMedia, opts) {
  const fmt = VIDEO_FORMATS[want] ? want : 'webm';
  if (fmt === 'mp4') {
    // 优先走帧精确那条路；浏览器不支持再退回实时录制
    try {
      return await renderMp4Blob(includeMedia, !!(opts && opts.audio));
    } catch (err) {
      if (err && err.code === 'unsupported' && pickVideoMime('mp4')) {
        console.warn('WebCodecs 走不通，退回实时录制：', err.message);
      } else {
        throw err;
      }
    }
  }
  const mime = pickVideoMime(fmt);
  if (!mime) {
    const err = new Error('这个浏览器不能直接录 ' + VIDEO_FORMATS[fmt].label
      + '。用 Chrome / Edge 打开工作室，或者导出「PNG 序列」再跑 tools/encode.py 转成 mp4。');
    err.code = 'unsupported';
    throw err;
  }
  const s = state.scene;
  const fps = s.fps;
  const rec = document.createElement('canvas');
  rec.width = s.width; rec.height = s.height;
  const rctx = rec.getContext('2d');
  const stream = rec.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const chunks = [];
  // MP4（H.264）没有透明通道：透明区交给浏览器去合，结果不可控（实测会变成浅灰）。
  // 所以打底自己来 —— 不勾"连底片一起渲"就压黑底，勾了的话底片本来就铺满整帧。
  const opaque = fmt === 'mp4';
  const mr = new MediaRecorder(stream, {
    mimeType: mime, videoBitsPerSecond: VIDEO_FORMATS[fmt].bits,
  });
  mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res, rej) => { mr.onstop = res; mr.onerror = (e) => rej(e.error || new Error('录制失败')); });
  mr.start(1000);                     // 每秒切一片，长片也不至于全憋在最后
  const total = await frameCount();
  const label = VIDEO_FORMATS[fmt].label;
  for (let i = 0; i < total; i++) {
    const c = await renderFrameForExport(i, includeMedia);
    rctx.clearRect(0, 0, s.width, s.height);
    if (opaque) { rctx.fillStyle = '#0a0a0c'; rctx.fillRect(0, 0, s.width, s.height); }
    rctx.drawImage(c, 0, 0);
    if (track.requestFrame) track.requestFrame();
    showBusy(`录制 ${label} ${i + 1}/${total}`, (i + 1) / total);
    await new Promise((r) => setTimeout(r, Math.max(1, 1000 / fps)));
  }
  mr.stop();
  await done;
  hideBusy();
  return { blob: new Blob(chunks, { type: mime }), mime, ext: VIDEO_FORMATS[fmt].ext, label };
}

async function exportVideo(want, includeMedia, opts) {
  const r = await renderVideoBlob(want, includeMedia, opts);
  downloadBlob(r.blob, `motionkit_${Date.now()}.${r.ext}`);
  toast(`${r.label} 导出完成（${(r.blob.size / 1048576).toFixed(1)} MB${r.audio ? '' : '，无声'}）`);
  return r;
}

function exportProject() {
  const data = JSON.stringify(exportScene({ includeMedia: false }), null, 2);
  downloadBlob(new Blob([data], { type: 'application/json' }), `motionkit_${Date.now()}.json`);
}

function exportBeats() {
  const s = state.scene;
  const bm = s.beat;
  const beats = bm.hitsIn(0, s.duration, 1);
  const tc = (t) => {
    const f = Math.floor((t % 1) * s.fps);
    return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
  };
  // Premiere 标记导入格式：时间码 <tab> 名称 <tab> 时长
  const lines = beats.map((b, i) => `${tc(b)}\tBEAT ${String(i + 1).padStart(3, '0')}\t00:00:00:00`);
  lines.unshift('MotionKit 卡点标记 —— 在 Premiere 标记面板点"导入标记"即可');
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/plain' }), `motionkit_beats_${Math.round(bm.bpm)}bpm.txt`);
}

function exportSrt() {
  const srt = toSRT(state.scene.captions.map((c) => ({ start: c.start, end: c.end, text: c.text })));
  downloadBlob(new Blob([srt], { type: 'text/plain;charset=utf-8' }), `motionkit_${Date.now()}.srt`);
}

// ---------------------------------------------------------------- 预设
async function loadPresetList() {
  // 单文件版：预设已经内联在页面里，直接列出来
  if (window.__PRESETS__ && window.__PRESETS__.length) {
    const sel = $('selPreset');
    for (const it of window.__PRESETS__) {
      const o = document.createElement('option'); o.value = it.file; o.textContent = it.name;
      sel.appendChild(o);
    }
    return;
  }
  try {
    const r = await fetch('../presets/index.json');
    if (!r.ok) return;
    const list = await r.json();
    const sel = $('selPreset');
    for (const it of list) {
      const o = document.createElement('option'); o.value = it.file; o.textContent = it.name;
      sel.appendChild(o);
    }
  } catch (_) {}
}

async function applyPreset(file) {
  if (!file) return;
  let data;
  const inline = (window.__PRESETS__ || []).find((it) => it.file === file);
  if (inline) data = inline.data;
  else data = await (await fetch('../presets/' + file)).json();
  adoptScene(data);          // 走统一入口：选择清空、素材接回、撤销栈重起
}

// ---------------------------------------------------------------- 工程存取
function saveProject() {
  downloadBlob(new Blob([JSON.stringify(state.scene.toJSON(), null, 2)], { type: 'application/json' }), `motionkit_${Date.now()}.json`);
}
function openProject(file) {
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      const media = state.media;
      state.scene = Scene.fromJSON(data);
      state.media = media;
      state.selection = null;
      state.selected = new Set();
      rightTab = 'scene';
      resetLayerIndex();
      resize(); drawTimeline(); renderRight(); updateBeatInfo();
    } catch (e) { alert('工程文件读取失败：' + e.message); }
  };
  r.readAsText(file, 'utf-8');
}

// ---------------------------------------------------------------- 图层索引
//
// 图层一多，时间轴上那条色块根本看不出"它是谁、在画面哪儿"。这里做两件事：
//   1. 把每个图层单独渲染一次，量出它在画布上的真实包围盒 —— 不是猜模板的
//      position 参数，是量渲染结果（模板各画各的，靠参数猜必错）。
//   2. 顶部一张小图，画播放头这一刻所有在图层的框和编号，跟下面列表一一对应。
// 点列表项 = 选中并跳到该图层中间，双击 = 跳到开头。

const CAT_COLOR = {
  overlay: '#00e5ff', typography: '#ff4b1f', caption: '#39ff88',
  panel: '#ffcc00', design: '#ff7ab6', focus: '#6ea8ff', data: '#2ee6a8', chaos: '#ff4a1c', rock: '#e01818', transition: '#b98bff', other: '#8b929e',
};

const CAT_LABEL = {
  overlay: '叠加层 / HUD', typography: '动态排版', caption: '字幕',
  panel: '面板卡片', design: '设计排版', focus: '聚焦 / 标注', data: '数据 / 图表', chaos: '秩序 / 混沌', rock: '摇滚 / 海报', transition: '转场 / 冲击', other: '其它',
};

let idxScratch = null;       // 全分辨率临时画布（复用一个）
let idxSmall = null;         // 缩略画布，用来快速扫 alpha
let idxRows = new Map();     // layer.id -> 行元素
let idxBoxCache = new Map(); // layer.id -> {x,y,w,h} 归一化
let idxPaneOpen = false;
let idxLiveKey = '';
let idxSelKey = '';
let idxFrameTick = 0;

function tplMeta(id) {
  return listTemplates().find((x) => x.id === id) || { id, name: id, category: 'other' };
}

// 颜色图例：和小图、行首圆点用同一套色
(function buildIdxLegend() {
  const box = $('idxLegend');
  if (!box) return;
  box.innerHTML = Object.keys(CAT_LABEL)
    .filter((k) => k !== 'other')
    .map((k) => '<span><i style="background:' + CAT_COLOR[k] + '"></i>' +
      CAT_LABEL[k].split(' /')[0] + '</span>')
    .join('');
})();

/**
 * 量一个图层"没被拖动过"时的包围盒（归一化 0~1）。量不出来返回 null。
 * 这是个昂贵的操作（要把这一层单独渲三遍），所以结果会缓存；拖动、缩放
 * 都不需要让它失效 —— 那些是纯几何变换，直接在下面用数学推。
 */
function layerBaseBox(L) {
  if (idxBoxCache.has(L.id)) return idxBoxCache.get(L.id);
  const cat = tplMeta(L.template).category;
  let box = null;

  if (cat === 'transition') {
    box = { x: 0, y: 0, w: 1, h: 1 };   // 变换式转场整帧都在动，标全屏
  } else {
    const sc = state.scene;
    const W = Math.max(64, Math.round(sc.width));
    const H = Math.max(36, Math.round(sc.height));
    if (!idxScratch) idxScratch = makeCanvas(W, H, 1);
    if (idxScratch.canvas.width !== W || idxScratch.canvas.height !== H) {
      idxScratch.canvas.width = W; idxScratch.canvas.height = H;
    }
    const sw = 160, sh = Math.max(2, Math.round(160 * H / W));
    if (!idxSmall) idxSmall = document.createElement('canvas');
    if (idxSmall.width !== sw || idxSmall.height !== sh) { idxSmall.width = sw; idxSmall.height = sh; }
    const sctx = idxSmall.getContext('2d', { willReadFrequently: true });

    // 只放这一个图层，按原尺寸渲染（字号是绝对像素，缩小画布会量歪）。
    // 注意必须走 Scene.fromJSON：new Scene() 不会把普通对象转成 Layer 实例，
    // 之后 scene.activeLayers() 会直接 TypeError。
      const spec = L.toJSON();
      spec.transform = null;      // 量的是"变换前"的盒子，变换稍后叠上去
      const mini = Scene.fromJSON({
      width: W, height: H, fps: sc.fps, duration: sc.duration,
      bg: null, transparent: true, fx: [],
      beat: sc.beat.toJSON ? sc.beat.toJSON() : sc.beat,
      captions: sc.captions.map((c) => ({
        start: c.start, end: c.end, text: c.text, words: c.words, style: c.style,
      })),
        layers: [spec],
    });

    // 入场/出场期间可能是透明的，取几个时刻求并集
    for (const frac of [0.35, 0.6, 0.8]) {
      const t = L.start + (L.end - L.start) * frac;
      const ctx = idxScratch.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      renderFrame(ctx, mini, t, { silent: true });
      sctx.clearRect(0, 0, sw, sh);
      sctx.drawImage(idxScratch.canvas, 0, 0, sw, sh);
      const d = sctx.getImageData(0, 0, sw, sh).data;
      let x0 = sw, y0 = sh, x1 = -1, y1 = -1;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (d[(y * sw + x) * 4 + 3] > 20) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 >= 0) {
        const b = { x: x0 / sw, y: y0 / sh, w: (x1 - x0 + 1) / sw, h: (y1 - y0 + 1) / sh };
        box = box
          ? {
            x: Math.min(box.x, b.x), y: Math.min(box.y, b.y),
            w: Math.max(box.x + box.w, b.x + b.w) - Math.min(box.x, b.x),
            h: Math.max(box.y + box.h, b.y + b.h) - Math.min(box.y, b.y),
          }
          : b;
      }
    }
  }
  idxBoxCache.set(L.id, box);
  return box;
}

/** 位移 + 缩放后的盒子（不含旋转）：p' = p + 位移 + (scale-1)×(p - 支点) */
function applyMoveScale(b, tr) {
  if (!b) return null;
  if (!tr) return b;
  const s = tr.scale;
  const x = b.x + tr.x + (s - 1) * (b.x - tr.px);
  const y = b.y + tr.y + (s - 1) * (b.y - tr.py);
  return { x, y, w: b.w * s, h: b.h * s };
}

/** 连旋转一起算，取外接矩形 —— 图层索引的小图、点击命中的兜底都用它 */
function transformBox(b, tr) {
  const m = applyMoveScale(b, tr);
  if (!m || !tr || !tr.rot) return m;
  const p = { x: tr.px + tr.x, y: tr.py + tr.y };       // 支点在画面上的位置
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [cx, cy] of [[m.x, m.y], [m.x + m.w, m.y], [m.x + m.w, m.y + m.h], [m.x, m.y + m.h]]) {
    const r = rotatePoint(cx, cy, p.x, p.y, tr.rot);
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x); y1 = Math.max(y1, r.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** 图层在画面上的实际包围盒 */
function layerBoxFor(L) {
  return transformBox(layerBaseBox(L), L.transform);
}

function centerOfBox(b) { return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; }

function rotatePoint(x, y, cx, cy, deg) {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = x - cx, dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** 画面上的 4 个角（含旋转），顺序：左上 右上 右下 左下 */
function boxCornersOnScreen(L) {
  const m = applyMoveScale(layerBaseBox(L), L.transform);
  if (!m) return null;
  const tr = L.transform;
  const p = tr ? { x: tr.px + tr.x, y: tr.py + tr.y } : { x: 0.5, y: 0.5 };
  const pts = [[m.x, m.y], [m.x + m.w, m.y], [m.x + m.w, m.y + m.h], [m.x, m.y + m.h]];
  return pts.map(([x, y]) => (tr && tr.rot ? rotatePoint(x, y, p.x, p.y, tr.rot) : { x, y }));
}

/**
 * 点 (nx,ny)（归一化）有没有落在这一层上。
 * 反向走一遍变换：先把点绕支点反旋，再撤掉缩放和位移，回到"基础盒"的坐标系里比。
 */
function hitTestLayer(L, nx, ny, padX, padY) {
  const b = layerBaseBox(L);
  if (!b) return false;
  const tr = L.transform;
  let x = nx, y = ny;
  if (tr) {
    const sx = tr.px + tr.x, sy = tr.py + tr.y;        // 支点在画面上的位置
    if (tr.rot) {
      const r = rotatePoint(x, y, sx, sy, -tr.rot);
      x = r.x; y = r.y;
    }
    const s = tr.scale || 1;
    x = tr.px + (x - sx) / s;
    y = tr.py + (y - sy) / s;
  }
  return x >= b.x - padX && x <= b.x + b.w + padX && y >= b.y - padY && y <= b.y + b.h + padY;
}

function invalidateLayerBox(id) {
  if (id === undefined) idxBoxCache.clear(); else idxBoxCache.delete(id);
  markIndexDirty();
}

/** 在缩略图上画出"这层占了哪块"。 */
function drawRowMap(cv, L, live) {
  const box = layerBoxFor(L);
  const col = CAT_COLOR[tplMeta(L.template).category] || CAT_COLOR.other;
  const c = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = live ? '#131a17' : '#0c0d10';
  c.fillRect(0, 0, w, h);
  c.strokeStyle = '#23262d'; c.lineWidth = 1;
  c.strokeRect(0.5, 0.5, w - 1, h - 1);
  c.strokeStyle = '#1a1d23';
  for (let i = 1; i < 3; i++) {
    c.beginPath(); c.moveTo(w * i / 3, 0); c.lineTo(w * i / 3, h); c.stroke();
    c.beginPath(); c.moveTo(0, h * i / 3); c.lineTo(w, h * i / 3); c.stroke();
  }
  if (!box) {
    c.fillStyle = '#4a505b'; c.font = '9px monospace';
    c.fillText('此刻不可见', 3, h - 4);
    return;
  }
  c.fillStyle = col + '55';
  c.fillRect(box.x * w, box.y * h, Math.max(2, box.w * w), Math.max(2, box.h * h));
  c.strokeStyle = col; c.lineWidth = 1.5;
  c.strokeRect(box.x * w + 1, box.y * h + 1, Math.max(1, box.w * w - 2), Math.max(1, box.h * h - 2));
}

let idxDirty = true;
let idxSig = null;

function markIndexDirty() { idxDirty = true; }

/** 整个工程被换掉时用（id 会重排，量好的包围盒也作废）。 */
function resetLayerIndex() { idxBoxCache.clear(); markIndexDirty(); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/** 结构指纹：图层增删、时长、起止、名字变了就重建列表。 */
function layerIndexSignature() {
  const sc = state.scene;
  return sc.layers.length + '|' + sc.width + 'x' + sc.height + '|' + sc.duration.toFixed(2) + '|' +
    sc.layers.map((L) => L.id + ':' + L.start.toFixed(3) + ':' + L.end.toFixed(3) + ':' +
      (L.enabled ? 1 : 0) + ':' + L.name).join(',');
}

/** 顶部小图：播放头这一刻，画面上都有谁、各占哪一块。 */
function drawIdxMap(active) {
  const cv = $('idxMap');
  const c = cv.getContext('2d');
  const w = cv.width, h = cv.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = '#101216'; c.fillRect(0, 0, w, h);
  c.strokeStyle = '#1e2128'; c.lineWidth = 1;
  for (let i = 1; i < 6; i++) {
    c.beginPath(); c.moveTo(w * i / 6, 0); c.lineTo(w * i / 6, h); c.stroke();
  }
  for (let i = 1; i < 4; i++) {
    c.beginPath(); c.moveTo(0, h * i / 4); c.lineTo(w, h * i / 4); c.stroke();
  }
  active.forEach((L, i) => {
    const box = layerBoxFor(L);
    if (!box) return;
    const col = CAT_COLOR[tplMeta(L.template).category] || CAT_COLOR.other;
    const bx = box.x * w, by = box.y * h, bw = box.w * w, bh = box.h * h;
    c.fillStyle = col + '33';
    c.fillRect(bx, by, bw, bh);
    c.strokeStyle = col; c.lineWidth = 1.5;
    c.strokeRect(bx + 1, by + 1, Math.max(2, bw - 2), Math.max(2, bh - 2));
    const nx = Math.min(w - 14, Math.max(0, bx + 2));
    const ny = Math.min(h - 12, Math.max(0, by + 2));
    c.fillStyle = col; c.fillRect(nx, ny, 13, 11);
    c.fillStyle = '#0b0c0e'; c.font = '9px monospace';
    c.fillText(String(i + 1), nx + 3, ny + 9);
  });
  $('idxMapHint').textContent = active.length
    ? (state.t.toFixed(2) + 's · ' + active.length + ' 个图层在画面里')
    : (state.t.toFixed(2) + 's · 这一刻画面是空的');
}

function rebuildLayerIndex() {
  const sc = state.scene;
  const list = $('layerList');
  idxRows.clear();
  idxLiveKey = '';
  idxSelKey = '';
  let arr = sc.layers.slice();
  const mode = $('sortLayers').value;
  if (mode === 'time') arr.sort((a, b) => a.start - b.start || a.id - b.id);
  else arr.sort((a, b) => b.id - a.id);            // 层级：后加的在上
  const q = ($('searchLayer').value || '').trim().toLowerCase();
  if (q) {
    arr = arr.filter((L) => (L.name + ' ' + L.template + ' ' + tplMeta(L.template).name).toLowerCase().includes(q));
  }

  list.innerHTML = '';
  $('layerCount').textContent = String(sc.layers.length);
  if (!arr.length) {
    const d = document.createElement('div');
    d.className = 'layer-empty';
    d.textContent = sc.layers.length
      ? '没有匹配的图层。'
      : '还没有图层。左边「模板库」点一下加一个，或者用 ✨ AI 助手一次铺满。';
    list.appendChild(d);
    drawIdxMap([]);
    idxSig = layerIndexSignature();
    return;
  }

  arr.forEach((L) => {
    const meta = tplMeta(L.template);
    const row = document.createElement('div');
    row.className = 'lrow' + (L.enabled ? '' : ' off') + (L.id === state.selection ? ' sel' : '');
    row.dataset.id = String(L.id);

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = CAT_COLOR[meta.category] || CAT_COLOR.other;
    dot.title = (CAT_LABEL[meta.category] || meta.category) + ' · 点一下临时关掉这层（只是预览开关，参数不动）';
    row.title = (L.name || L.template) + '　' + L.template +
      '\n' + L.start.toFixed(2) + 's → ' + L.end.toFixed(2) + 's' +
      '\n单击：选中并跳到中间　双击：跳到开头';

    const cv = document.createElement('canvas');
    cv.className = 'map'; cv.width = 62; cv.height = 35;

    const who = document.createElement('div');
    who.className = 'who';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.innerHTML = escapeHtml(L.name || L.template) +
      ' <span class="tag">' + escapeHtml(L.template) + '</span>';
    const mt = document.createElement('div');
    mt.className = 'mt';
    mt.textContent = L.start.toFixed(2) + '→' + L.end.toFixed(2) + 's · ' +
      (L.end - L.start).toFixed(2) + 's · ' + (meta.name || '');
    who.appendChild(nm); who.appendChild(mt);
    row.appendChild(dot); row.appendChild(cv); row.appendChild(who);

    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      L.enabled = !L.enabled;
      row.classList.toggle('off', !L.enabled);
      renderAt(state.t); blit(); drawTimeline();
      markIndexDirty();
    });
    row.addEventListener('click', () => {
        selectLayer(L.id);
      setTime(L.start + (L.end - L.start) * 0.5);   // 跳到中间，一眼就能看到
      idxSelKey = '';
      updateLayerIndexLive();
    });
    row.addEventListener('dblclick', () => setTime(L.start));

    list.appendChild(row);
    idxRows.set(L.id, row);
    drawRowMap(cv, L, false);
  });

  idxSig = layerIndexSignature();
  updateLayerIndexLive();
}

/** 每帧调用：只做开销很小的"当前高亮"，结构变了才重建。 */
function tickLayerIndex() {
  if (!idxPaneOpen) return;
  if (idxDirty) { idxDirty = false; rebuildLayerIndex(); return; }
  if (++idxFrameTick % 12 === 0 && layerIndexSignature() !== idxSig) { rebuildLayerIndex(); return; }
  updateLayerIndexLive();
}

function updateLayerIndexLive() {
  if (!idxPaneOpen) return;
  const t = state.t;
  const active = state.scene.layers.filter((L) => L.enabled && L.covers(t));
  const liveKey = active.map((L) => L.id).join(',');
  if (liveKey !== idxLiveKey) {
    idxLiveKey = liveKey;
    const set = new Set(active.map((L) => L.id));
    for (const [id, row] of idxRows) {
      const on = set.has(id);
      row.classList.toggle('live', on);
      const cv = row.querySelector('canvas');
      const L = state.scene.layers.find((x) => x.id === id);
      if (cv && L) drawRowMap(cv, L, on);
    }
    drawIdxMap(active);
  }
  const selKey = String(state.selection || '');
  if (selKey !== idxSelKey) {
    idxSelKey = selKey;
    for (const [id, row] of idxRows) row.classList.toggle('sel', String(id) === selKey);
  }
}

function setIndexTab(which) {
  idxPaneOpen = which === 'layers';
  $('paneTpl').classList.toggle('hidden', idxPaneOpen);
  $('paneLayers').classList.toggle('hidden', !idxPaneOpen);
  $('tabTpl').classList.toggle('active', !idxPaneOpen);
  $('tabLayers').classList.toggle('active', idxPaneOpen);
  if (idxPaneOpen) rebuildLayerIndex();
}

// ---------------------------------------------------------------- 交互绑定
$('btnPlay').addEventListener('click', togglePlay);
$('btnToStart').addEventListener('click', () => setTime(0));
$('btnMute').addEventListener('click', () => { state.muted = !state.muted; applyAudio(); });
$('chkFlash').addEventListener('change', (e) => {
  const on = e.target.checked;
  for (const s of state.scene.fx || []) {
    if (s.type === 'flash' || s.type === 'invert') s.enabled = on;
  }
  renderRight(); renderAt(state.t); blit();
});
$('tabTpl').addEventListener('click', () => setIndexTab('tpl'));
$('tabLayers').addEventListener('click', () => setIndexTab('layers'));
$('sortLayers').addEventListener('change', () => { markIndexDirty(); rebuildLayerIndex(); });
$('searchLayer').addEventListener('input', (e) => {
  state.tlFind = e.target.value || '';   // 时间轴同步高亮（搜到的亮、其余淡）
  rebuildLayerIndex();
  drawTimeline();
});
// 并轨开关（默认开，省地方）
{
  const saved = localStorage.getItem('motionkit.tlPack');
  if (saved === '0') state.tlPack = false;
  const cb = $('chkPack');
  if (cb) {
    cb.checked = state.tlPack;
    cb.addEventListener('change', () => {
      state.tlPack = cb.checked;
      try { localStorage.setItem('motionkit.tlPack', state.tlPack ? '1' : '0'); } catch (_) {}
      state.tlScroll = 0;
      drawTimeline();
    });
  }
}
$('btnOpenVideo').addEventListener('click', () => $('fileVideo').click());
$('btnOpenAudio').addEventListener('click', () => $('fileAudio').click());
$('btnOpenSubs').addEventListener('click', () => $('fileSubs').click());
$('btnSaveProject').addEventListener('click', saveProject);
$('btnLoadProject').addEventListener('click', () => $('fileProject').click());
$('btnNewProject').addEventListener('click', () => newProject(false));
$('btnRestoreOk').addEventListener('click', hideRestoreBar);
$('btnRestoreDrop').addEventListener('click', () => {
  clearLocalProject();
  hideRestoreBar();
  newProject(true);
});
$('searchTpl').addEventListener('input', (e) => buildTemplateList(e.target.value));
// 全部折叠 / 全部展开
{
  try {
    const saved = localStorage.getItem('motionkit.tplCollapsed');
    if (saved) state.tplCollapsed = JSON.parse(saved) || {};
  } catch (_) {}
  const b = $('btnTplFold');
  if (b) {
    const sync = () => {
      const anyOpen = Object.keys(CATEGORIES).some((c) => !state.tplCollapsed[c]);
      b.textContent = anyOpen ? '折叠' : '展开';
      b.title = anyOpen ? '把分类全部折叠' : '把分类全部展开';
    };
    b.addEventListener('click', () => {
      const anyOpen = Object.keys(CATEGORIES).some((c) => !state.tplCollapsed[c]);
      const next = {};
      for (const c of Object.keys(CATEGORIES)) next[c] = anyOpen;
      state.tplCollapsed = next;
      try { localStorage.setItem('motionkit.tplCollapsed', JSON.stringify(next)); } catch (_) {}
      buildTemplateList($('searchTpl').value || '');
      sync();
    });
    sync();
  }
}
$('tplBarCancel').addEventListener('click', () => pickTemplate(null));
// 右侧标签页
for (const b of document.querySelectorAll('#rightTabs .rtab')) {
  b.addEventListener('click', () => setRightTab(b.dataset.tab));
}

$('fileVideo').addEventListener('change', (e) => e.target.files[0] && loadVideoFile(e.target.files[0]));
$('fileAudio').addEventListener('change', (e) => e.target.files[0] && loadAudioFile(e.target.files[0]));
$('fileSubs').addEventListener('change', (e) => e.target.files[0] && loadSubtitleFile(e.target.files[0]));
$('fileProject').addEventListener('change', (e) => e.target.files[0] && openProject(e.target.files[0]));

const scrub = $('scrub');
scrub.addEventListener('pointerdown', () => { scrubbing = true; });
scrub.addEventListener('pointerup', () => { scrubbing = false; });
scrub.addEventListener('input', () => {
  const t = (parseFloat(scrub.value) / 1000) * state.scene.duration;
  setTime(t);
});

$('selPreset').addEventListener('change', (e) => applyPreset(e.target.value));

// 拖放
// 两种东西从这儿进来：① 素材文件 ② 左边模板库里拖过来的模板
const hasTplDrag = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(TPL_MIME);
['dragenter', 'dragover'].forEach((ev) => stage.addEventListener(ev, (e) => {
  e.preventDefault();
  if (hasTplDrag(e)) {
    e.dataTransfer.dropEffect = 'copy';
    stage.classList.add('tpl-over');
    moveDropMark(e);
  } else {
    stage.classList.add('dragover');
  }
}));
stage.addEventListener('dragleave', (e) => {
  // 拖过子元素也会触发 dragleave，只有真的离开 stage 才算数
  if (e.relatedTarget && stage.contains(e.relatedTarget)) return;
  stage.classList.remove('dragover', 'tpl-over');
  moveDropMark(null);
});
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover', 'tpl-over');
  moveDropMark(null);
  if (hasTplDrag(e)) {
    const t = listTemplates().find((x) => x.id === e.dataTransfer.getData(TPL_MIME));
    if (t) dropTemplateOnStage(t, e);
    return;
  }
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (/^video\/|^image\//.test(f.type)) loadVideoFile(f);
  else if (/^audio\//.test(f.type)) loadAudioFile(f);
  else if (/\.(srt|vtt|ass|ssa)$/i.test(f.name)) loadSubtitleFile(f);
});

// 导出弹窗
const dlg = $('exportDlg');
$('btnExport').addEventListener('click', () => {
  $('exportInfo').textContent = `${state.scene.width}×${state.scene.height} · ${state.scene.fps}fps · ${state.scene.frameCount} 帧`;
  dlg.showModal();
});
$('btnCloseDlg').addEventListener('click', () => dlg.close());

// 弹窗里补一个"包含底图"开关
const optRow = document.createElement('label');
optRow.className = 'mini';
optRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:12px;color:#8b929e';
optRow.innerHTML = '<input type="checkbox" id="chkIncludeMedia" /> 导出画面时把底下的视频/图片一起渲染进去（不勾选 = 只导出带透明的叠加层）';
dlg.querySelector('.dlg-grid').after(optRow);

// 声音：MP4 能带走，其它导出项都是画面层
const audioRow = document.createElement('label');
audioRow.className = 'mini';
audioRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:6px;color:#8b929e';
audioRow.innerHTML = '<input type="checkbox" id="chkExportAudio" checked /> 导出 MP4 时带上声音（需要先「载入音频」；其它导出项都是画面层）';
optRow.after(audioRow);

// 把"哪些导出项有声音"写在面板上，省得误会
const soundNote = document.createElement('div');
soundNote.className = 'mini';
soundNote.style.cssText = 'margin-top:8px;color:#8b929e;line-height:1.7;font-size:11px';
soundNote.innerHTML =
  '<b>MP4 可以带声音</b>（勾上面那个开关，带的是「载入音频」那一轨，编成 AAC）。' +
  'MP4 还是<b>帧精确</b>的：每帧时间戳按工程帧率写，工程多长就导出多长，渲染多快就多快（WebCodecs + 自带的 H.264）。<br>' +
  'PNG 序列 / WebM / ProRes 导的都是<b>画面层，不含声音</b>；WebM 还是实时录制，渲染一帧比 1/fps 慢就会把时长拖长。<br>' +
  '要"原片原声 + 叠加层"的成片：用 <code>tools/encode.py --overlay 原片.mp4 --audio 音乐.wav</code>，' +
  '或者 AI 助手跑 <code>--render</code>。';
audioRow.after(soundNote);

dlg.addEventListener('click', async (e) => {
  const b = e.target.closest('.ex');
  if (!b) return;
  const kind = b.dataset.ex;
  const includeMedia = $('chkIncludeMedia').checked;
  const withAudio = $('chkExportAudio') ? $('chkExportAudio').checked : true;
  dlg.close();
  try {
    if (kind === 'png') await exportPngSequence(includeMedia);
    else if (kind === 'webm') await exportVideo('webm', includeMedia);
    else if (kind === 'mp4') await exportVideo('mp4', includeMedia, { audio: withAudio });
    else if (kind === 'json') exportProject();
    else if (kind === 'beats') exportBeats();
    else if (kind === 'srt') exportSrt();
    else if (kind === 'mov') {
      alert('ProRes 4444 走本机 ffmpeg：\n\n1) 先导出「PNG 序列(ZIP)」并解压到某个文件夹\n2) 在本工具目录执行：\n\n   python tools/encode.py --in 你的文件夹 --out out.mov --codec prores4444 --fps ' + state.scene.fps);
    }
  } catch (err) {
    hideBusy();
    alert('导出失败：' + err.message);
  }
});

// 快捷键
window.addEventListener('keydown', (e) => {
  // 撤销 / 重做 / 复制：在真正的文本框里让浏览器自己来
  const el = e.target;
  const typing = !!el && (el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && /^(text|search|url|email|password|number)$/i.test(el.type || 'text')));
  if ((e.ctrlKey || e.metaKey) && !typing) {
    const k = String(e.key || '').toLowerCase();
    if (k === 'z') { e.preventDefault(); historyStep(e.shiftKey ? 1 : -1); return; }
    if (k === 'y') { e.preventDefault(); historyStep(1); return; }
    if (k === 'd') { e.preventDefault(); duplicateSelectedClip(); return; }
  }
  if (/input|textarea|select/i.test(e.target.tagName)) return;
  // Alt + 方向键 = 微调选中的图层（Shift 加速 10 倍），原本的方向键留给走带
  if (e.altKey && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
    const L = selectedLayer();
    if (L) {
      e.preventDefault();
      const d = e.shiftKey ? 0.02 : 0.002;
      const tr = ensureTransform(L);
      if (e.key === 'ArrowLeft') tr.x -= d;
      else if (e.key === 'ArrowRight') tr.x += d;
      else if (e.key === 'ArrowUp') tr.y -= d;
      else tr.y += d;
      markIndexDirty(); renderAt(state.t); blit();
      return;
    }
  }
  if (e.key === 'Escape') { closeTextEditor(); selectLayer(null); return; }
  const step = e.shiftKey ? 1 : 1 / state.scene.fps;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); setTime(state.t - step); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); setTime(state.t + step); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    // 选中片段就删片段，否则删图层
    if (selectedClip()) deleteSelectedClip();
    else deleteSelectedLayers();     // 单选 / 框选 / Shift 加选，一次都删掉
  } else if ((e.key === 's' || e.key === 'S') && !e.metaKey && !e.ctrlKey) {
    splitClipAt(state.t);            // 剪映里也是 S 切一刀
  } else if (e.key === 'Home') setTime(0);
  else if (e.key === 'End') setTime(state.scene.duration);
  else if (e.key === 'm' || e.key === 'M') { state.muted = !state.muted; applyAudio(); }
  else if (e.key === 'i' || e.key === 'I') { setIndexTab(idxPaneOpen ? 'tpl' : 'layers'); }
});

window.addEventListener('resize', () => { blit(); drawTimeline(); });

// ---------------------------------------------------------------- 预览直接操控
// 在预览里点选图层、拖动挪位置、拉角缩放、转手柄旋转、双击改文字。
// 位置/缩放/旋转记在 layer.transform 上（见 engine/core.js 的 normalizeTransform），
// 不写进模板参数 —— 这样 23 个模板（含没有 position 参数的全屏 HUD、字幕层、
// 转场层）都能被同一套手柄操控，而且导出、无头渲染用的是同一个引擎，所见即所得。
const editLayerEl = $('editLayer');
let elSel = null, elTagName = null, elRotH = null, elText = null, elTextKey = null, elTextArea = null, elToast = null;
let elGuideX = null, elGuideY = null;
let pdrag = null;        // 正在进行的拖拽
let lastHit = null;      // 上一次落点，重叠时用来逐层下探
let marquee = null;      // 预览里正在拉的框选矩形（归一化坐标）
let tlMarquee = null;    // 时间轴上正在拉的框选矩形（画布像素坐标）
let textParamKey = null; // 文字浮窗正在编辑的参数

function selectedLayer() { return state.scene.layers.find((x) => x.id === state.selection) || null; }

/** 外部脚本传图层对象、下标都行；-1 / 省略 = 当前选中的那层 */
function layerArgOf(i) {
  if (i && typeof i === 'object') return i;
  if (typeof i === 'number' && i >= 0) return state.scene.layers[i] || null;
  return selectedLayer();
}

function ensureTransform(L) {
  if (!L.transform) L.transform = { x: 0, y: 0, scale: 1, rot: 0, px: 0.5, py: 0.5 };
  return L.transform;
}

function buildEditOverlay() {
  if (!editLayerEl || elSel) return;
  editLayerEl.innerHTML =
    '<div class="el-guide el-guide-x"></div><div class="el-guide el-guide-y"></div>' +
    '<div class="el-sel hidden">' +
      '<i class="el-h el-nw" data-c="nw"></i><i class="el-h el-ne" data-c="ne"></i>' +
      '<i class="el-h el-se" data-c="se"></i><i class="el-h el-sw" data-c="sw"></i>' +
      '<i class="el-rot" title="拖动旋转（按住 Shift 吸附 15°）">⟳</i>' +
      '<div class="el-tag"><b class="el-name"></b>' +
        '<button class="el-act" data-act="text" title="改文字（也可以直接在预览里双击）">T</button>' +
        '<button class="el-act" data-act="reset" title="复位位置 / 缩放 / 旋转">复位</button>' +
        '<button class="el-act danger" data-act="del" title="删除这一层">×</button>' +
      '</div>' +
    '</div>' +
    '<div class="el-toast hidden"></div>' +
    '<div class="el-text hidden">' +
      '<div class="el-text-head"><span>改文字</span><select class="el-text-key"></select>' +
        '<button class="el-text-close" title="结束（Esc）">✓</button></div>' +
      '<textarea class="el-text-area" rows="2" spellcheck="false"></textarea>' +
      '<div class="el-text-tip">边打边改，实时生效 · Esc 结束</div>' +
    '</div>';

  elSel = editLayerEl.querySelector('.el-sel');
  elTagName = editLayerEl.querySelector('.el-name');
  elRotH = editLayerEl.querySelector('.el-rot');
  elGuideX = editLayerEl.querySelector('.el-guide-x');
  elGuideY = editLayerEl.querySelector('.el-guide-y');
  elToast = editLayerEl.querySelector('.el-toast');
  elText = editLayerEl.querySelector('.el-text');
  elTextKey = editLayerEl.querySelector('.el-text-key');
  elTextArea = editLayerEl.querySelector('.el-text-area');

  editLayerEl.querySelector('.el-text-close').addEventListener('click', closeTextEditor);
  elTextKey.addEventListener('change', () => {
    textParamKey = elTextKey.value;
    fillTextArea();
  });
  elTextArea.addEventListener('input', () => {
    const L = selectedLayer();
    if (!L || !textParamKey) return;
    L.params[textParamKey] = elTextArea.value;
    invalidateLayerBox(L.id);
    renderAt(state.t); blit();
  });
  elTextArea.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeTextEditor(); }
    e.stopPropagation();     // 别让空格 / 方向键跑去控制播放
  });

  elSel.addEventListener('click', (e) => {
    const b = e.target.closest('.el-act');
    if (!b) return;
    const L = selectedLayer();
    if (!L) return;
    e.stopPropagation();
    if (b.dataset.act === 'text') openTextEditor(L);
    else if (b.dataset.act === 'reset') {
      L.transform = null;
      markIndexDirty(); renderAt(state.t); blit();
    } else if (b.dataset.act === 'del') {
      deleteSelectedLayers();
    }
  });

  // 指针交互：手柄 = 缩放 / 旋转，其它地方 = 选中 + 拖动
  editLayerEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.el-text') || e.target.closest('.el-tag')) return;

    const handle = e.target.closest('.el-h');
    if (handle && selectedLayer()) { startScale(e, selectedLayer(), handle.dataset.c); return; }
    if (e.target.closest('.el-rot') && selectedLayer()) { startRotate(e, selectedLayer()); return; }

    const p = pointerNorm(e);
    const cands = pickLayerAt(p.x, p.y);
    if (!cands.length) {
      // 空白处按下 = 框选（原来这里是"点空白取消选择"，没丢功能：
      // 不拖动的单击在抬手时一样是取消选择）
      startMarquee(e, p);
      return;
    }

    let hit = cands[0];
    // Alt + 点 = 穿透到下面那层（重叠时不用去翻图层列表）。
    // 注意别用"同一位置连点"来判定穿透：想再拖一次的时候会点回同一个位置，
    // 那样会莫名其妙拖到别的层上去。
    if (e.altKey && lastHit) {
      const i = cands.findIndex((c) => c.id === lastHit.id);
      if (i >= 0) hit = cands[(i + 1) % cands.length];
      else hit = cands[cands.length - 1];
    }
    lastHit = { x: p.x, y: p.y, id: hit.id };
    // Shift = 加选（多选后一次性删掉）；Ctrl/Cmd = 在已选里来回切
    const mode = e.shiftKey ? 'add' : (e.metaKey || e.ctrlKey) ? 'toggle' : undefined;
    if (mode) { selectLayer(hit.id, mode); return; }
    if (state.selection !== hit.id) selectLayer(hit.id);
    startMove(e, hit);
  });

  function startMarquee(e, p) {
    marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, keep: e.shiftKey ? new Set(state.selected) : new Set(), moved: false };
    if (!e.shiftKey) { state.selected = new Set(); state.selection = null; }
    try { editLayerEl.setPointerCapture(e.pointerId); } catch (_) {}
    renderRight(); drawTimeline();
    blit();
  }

  editLayerEl.addEventListener('pointermove', (e) => {
    if (pdrag) return;                       // 拖拽中的移动统一走 window，指针甩出画布也不断线
    const p = pointerNorm(e);
    editLayerEl.style.cursor = pickLayerAt(p.x, p.y).length ? 'move' : 'default';
  });
  const endDrag = () => {
    if (marquee) {
      const m = marquee;
      marquee = null;
      const hit = m.moved ? layersInMarquee(m) : [];
      const keep = [...m.keep].filter((id) => state.scene.layers.some((L) => L.id === id));
      const ids = [...keep, ...hit.map((L) => L.id)];
      state.selected = new Set(ids);
      state.selection = (hit[0] || state.scene.layers.find((L) => L.id === keep[0]) || {}).id ?? null;
      if (state.selection != null) rightTab = 'layer';
      renderRight(); drawTimeline(); blit();
      if (hit.length > 1) toast(`框选了 ${ids.length} 层 —— Delete 删除，Shift 点选加减，空白单击取消`);
      return;
    }
    if (!pdrag) return;
    const L = pdrag.L;
    pdrag = null;
    setGuides(null, null);
    // 只是点了一下没拖动：别留一个"全零的变换"在工程里，存档会脏
    if (L && L.transform && !L.transform.x && !L.transform.y && L.transform.scale === 1 && !L.transform.rot) {
      L.transform = null;
    }
    renderRight();          // 右栏那句「预览里摆过位置」跟着刷新
    markIndexDirty();
  };
  window.addEventListener('pointermove', (e) => {
    if (pdrag) { onDragMove(e); return; }
    if (!marquee) return;
    const p = pointerNorm(e);
    marquee.x1 = p.x; marquee.y1 = p.y;
    if (Math.abs(p.x - marquee.x0) > 0.004 || Math.abs(p.y - marquee.y0) > 0.004) marquee.moved = true;
    blit();
  });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  editLayerEl.addEventListener('pointerleave', () => { if (!pdrag) editLayerEl.style.cursor = 'default'; });

  // 双击 = 改文字
  editLayerEl.addEventListener('dblclick', (e) => {
    if (e.target.closest('.el-text') || e.target.closest('.el-tag')) return;
    const p = pointerNorm(e);
    const cands = pickLayerAt(p.x, p.y);
    const L = cands[0] || selectedLayer();
    if (!L) return;
    if (state.selection !== L.id) selectLayer(L.id);
    openTextEditor(L);
  });

  // Alt + 滚轮 = 缩放选中层（不想去够角落手柄的时候用）
  editLayerEl.addEventListener('wheel', (e) => {
    const L = selectedLayer();
    if (!L || !e.altKey) return;
    e.preventDefault();
    const b = layerBaseBox(L);
    if (!b) return;
    const tr = ensureTransform(L);
    const c = centerOfBox(applyMoveScale(b, tr));
    tr.px = c.x - tr.x; tr.py = c.y - tr.y;      // 以当前画面中心为支点
    tr.scale = clamp(tr.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 0.05, 8);
    markIndexDirty(); renderAt(state.t); blit();
  }, { passive: false });
}

/** 把交互层贴到画布上（画布是居中的，尺寸随窗口变） */
function layoutEditOverlay() {
  if (!editLayerEl) return;
  const sr = stage.getBoundingClientRect(), cr = preview.getBoundingClientRect();
  if (cr.width < 4 || cr.height < 4) { editLayerEl.classList.add('hidden'); return; }
  editLayerEl.classList.remove('hidden');
  editLayerEl.style.left = (cr.left - sr.left) + 'px';
  editLayerEl.style.top = (cr.top - sr.top) + 'px';
  editLayerEl.style.width = cr.width + 'px';
  editLayerEl.style.height = cr.height + 'px';
}

function pointerNorm(e) {
  const r = editLayerEl.getBoundingClientRect();
  return { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) };
}

/** 这一层的点击容差（归一化），保证小元素也点得中 */
function hitPad() {
  const W = Math.max(1, editLayerEl.clientWidth), H = Math.max(1, editLayerEl.clientHeight);
  return { x: 5 / W, y: 5 / H };
}

function pickLayerAt(nx, ny) {
  const pad = hitPad();
  const out = [];
  const ls = state.scene.layers;
  for (let i = ls.length - 1; i >= 0; i--) {          // 从上往下
    const L = ls[i];
    if (!L.covers(state.t)) continue;                 // 此刻不在画面上的点不到
    if (hitTestLayer(L, nx, ny, pad.x, pad.y)) out.push(L);
  }
  return out;
}

/**
 * 选中图层。mode：
 *   undefined  单选（原来的行为）
 *   'add'      Shift 点选 —— 加进已选集合
 *   'toggle'   Ctrl/Cmd 点选 —— 在集合里来回切
 *   'keep'     只换"主选"，集合不动（框选完想让参数面板认某一层时用）
 */
function selectLayer(id, mode) {
  if (id == null) {
    if (mode !== 'keep') state.selected = new Set();
    state.selection = null;
  } else {
    if (mode === 'add') state.selected.add(id);
    else if (mode === 'toggle') {
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
    } else if (mode !== 'keep') {
      state.selected = new Set([id]);
    }
    if (!state.selected.size) state.selected.add(id);
    // 主选 = 刚点的这个（如果被 toggle 掉了，就退回集合里的第一个）
    state.selection = state.selected.has(id) ? id : (selectedLayers()[0] || {}).id ?? null;
  }
  if (state.selection != null) rightTab = 'layer';   // 选了图层就自动切到「图层」页
  if (elText) closeTextEditor();
  if (state.selection != null) scrollLayerIntoView(state.selection);
  renderRight();
  drawTimeline();
}

/** 已选的图层（按图层栈顺序，方便"选一批一起删"） */
function selectedLayers() { return state.scene.layers.filter((L) => state.selected.has(L.id)); }
function isSelected(id) { return state.selected.has(id); }

/** 删掉当前选中的全部图层（单选 / 框选 / Shift 加选都走这里） */
function deleteSelectedLayers() {
  const ids = new Set(state.selected);
  if (!ids.size && state.selection != null) ids.add(state.selection);
  if (!ids.size) return 0;
  const n = ids.size;
  state.scene.layers = state.scene.layers.filter((L) => !ids.has(L.id));
  state.selected = new Set();
  state.selection = null;
  markIndexDirty();
  renderRight(); drawTimeline(); renderAt(state.t); blit();
  toast(n > 1 ? `删掉 ${n} 层` : '删掉 1 层');
  return n;
}

function startMove(e, L) {
  const tr = ensureTransform(L);
  const p = pointerNorm(e);
  pdrag = {
    mode: 'move', L, tr, p0: p,
    off0: { x: tr.x, y: tr.y },
    center0: centerOfBox(applyMoveScale(layerBaseBox(L), tr)),
  };
  try { editLayerEl.setPointerCapture(e.pointerId); } catch (_) {}
}

function startScale(e, L, corner) {
  const base = layerBaseBox(L);
  const corners = boxCornersOnScreen(L);
  if (!base || !corners) return;
  const order = ['nw', 'ne', 'se', 'sw'];
  const opp = { nw: 2, ne: 3, se: 0, sw: 1 }[corner];
  const tr = ensureTransform(L);
  // 把支点挪到"对角"上：这样拖动时对角钉死不动，跟设计软件的手感一致
  tr.px = corners[opp].x - tr.x;
  tr.py = corners[opp].y - tr.y;
  const W = Math.max(1, editLayerEl.clientWidth), H = Math.max(1, editLayerEl.clientHeight);
  const p = pointerNorm(e);
  const pivotPx = { x: tr.px * W, y: tr.py * H };
  const pPx = { x: p.x * W, y: p.y * H };
  pdrag = {
    mode: 'scale', L, tr, pivot: { x: tr.px, y: tr.py }, scale0: tr.scale,
    d0: Math.max(4, Math.hypot(pPx.x - pivotPx.x, pPx.y - pivotPx.y)), W, H,
    _cornerOrder: order,
  };
  try { editLayerEl.setPointerCapture(e.pointerId); } catch (_) {}
}

function startRotate(e, L) {
  const base = layerBaseBox(L);
  if (!base) return;
  const tr = ensureTransform(L);
  const c = centerOfBox(applyMoveScale(base, tr));      // 以当前画面中心为轴
  tr.px = c.x - tr.x; tr.py = c.y - tr.y;
  const W = Math.max(1, editLayerEl.clientWidth), H = Math.max(1, editLayerEl.clientHeight);
  const p = pointerNorm(e);
  const cp = { x: (tr.px + tr.x) * W, y: (tr.py + tr.y) * H };
  pdrag = {
    mode: 'rot', L, tr, pivot: { x: tr.px, y: tr.py }, W, H,
    a0: Math.atan2(p.y * H - cp.y, p.x * W - cp.x), rot0: tr.rot,
  };
  try { editLayerEl.setPointerCapture(e.pointerId); } catch (_) {}
}

function onDragMove(e) {
  const { L, tr, mode } = pdrag;
  const p = pointerNorm(e);
  const W = pdrag.W || Math.max(1, editLayerEl.clientWidth);
  const H = pdrag.H || Math.max(1, editLayerEl.clientHeight);

  if (mode === 'move') {
    let ox = pdrag.off0.x + (p.x - pdrag.p0.x);
    let oy = pdrag.off0.y + (p.y - pdrag.p0.y);
    // 吸到画面正中（跟对齐辅助线一起出现）
    const tol = 0.012;
    let gx = false, gy = false;
    const cx = pdrag.center0.x + (ox - pdrag.off0.x);
    const cy = pdrag.center0.y + (oy - pdrag.off0.y);
    if (Math.abs(cx - 0.5) < tol) { ox = pdrag.off0.x + (0.5 - pdrag.center0.x); gx = true; }
    if (Math.abs(cy - 0.5) < tol) { oy = pdrag.off0.y + (0.5 - pdrag.center0.y); gy = true; }
    tr.x = ox; tr.y = oy;
    setGuides(gx ? 0.5 : null, gy ? 0.5 : null);
  } else if (mode === 'scale') {
    const pivotPx = { x: pdrag.pivot.x * W, y: pdrag.pivot.y * H };
    const d = Math.hypot(p.x * W - pivotPx.x, p.y * H - pivotPx.y);
    tr.scale = clamp(pdrag.scale0 * (d / pdrag.d0), 0.05, 8);
    tr.px = pdrag.pivot.x; tr.py = pdrag.pivot.y;
  } else if (mode === 'rot') {
    const cp = { x: (pdrag.pivot.x + tr.x) * W, y: (pdrag.pivot.y + tr.y) * H };
    const a = Math.atan2(p.y * H - cp.y, p.x * W - cp.x);
    let deg = pdrag.rot0 + ((a - pdrag.a0) * 180) / Math.PI;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    tr.rot = deg;
    tr.px = pdrag.pivot.x; tr.py = pdrag.pivot.y;
  }
  renderAt(state.t); blit();
}

function setGuides(x, y) {
  if (!elGuideX) return;
  elGuideX.classList.toggle('hidden', x === null);
  elGuideY.classList.toggle('hidden', y === null);
  if (x !== null) elGuideX.style.left = (x * editLayerEl.clientWidth) + 'px';
  if (y !== null) elGuideY.style.top = (y * editLayerEl.clientHeight) + 'px';
}

/** 每帧更新选择框的位置（变换是纯几何，不需要重新测量图层） */
function drawEditOverlay() {
  if (!editLayerEl || !elSel) return;
  const L = selectedLayer();
  const m = L && !editLayerEl.classList.contains('hidden') ? applyMoveScale(layerBaseBox(L), L.transform) : null;
  if (!m) { elSel.classList.add('hidden'); setGuides(null, null); return; }
  const W = editLayerEl.clientWidth, H = editLayerEl.clientHeight;
  elSel.classList.remove('hidden');
  elSel.style.left = (m.x * W) + 'px';
  elSel.style.top = (m.y * H) + 'px';
  elSel.style.width = Math.max(6, m.w * W) + 'px';
  elSel.style.height = Math.max(6, m.h * H) + 'px';
  // 贴着画面顶边时，名字牌和旋转手柄翻到下面去，别被裁掉够不着
  const tight = m.y * H < 34;
  elSel.classList.toggle('flip-top', tight);
  const tr = L.transform;
  if (tr && tr.rot) {
    elSel.style.transformOrigin = ((tr.px + tr.x - m.x) * W) + 'px ' + ((tr.py + tr.y - m.y) * H) + 'px';
    elSel.style.transform = 'rotate(' + tr.rot + 'deg)';
  } else {
    elSel.style.transform = '';
  }
  const bits = [];
  if (tr) {
    if (tr.scale !== 1) bits.push('×' + tr.scale.toFixed(2));
    if (tr.rot) bits.push(Math.round(tr.rot) + '°');
  }
  elTagName.textContent = (L.name || L.template) + (bits.length ? '  ' + bits.join(' ') : '');
}

// ---------------------------------------------------------------- 预览里改文字
const TEXT_KEY_RE = /(text|title|label|lines|ticker|caption|note|msg|message|kicker|sub|body|content|desc|value)/i;

function textParamsOf(tpl) {
  return ((tpl && tpl.params) || []).filter((p) => {
    if (p.type === 'multiline') return true;
    if (p.type && p.type !== 'string') return false;
    return TEXT_KEY_RE.test(p.key);
  });
}

function openTextEditor(L) {
  const tpl = listTemplates().find((x) => x.id === L.template);
  const ps = textParamsOf(tpl);
  if (!ps.length) {
    toast((/caption|subtitle|字幕/i.test(L.template) ? '这层的字来自字幕轨（导入 SRT 或用字幕面板改）' : '这层没有可直接改的文字'));
    return;
  }
  elTextKey.innerHTML = '';
  for (const p of ps) {
    const o = document.createElement('option');
    o.value = p.key; o.textContent = p.label || p.key;
    elTextKey.appendChild(o);
  }
  textParamKey = ps.some((p) => p.key === textParamKey) ? textParamKey : ps[0].key;
  elTextKey.value = textParamKey;
  fillTextArea();

  // 摆在图层旁边（贴着上边，尽量不挡住它）
  const m = applyMoveScale(layerBaseBox(L), L.transform);
  const W = editLayerEl.clientWidth, H = editLayerEl.clientHeight;
  const x = m ? m.x * W + m.w * W + 10 : 12;
  const y = m ? m.y * H : 12;
  elText.style.left = clamp(x, 8, Math.max(8, W - 250)) + 'px';
  elText.style.top = clamp(y, 8, Math.max(8, H - 130)) + 'px';
  elText.classList.remove('hidden');
  elTextArea.focus();
  elTextArea.setSelectionRange(elTextArea.value.length, elTextArea.value.length);
}

function fillTextArea() {
  const L = selectedLayer();
  if (!L || !textParamKey) return;
  const tpl = listTemplates().find((x) => x.id === L.template);
  const def = ((tpl && tpl.params) || []).find((p) => p.key === textParamKey);
  elTextArea.value = L.params[textParamKey] !== undefined
    ? L.params[textParamKey]
    : (def ? def.default : '');
}

function closeTextEditor() {
  if (!elText) return;
  elText.classList.add('hidden');
  textParamKey = null;
}

let toastTimer = 0;
function toast(msg) {
  if (!elToast) return;
  elToast.textContent = msg;
  elToast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elToast.classList.add('hidden'), 2600);
}

// ---------------------------------------------------------------- 自动保存 / 恢复
// 以前刷新一下工程就没了（只有手动「保存工程」才落盘）。现在改什么都会自动存一份：
//   · 工程本身（图层 / 参数 / 变换 / 特效栈 / 字幕 / 卡点）→ localStorage，同步写，随手就存
//   · 素材（视频 / 图片 / 音乐）→ IndexedDB，太大（>120MB）就不存，只记名字提醒你重新拖进来
// 刷新、关掉浏览器再打开，都会自动接上一次的状态。
const AUTOSAVE_KEY = 'motionkit.autosave.v1';
const MEDIA_MAX = 120 * 1024 * 1024;
const QS = new URLSearchParams(location.search);
const NO_PERSIST = QS.get('render') === '1';   // 无头渲染时不碰存储
const DEEP_LINK = QS.get('preset');            // ?preset= 明确指定了要载入什么，别去覆盖它
                                               // （?layers=1 只是打开图层索引页签，照常恢复）
let autosaveLast = '';
let autosaveWarned = false;

function showRestoreBar(html) {
  const bar = $('restoreBar');
  if (!bar) return;
  $('restoreText').innerHTML = html;
  bar.classList.remove('hidden');
}
function hideRestoreBar() { const b = $('restoreBar'); if (b) b.classList.add('hidden'); }

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no idb')); return; }
    const req = indexedDB.open('motionkit', 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('media')) req.result.createObjectStore('media'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb open failed'));
  });
}
async function idbPut(key, val) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').put(val, key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('idb abort')); };
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('media', 'readonly');
    const rq = tx.objectStore('media').get(key);
    rq.onsuccess = () => { db.close(); resolve(rq.result || null); };
    rq.onerror = () => { db.close(); reject(rq.error); };
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').delete(key);
    tx.oncomplete = () => { db.close(); resolve(true); };
    tx.onerror = () => { db.close(); resolve(false); };
  });
}

/** 素材存一份到 IndexedDB（太大就只记名字） */
function persistMedia(kind, file) {
  if (NO_PERSIST || !file) return;
  if (file.size > MEDIA_MAX) {
    idbDel(kind).catch(() => {});
    return;
  }
  idbPut(kind, file).catch(() => {});
}

/**
 * 素材库持久化：每份素材单独存一条（key = 'asset:<id>'）。
 * 刷新 / 换电脑打开工程时靠它把画面接回来 —— 否则工程 JSON 里只有个 assetId，
 * 时间轴上是空壳。太大（> MEDIA_MAX）就跳过，工程里那一格会显示成"素材丢了"。
 */
function persistAsset(a) {
  if (NO_PERSIST || !a || !a.file) return;
  if (a.file.size > MEDIA_MAX) return;
  idbPut('asset:' + a.id, { file: a.file, meta: { name: a.name, kind: a.kind, size: a.file.size, type: a.file.type } })
    .catch(() => {});
}

/** 工程里有片段、但素材不在内存里时，按 id 把它们从 IndexedDB 捞回来 */
async function restoreAssets() {
  const ids = [...new Set(state.scene.clips.map((c) => c.assetId).filter(Boolean))];
  let back = 0;
  for (const id of ids) {
    if (state.assets.has(id)) continue;
    let rec = null;
    try { rec = await idbGet('asset:' + id); } catch (_) {}
    if (!rec || !rec.file) continue;
    try {
      const a = await addAsset(rec.file, (rec.meta && rec.meta.kind) || 'video');
      const old = state.assets.get(a.id);
      state.assets.delete(a.id);                 // 换成工程里记的那个 id
      a.id = id;
      state.assets.set(id, a);
      void old;
      back++;
    } catch (_) {}
  }
  return back;
}

function autosaveSnapshot() {
  return {
    v: 1,
    savedAt: Date.now(),
    t: state.t,
    scene: state.scene.toJSON(),
    media: {
      video: state.media.videoMeta || null,
      audio: state.media.audioMeta || null,
    },
  };
}

/** 存一次。force=true 时不比对内容，直接写（关页面的时候用）。 */
function autosaveNow(force) {
  if (NO_PERSIST) return false;
  let json;
  try { json = JSON.stringify(autosaveSnapshot()); } catch (_) { return false; }
  if (!force && json === autosaveLast) return false;
  try {
    localStorage.setItem(AUTOSAVE_KEY, json);
    autosaveLast = json;
    return true;
  } catch (err) {
    // 配额炸了（字幕/图层特别多的时候会）。别反复弹，提示一次就够。
    if (!autosaveWarned) {
      autosaveWarned = true;
      showRestoreBar('自动保存失败：工程太大，浏览器存不下了。请用 <b>保存工程</b> 存成文件。');
    }
    return false;
  }
}

/** 把一份工程接管进来（恢复 / 新建 共用） */
function adoptScene(json) {
  state.scene = Scene.fromJSON(json);
  state.selection = null;
  state.selected = new Set();
  state.clipSel = null;
  rightTab = 'scene';
  resetLayerIndex();
  syncTransitionLayers();
  resize(); drawTimeline(); renderRight(); updateBeatInfo();
  if (state.scene.clips.length) restoreAssets();     // 片段要配上素材才有画面
  historyReset();                                    // 换工程了，撤销栈重新起算
}

function clearLocalProject() {
  try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) {}
  autosaveLast = '';
  idbDel('video').catch(() => {});
  idbDel('audio').catch(() => {});
}

/** 新建空白工程 */
function newProject(silent) {
  if (!silent && !confirm('新建空白工程？当前工程会被清空。\n（之前用「保存工程」存出来的文件不受影响）')) return;
  state.scene = new Scene({ width: 1920, height: 1080, fps: 24, duration: 10, transparent: true });
  for (const a of state.assets.values()) { try { URL.revokeObjectURL(a.url); } catch (_) {} }
  state.assets.clear();
  state.clipSel = null;
  state.media = { video: null, audio: null, videoName: '', audioName: '', videoFile: null, videoMeta: null, audioMeta: null };
  state.analysis = null;
  state.selection = null;
  state.selected = new Set();
  rightTab = 'scene';
  state.t = 0;
  resetLayerIndex();
  resize(); drawTimeline(); renderRight(); updateBeatInfo(); applyAudio();
  autosaveNow(true);
}

/** 开页面时把上次的工程接回来 */
function restoreAutosave() {
  if (NO_PERSIST || DEEP_LINK) return;
  let raw = null;
  try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (_) { return; }
  if (!raw) return;
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { return; }
  if (!data || !data.scene || !Array.isArray(data.scene.layers)) return;
  try { adoptScene(data.scene); } catch (err) {
    console.warn('[autosave] 恢复失败，忽略这份存档', err);
    return;
  }
  autosaveLast = raw;                    // 刚恢复的内容不用再原样写回去
  if (typeof data.t === 'number') setTime(clamp(data.t, 0, state.scene.duration));

  const sc = state.scene;
  const at = new Date(data.savedAt || Date.now());
  const hh = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0');
  const summary = () => {
    const s = state.scene;
    return `已 <b>恢复上次的工程</b>（${hh} 自动保存 · ${s.layers.length} 个图层`
      + (s.captions.length ? ' · ' + s.captions.length + ' 条字幕' : '')
      + (s.clips.length ? ' · ' + s.clips.length + ' 个片段' : '') + '）';
  };
  const missing = (m) => `素材「${escapeHtml(m.name)}」没有一起存下来，需要重新拖进来一次`;
  const meta = data.media || {};

  // 素材是异步读回来的，接上之前先把话说清楚
  const want = [];
  if (meta.video && meta.video.name) want.push(['video', meta.video]);
  if (meta.audio && meta.audio.name) want.push(['audio', meta.audio]);
  for (const [kind, m] of want) {
    idbGet(kind).then((blob) => {
      if (!blob) { showRestoreBar(summary() + '<br>' + missing(m)); return; }
      const f = new File([blob], m.name, { type: m.type || '' });
      // noClip：工程里已经存了片段表，这里只是把"当前素材"接回来当兜底
      if (kind === 'video') loadVideoFile(f, { keepDuration: true, noClip: true });
      else loadAudioFile(f, { analyze: false, noClip: true });
      restoreAssets();
    }).catch(() => showRestoreBar(summary() + '<br>' + missing(m)));
  }
  if (!want.length && state.scene.clips.length) restoreAssets();

  if (sc.layers.length || sc.captions.length) {
    showRestoreBar(summary());
  }
}

// 改了东西就存：定时比对一次内容，变了才写盘（比在每个改参数的地方插钩子可靠）
if (!NO_PERSIST) {
  setInterval(() => autosaveNow(false), 1200);
  window.addEventListener('beforeunload', () => autosaveNow(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosaveNow(true);
  });
}
// 撤销：比自动保存勤一点，改完差不多半秒就能撤
setInterval(historyTick, 350);

// ---------------------------------------------------------------- 初始化
// 本地服务是不是旧版本？（旧版本没有新加的接口，会莫名其妙 404）
{
  const NEED = 6;   // 和 tools/serve.mjs 的 APP_VERSION 保持一致
  fetch('/api/ping', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || j.app !== 'motionkit-studio') return;          // 没后端（单文件版）就不提示
      if (typeof j.v === 'number' && j.v < NEED) {
        $('staleText').innerHTML = '本地服务是<b>旧版本</b>（没有新功能需要的接口）。'
          + '关掉那个黑窗口，重新双击 <b>启动工作室.bat</b>，再刷新本页就好。';
        $('staleBar').classList.remove('hidden');
      }
    })
    .catch(() => {});
  const sb = $('btnStaleOk');
  if (sb) sb.addEventListener('click', () => $('staleBar').classList.add('hidden'));
}

buildEditOverlay();
restoreAutosave();          // 先把上次的工程接回来，后面的初始化都在它上面跑
buildTimelineTools();       // 时间轴上方那排图标（撤销 / 切开 / 复制 / 删 / 吸附）
historyReset();             // 撤销栈从"刚打开的这一版"起算
buildTemplateList();
renderRight();
updateBeatInfo();
applyAudio();
loadPresetList();
resize();
rafId = requestAnimationFrame(loop);

// ---------------------------------------------------------------- AI 助手
// 面板只负责"上传素材 + 收集几个选择 + 收进度"，分析和规划都在本地服务里。
// 同步面板（提交 / 上传 GitHub / 拉取 / 打包）也走本地服务，逻辑在 sync-panel.js
initSyncPanel();

initAgentPanel({
  getFile: () => state.media.videoFile || null,
  getVideoName: () => state.media.videoName || '',
  getSize: () => ({ w: state.scene.width, h: state.scene.height, fps: state.scene.fps }),
  getDuration: () => state.scene.duration,
  loadScene(json) {
    const media = state.media;
    state.scene = Scene.fromJSON(json);
    state.media = media;
    state.selection = null;
    state.selected = new Set();
    rightTab = 'scene';
    resetLayerIndex();
    if (!state.media.video) state.media.videoName = state.media.videoName || '';
    resize(); drawTimeline(); renderRight(); updateBeatInfo();
    setTime(0);
    historyReset();
  },
});

// ---------------------------------------------------------------- 对外 API（无头渲染用）
window.MotionKit = {
  state, off, Scene, Layer, Caption, BeatMap,
  templates: listTemplates, registerAll,
  renderAt, setScene(json) {
    state.scene = Scene.fromJSON(json);
    state.selection = null;
    state.selected = new Set();
    state.clipSel = null;
    rightTab = 'scene';
    resetLayerIndex();
    syncTransitionLayers();
    resize(); drawTimeline(); renderRight(); updateBeatInfo();
    if (state.scene.clips.length) restoreAssets();
    return state.scene;
  },
  blit,
  getScene() { return state.scene.toJSON(); },
  setTime, play, pause, togglePlay,
  addLayer(spec) { const L = state.scene.add(spec); drawTimeline(); return L; },
    // 从模板库加一层（at 是归一化落点，省略就按模板默认位置）
    addTemplate(id, at) {
      const t = listTemplates().find((x) => x.id === id);
      return t ? addLayerFromTemplate(t, at || null) : null;
    },
    pickTemplate: (id) => { const t = listTemplates().find((x) => x.id === id); pickTemplate(t || null); },
  clearLayers() { state.scene.layers = []; drawTimeline(); },
  setCaptions(list) { state.scene.captions = list.map((c) => new Caption(c)); drawTimeline(); },
    // 预览直接操控相关的接口（自检 / 自动化用，也可从外部脚本驱动）
    selectLayer,
    selected: () => state.selection,
    mediaInfo: () => ({
      video: state.media.videoName || '', videoDur: state.media.videoDur || 0,
      audio: state.media.audioName || '', audioDur: state.media.audioDur || 0,
      sceneDur: state.scene.duration, auto: state.durationAuto, peaks: state.media.peaks ? state.media.peaks.length : 0,
    }),
    followMedia: (on) => { state.durationAuto = on !== false; return applyAutoDuration(true); },
    tlScroll: () => ({ y: state.tlScroll || 0, max: tlScrollMax(), rowH: ROW_H, gap: ROW_GAP, top: TRACK_TOP,
                       visible: Math.max(0, (tl.clientHeight - ROW_H - 8) - TRACK_TOP) }),
    tlRows: () => ({ count: tlRows().count, packed: state.tlPack !== false, layers: state.scene.layers.length }),
    rowOf: (id) => { const r = tlRows().place.get(id); return r === undefined ? -1 : r; },
    beatFx: {
      list: (tpl) => beatFxList(tpl).length,
      apply: (tpl, o) => beatFxApply(tpl, o || {}),
      relay: (tpl, n) => beatFxRelay(tpl, n),
      retime: (tpl, n) => beatFxRetime(tpl, n),
      clear: (tpl) => beatFxClear(tpl),
      base: (tpl) => beatFxBase(tpl),
    },
    rightTab: (t) => { if (t) setRightTab(t); return rightTab; },
    pickAt: (nx, ny) => pickLayerAt(nx, ny).map((l) => l.id),
    layerBox: (i) => { const L = layerArgOf(i); return L ? layerBoxFor(L) : null; },
    layerBaseBox: (i) => { const L = layerArgOf(i); return L ? layerBaseBox(L) : null; },
    textParamsOf: (i) => {
      const L = layerArgOf(i);
      return L ? textParamsOf(listTemplates().find((x) => x.id === L.template)).map((p) => p.key) : [];
    },
    openTextEditor: (i) => {
      const L = layerArgOf(i);
      if (!L) return null;
      selectLayer(L.id); openTextEditor(L);
      return L.id;
    },
    setTransform(i, tr) {
      const L = layerArgOf(i);
      if (!L) return null;
      L.transform = tr ? Object.assign({ x: 0, y: 0, scale: 1, rot: 0, px: 0.5, py: 0.5 }, tr) : null;
      markIndexDirty(); renderAt(state.t); blit();
      return L.transform;
    },
  // 导出：录一段视频（自检里会用，用来确认 MP4 这条线真的能出文件）
  renderVideoBlob: (want, includeMedia, opts) => renderVideoBlob(want, includeMedia, opts),
  loadAudioFile: (file) => loadAudioFile(file, { analyze: false }),
  addImageFile: (file) => loadVideoFile(file, { noClip: true }).then((a) => addClip(a)),
  loadVideoAsClip: (file) => loadVideoFile(file),
  splitAt: (t) => splitClipAt(t),
  undo: () => historyStep(-1),
  redo: () => historyStep(1),
  historyInfo: () => ({ at: history.at, len: history.list.length }),
  clipRows: () => [...clipRowMap.entries()].map(([id, g]) => Object.assign({ id }, g)),
  transMarks: () => [...transMarkMap.entries()].map(([id, g]) => Object.assign({ id }, g)),
  transLayers: () => state.scene.layers.filter((L) => L.group === 'clip-trans')
    .map((L) => ({ template: L.template, start: L.start, end: L.end, clipId: L.meta && L.meta.clipId })),
  tlView: () => tlView(),
  tlZoomFit: () => tlZoomFit(),
  clipById: (id) => clipById(id),
  assetState: (id) => {
    const a = state.assets.get(id);
    if (!a || !a.el) return null;
    return { t: a.el.currentTime, rate: a.el.playbackRate, vol: a.el.volume, paused: a.el.paused, kind: a.kind };
  },
  clipGain: (id, t) => { const c = clipById(id); return c ? clipGainAt(c, t) : null; },
  fadeWindow: (id) => { const c = clipById(id); return c ? fadeWindow(c) : null; },
  videoSupport: () => ({ mp4: pickVideoMime('mp4'), webm: pickVideoMime('webm') }),
  registerTemplate,
  version: '1.0.0',
};

// 无头渲染模式：?render=1 时隐藏 UI 相关干扰
if (new URLSearchParams(location.search).get('render') === '1') {
  pause();
  state.t = 0;
}

// 深链，截图/自检用：
//   studio/index.html?preset=slopcore.json&layers=1   ← 载入预设并打开图层索引
{
  const qs = new URLSearchParams(location.search);
  if (qs.get('preset')) {
    applyPreset(qs.get('preset')).catch(() => {}).then(() => {
      if (qs.get('layers') === '1') setIndexTab('layers');
    });
  } else if (qs.get('layers') === '1') {
    setIndexTab('layers');
  }
}
