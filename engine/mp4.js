// ============================================================================
// 最小可用的 MP4 封装器：一条 H.264 视频轨，普通（非分片）.mp4。
//
// 为什么自己写：
//   浏览器录屏（MediaRecorder）是**按墙上时钟**给帧打时间戳的 —— 渲染一帧比 1/fps 慢，
//   录出来的时长就被拖长（实测 2 分 40 秒的工程导出成 6 分钟）。WebCodecs 的 VideoEncoder
//   能一帧一帧拿到编码结果，时间戳由我们说了算，代价就是得自己把样本装进 MP4。
//   零依赖，和 engine/zip.js（自己写 ZIP 写入器）是同一个路子。
//
// 文件摆放：ftyp | mdat（样本数据）| moov（索引）
// 索引里每个样本单独占一个 chunk，stsc 只有一条，够简单也够通用。
// ============================================================================

/** 大端整数 → 字节 */
function be(value, n) {
  const a = new Uint8Array(n);
  let v = Math.max(0, Math.floor(value));
  for (let i = n - 1; i >= 0; i--) { a[i] = v & 255; v = Math.floor(v / 256); }
  return a;
}

/** ASCII 字符串 → 字节 */
function ascii(s) {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255;
  return a;
}

function join(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 一个 box：4 字节长度 + 4 字节类型 + 内容 */
function box(type, ...parts) {
  const body = join(parts);
  return join([be(body.length + 8, 4), ascii(type), body]);
}

/** full box：多一个 version + flags */
function fullBox(type, version, flags, ...parts) {
  return box(type, new Uint8Array([version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]), ...parts);
}

const UNITY_MATRIX = join([
  be(0x00010000, 4), be(0, 4), be(0, 4),
  be(0, 4), be(0x00010000, 4), be(0, 4),
  be(0, 4), be(0, 4), be(0x40000000, 4),
]);

function ftyp() {
  return box('ftyp', ascii('isom'), be(0x200, 4), ascii('isomavc1iso2mp41'));
}

/** avc1 样本描述：一段固定字段 + 编码器给的 avcC（SPS/PPS） */
function sampleEntry(width, height, avcC) {
  const compressorname = new Uint8Array(32);          // 第一字节 0 = 空名字
  return box('avc1',
    new Uint8Array(6),                                 // reserved
    be(1, 2),                                          // data_reference_index
    be(0, 2), be(0, 2), new Uint8Array(12),            // pre_defined / reserved
    be(width, 2), be(height, 2),
    be(0x00480000, 4), be(0x00480000, 4),              // 72dpi
    be(0, 4), be(1, 2), compressorname,
    be(0x0018, 2),                                     // depth
    be(0xffff, 2),
    avcC);
}

/**
 * @param {object} o
 *   width, height, fps     画面信息
 *   samples                [{ data: Uint8Array, key: boolean }] 按顺序的编码帧
 *   description            avcC 内容（VideoEncoder 的 decoderConfig.description）
 * @returns {Uint8Array} 完整的 .mp4
 */
export function muxMp4({ width, height, fps, samples, description }) {
  const n = samples.length;
  if (!n) throw new Error('没有帧可以封装');
  if (!description || !description.length) throw new Error('缺少 avcC（SPS/PPS），封装不了 MP4');

  // 时间基：用 fps*1000，每帧就是整数刻度，不会因为除不尽而累积漂移
  const timescale = Math.max(1, Math.round(fps * 1000));
  const frameDur = Math.max(1, Math.round(timescale / fps));
  const duration = frameDur * n;

  // ---- mdat：样本数据挨着放，顺便记住每个样本的偏移（stco/co64 用）
  let dataSize = 0;
  for (const s of samples) dataSize += s.data.length;
  const needLarge = dataSize + 8 > 0xfffffff0;
  const mdatHead = needLarge
    ? join([be(1, 4), ascii('mdat'), be(dataSize + 16, 8)])
    : join([be(dataSize + 8, 4), ascii('mdat')]);
  const head = ftyp();
  const base = head.length + mdatHead.length;
  const offsets = [];
  let at = base;
  for (const s of samples) { offsets.push(at); at += s.data.length; }
  const mdat = join([mdatHead, ...samples.map((s) => s.data)]);

  // ---- 索引表
  const stsd = fullBox('stsd', 0, 0, be(1, 4), sampleEntry(width, height, box('avcC', description)));
  const stts = fullBox('stts', 0, 0, be(1, 4), be(n, 4), be(frameDur, 4));
  const stsc = fullBox('stsc', 0, 0, be(1, 4), be(1, 4), be(1, 4), be(1, 4));
  const stsz = fullBox('stsz', 0, 0, be(0, 4), be(n, 4), ...samples.map((s) => be(s.data.length, 4)));
  const use64 = offsets.some((o) => o > 0xfffffff0);
  const stco = use64
    ? fullBox('co64', 0, 0, be(offsets.length, 4), ...offsets.map((o) => be(o, 8)))
    : fullBox('stco', 0, 0, be(offsets.length, 4), ...offsets.map((o) => be(o, 4)));

  // 关键帧表：不全都是关键帧才需要写
  const keys = [];
  samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
  const stss = keys.length === n ? null
    : fullBox('stss', 0, 0, be(keys.length, 4), ...keys.map((k) => be(k, 4)));

  const stbl = box('stbl', stsd, stts, ...(stss ? [stss] : []), stsc, stsz, stco);
  const vmhd = fullBox('vmhd', 0, 1, be(0, 2), be(0, 2), be(0, 2), be(0, 2));
  const dref = fullBox('dref', 0, 0, be(1, 4), fullBox('url ', 0, 1));
  const dinf = box('dinf', dref);
  const minf = box('minf', vmhd, dinf, stbl);
  const hdlr = fullBox('hdlr', 0, 0, be(0, 4), ascii('vide'), new Uint8Array(12), ascii('VideoHandler\0'));
  const mdhd = fullBox('mdhd', 0, 0, be(0, 4), be(0, 4), be(timescale, 4), be(duration, 4), be(0x55c4, 2), be(0, 2));
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = fullBox('tkhd', 0, 7,
    be(0, 4), be(0, 4), be(1, 4), be(0, 4), be(duration, 4),
    new Uint8Array(8), be(0, 2), be(0, 2), be(0, 2), be(0, 2),
    UNITY_MATRIX, be(width << 16, 4), be(height << 16, 4));
  const trak = box('trak', tkhd, mdia);
  const mvhd = fullBox('mvhd', 0, 0,
    be(0, 4), be(0, 4), be(timescale, 4), be(duration, 4),
    be(0x00010000, 4), be(0x0100, 2), be(0, 2), new Uint8Array(8),
    UNITY_MATRIX, new Uint8Array(24), be(2, 4));
  const moov = box('moov', mvhd, trak);

  return join([head, mdat, moov]);
}

/** 给界面用：这组样本封装出来大概多长（秒） */
export function mp4Duration(frameCount, fps) {
  const timescale = Math.max(1, Math.round(fps * 1000));
  const frameDur = Math.max(1, Math.round(timescale / fps));
  return (frameDur * frameCount) / timescale;
}
