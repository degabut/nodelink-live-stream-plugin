/**
 * Ogg Opus muxing (RFC 7845).
 *
 * Encoded Opus packets are shared between listeners (encoding happens once per
 * broadcast), but every listener owns a {@link OggOpusPager} so its serial
 * number, page sequence and granule positions stay internally consistent
 * regardless of when it joined. Granules are counted from each listener's own
 * start, which keeps the `OpusHead` pre-skip consistent with the page granules.
 */

import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import {
  CHANNELS,
  OGG_HEADER,
  OPUS_FRAME_SAMPLES,
  OPUS_PRESKIP,
  OPUS_VENDOR,
  SAMPLE_RATE,
} from "./constants.ts";

/**
 * Ogg CRC-32 lookup table.
 *
 * Ogg uses CRC-32 with polynomial `0x04C11DB7`, an initial value of zero, no
 * final XOR and **no bit reflection**, so `zlib.crc32` (which is reflected)
 * cannot be used here.
 */
const OGG_CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index++) {
    let remainder = (index << 24) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      remainder =
        (remainder & 0x80000000) !== 0
          ? ((remainder << 1) ^ 0x04c11db7) >>> 0
          : (remainder << 1) >>> 0;
    }
    table[index] = remainder >>> 0;
  }

  return table;
})();

/**
 * Computes an Ogg page checksum.
 *
 * @param buffer - Page bytes with the CRC field still zeroed.
 * @returns The checksum to store at byte offset 22.
 */
function oggCrc32(buffer: Buffer): number {
  let crc = 0;

  for (let index = 0; index < buffer.length; index++) {
    const byte = buffer[index] as number;
    crc =
      ((crc << 8) ^ (OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] as number)) >>>
      0;
  }

  return crc >>> 0;
}

/**
 * Builds a single Ogg page.
 *
 * @param headerType - `0x01` continued, `0x02` BOS, `0x04` EOS.
 * @param granule - Granule position in 48 kHz samples, including pre-skip.
 * @param serial - Bitstream serial number.
 * @param sequence - Page sequence number.
 * @param packets - Packets to place in the page.
 * @returns The serialized page.
 * @throws When the packets would need more than 255 lacing values.
 */
function buildOggPage(
  headerType: number,
  granule: number,
  serial: number,
  sequence: number,
  packets: Buffer[],
): Buffer {
  const lacing: number[] = [];
  let payloadLength = 0;

  for (const packet of packets) {
    payloadLength += packet.length;
    let remaining = packet.length;
    // A packet whose size is an exact multiple of 255 needs a trailing 0
    // lacing value to mark its end.
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }

  if (lacing.length > 255) {
    throw new Error("Ogg page would require more than 255 segments");
  }

  const header = Buffer.allocUnsafe(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8(headerType, 5);
  header.writeBigUInt64LE(BigInt(granule), 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(sequence >>> 0, 18);
  header.writeUInt32LE(0, 22); // CRC placeholder
  header.writeUInt8(lacing.length, 26);

  for (let index = 0; index < lacing.length; index++) {
    header.writeUInt8(lacing[index] as number, 27 + index);
  }

  const page = Buffer.allocUnsafe(header.length + payloadLength);
  header.copy(page, 0);

  let offset = header.length;
  for (const packet of packets) {
    packet.copy(page, offset);
    offset += packet.length;
  }

  page.writeUInt32LE(oggCrc32(page), 22);
  return page;
}

/**
 * Builds the `OpusHead` identification header.
 *
 * @returns The 19-byte header for the pipeline's stereo 48 kHz output.
 */
function buildOpusHead(): Buffer {
  const head = Buffer.allocUnsafe(19);
  head.write("OpusHead", 0, "ascii");
  head.writeUInt8(1, 8); // version
  head.writeUInt8(CHANNELS, 9);
  head.writeUInt16LE(OPUS_PRESKIP, 10);
  head.writeUInt32LE(SAMPLE_RATE, 12); // original input rate (informational)
  head.writeInt16LE(0, 16); // output gain (Q7.8)
  head.writeUInt8(0, 18); // channel mapping family
  return head;
}

/**
 * Builds the `OpusTags` comment header.
 *
 * @returns The serialized comment header with no user comments.
 */
function buildOpusTags(): Buffer {
  const vendor = Buffer.from(OPUS_VENDOR, "utf8");
  const tags = Buffer.allocUnsafe(8 + 4 + vendor.length + 4);

  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length); // user comment count

  return tags;
}

/**
 * Serializes shared Opus packets into one listener's Ogg Opus bitstream.
 */
export class OggOpusPager {
  private readonly serial: number;
  private readonly pagePackets: number;
  private sequence = 0;
  private pending: Buffer[] = [];
  private samples = 0;
  private closed = false;

  /**
   * Creates a pager.
   *
   * @param pagePackets - Audio packets to accumulate before emitting a page.
   */
  constructor(pagePackets: number) {
    this.serial = randomBytes(4).readUInt32LE(0);
    this.pagePackets = Math.max(1, pagePackets);
  }

  /**
   * Builds the two mandatory header pages.
   *
   * @returns The BOS page carrying `OpusHead`, then the `OpusTags` page.
   */
  public headerPages(): Buffer[] {
    return [
      buildOggPage(OGG_HEADER.bos, 0, this.serial, this.sequence++, [
        buildOpusHead(),
      ]),
      buildOggPage(0, 0, this.serial, this.sequence++, [buildOpusTags()]),
    ];
  }

  /**
   * Adds an encoded packet, returning a page once enough have accumulated.
   *
   * @param packet - Encoded Opus packet (20 ms of audio).
   * @returns The serialized page, or `null` while more packets are needed.
   */
  public pushPacket(packet: Buffer): Buffer | null {
    if (this.closed) return null;

    this.pending.push(packet);
    this.samples += OPUS_FRAME_SAMPLES;

    if (this.pending.length < this.pagePackets) return null;
    return this.emitPage(0);
  }

  /**
   * Flushes buffered packets and appends an end-of-stream page.
   *
   * @returns The trailing page(s); empty when the pager is already closed.
   */
  public flush(): Buffer[] {
    if (this.closed) return [];
    this.closed = true;

    const pages: Buffer[] = [];
    const pendingPage = this.emitPage(0);
    if (pendingPage) pages.push(pendingPage);
    pages.push(this.emitPage(OGG_HEADER.eos));
    return pages;
  }

  /**
   * Emits any buffered packets as a normal (non-EOS) page without closing the
   * bitstream.
   *
   * Needed when the filler sends nothing: packets already accumulated must be
   * delivered before going quiet, otherwise a fragment of the finished track
   * would sit in memory and be flushed later, arriving out of time ahead of the
   * next track's audio.
   *
   * @returns The page, or `null` when nothing is buffered or already closed.
   */
  public flushPartial(): Buffer | null {
    if (this.closed || this.pending.length === 0) return null;
    return this.emitPage(0);
  }

  /**
   * Builds an empty Ogg page used as an idle heartbeat.
   *
   * The page has zero segments, so it advances the page sequence while leaving
   * the granule position exactly where the last audio page left it: a decoder
   * sees the same timeline with a gap in it. That makes it safe to emit while
   * nothing is playing, where real silence would cost ~12.4 kB/s.
   *
   * @returns The 27-byte page, or `null` when a page is already pending or the
   *   bitstream has been closed.
   */
  public keepAlivePage(): Buffer | null {
    if (this.closed) return null;

    // `samples` only advances together with `pending`, so an empty pending list
    // means the last emitted page already carries this granule. Emitting a page
    // with the same granule first would make the buffered packets look like they
    // occupy no time.
    if (this.pending.length > 0) return null;

    return buildOggPage(
      0,
      OPUS_PRESKIP + this.samples,
      this.serial,
      this.sequence++,
      [],
    );
  }

  /**
   * Serializes the buffered packets into one page.
   *
   * @param headerType - Ogg header type flags.
   * @returns The page, or `null` when there is nothing buffered.
   */
  private emitPage(headerType: number): Buffer | null {
    if (this.pending.length === 0 && headerType !== OGG_HEADER.eos) return null;

    const page = buildOggPage(
      headerType,
      OPUS_PRESKIP + this.samples,
      this.serial,
      this.sequence++,
      this.pending,
    );

    this.pending = [];
    return page;
  }
}
