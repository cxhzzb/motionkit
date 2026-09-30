// ============================================================================
// 字幕解析 / 导出
// 支持 SRT、WebVTT、以及 ASS 的基本对话行。目标是拿到带时间轴的纯文本。
// 也提供从音频能量自动"猜词级时间"的辅助（粗对齐）。
// ============================================================================

const toSec = (h, m, s, ms) => (+h) * 3600 + (+m) * 60 + (+s) + (+String(ms).padEnd(3, '0').slice(0, 3)) / 1000;

function parseStamps(line) {
  // 00:00:01,000 --> 00:00:04,000   /   00:00:01.000 --> 00:00:04.000
  const m = line.match(/(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return { start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]) };
}

/** 解析 SRT / VTT */
export function parseSRT(src) {
  const text = String(src).replace(/\r/g, '');
  const blocks = text.split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let idx = 0;
    if (/^\d+$/.test(lines[0].trim())) idx = 1;
    const stamp = parseStamps(lines[idx] || '');
    if (!stamp) continue;
    const bodyLines = lines.slice(idx + 1).join('\n')
      .replace(/<\/?[^>]+>/g, '')      // 去 VTT 内联标签
      .replace(/\{[^}]*\}/g, '')       // 去 ASS 覆盖码
      .trim();
    if (!bodyLines) continue;
    out.push({ ...stamp, text: bodyLines });
  }
  return out;
}

/** 解析 ASS/SSA 的 Dialogue 行 */
export function parseASS(src) {
  const out = [];
  for (const line of String(src).replace(/\r/g, '').split('\n')) {
    if (!/^Dialogue:/i.test(line)) continue;
    const parts = line.replace(/^Dialogue:\s*/i, '').split(',');
    if (parts.length < 10) continue;
    const st = parts[1].trim(), et = parts[2].trim();
    const body = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').trim();
    const p = (s) => {
      const m = s.match(/(\d+):(\d{2}):(\d{2})[.:](\d{1,2})/);
      return m ? toSec(m[1], m[2], m[3], String(m[4]).padEnd(2, '0') + '0') : null;
    };
    const a = p(st), b = p(et);
    if (a === null || b === null || !body) continue;
    out.push({ start: a, end: b, text: body });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** 自动判断格式 */
export function parseSubtitles(src) {
  const t = String(src);
  if (/^WEBVTT/m.test(t) || /\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->/.test(t)) return parseSRT(t);
  if (/\[Script Info\]|^Dialogue:/im.test(t)) return parseASS(t);
  return parseSRT(t);
}

/** 导出 SRT */
export function toSRT(items) {
  const ts = (s) => {
    const ms = Math.round((s % 1) * 1000);
    const total = Math.floor(s);
    const hh = String(Math.floor(total / 3600)).padStart(2, '0');
    const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const ss = String(total % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss},${String(ms).padStart(3, '0')}`;
  };
  return items.map((it, i) => `${i + 1}\n${ts(it.start)} --> ${ts(it.end)}\n${it.text}\n`).join('\n');
}

/** 按标点/长度切分成长度均衡的短句，适合做"逐句弹字" */
export function splitForKinetic(items, { maxChars = 14, minDur = 0.4 } = {}) {
  const out = [];
  for (const it of items) {
    const chunks = String(it.text)
      .split(/(?<=[，。！？；：,.!?;:])\s*/)
      .flatMap((s) => {
        if (s.length <= maxChars) return [s];
        const parts = [];
        for (let i = 0; i < s.length; i += maxChars) parts.push(s.slice(i, i + maxChars));
        return parts;
      })
      .map((s) => s.trim())
      .filter(Boolean);
    if (!chunks.length) continue;
    const totalChars = chunks.reduce((a, c) => a + c.length, 0) || 1;
    const dur = Math.max(minDur, it.end - it.start);
    let cursor = it.start;
    for (const c of chunks) {
      const d = Math.max(minDur, (dur * c.length) / totalChars);
      out.push({ start: cursor, end: Math.min(it.end, cursor + d), text: c });
      cursor += d;
    }
  }
  return out;
}

/**
 * 用音频包络给一句话做"词级"时间估算。
 * 不是真 ASR，只是把词均匀铺开并按能量峰值吸附，做卡拉OK式高亮够用了。
 */
export function estimateWordTimings(item, analysis, opts = {}) {
  const words = String(item.text).split(/(\s+|(?<=[\u4e00-\u9fa5]))/).filter((w) => w && !/^\s+$/.test(w));
  if (!words.length) return [];
  const { env, envRate } = analysis;
  const span = Math.max(0.05, item.end - item.start);
  const n = words.length;
  const weights = words.map((w, i) => {
    const t = item.start + (span * i) / n;
    const idx = Math.min(env.length - 1, Math.max(0, Math.round(t * envRate)));
    return 0.6 + 1.4 * (env?.[idx] || 0);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = item.start;
  return words.map((w, i) => {
    const d = (span * weights[i]) / total;
    const rec = { word: w, start: cursor, end: cursor + d };
    cursor += d;
    return rec;
  });
}
