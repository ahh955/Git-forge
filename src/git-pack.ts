import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, ObjectType } from './store.ts';
import { hashObject } from './git-objects.ts';

/** A Uint8Array as a Buffer without copying when it already is one. */
export const asBuffer = (u: Uint8Array): Buffer => Buffer.isBuffer(u) ? u : Buffer.from(u);

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' | 'delim' | 'end' };
export function pkt(data: string | Uint8Array): Buffer {
  const b = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data), h = Buffer.from((b.length + 4).toString(16).padStart(4, '0'));
  if (b.length > 65516) throw new Error('pkt-line too large');
  return Buffer.concat([h, b]);
}
export const flush = (): Buffer => Buffer.from('0000');
export const delim = (): Buffer => Buffer.from('0001');
export function pktLines(lines: Array<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  return Buffer.concat(lines.map(x => x === 'flush' ? flush() : x === 'delim' ? delim() : pkt(x)));
}
export function decodePackets(data: Uint8Array): Packet[] {
  const b = asBuffer(data), out: Packet[] = []; let p = 0;
  while (p < b.length) {
    if (p + 4 > b.length) throw new Error('Truncated pkt-line');
    const raw = b.toString('ascii', p, p + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(raw)) throw new Error('Invalid pkt-line header');
    const n = parseInt(raw, 16); p += 4;
    if (n === 0) out.push({ kind: 'flush' }); else if (n === 1) out.push({ kind: 'delim' }); else if (n === 2) out.push({ kind: 'end' });
    else { if (n < 4 || p + n - 4 > b.length) throw new Error('Invalid pkt-line length'); out.push({ kind: 'data', payload: b.subarray(p, p + n - 4) }); p += n - 4; }
  }
  return out;
}

/** Decode pkt-lines up to and including the first flush, reporting bytes consumed.
 *  A receive-pack body is a command list followed by RAW pack bytes, so the full
 *  body must never be decoded as pkt-lines — the pack would throw. */
export function decodePacketsUntilFlush(data: Uint8Array): { packets: Packet[]; consumed: number } {
  const b = asBuffer(data), out: Packet[] = []; let p = 0;
  while (p < b.length) {
    if (p + 4 > b.length) throw new Error('Truncated pkt-line');
    const raw = b.toString('ascii', p, p + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(raw)) throw new Error('Invalid pkt-line header');
    const n = parseInt(raw, 16); p += 4;
    if (n === 0) { out.push({ kind: 'flush' }); return { packets: out, consumed: p }; }
    if (n === 1) out.push({ kind: 'delim' }); else if (n === 2) out.push({ kind: 'end' });
    else { if (n < 4 || p + n - 4 > b.length) throw new Error('Invalid pkt-line length'); out.push({ kind: 'data', payload: b.subarray(p, p + n - 4) }); p += n - 4; }
  }
  return { packets: out, consumed: p };
}

const typeCode: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function entryHead(type: ObjectType, size: number): Buffer {
  let first = (typeCode[type] << 4) | (size & 15), n = Math.floor(size / 16), bytes: number[] = [];
  while (n) { bytes.push(first | 128); first = n & 127; n = Math.floor(n / 128); }
  bytes.push(first); return Buffer.from(bytes);
}
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects], head = Buffer.alloc(12); head.write('PACK'); head.writeUInt32BE(2, 4); head.writeUInt32BE(list.length, 8);
  const chunks: Buffer[] = [head];
  for (const o of list) chunks.push(entryHead(o.type, o.data.length), deflateSync(o.data, { level: 1 }));
  const body = Buffer.concat(chunks); return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVar(b: Buffer, state: { p: number }): number {
  let x = 0, shift = 0, c: number;
  do { if (state.p >= b.length) throw new Error('Truncated pack varint'); c = b[state.p++]; x += (c & 127) * 2 ** shift; shift += 7; } while (c & 128);
  return x;
}
export function readPack(input: Uint8Array): Map<string, GitObject> {
  const b = asBuffer(input), trailer = b.length - 20;
  if (b.length < 32 || b.toString('ascii', 0, 4) !== 'PACK' || ![2, 3].includes(b.readUInt32BE(4))) throw new Error('Invalid pack header');
  if (!createHash('sha1').update(b.subarray(0, trailer)).digest().equals(b.subarray(trailer))) throw new Error('Pack checksum mismatch');
  const count = b.readUInt32BE(8), byOid = new Map<string, GitObject>(); let p = 12;
  const pending: Array<{ type: number; data: Buffer; baseOffset?: number; baseOid?: string; offset: number }> = [];
  const offsets = new Map<number, GitObject | { type: number; data: Buffer; baseOffset?: number; baseOid?: string; offset: number }>();
  for (let i = 0; i < count; i++) {
    const offset = p; let c = b[p++], type = c >> 4 & 7, size = c & 15, shift = 4;
    while (c & 128) { c = b[p++]; size += (c & 127) * 2 ** shift; shift += 7; }
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 6) { c = b[p++]; let distance = c & 127; while (c & 128) { c = b[p++]; distance = (distance + 1) * 128 + (c & 127); } baseOffset = offset - distance; }
    if (type === 7) { baseOid = b.subarray(p, p + 20).toString('hex'); p += 20; }
    const inflated = inflateSync(b.subarray(p, trailer), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    p += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('Pack object size mismatch');
    if (type >= 1 && type <= 4) {
      // Fast path: plain objects resolve immediately (no pending/resolve machinery).
      const obj: GitObject = { type: (['', 'commit', 'tree', 'blob', 'tag'][type]) as ObjectType, data: inflated.buffer };
      byOid.set(hashObject(obj.type, obj.data), obj);
      offsets.set(offset, obj);
    } else {
      const e = { type, data: inflated.buffer, baseOffset, baseOid, offset };
      pending.push(e); offsets.set(offset, e);
    }
  }
  const resolve = (e: typeof pending[number], seen = new Set<number>()): GitObject => {
    if (seen.has(e.offset)) throw new Error('Delta cycle'); seen.add(e.offset);
    let base: GitObject | undefined;
    if (e.type === 6) { const be = offsets.get(e.baseOffset!); if (be) base = typeof be.type === 'string' ? be : resolve(be, seen); }
    else base = byOid.get(e.baseOid!);
    if (!base) throw new Error('Missing delta base');
    const state = { p: 0 }, baseLen = readVar(e.data, state), targetLen = readVar(e.data, state);
    if (baseLen !== base.data.length) throw new Error('Delta base size mismatch');
    const out = Buffer.alloc(targetLen); let w = 0;
    while (state.p < e.data.length) {
      const op = e.data[state.p++];
      if (op & 128) {
        let off = 0, len = 0;
        for (let i = 0; i < 4; i++) if (op & (1 << i)) off += e.data[state.p++] * 2 ** (i * 8);
        for (let i = 0; i < 3; i++) if (op & (16 << i)) len += e.data[state.p++] * 2 ** (i * 8);
        if (!len) len = 65536; base.data.copy(out, w, off, off + len); w += len;
      } else { if (!op) throw new Error('Invalid delta opcode'); e.data.copy(out, w, state.p, state.p + op); state.p += op; w += op; }
    }
    if (w !== targetLen) throw new Error('Delta target size mismatch'); return { type: base.type, data: out };
  };
  for (const e of pending) { const obj = resolve(e); const oid = hashObject(obj.type, obj.data); byOid.set(oid, obj); }
  if (p !== trailer) throw new Error('Trailing pack bytes');
  return byOid;
}

export function sideband(pack: Uint8Array): Buffer {
  const b = asBuffer(pack), parts: Buffer[] = [];
  for (let p = 0; p < b.length; p += 65515) parts.push(pkt(Buffer.concat([Buffer.from([1]), b.subarray(p, p + 65515)])));
  if (!parts.length) parts.push(pkt(Buffer.from([1])));
  return Buffer.concat(parts);
}
