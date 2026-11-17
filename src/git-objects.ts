import { createHash } from 'node:crypto';
import type { GitObject, ObjectType } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export interface TreeEntry { mode: string; name: string; oid: string }
export interface Commit { tree: string; parents: string[]; author: string; committer: string; message: string }
export const hashObject = (type: ObjectType, data: Uint8Array): string => createHash('sha1').update(Buffer.from(`${type} ${data.byteLength}\0`)).update(data).digest('hex');

export function parseTree(data: Uint8Array): TreeEntry[] {
  const b = Buffer.from(data), out: TreeEntry[] = [];
  for (let p = 0; p < b.length;) {
    const sp = b.indexOf(32, p), nul = b.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > b.length) throw new Error('Malformed tree');
    out.push({ mode: b.toString('ascii', p, sp), name: b.toString('utf8', sp + 1, nul), oid: b.subarray(nul + 1, nul + 21).toString('hex') });
    p = nul + 21;
  }
  return out;
}

export function readTreePath(repo: { objects: Map<string, GitObject> }, rootTreeOid: string, dirPath: string): TreeEntry[] | null {
  let current = rootTreeOid;
  if (dirPath) {
    for (const part of dirPath.split('/')) {
      const tree = repo.objects.get(current);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find(e => e.name === part && e.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
  }
  const tree = repo.objects.get(current);
  return tree?.type === 'tree' ? parseTree(tree.data) : null;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sortKey = (e: TreeEntry) => Buffer.from(e.mode === '40000' ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => Buffer.compare(sortKey(a), sortKey(b)));
  return Buffer.concat(sorted.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]));
}

export function parseCommit(data: Uint8Array): Commit {
  const text = Buffer.from(data).toString(), split = text.indexOf('\n\n');
  const headers = split < 0 ? text : text.slice(0, split), message = split < 0 ? '' : text.slice(split + 2);
  const lines = headers.split('\n'), tree = lines.find(x => x.startsWith('tree '))?.slice(5) ?? '';
  if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('Malformed commit tree');
  return { tree, parents: lines.filter(x => x.startsWith('parent ')).map(x => x.slice(7)), author: lines.find(x => x.startsWith('author '))?.slice(7) ?? '', committer: lines.find(x => x.startsWith('committer '))?.slice(10) ?? '', message };
}

export function parseTag(data: Uint8Array): { object: string; type: ObjectType } {
  const lines = Buffer.from(data).toString().split('\n');
  const object = lines.find(x => x.startsWith('object '))?.slice(7) ?? '';
  const type = lines.find(x => x.startsWith('type '))?.slice(5) as ObjectType;
  if (!/^[0-9a-f]{40}$/.test(object)) throw new Error('Malformed tag');
  return { object, type };
}

export function buildCommit(fields: { tree: string; parents?: string[]; message: string; identity: string }): Buffer {
  const lines = [`tree ${fields.tree}`, ...(fields.parents ?? []).map(x => `parent ${x}`), `author ${fields.identity} 1700000000 +0000`, `committer ${fields.identity} 1700000000 +0000`, ''];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}\n`);
}

export function addObject(repo: { objects: Map<string, GitObject> }, type: ObjectType, data: Uint8Array): string {
  const bytes = Buffer.from(data), oid = hashObject(type, bytes);
  repo.objects.set(oid, { type, data: bytes });
  return oid;
}

export function flattenTree(repo: { objects: Map<string, GitObject> }, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const tree = repo.objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

export function buildTreeFromFiles(repo: { objects: Map<string, GitObject> }, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/'); let node = root;
    for (const part of parts.slice(0, -1)) { if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() }); node = node.dirs.get(part)!; }
    node.files.set(parts.at(-1)!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ name, mode: e.mode, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ name, mode: '40000', oid: build(child) });
    return addObject(repo as { objects: Map<string, GitObject> }, 'tree', buildTree(entries));
  };
  return build(root);
}
