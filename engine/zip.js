// ============================================================================
// 极简 ZIP 写入器（store 模式，不压缩）
// 用途：在浏览器里把导出的 PNG 序列直接打包下载，不依赖任何第三方库。
// ============================================================================

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

/** 生成 ZIP 的 Blob。files: [{name, data: Uint8Array|string}] */
export function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  const concat = (...arrs) => {
    const n = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);

    const local = concat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), nameBytes, data,
    );
    chunks.push(local);

    central.push(concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
    ));
    offset += local.length;
  }

  const centralBytes = concat(...central);
  const end = concat(
    u32(0x06054b50), u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralBytes.length), u32(offset), u16(0),
  );

  return new Blob([...chunks, centralBytes, end], { type: 'application/zip' });
}

/** 触发浏览器下载 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * 流式 ZIP 写入器：边渲染边往磁盘写，导出几百帧也不会把内存吃爆。
 * usage: const z = createZipWriter(async (bytes) => writer.write(bytes)); z.add(name, u8); await z.finish();
 */
export function createZipWriter(write) {
  const enc2 = new TextEncoder();
  const entries = [];
  let offset = 0;

  const u16 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff]);
  const cat = (...arrs) => {
    const n = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  };

  return {
    async add(name, data) {
      const nameBytes = enc2.encode(name);
      const bytes = typeof data === 'string' ? enc2.encode(data) : data;
      const crc = crc32(bytes);
      const local = cat(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
        u32(crc), u32(bytes.length), u32(bytes.length),
        u16(nameBytes.length), u16(0), nameBytes,
      );
      await write(local);
      await write(bytes);
      entries.push({ nameBytes, crc, size: bytes.length, offset });
      offset += local.length + bytes.length;
      return bytes.length;
    },
    async finish() {
      let centralLen = 0;
      for (const e of entries) {
        const rec = cat(
          u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
          u32(e.crc), u32(e.size), u32(e.size),
          u16(e.nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(e.offset), e.nameBytes,
        );
        await write(rec);
        centralLen += rec.length;
      }
      await write(cat(
        u32(0x06054b50), u16(0), u16(0),
        u16(entries.length), u16(entries.length),
        u32(centralLen), u32(offset), u16(0),
      ));
      return offset + centralLen + 22;
    },
  };
}

/** canvas -> PNG Uint8Array */
export async function canvasToPngBytes(canvas) {
  const blob = await new Promise((res) => canvas.convertToBlob ? canvas.convertToBlob({ type: 'image/png' }).then(res) : canvas.toBlob(res, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}
