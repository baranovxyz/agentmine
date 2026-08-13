/**
 * Framed compression for archived session payload.
 *
 * Archived payload is stored as a BLOB rather than TEXT so it can be
 * compressed. Every stored value carries a one-byte frame header naming its
 * encoding, so a stored payload is self-describing and a future codec change
 * does not require a corpus-wide rewrite or an out-of-band version lookup.
 *
 * Frame layout:  [ 1-byte encoding tag ][ payload bytes ]
 *
 * The identity encoding exists because compression is not always a win: very
 * short events (a few dozen bytes) grow under a zstd frame header. Storing
 * those verbatim is an explicit, self-describing choice — distinct from
 * silently failing to compress, which the storage contract forbids.
 */

const ENCODING_IDENTITY = 0x00;
const ENCODING_ZSTD = 0x01;

/** Low-overhead default; benchmark representative payload before changing. */
export const ZSTD_COMPRESSION_LEVEL = 3;

interface ZstdCodec {
  compress(input: Uint8Array): Uint8Array;
  decompress(input: Uint8Array): Uint8Array;
}

let resolved: ZstdCodec | undefined;
let resolutionError: string | undefined;

/**
 * Resolve zstd from the host runtime. Node exposes it through `node:zlib`
 * (>= 22.15); Bun exposes `Bun.zstdCompressSync` and, in newer versions, the
 * same `node:zlib` surface. Prefer `node:zlib` so both runtimes take one path
 * whenever they can, and fall back to Bun's global only when they cannot.
 */
async function resolveCodec(): Promise<ZstdCodec | undefined> {
  const zlib = (await import("node:zlib")) as Record<string, unknown>;
  const compressSync = zlib.zstdCompressSync;
  const decompressSync = zlib.zstdDecompressSync;
  const constants = zlib.constants;
  if (
    typeof compressSync === "function" &&
    typeof decompressSync === "function" &&
    typeof constants === "object" &&
    constants !== null
  ) {
    const levelParam = (constants as Record<string, unknown>)
      .ZSTD_c_compressionLevel;
    const options =
      typeof levelParam === "number"
        ? { params: { [levelParam]: ZSTD_COMPRESSION_LEVEL } }
        : undefined;
    return {
      compress: (input) => compressSync(input, options) as Uint8Array,
      decompress: (input) => decompressSync(input) as Uint8Array,
    };
  }

  const bun = (globalThis as Record<string, unknown>).Bun;
  if (typeof bun === "object" && bun !== null) {
    const bunCompress = (bun as Record<string, unknown>).zstdCompressSync;
    const bunDecompress = (bun as Record<string, unknown>).zstdDecompressSync;
    if (
      typeof bunCompress === "function" &&
      typeof bunDecompress === "function"
    ) {
      return {
        compress: (input) =>
          bunCompress(input, { level: ZSTD_COMPRESSION_LEVEL }) as Uint8Array,
        decompress: (input) => bunDecompress(input) as Uint8Array,
      };
    }
  }

  return undefined;
}

try {
  resolved = await resolveCodec();
} catch (error) {
  resolutionError = error instanceof Error ? error.message : String(error);
}

/** True when this runtime can store compressed payload. */
export function payloadCodecAvailable(): boolean {
  return resolved !== undefined;
}

/**
 * A runtime without the codec must fail rather than silently store
 * payload uncompressed. Call before opening an archive for writing.
 */
export function assertPayloadCodecAvailable(): void {
  if (resolved !== undefined) return;
  const detail = resolutionError ? ` (${resolutionError})` : "";
  throw new Error(
    `This runtime provides no zstd implementation${detail}. Agentmine stores archived session payload compressed and will not fall back to uncompressed storage. Use Node >= 22.15 or a Bun build with zstd support.`,
  );
}

function codec(): ZstdCodec {
  assertPayloadCodecAvailable();
  if (resolved === undefined) throw new Error("unreachable");
  return resolved;
}

/** Encode payload text into a framed, usually compressed, BLOB value. */
export function encodePayload(text: string): Uint8Array {
  const raw = Buffer.from(text, "utf8");
  const compressed = codec().compress(raw);
  // Keep whichever is smaller; the frame tag records which one was stored.
  if (compressed.byteLength < raw.byteLength) {
    return frame(ENCODING_ZSTD, compressed);
  }
  return frame(ENCODING_IDENTITY, raw);
}

/** Decode a framed BLOB value back into the exact original payload text. */
export function decodePayload(blob: Uint8Array): string {
  if (blob.byteLength === 0) {
    throw new Error("archived payload is empty and carries no encoding frame");
  }
  const tag = blob[0];
  const body = blob.subarray(1);
  switch (tag) {
    case ENCODING_IDENTITY:
      return Buffer.from(body).toString("utf8");
    case ENCODING_ZSTD:
      return Buffer.from(codec().decompress(body)).toString("utf8");
    default:
      throw new Error(
        `archived payload carries unknown encoding tag ${tag}; it was written by a newer Agentmine`,
      );
  }
}

function frame(tag: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(body.byteLength + 1);
  out[0] = tag;
  out.set(body, 1);
  return out;
}
