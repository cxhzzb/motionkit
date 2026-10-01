// ============================================================================
// MotionKit 工作室
// 预览 / 参数 / 卡点 / 字幕 / 导出，全部跑在浏览器里，零依赖。
// 同时对外暴露 window.MotionKit，供 tools/render.mjs 无头调用。
// ============================================================================

import {
  Scene, Layer, Caption, BeatMap, renderFrame, makeCanvas, timecode,
  clamp, lerp, Rng, registerTemplate,
} from '../engine/core.js';
import * as Draw from '../engine/draw.js';
import * as FX from '../engine/fx.js';
import { runFx } from '../engine/fx.js';
import { analyzeAudioFile, analyzeBuffer, envAt, onsets } from '../engine/audio.js';
import { parseSubtitles, toSRT, splitForKinetic, estimateWordTimings } from '../engine/srt.js';
import { makeZip, createZipWriter, downloadBlob, canvasToPngBytes } from '../engine/zip.js';
import { registerAll, listTemplates, CATEGORIES, byCategory } from '../templates/index.js';
import { initAgentPanel } from './agent-panel.js';
import { initSyncPanel } from './sync-panel.js';

registerAll();

// ---------------------------------------------------------------- 状态
const state = {
  scene: new Scene({ width: 1920, height: 1080, fps: 24, duration: 10, transparent: true }),
  selection: null,          // 选中的图层 id
  playing: false,
  t: 0,
  lastFrameTs: 0,
    media: {
      video: null, audio: null, videoName: '', audioName: '',
      videoFile: null, videoMeta: null, audioMeta: null,   // 后三个给「自动保存」用
      videoDur: 0, audioDur: 0, peaks: null,               // 素材时长 + 音频波形（时间轴那两条轨用）
    },
  analysis: null,
  layerSeq: 0,
  muted: false,          // 预览总静音（走带栏那个喇叭）
    tplPick: null,         // 模板库里点选中的模板（只是选中，拖着往画面里放才会加图层）
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
  const v = state.media.video;
  if (!v) return;
  if (v.tagName === 'IMG') {
    drawCover(ctx, v, sc.width, sc.height);
    return;
  }
  if (v.readyState < 2) return;
  drawCover(ctx, v, sc.width, sc.height);
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
  $('dropHint').classList.toggle('hidden', !!state.media.video);
  layoutEditOverlay();
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
    if (clockEl && clockEl.tagName === 'VIDEO' || clockEl && clockEl.tagName === 'AUDIO') {
      state.t = clockEl.currentTime;
    } else {
      state.t += dt;
    }
    if (state.t >= dur) {
      if ($('chkLoop').checked) { setTime(0); state.t = 0; }
      else { state.t = dur; pause(); }
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
  for (const el of [state.media.video, state.media.audio]) {
    if (el && el.tagName !== 'IMG') { try { el.currentTime = v; } catch (_) {} }
  }
  if (!state.playing) { renderAt(v); blit(); updateTransport(); drawTimeline(); }
}
function play() {
  state.playing = true;
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

function drawTimeline() {
  if (!tl.clientWidth) return;
  const { w, h } = tlGeom();
  const s = state.scene;
  const x0 = 8, x1 = w - 8;
  const sx = (t) => x0 + (t / Math.max(0.001, s.duration)) * (x1 - x0);
  const bg = '#121317';
  tlCtx.clearRect(0, 0, w, h);
  tlCtx.fillStyle = bg; tlCtx.fillRect(0, 0, w, h);

  // 标尺
  tlCtx.fillStyle = '#0e0f12';
  tlCtx.fillRect(0, 0, w, RULER_H);
  const step = niceStep(s.duration, (x1 - x0) / 90);
  tlCtx.strokeStyle = '#2a2d34'; tlCtx.lineWidth = 1;
  tlCtx.font = '10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  tlCtx.textBaseline = 'middle';
  for (let t = 0; t <= s.duration + 1e-6; t += step) {
    const x = sx(t);
    tlCtx.beginPath(); tlCtx.moveTo(x + 0.5, 0); tlCtx.lineTo(x + 0.5, h); tlCtx.stroke();
    tlCtx.fillStyle = '#5c626d';
    tlCtx.fillText(fmtShort(t), x + 4, RULER_H / 2);
  }

  // 拍点
  const bm = s.beat;
  const beats = bm.hitsIn(0, s.duration, 1);
  const strong = new Set(bm.hitsIn(0, s.duration, 0.25).filter((_, i) => i % 4 === 0).map((v) => +v.toFixed(4)));
  for (const b of beats) {
    const x = sx(b);
    const isStrong = strong.has(+b.toFixed(4));
    tlCtx.fillStyle = isStrong ? 'rgba(0,229,255,0.55)' : 'rgba(255,255,255,0.14)';
    tlCtx.fillRect(x - 0.5, RULER_H, 1, h - RULER_H);
  }

  // 图层
  // ---- 媒体轨：视频 / 音频 ----
  const monoS = getComputedStyle(document.body).getPropertyValue('--mono');
  const vidY = MEDIA_TOP;
  const audY = MEDIA_TOP + VID_H + 3;
  const mv = state.media.video;
  const ma = state.media.audio;

  // 视频轨
  tlCtx.fillStyle = 'rgba(0,229,255,0.055)';
  tlCtx.fillRect(x0, vidY, x1 - x0, VID_H);
  if (mv) {
    const vd = Math.max(0.1, state.media.videoDur || s.duration);
    const bx = sx(0), bw = Math.max(6, sx(Math.min(vd, s.duration)) - bx);
    roundRectPath(tlCtx, bx, vidY + 3, bw, VID_H - 6, 3);
    tlCtx.fillStyle = 'rgba(0,229,255,0.28)'; tlCtx.fill();
    tlCtx.strokeStyle = 'rgba(0,229,255,0.75)'; tlCtx.lineWidth = 1; tlCtx.stroke();
    // 素材比工程短的话，后面那段空出来一眼就看得见
    if (vd < s.duration - 0.02) {
      tlCtx.fillStyle = 'rgba(255,255,255,0.05)';
      tlCtx.fillRect(sx(vd), vidY + 3, Math.max(0, x1 - sx(vd)), VID_H - 6);
    }
    tlCtx.save();
    tlCtx.beginPath(); tlCtx.rect(bx + 6, vidY, Math.max(10, bw - 12), VID_H); tlCtx.clip();
    tlCtx.fillStyle = '#cdf3ff';
    tlCtx.font = '600 11px ' + getComputedStyle(document.body).getPropertyValue('--sans');
    tlCtx.fillText(`视频  ${state.media.videoName || ''}  ${vd.toFixed(2)}s`, bx + 7, vidY + VID_H / 2 + 0.5);
    tlCtx.restore();
  } else {
    tlCtx.fillStyle = '#4a505b';
    tlCtx.font = '11px ' + monoS;
    tlCtx.fillText('视频轨 · 未载入（把视频/图片拖进画面区）', x0 + 8, vidY + VID_H / 2);
  }

  // 音频轨（带波形）
  tlCtx.fillStyle = 'rgba(255,204,0,0.05)';
  tlCtx.fillRect(x0, audY, x1 - x0, AUD_H);
  if (ma) {
    const ad = Math.max(0.1, state.media.audioDur || s.duration);
    const midY = audY + AUD_H / 2;
    const pk = state.media.peaks;
    if (pk && pk.length) {
      const nb = pk.length;
      const bw2 = (x1 - x0) / nb;
      tlCtx.fillStyle = 'rgba(255,204,0,0.72)';
      for (let i = 0; i < nb; i++) {
        const x = x0 + i * bw2;
        if (x > x1) break;
        const hh = Math.max(0.8, pk[i] * (AUD_H - 10) * 0.5);
        tlCtx.fillRect(x, midY - hh, Math.max(1, bw2 * 0.85), hh * 2);
      }
    } else {
      tlCtx.fillStyle = 'rgba(255,204,0,0.22)';
      tlCtx.fillRect(x0, midY - 1, Math.min(x1 - x0, Math.max(4, sx(ad) - x0)), 2);
    }
    // 音频比工程短也标一下
    if (ad < s.duration - 0.02) {
      tlCtx.fillStyle = 'rgba(255,255,255,0.05)';
      tlCtx.fillRect(sx(ad), audY, Math.max(0, x1 - sx(ad)), AUD_H);
    }
    tlCtx.fillStyle = '#ffe9a8';
    tlCtx.font = '600 11px ' + getComputedStyle(document.body).getPropertyValue('--sans');
    tlCtx.fillText(`音频  ${state.media.audioName || ''}  ${ad.toFixed(2)}s`, x0 + 8, audY + 11);
  } else {
    tlCtx.fillStyle = '#4a505b';
    tlCtx.font = '11px ' + monoS;
    tlCtx.fillText('音频轨 · 未载入（拖一首歌进来会自动分析卡点）', x0 + 8, audY + AUD_H / 2);
  }

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
    const isSel = L.id === state.selection;
    const hit = !find || (tpl ? tpl.name : L.template).toLowerCase().includes(find)
      || String(L.template).toLowerCase().includes(find) || String(L.name || '').toLowerCase().includes(find);
    tlCtx.fillStyle = !L.enabled ? '#2a2d34' : isSel ? '#ff4b1f' : 'rgba(255,75,31,0.55)';
    tlCtx.globalAlpha = (!find || hit) ? 1 : 0.22;     // 搜索时，没中的层淡下去
    roundRectPath(tlCtx, bx, y, bw, ROW_H, 3); tlCtx.fill();
    tlCtx.globalAlpha = 1;
    tlCtx.fillStyle = isSel ? '#1a0a04' : '#e9ecf1';
    tlCtx.font = '600 11px ' + getComputedStyle(document.body).getPropertyValue('--sans');
    const nm = (tpl ? tpl.name : L.template) + '  ' + L.start.toFixed(2) + 's→' + L.end.toFixed(2) + 's';
    tlCtx.save(); tlCtx.beginPath(); tlCtx.rect(bx + 6, y, bw - 12, ROW_H); tlCtx.clip();
    tlCtx.fillText(nm, bx + 7, y + ROW_H / 2 + 0.5);
    tlCtx.restore();
    if (isSel) {
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
function tlTimeAt(clientX) {
  const r = tl.getBoundingClientRect();
  const x0 = 8, x1 = r.width - 8;
  const p = clamp((clientX - r.left - x0) / (x1 - x0), 0, 1);
  let t = p * state.scene.duration;
  if ($('chkSnap').checked && state.scene.beat) {
    const snapped = state.scene.beat.snap(t, 4, 0.12);
    t = snapped;
  }
  return t;
}

tl.addEventListener('pointerdown', (e) => {
  const r = tl.getBoundingClientRect();
  const y = e.clientY - r.top;
  // 命中图层？
  for (const [id, g] of rowMap) {
    if (y >= g.y && y <= g.y + ROW_H && e.clientX - r.left >= g.x - 2 && e.clientX - r.left <= g.x + g.w + 2) {
      const L = state.scene.layers.find((x) => x.id === id);
      const edge = (e.clientX - r.left) - g.x;
      if (edge < 6) drag = { id, mode: 'resize-l', orig: L.start };
      else if (edge > g.w - 6) drag = { id, mode: 'resize-r', orig: L.end };
      else drag = { id, mode: 'move', grab: tlTimeAt(e.clientX) - L.start, origStart: L.start, origEnd: L.end };
      selectLayer(id);
      tl.setPointerCapture(e.pointerId);
      return;
    }
  }
  // 否则设置播放头
  scrubbing = true;
  setTime(tlTimeAt(e.clientX));
  tl.setPointerCapture(e.pointerId);
});

tl.addEventListener('pointermove', (e) => {
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

const endDrag = () => { drag = null; scrubbing = false; };
tl.addEventListener('pointerup', endDrag);
tl.addEventListener('pointercancel', endDrag);
// 滚轮：上下翻图层（层数多的时候时间轴装不下）
tl.addEventListener('wheel', (e) => {
  const dy = e.deltaY > 0 ? Math.max(14, Math.abs(e.deltaY) * 0.6) : -Math.max(14, Math.abs(e.deltaY) * 0.6);
  if (tlScrollBy(dy)) e.preventDefault();
}, { passive: false });

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
    const h = document.createElement('div');
    h.className = 'tpl-cat';
    h.textContent = CATEGORIES[cat] || cat;
    box.appendChild(h);
    for (const t of shown) {
      const d = document.createElement('div');
      d.className = 'tpl' + (state.tplPick === t.id ? ' sel' : '');
      d.dataset.tid = t.id;
      d.draggable = true;
      d.innerHTML = `<b>${t.name}</b><span>${t.hint || ''}</span><div class="tag">${t.category} · ${t.id}</div>`;
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
const RIGHT_TABS = ['layer', 'scene', 'beat', 'subs', 'fx'];
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
    scene: '工程设置 · 画面 / 文件',
    beat: '卡点',
    subs: '字幕',
    fx: '特效（后期栈）',
  }[rightTab] || '工程设置';

  if (rightTab === 'layer') rightPanelLayer(body, L);
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
    const g0 = group('图层');
    g0.appendChild(field('模板', () => {
      const sel = document.createElement('select');
      for (const tt of listTemplates()) {
        const o = document.createElement('option'); o.value = tt.id; o.textContent = tt.name;
        if (tt.id === L.template) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => { L.template = sel.value; renderRight(); drawTimeline(); });
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
    g.appendChild(colorField('背景色(空=透明)', state.scene.bg || '', (v) => { state.scene.bg = v || null; }));
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
    ba.appendChild(btn('一键卡点铺满(闪白)', () => autoBeatLayers('flash-cut', 1)));
    ba.appendChild(btn('每 2 拍铺一个推近', () => autoBeatLayers('zoom-punch', 2)));
    gb.appendChild(ba);
    body.appendChild(gb);
  }
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
}

/** 特效页：整段画面的后期栈（「画面一直闪」就在这儿关） */
function rightPanelFx(body) {
  body.appendChild(buildFxGroup());
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
function colorField(labelText, value, onChange) {
  return field(labelText, () => {
    const holder = document.createElement('div');
    holder.style.cssText = 'display:flex;gap:6px;flex:1 1 auto;min-width:0';
    const c = document.createElement('input'); c.type = 'color';
    c.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#ffffff';
    const t = document.createElement('input'); t.type = 'text'; t.value = value || ''; t.placeholder = '空 = 透明';
    c.addEventListener('input', () => { t.value = c.value; onChange(c.value); renderAt(state.t); blit(); });
    t.addEventListener('change', () => { onChange(t.value.trim()); renderAt(state.t); blit(); });
    holder.appendChild(c); holder.appendChild(t);
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
    case 'color': return colorField(p.label, get(), (v) => { bag[p.key] = v; onChange(); });
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
function autoBeatLayers(templateId, everyN = 1) {
  const s = state.scene;
  const tpl = listTemplates().find((t) => t.id === templateId);
  const dur = Math.max(0.12, s.beat.beatDur * 0.5);
  const beats = s.beat.hitsIn(0, s.duration, 1).filter((_, i) => i % everyN === 0);
  for (const b of beats) {
    s.add({ template: templateId, start: b, end: Math.min(s.duration, b + dur), seed: `${templateId}-${++state.layerSeq}`, name: tpl ? tpl.name : templateId });
  }
  drawTimeline();
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
  const d = Math.max(state.media.videoDur || 0, state.media.audioDur || 0);
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

function loadVideoFile(file, opts = {}) {
  const url = URL.createObjectURL(file);
  state.media.videoFile = file;          // AI 助手要把原始文件上传给本地服务
  state.media.videoMeta = { name: file.name, type: file.type, size: file.size };
  persistMedia('video', file);           // 刷新后还能接回来
  if (/^image\//.test(file.type)) {
    const img = new Image();
    img.onload = () => {
      state.media.video = img; state.media.videoName = file.name;
      state.media.videoDur = 0;            // 静态图没有时长，时长就看音频的
      $('dropHint').classList.add('hidden');
      renderAt(state.t); blit();
      applyAutoDuration(!!opts.keepDuration);   // 恢复工程时不弹提示
      renderRight();
    };
    img.src = url;
    return;
  }
  const v = document.createElement('video');
  // 别默认静音：导入的视频本来就该能听见。如果已经载入了音乐，
  // applyAudio() 会把视频原声静掉，避免两轨撞车。
  v.src = url; v.muted = !!state.media.audio; v.playsInline = true; v.loop = false; v.preload = 'auto';
  v.addEventListener('loadeddata', () => {
    state.media.video = v; state.media.videoName = file.name;
      state.media.videoDur = Number.isFinite(v.duration) ? v.duration : 0;
    applyAudio();
    $('dropHint').classList.add('hidden');
      // 恢复上次工程时视频是"迟到"的，别让它把已存的时长改掉
      if (!opts.keepDuration) applyAutoDuration(!opts.quiet);
    resize(); drawTimeline(); renderRight();
  });
  v.load();
}

async function loadAudioFile(file, opts = {}) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('audio');
  a.src = url; a.preload = 'auto';
  state.media.audio = a; state.media.audioName = file.name;
  state.media.audioMeta = { name: file.name, type: file.type, size: file.size };
  persistMedia('audio', file);
  a.muted = state.muted;
  applyAudio();          // 载入音乐后视频原声自动让位
  if (opts.analyze === false) return;   // 恢复上次工程：拍点图已经存在工程里了，别再分析一遍
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
  const v = state.media.video;
  return new Promise((res) => {
    if (!v || v.tagName === 'IMG' || v.readyState < 1) { res(); return; }
    if (Math.abs(v.currentTime - t) < 1 / (state.scene.fps * 2) && v.readyState >= 2) { res(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; v.removeEventListener('seeked', finish); res(); };
    v.addEventListener('seeked', finish);
    try { v.currentTime = t; } catch (_) {}
    setTimeout(finish, 500);
  });
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
  const savedVideo = state.media.video;
  if (!includeMedia) state.media.video = null;
  const c = renderAt(t);
  state.media.video = savedVideo;
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

async function exportWebm(includeMedia) {
  const s = state.scene;
  const fps = s.fps;
  const rec = document.createElement('canvas');
  rec.width = s.width; rec.height = s.height;
  const rctx = rec.getContext('2d');
  const stream = rec.captureStream(0);
  const track = stream.getVideoTracks()[0];
  let mime = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8';
  const chunks = [];
  const mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 40_000_000 });
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { mr.onstop = res; });
  mr.start();
  const total = await frameCount();
  for (let i = 0; i < total; i++) {
    const c = await renderFrameForExport(i, includeMedia);
    rctx.clearRect(0, 0, s.width, s.height);
    rctx.drawImage(c, 0, 0);
    if (track.requestFrame) track.requestFrame();
    showBusy(`录制 WebM ${i + 1}/${total}`, (i + 1) / total);
    await new Promise((r) => setTimeout(r, Math.max(1, 1000 / fps)));
  }
  mr.stop();
  await done;
  hideBusy();
  downloadBlob(new Blob(chunks, { type: mime }), `motionkit_${Date.now()}.webm`);
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
  const sc = Scene.fromJSON(data);
  const media = state.media;
  state.scene = sc;
  state.media = media;
  state.selection = null;
    rightTab = 'scene';
  resetLayerIndex();
  resize(); drawTimeline(); renderRight(); updateBeatInfo();
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
  panel: '#ffcc00', design: '#ff7ab6', rock: '#e01818', transition: '#b98bff', other: '#8b929e',
};

const CAT_LABEL = {
  overlay: '叠加层 / HUD', typography: '动态排版', caption: '字幕',
  panel: '面板卡片', design: '设计排版', rock: '摇滚 / 海报', transition: '转场 / 冲击', other: '其它',
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

// 这里导出的都是"画面层"，没有声音这一轨；把这句话写在面板上，省得误会
const soundNote = document.createElement('div');
soundNote.className = 'mini';
soundNote.style.cssText = 'margin-top:8px;color:#8b929e;line-height:1.7;font-size:11px';
soundNote.innerHTML =
  '上面这些导出的都是<b>画面层，不含声音</b>（连底片一起渲进去也不含）。' +
  '要带声音的成片：① 用 AI 助手跑 <code>--render</code>，它会输出带原声的 <code>final.mp4</code>；' +
  '② 或者用 <code>tools/encode.py --overlay 原片.mp4</code> 把叠加层烧到原片上，声音跟着原片走。';
optRow.after(soundNote);

dlg.addEventListener('click', async (e) => {
  const b = e.target.closest('.ex');
  if (!b) return;
  const kind = b.dataset.ex;
  const includeMedia = $('chkIncludeMedia').checked;
  dlg.close();
  try {
    if (kind === 'png') await exportPngSequence(includeMedia);
    else if (kind === 'webm') await exportWebm(includeMedia);
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
    const L = state.scene.layers.find((x) => x.id === state.selection);
    if (L) {
      state.scene.layers = state.scene.layers.filter((x) => x !== L);
        selectLayer(null);
      markIndexDirty();
    }
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
      state.scene.layers = state.scene.layers.filter((x) => x !== L);
        selectLayer(null); markIndexDirty();
      renderAt(state.t); blit();
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
    if (!cands.length) { selectLayer(null); return; }

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
    if (state.selection !== hit.id) selectLayer(hit.id);
    startMove(e, hit);
  });

  editLayerEl.addEventListener('pointermove', (e) => {
    if (pdrag) return;                       // 拖拽中的移动统一走 window，指针甩出画布也不断线
    const p = pointerNorm(e);
    editLayerEl.style.cursor = pickLayerAt(p.x, p.y).length ? 'move' : 'default';
  });
  const endDrag = () => {
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
  window.addEventListener('pointermove', (e) => { if (pdrag) onDragMove(e); });
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

function selectLayer(id) {
  state.selection = id;
  if (id != null) rightTab = 'layer';     // 选了图层就自动切到「图层」页
  if (elText) closeTextEditor();
  if (id != null) scrollLayerIntoView(id); // 让它出现在时间轴可见区里
  renderRight();
  drawTimeline();
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
  rightTab = 'scene';
  resetLayerIndex();
  resize(); drawTimeline(); renderRight(); updateBeatInfo();
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
  state.media = { video: null, audio: null, videoName: '', audioName: '', videoFile: null, videoMeta: null, audioMeta: null };
  state.analysis = null;
  state.selection = null;
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
      + (s.captions.length ? ' · ' + s.captions.length + ' 条字幕' : '') + '）';
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
      if (kind === 'video') loadVideoFile(f, { keepDuration: true });
      else loadAudioFile(f, { analyze: false });
    }).catch(() => showRestoreBar(summary() + '<br>' + missing(m)));
  }

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
    rightTab = 'scene';
    resetLayerIndex();
    if (!state.media.video) state.media.videoName = state.media.videoName || '';
    resize(); drawTimeline(); renderRight(); updateBeatInfo();
    setTime(0);
  },
});

// ---------------------------------------------------------------- 对外 API（无头渲染用）
window.MotionKit = {
  state, off, Scene, Layer, Caption, BeatMap,
  templates: listTemplates, registerAll,
  renderAt, setScene(json) {
    state.scene = Scene.fromJSON(json);
    state.selection = null;
    rightTab = 'scene';
    resetLayerIndex();
    resize(); drawTimeline(); renderRight(); updateBeatInfo();
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
