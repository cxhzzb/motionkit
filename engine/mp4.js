// ============================================================================
// 最小可用的 MP4 封装器：一条 H.264 视频轨 +（可选）一条 AAC 音频轨，普通（非分片）.mp4。
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
  // 注意别用位运算：采样率 <<16 这类值会超过 2^31，位与会被截成负数
  for (let i = n - 1; i >= 0; i--) { a[i] = v % 256; v = Math.floor(v / 256); }
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

/** MP4 的 descriptor（esds 里那套嵌套长度编码）：tag + 变长长度 + 内容 */
function descriptor(tag, payload) {
  const len = [];
  let n = payload.length;
  do { len.unshift(n & 0x7f); n >>= 7; } while (n > 0);
  for (let i = 0; i < len.length - 1; i++) len[i] |= 0x80;
  return join([new Uint8Array([tag]), new Uint8Array(len), payload]);
}

/** AAC 的 esds：告诉播放器"这是 MPEG-4 音频，SPS 在这儿"，缺了它多数播放器不出声 */
function esds(description, sampleRate, channels, bitrate) {
  const dsi = descriptor(0x05, description);
  const dcd = descriptor(0x04, join([
    new Uint8Array([0x40]),            // objectTypeIndication: MPEG-4 Audio
    new Uint8Array([0x15]),            // streamType=5(audio) << 2 | 1
    be(0, 3),                          // bufferSizeDB
    be(bitrate, 4), be(bitrate, 4),    // max / avg bitrate
    dsi,
  ]));
  const sl = descriptor(0x06, new Uint8Array([0x02]));   // SLConfigDescriptor: predefined
  return fullBox('esds', 0, 0, descriptor(0x03, join([be(1, 2), new Uint8Array([0]), dcd, sl])));
}

/** 把"每段时长"折成 stts（相邻相同的合并成一条） */
function timeToSampleTable(durations) {
  const entries = [];
  for (const d of durations) {
    const last = entries[entries.length - 1];
    if (last && last.delta === d) last.count++;
    else entries.push({ count: 1, delta: d });
  }
  return fullBox('stts', 0, 0, be(entries.length, 4),
    ...entries.flatMap((e) => [be(e.count, 4), be(e.delta, 4)]));
}

/** 一张轨的样本表（每个样本单独一个 chunk，stsc 就只有一条，够简单也够稳） */
function sampleTable({ entry, durations, sizes, offsets, sync }) {
  const stsd = fullBox('stsd', 0, 0, be(1, 4), entry);
  const stts = timeToSampleTable(durations);
  const stss = (sync && sync.length && sync.length < sizes.length)
    ? fullBox('stss', 0, 0, be(sync.length, 4), ...sync.map((k) => be(k, 4)))
    : null;
  const stsc = fullBox('stsc', 0, 0, be(1, 4), be(1, 4), be(1, 4), be(1, 4));
  const stsz = fullBox('stsz', 0, 0, be(0, 4), be(sizes.length, 4), ...sizes.map((s) => be(s, 4)));
  const use64 = offsets.some((o) => o > 0xfffffff0);
  const stco = use64
    ? fullBox('co64', 0, 0, be(offsets.length, 4), ...offsets.map((o) => be(o, 8)))
    : fullBox('stco', 0, 0, be(offsets.length, 4), ...offsets.map((o) => be(o, 4)));
  return box('stbl', stsd, stts, ...(stss ? [stss] : []), stsc, stsz, stco);
}

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

const MOVIE_TIMESCALE = 1000;      // mvhd/tkhd 用毫秒级的时基，够用也不会有小数

/** mp4a 样本描述：一段固定字段 + esds（AudioSpecificConfig） */
function audioEntry(channels, sampleRate, esdsBox) {
  return box('mp4a',
    new Uint8Array(6),                                 // reserved
    be(1, 2),                                          // data_reference_index
    be(0, 2), be(0, 2), be(0, 4),                      // version / revision / vendor
    be(channels, 2), be(16, 2),                        // channelcount / samplesize
    be(0, 2), be(0, 2),                                // pre_defined / reserved
    be(sampleRate * 65536, 4),                         // samplerate（16.16 定点）
    esdsBox);
}

/** 一条轨的外壳（tkhd + mdia），视频和音频只差中间那几样 */
function trak({ id, durationMovie, handler, mdhdTimescale, mdhdDuration, mediaHeader, stbl,
  width = 0, height = 0, volume = 0 }) {
  const dref = fullBox('dref', 0, 0, be(1, 4), fullBox('url ', 0, 1));
  const hdlr = fullBox('hdlr', 0, 0, be(0, 4), ascii(handler),
    new Uint8Array(12), ascii(handler === 'vide' ? 'VideoHandler\0' : 'SoundHandler\0'));
  const mdhd = fullBox('mdhd', 0, 0, be(0, 4), be(0, 4),
    be(mdhdTimescale, 4), be(mdhdDuration, 4), be(0x55c4, 2), be(0, 2));
  const mdia = box('mdia', mdhd, hdlr, box('minf', mediaHeader, box('dinf', dref), stbl));
  const tkhd = fullBox('tkhd', 0, 7,
    be(0, 4), be(0, 4), be(id, 4), be(0, 4), be(durationMovie, 4),
    new Uint8Array(8), be(0, 2), be(0, 2), be(volume, 2), be(0, 2),
    UNITY_MATRIX, be(width * 65536, 4), be(height * 65536, 4));
  return box('trak', tkhd, mdia);
}

/**
 * @param {object} o
 *   width, height, fps     画面信息
 *   samples                [{ data: Uint8Array, key: boolean }] 按顺序的编码帧
 *   description            avcC 内容（VideoEncoder 的 decoderConfig.description）
 *   audio                  { sampleRate, channels, samples: [{data, frames}], description, bitrate }
 *                          不传 = 只有画面（导出的 MP4 就是无声的）
 * @returns {Uint8Array} 完整的 .mp4
 */
export function muxMp4({ width, height, fps, samples, description, audio }) {
  const n = samples.length;
  if (!n) throw new Error('没有帧可以封装');
  if (!description || !description.length) throw new Error('缺少 avcC（SPS/PPS），封装不了 MP4');
  if (audio && (!audio.description || !audio.samples || !audio.samples.length)) audio = null;

  // 时间基：视频用 fps*1000，每帧就是整数刻度，不会因为除不尽而累积漂移
  const timescale = Math.max(1, Math.round(fps * 1000));
  const frameDur = Math.max(1, Math.round(timescale / fps));
  const videoDuration = frameDur * n;
  const audioFrames = audio ? audio.samples.reduce((s, c) => s + (c.frames || 0), 0) : 0;
  const audioDuration = audio ? audioFrames : 0;
  const audioSeconds = audio ? audioFrames / audio.sampleRate : 0;
  const movieDuration = Math.round(Math.max(videoDuration / timescale, audioSeconds) * MOVIE_TIMESCALE);

  // ---- mdat：视频样本在前、音频样本在后，顺便记住偏移（stco/co64 用）
  const all = samples.concat(audio ? audio.samples : []);
  let dataSize = 0;
  for (const s of all) dataSize += s.data.length;
  const needLarge = dataSize + 8 > 0xfffffff0;
  const mdatHead = needLarge
    ? join([be(1, 4), ascii('mdat'), be(dataSize + 16, 8)])
    : join([be(dataSize + 8, 4), ascii('mdat')]);
  const head = ftyp();
  const base = head.length + mdatHead.length;
  const offsets = [];
  let at = base;
  for (const s of all) { offsets.push(at); at += s.data.length; }
  const mdat = join([mdatHead, ...all.map((s) => s.data)]);

  // ---- 视频轨
  const vEntry = sampleEntry(width, height, box('avcC', description));
  const videoStbl = sampleTable({
    entry: vEntry,
    durations: new Array(n).fill(frameDur),
    sizes: samples.map((s) => s.data.length),
    offsets: offsets.slice(0, n),
    sync: samples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean),
  });
  const vmhd = fullBox('vmhd', 0, 1, be(0, 2), be(0, 2), be(0, 2), be(0, 2));
  const vTrak = trak({
    id: 1, durationMovie: Math.round((videoDuration / timescale) * MOVIE_TIMESCALE),
    handler: 'vide', mdhdTimescale: timescale, mdhdDuration: videoDuration,
    mediaHeader: vmhd, stbl: videoStbl, width, height, volume: 0,
  });

  // ---- 音频轨（可选）：soun + smhd + mp4a/esds
  let aTrak = null;
  if (audio) {
    const aEntry = audioEntry(audio.channels, audio.sampleRate,
      esds(audio.description, audio.sampleRate, audio.channels, audio.bitrate || 192000));
    const aStbl = sampleTable({
      entry: aEntry,
      durations: audio.samples.map((s) => Math.max(1, s.frames || 0)),
      sizes: audio.samples.map((s) => s.data.length),
      offsets: offsets.slice(n),
    });
    const smhd = fullBox('smhd', 0, 0, be(0, 2), be(0, 2));
    aTrak = trak({
      id: 2, durationMovie: Math.round(audioSeconds * MOVIE_TIMESCALE),
      handler: 'soun', mdhdTimescale: audio.sampleRate, mdhdDuration: audioDuration,
      mediaHeader: smhd, stbl: aStbl, volume: 0x0100,
    });
  }

  // ---- moov
  const mvhd = fullBox('mvhd', 0, 0,
    be(0, 4), be(0, 4), be(MOVIE_TIMESCALE, 4), be(movieDuration, 4),
    be(0x00010000, 4), be(0x0100, 2), be(0, 2), new Uint8Array(8),
    UNITY_MATRIX, new Uint8Array(24), be(audio ? 3 : 2, 4));
  return join([head, mdat, box('moov', mvhd, vTrak, ...(aTrak ? [aTrak] : []))]);
}
