import pako from "pako";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ZipArchive {
  files: Map<string, Uint8Array>;
  readText(path: string): string | null;
  writeText(path: string, content: string): void;
  toBytes(compress?: boolean): Uint8Array;
}

/**
 * Lightweight, zero-external-dependency OpenXML/ZIP reader and writer.
 * Uses existing `pako` (already in the dependency tree) for DEFLATE/INFLATE.
 */
export function readZip(buffer: Uint8Array): ZipArchive {
  const files = new Map<string, Uint8Array>();
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // 1. Locate End of Central Directory Record (EOCD) by scanning backwards from the end
  let eocdOffset = -1;
  const maxScan = Math.min(buffer.length, 65557);
  for (let i = buffer.length - 22; i >= buffer.length - maxScan; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error("Invalid ZIP archive: End of Central Directory (EOCD) not found.");
  }

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  // 2. Iterate Central Directory entries
  let currentCd = cdOffset;
  for (let entryIdx = 0; entryIdx < totalEntries; entryIdx++) {
    if (view.getUint32(currentCd, true) !== 0x02014b50) {
      throw new Error(`Corrupted ZIP Central Directory at offset ${currentCd}`);
    }

    const method = view.getUint16(currentCd + 10, true);
    const compressedSize = view.getUint32(currentCd + 20, true);
    const uncompressedSize = view.getUint32(currentCd + 24, true);
    const nameLength = view.getUint16(currentCd + 28, true);
    const extraLength = view.getUint16(currentCd + 30, true);
    const commentLength = view.getUint16(currentCd + 32, true);
    const localHeaderOffset = view.getUint32(currentCd + 42, true);

    const nameBytes = buffer.subarray(currentCd + 46, currentCd + 46 + nameLength);
    const fileName = textDecoder.decode(nameBytes);

    // 3. Jump to Local File Header to read raw payload
    if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
      throw new Error(`Corrupted Local File Header for ${fileName} at offset ${localHeaderOffset}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataOffset = localHeaderOffset + 30 + localNameLen + localExtraLen;

    const rawData = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let decompressed: Uint8Array;

    if (method === 0) {
      decompressed = rawData.slice(); // Stored (no compression)
    } else if (method === 8) {
      decompressed = pako.inflateRaw(rawData);
    } else {
      throw new Error(`Unsupported compression method ${method} for file ${fileName}`);
    }

    files.set(fileName, decompressed);

    currentCd += 46 + nameLength + extraLength + commentLength;
  }

  return {
    files,
    readText(path: string) {
      const data = files.get(path);
      return data ? textDecoder.decode(data) : null;
    },
    writeText(path: string, content: string) {
      files.set(path, textEncoder.encode(content));
    },
    toBytes(compress = true) {
      return buildZip(files, compress);
    },
  };
}

/**
 * Serialize a Map of filenames -> file bytes into a standard ZIP archive.
 */
export function buildZip(files: Map<string, Uint8Array>, compress = true): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  let centralSize = 0;

  for (const [path, uncompressedBody] of files.entries()) {
    const name = textEncoder.encode(path);
    const checksum = crc32(uncompressedBody);

    let method = 0;
    let bodyToStore = uncompressedBody;

    if (compress) {
      const deflated = pako.deflateRaw(uncompressedBody);
      // Only keep deflated if it actually saved space
      if (deflated.length < uncompressedBody.length) {
        method = 8;
        bodyToStore = deflated;
      }
    }

    // Local header (30 bytes + name length)
    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true); // version needed: 2.0
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, method, true); // compression method (0 or 8)
    localView.setUint16(10, 0, true); // time
    localView.setUint16(12, 0x0021, true); // date
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, bodyToStore.length, true); // compressed size
    localView.setUint32(22, uncompressedBody.length, true); // uncompressed size
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true); // extra length
    localHeader.set(name, 30);

    localParts.push(localHeader, bodyToStore);

    // Central directory header (46 bytes + name length)
    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0, true); // flags
    centralView.setUint16(10, method, true);
    centralView.setUint16(12, 0, true); // time
    centralView.setUint16(14, 0x0021, true); // date
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, bodyToStore.length, true);
    centralView.setUint32(24, uncompressedBody.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, 0, true); // extra field len
    centralView.setUint16(32, 0, true); // comment len
    centralView.setUint16(34, 0, true); // disk start
    centralView.setUint16(36, 0, true); // internal attrs
    centralView.setUint32(38, 0, true); // external attrs
    centralView.setUint32(42, localOffset, true); // relative offset of local header
    centralHeader.set(name, 46);

    centralParts.push(centralHeader);

    localOffset += localHeader.length + bodyToStore.length;
    centralSize += centralHeader.length;
  }

  // End of Central Directory (22 bytes)
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true); // disk number
  endView.setUint16(6, 0, true); // disk with CD
  endView.setUint16(8, files.size, true); // total entries on this disk
  endView.setUint16(10, files.size, true); // total entries
  endView.setUint32(12, centralSize, true); // size of CD
  endView.setUint32(16, localOffset, true); // offset of CD
  endView.setUint16(20, 0, true); // comment length

  return concatBytes([...localParts, ...centralParts, end]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const res = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    res.set(chunk, offset);
    offset += chunk.length;
  }
  return res;
}
