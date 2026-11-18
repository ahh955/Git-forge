import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/** The fixed trial instant: the environment never changes at runtime, so read it once. */
const NOW = process.env.MAKEFUN_TRIAL_NOW || '2025-01-01T00:00:00.000Z';
export const fixedNow = (): string => NOW;
let requestCounter = 0;
export const nextRequestId = (): string => `req-${++requestCounter}`;
export const b64url = (value: string): string => Buffer.from(value).toString('base64url');
export const unb64url = (value: string): string => Buffer.from(value, 'base64url').toString();
export const sha1 = (value: Uint8Array): string => createHash('sha1').update(value).digest('hex');

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // One UTF-8 pass: Buffer.from encodes once and gives the exact byte length,
  // replacing Buffer.byteLength (a full scan) + res.end(string) (a second encode
  // on the write path).
  const buf = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buf.length), ...headers });
  res.end(buf);
}

/** sendJson for a response body that is already serialized (cached GETs). */
export function sendJsonBuffer(res: ServerResponse, status: number, buf: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(buf.length), ...headers });
  res.end(buf);
}

/** Lazily-parsed query string: most requests never read a parameter, so the
 *  URLSearchParams object is built only on first access. */
export class Query {
  private p: URLSearchParams | null = null;
  private raw: string;
  constructor(raw: string) { this.raw = raw; }
  get(name: string): string | null {
    if (!this.p) this.p = new URLSearchParams(this.raw);
    return this.p.get(name);
  }
  has(name: string): boolean {
    if (!this.p) this.p = new URLSearchParams(this.raw);
    return this.p.has(name);
  }
}

export function sendEmpty(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': '0', ...headers });
  res.end();
}

export async function readBody(req: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function readJson(req: AsyncIterable<Uint8Array>): Promise<Record<string, unknown>> {
  const data = await readBody(req);
  const value = JSON.parse(data.toString('utf8')) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
