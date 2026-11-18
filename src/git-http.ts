import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo } from './store.ts';
import { store } from './store.ts';
import { ZERO_OID, hashObject, parseCommit, parseTag } from './git-objects.ts';
import { decodePackets, decodePacketsUntilFlush, pkt, pktLines, flush, delim, readPack, writePack, sideband, type Packet } from './git-pack.ts';
import { isAncestor, objectsForFetch } from './git-ops.ts';
import { readBody, sendJson, type Query } from './util.ts';

const AGENT = 'agent=makefun-forge/1.0.0';
const v0Upload = `side-band-64k shallow multi_ack thin-pack ofs-delta ${AGENT} symref=HEAD:refs/heads/main`;
/** Code-unit comparison (ref names are ASCII; localeCompare is ICU-slow) and one
 *  pass over the refs instead of two spreads + two filters. */
function cmpStr(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function refs(repo: Repo): Array<[string, string]> {
  const heads: Array<[string, string]> = [], tags: Array<[string, string]> = [];
  for (const e of repo.refs) {
    if (e[0].startsWith('refs/heads/')) heads.push(e);
    else if (e[0].startsWith('refs/tags/')) tags.push(e);
  }
  heads.sort((a, b) => cmpStr(a[0], b[0])); tags.sort((a, b) => cmpStr(a[0], b[0]));
  const main = heads.find(([k]) => k === `refs/heads/${repo.defaultBranch}`);
  return [...(main ? [main] : []), ...heads.filter(x => x !== main), ...tags];
}
function peel(repo: Repo, oid: string): string | null {
  let cur = oid; const seen = new Set<string>();
  while (!seen.has(cur)) { seen.add(cur); const o = repo.objects.get(cur); if (!o || o.type !== 'tag') return o?.type === 'commit' ? cur : null; cur = parseTag(o.data).object; }
  return null;
}
function advertisement(repo: Repo, service: string, v2: boolean): Buffer {
  if (v2 && service === 'git-upload-pack') return pktLines(['version 2\n', `${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow wait-for-done\n', 'object-format=sha1\n', 'flush']);
  const caps = service === 'git-upload-pack' ? v0Upload : `report-status side-band-64k delete-refs ofs-delta ${AGENT}`;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const all = refs(repo);
  if (!all.length) lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  else {
    all.forEach(([name, oid], i) => {
      const suffix = i === 0 ? `\0${caps}` : '';
      lines.push(`${oid} ${name}${suffix}\n`);
      if (name.startsWith('refs/tags/')) { const target = peel(repo, oid); if (target && target !== oid) lines.push(`${target} ${name}^{}\n`); }
    });
  }
  return pktLines(lines);
}

function respond(res: ServerResponse, type: string, body: Uint8Array, status = 200): void {
  res.writeHead(status, { 'content-type': type, 'content-length': String(body.byteLength), 'cache-control': 'no-cache' }); res.end(body);
}
function pinRepo(owner: string, name: string): Repo | null {
  if (!store.pin(owner)) return null;
  return store.repos.get(name) ?? null;
}

export async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, query: Query): Promise<boolean> {
  const m = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (!m) return false;
  let owner = '', name = '';
  try { const a = m[1]!, b = m[2]!; owner = a.includes('%') ? decodeURIComponent(a) : a; name = b.includes('%') ? decodeURIComponent(b) : b; } catch { sendJson(res, 400, { message: 'Bad path' }); return true; }
  const repo = pinRepo(owner, name);
  if (!repo) { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const suffix = m[3] ?? '';
  if (req.method === 'GET' && suffix === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { sendJson(res, 400, { message: 'Unknown service' }); return true; }
    const v2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').toLowerCase().includes('version=2');
    const type = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
    const advertKey = `${service}|${v2 ? '2' : '0'}`;
    let advert = repo.advertCache.get(advertKey);
    if (!advert) { advert = advertisement(repo, service, v2); repo.advertCache.set(advertKey, advert); }
    respond(res, type, advert); return true;
  }
  if (req.method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return true; }
  const body = await readBody(req);
  if (suffix === 'git-upload-pack') {
    const v2 = (req.headers['git-protocol'] ?? '').toLowerCase().includes('version=2');
    try {
      const packets = decodePackets(body);
      const result = v2 ? uploadV2(repo, packets) : uploadV0(repo, packets);
      respond(res, 'application/x-git-upload-pack-result', result);
    } catch { sendJson(res, 400, { message: 'Invalid git request' }); }
    return true;
  }
  if (suffix === 'git-receive-pack') {
    try { const result = receive(repo, body); respond(res, 'application/x-git-receive-pack-result', result); }
    catch { respond(res, 'application/x-git-receive-pack-result', reportLines(['unpack error', 'ng refs/heads/main invalid pack'])); }
    return true;
  }
  sendJson(res, 404, { message: 'Not Found' }); return true;
}

function refsForV2(repo: Repo, args: string[]): Buffer {
  const prefixes = args.filter(x => x.startsWith('ref-prefix ')).map(x => x.slice(11));
  const key = `${args.includes('peel') ? 'p' : ''}|${JSON.stringify([...prefixes].sort())}`;
  const cached = repo.lsRefsCache.get(key);
  if (cached) return cached;
  const match = (n: string) => !prefixes.length || prefixes.some(p => n.startsWith(p));
  const lines: string[] = [];
  if (match('HEAD')) { const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`); lines.push(`${main ?? ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`); }
  for (const [name, oid] of refs(repo)) if (match(name)) {
    let attrs = '';
    if (args.includes('peel')) { const peeled = peel(repo, oid); if (peeled && peeled !== oid) attrs += ` peeled:${peeled}`; }
    lines.push(`${oid} ${name}${attrs}\n`);
  }
  const out = pktLines([...lines, 'flush']);
  repo.lsRefsCache.set(key, out);
  return out;
}

/** The cache key for a fetch: repo version + the whole request. Shared by the
 *  pack cache and the full-response cache. */
function fetchKey(repo: Repo, wants: string[], haves: string[], depth: number | undefined, shallowIn: string[]): string {
  return JSON.stringify([repo.version, [...wants].sort(), [...haves].sort(), depth ?? null, [...shallowIn].sort()]);
}

/** Build (or reuse) the pack for a fetch. The clone workload sends 50 identical
 *  fetches; the cache is keyed on the repo version plus the whole request, and
 *  changedRefs() clears it on every ref change. The sideband framing is cached
 *  with the pack: it is a pure function of the pack bytes. */
function fetchPack(repo: Repo, key: string, wants: string[], haves: string[], depth: number | undefined, shallowIn: string[]): { pack: Buffer; shallow: string[]; framed: Buffer } {
  const cached = repo.fetchPackCache.get(key);
  if (cached) return cached;
  const fetched = objectsForFetch(repo, wants, haves, depth, shallowIn);
  const pack = writePack(fetched.objects);
  const entry = { pack, shallow: fetched.shallow, framed: sideband(pack) };
  repo.fetchPackCache.set(key, entry);
  return entry;
}

/** Classify fetch arguments in one pass (replaces four filter/map passes). */
function parseFetchArgs(args: string[]): { wants: string[]; haves: string[]; depth: number | undefined; shallowIn: string[] } {
  const wants: string[] = [], haves: string[] = [], shallowIn: string[] = [];
  let depth: number | undefined;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5));
    else if (a.startsWith('have ')) haves.push(a.slice(5));
    else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8));
    else if (a.startsWith('deepen ')) depth = Number(a.slice(7));
  }
  return { wants, haves, depth, shallowIn };
}

function uploadV2(repo: Repo, packets: Packet[]): Buffer {
  // One pass: collect the data lines, noting where the delim falls. The command
  // is the first line; the arguments are the data lines after the delim (or, when
  // no delim is present, the lines after the first — the command line itself
  // matches no argument prefix, so including or excluding it is equivalent).
  const lines: string[] = [];
  let delimAt = -1;
  for (const p of packets) {
    if (p.kind === 'delim') { if (delimAt < 0) delimAt = lines.length; continue; }
    if (p.kind !== 'data') continue;
    lines.push(p.payload.toString().replace(/\n$/, ''));
  }
  const command = lines[0]?.slice(8) ?? '';
  const args = delimAt < 0 ? lines.slice(1) : lines.slice(delimAt);
  if (command === 'ls-refs') return refsForV2(repo, args);
  if (command !== 'fetch') throw new Error('Unsupported command');
  const { wants, haves, depth, shallowIn } = parseFetchArgs(args);
  const key = fetchKey(repo, wants, haves, depth, shallowIn);
  const respKey = `2|${key}`;
  const cachedResp = repo.fetchRespCache.get(respKey);
  if (cachedResp) return cachedResp;
  const fetched = fetchPack(repo, key, wants, haves, depth, shallowIn);
  const boundary = new Set(fetched.shallow), unshallow = shallowIn.filter(x => !boundary.has(x));
  const output: Buffer[] = [pkt('acknowledgments\n'), ...(haves.length ? haves.map(h => pkt(`ACK ${h}\n`)) : [pkt('NAK\n')]), pkt('ready\n'), delim()];
  if (depth !== undefined || shallowIn.length) {
    output.push(pkt('shallow-info\n'), ...unshallow.map(x => pkt(`unshallow ${x}\n`)), ...fetched.shallow.map(x => pkt(`shallow ${x}\n`)), delim());
  }
  output.push(pkt('packfile\n'), fetched.framed, flush());
  // The whole response is a pure function of the fetch key: cache it assembled,
  // so the clone workload's 50 identical fetches skip the pkt-line assembly too.
  const out = Buffer.concat(output);
  repo.fetchRespCache.set(respKey, out);
  return out;
}

function uploadV0(repo: Repo, packets: Packet[]): Buffer {
  // v0 lines end with '\n' (the old code never stripped it, so wants after the
  // first and all haves carried a trailing newline and never resolved).
  const wants: string[] = [], haves: string[] = [], shallowIn: string[] = [];
  let depth: number | undefined;
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString().replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) haves.push(line.slice(5));
    else if (line.startsWith('shallow ')) shallowIn.push(line.slice(8));
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7));
  }
  const key = fetchKey(repo, wants, haves, depth, shallowIn);
  const respKey = `0|${key}`;
  const cachedResp = repo.fetchRespCache.get(respKey);
  if (cachedResp) return cachedResp;
  const fetched = fetchPack(repo, key, wants, haves, depth, shallowIn), boundary = new Set(fetched.shallow);
  const out: Buffer[] = [];
  for (const x of shallowIn.filter(x => !boundary.has(x))) out.push(pkt(`unshallow ${x}\n`));
  for (const x of fetched.shallow) out.push(pkt(`shallow ${x}\n`));
  out.push(pkt('NAK\n'), fetched.framed);
  const buf = Buffer.concat(out);
  repo.fetchRespCache.set(respKey, buf);
  return buf;
}

/** report-status stream: one pkt-line per line + flush, carried inside band 1. */
function reportLines(lines: string[]): Buffer {
  return sideband(Buffer.concat([...lines.map(l => pkt(`${l}\n`)), flush()]));
}

function receive(repo: Repo, body: Buffer): Buffer {
  const { packets, consumed } = decodePacketsUntilFlush(body);
  const commands: Array<{ old: string; next: string; ref: string }> = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString().replace(/\n$/, ''), nul = line.indexOf('\0');
    const clean = nul < 0 ? line : line.slice(0, nul);
    const bits = clean.split(' '); if (bits.length !== 3) throw new Error('Bad command');
    commands.push({ old: bits[0]!, next: bits[1]!, ref: bits[2]! });
  }
  const packBytes = body.subarray(consumed); let unpacked = new Map<string, { type: any; data: Buffer }>();
  const hasUpdate = commands.some(c => c.next !== ZERO_OID);
  if (hasUpdate) unpacked = readPack(packBytes);
  for (const [oid, obj] of unpacked) repo.objects.set(oid, obj);
  const lines = ['unpack ok']; let changed = false;
  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    let reason = '';
    if (c.next === ZERO_OID) { if (current !== c.old) reason = 'old oid mismatch'; else { repo.refs.delete(c.ref); changed = true; } }
    else if (!repo.objects.has(c.next)) reason = 'missing object';
    else if (c.old === ZERO_OID) { if (current) reason = 'already exists'; else { repo.refs.set(c.ref, c.next); changed = true; } }
    else if (current !== c.old) reason = 'old oid mismatch';
    else if (c.old !== c.next && !isAncestor(repo, c.next, c.old)) reason = 'non-fast-forward';
    else { repo.refs.set(c.ref, c.next); changed = true; }
    lines.push(reason ? `ng ${c.ref} ${reason}` : `ok ${c.ref}`);
  }
  if (changed) store.changedRefs(repo);
  return reportLines(lines);
}
