import { crc32 } from 'node:zlib';

/**
 * Minimal streaming ZIP writer: "stored" entries (photos and videos are already compressed), sizes and CRC in
 * data descriptors so nothing is buffered, UTF-8 names. No ZIP64: callers keep the total under [ZIP_MAX_BYTES].
 */
export interface ZipEntry {
  name: string;
  /** Modification time (epoch ms), shown by unzip tools. */
  mtime: number;
  data: () => AsyncIterable<Buffer>;
}

/** Offsets and sizes are 32-bit without ZIP64; leave room for headers. */
export const ZIP_MAX_BYTES = 0xffffffff - 64 * 1024 * 1024;

const FLAGS = 0x0808; // bit 3: sizes/CRC in a data descriptor; bit 11: UTF-8 names

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const { time, date } = dosTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // CRC and sizes (14..25) stay 0: they follow in the data descriptor.
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const start = offset;
    yield local;
    yield name;
    offset += local.length + name.length;

    let crc = 0;
    let size = 0;
    for await (const chunk of e.data()) {
      crc = crc32(chunk, crc);
      size += chunk.length;
      yield chunk;
    }
    offset += size;
    if (offset > ZIP_MAX_BYTES) throw new Error('zip too large');

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc >>> 0, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    yield desc;
    offset += desc.length;

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(FLAGS, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc >>> 0, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs = 0
    cd.writeUInt32LE(start, 42);
    central.push(cd, name);
  }
  const cdBuf = Buffer.concat(central);
  yield cdBuf;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  yield end;
}
