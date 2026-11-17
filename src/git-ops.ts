import type { Repo, GitObject } from './store.ts';
import { parseCommit, parseTag, parseTree, flattenTree, buildTreeFromFiles, addObject, buildCommit } from './git-objects.ts';

export function reachable(repo: Repo, roots: Iterable<string>, options: { shallow?: Set<string> } = {}): Set<string> {
  const seen = new Set<string>(), todo = [...roots];
  while (todo.length) {
    const oid = todo.pop()!; if (seen.has(oid)) continue;
    const o = repo.objects.get(oid); if (!o) continue; seen.add(oid);
    if (o.type === 'commit') { const c = parseCommit(o.data); todo.push(c.tree); if (!options.shallow?.has(oid)) todo.push(...c.parents); }
    else if (o.type === 'tree') for (const e of parseTree(o.data)) if (e.mode !== '160000') todo.push(e.oid);
    else if (o.type === 'tag') todo.push(parseTag(o.data).object);
  }
  return seen;
}

export function commitAncestors(repo: Repo, tip: string): Map<string, number> {
  const distances = new Map<string, number>(), queue: Array<[string, number]> = [[tip, 0]];
  while (queue.length) { const [oid, depth] = queue.shift()!; if (distances.has(oid)) continue; distances.set(oid, depth); const o = repo.objects.get(oid); if (o?.type === 'commit') for (const p of parseCommit(o.data).parents) queue.push([p, depth + 1]); }
  return distances;
}

/** True when `ancestor` is reachable from `tip`. Early-exits on first sight — the
 *  receive-pack fast-forward check only needs the answer, not the full distance map,
 *  so a push onto the current tip costs one parent step instead of a whole-history walk. */
export function isAncestor(repo: Repo, tip: string, ancestor: string): boolean {
  if (tip === ancestor) return true;
  const seen = new Set<string>(), todo = [tip];
  while (todo.length) {
    const oid = todo.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const o = repo.objects.get(oid);
    if (o?.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) {
      if (p === ancestor) return true;
      todo.push(p);
    }
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aa = commitAncestors(repo, a), bb = commitAncestors(repo, b);
  let best: string | null = null, score = Infinity;
  for (const [oid, d] of aa) { const other = bb.get(oid); if (other !== undefined && d + other < score) { best = oid; score = d + other; } }
  return best;
}

export function treeOid(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid); return object?.type === 'commit' ? parseCommit(object.data).tree : null;
}

export function diffTrees(repo: Repo, baseCommit: string | null, headCommit: string): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const bt = baseCommit ? treeOid(repo, baseCommit) : null, ht = treeOid(repo, headCommit);
  const before = bt ? flattenTree(repo, bt) : new Map(), after = ht ? flattenTree(repo, ht) : new Map();
  const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(path), now = after.get(path); if (old?.oid === now?.oid) continue;
    const a = old ? (repo.objects.get(old.oid)?.data.toString().split('\n').length ?? 0) : 0;
    const b = now ? (repo.objects.get(now.oid)?.data.toString().split('\n').length ?? 0) : 0;
    let additions = b, deletions = a;
    if (old && now) {
      const x = repo.objects.get(old.oid)?.data.toString().split('\n') ?? [], y = repo.objects.get(now.oid)?.data.toString().split('\n') ?? [];
      const dp = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
      for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      additions = y.length - dp[0][0]; deletions = x.length - dp[0][0];
    }
    files.push({ filename: path, status: !old ? 'added' : !now ? 'removed' : 'modified', additions, deletions, changes: additions + deletions });
  }
  return files.sort((a, b) => a.filename.localeCompare(b.filename));
}

export function mergedTree(repo: Repo, base: string, head: string, current: string): { tree: string | null; conflict: boolean } {
  const baseOid = treeOid(repo, base), headOid = treeOid(repo, head), currentOid = treeOid(repo, current);
  if (!baseOid || !headOid || !currentOid) return { tree: null, conflict: true };
  const b = flattenTree(repo, baseOid), h = flattenTree(repo, headOid), c = flattenTree(repo, currentOid);
  const result = new Map<string, { oid: string; mode: string }>();
  for (const path of new Set([...b.keys(), ...h.keys(), ...c.keys()])) {
    const bv = b.get(path), hv = h.get(path), cv = c.get(path), eq = (x: typeof bv, y: typeof bv) => x?.oid === y?.oid;
    if (!eq(hv, bv) && !eq(cv, bv) && !eq(hv, cv)) return { tree: null, conflict: true };
    const chosen = !eq(hv, bv) ? hv : cv;
    if (chosen) result.set(path, chosen);
  }
  return { tree: buildTreeFromFiles(repo, result), conflict: false };
}

export function createSquash(repo: Repo, tree: string, parent: string, number: number, login: string): string {
  const data = buildCommit({ tree, parents: [parent], message: `Merge pull request #${number}`, identity: `${login} <${login}@example.invalid>` });
  return addObject(repo, 'commit', data);
}

export function objectsForFetch(repo: Repo, wants: string[], haves: string[], depth?: number, shallowIn: string[] = []): { objects: GitObject[]; shallow: string[] } {
  // The client already has everything reachable from its haves — EXCEPT below its
  // shallow boundary, where its history was cut: traversal stops at shallow commits.
  const haveObjects = reachable(repo, haves, { shallow: new Set(shallowIn) });
  const includedCommits = new Set<string>(), shallow: string[] = [];
  // Depth walk from the wants, straight THROUGH haves: deepening a shallow clone
  // must reach the parents of a have (the client does not have them yet).
  const queue: Array<[string, number]> = wants.map(x => [x, 1]);
  let qi = 0;
  while (qi < queue.length) {
    const [oid, gen] = queue[qi++]!, obj = repo.objects.get(oid); if (!obj) continue;
    if (obj.type === 'tag') { if (!includedCommits.has(oid)) { includedCommits.add(oid); queue.push([parseTag(obj.data).object, gen]); } continue; }
    if (obj.type !== 'commit' || includedCommits.has(oid)) continue;
    includedCommits.add(oid); const c = parseCommit(obj.data);
    if (depth !== undefined && gen >= depth) shallow.push(oid); else for (const p of c.parents) queue.push([p, gen + 1]);
  }
  const shallowSet = new Set(shallow);
  const objectSet = new Set<string>(), todo = [...includedCommits];
  while (todo.length) { const oid = todo.pop()!; if (objectSet.has(oid) || haveObjects.has(oid)) continue; const o = repo.objects.get(oid); if (!o) continue; objectSet.add(oid);
    if (o.type === 'commit') { const c = parseCommit(o.data); todo.push(c.tree); if (!shallowSet.has(oid)) todo.push(...c.parents); }
    else if (o.type === 'tree') for (const e of parseTree(o.data)) todo.push(e.oid);
    else if (o.type === 'tag') todo.push(parseTag(o.data).object);
  }
  return { objects: [...objectSet].map(oid => repo.objects.get(oid)!).filter(Boolean), shallow };
}
