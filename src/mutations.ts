import { store, type Comment, type Issue, type Pull, type Repo } from './store.ts';
import { createSquash, mergeBase, mergedTree } from './git-ops.ts';
import { unb64url } from './util.ts';

/** Decode a global id (base64url of `Kind:<repoDbId>[:<number>[:<commentId>]]`). */
export function decodeGid(gid: string): { kind: string; repoId: number; n?: number; comment?: number } | null {
  try {
    const parts = unb64url(gid).split(':');
    const kind = parts[0] ?? '';
    const repoId = Number(parts[1]);
    if (!kind || !Number.isInteger(repoId) || repoId <= 0) return null;
    const n = parts[2] === undefined ? undefined : Number(parts[2]);
    const comment = parts[3] === undefined ? undefined : Number(parts[3]);
    if (n !== undefined && !Number.isInteger(n)) return null;
    if (comment !== undefined && !Number.isInteger(comment)) return null;
    return { kind, repoId, n, comment };
  } catch {
    return null;
  }
}

export function findRepoById(id: number): Repo | undefined {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

export function createIssueInRepo(repo: Repo, title: string, body: string, labels: string[] = []): Issue {
  const number = store.nextIssueNumber(repo);
  const issue: Issue = { id: store.nextItemId(), number, title, body, state: 'open', labels, createdSeq: store.nextSeq(), updatedSeq: store.nextSeq(), nodeId: store.gid('Issue', repo, number) };
  repo.issues.set(number, issue);
  return issue;
}

export function closeIssueInRepo(repo: Repo, number: number): Issue | null {
  const issue = repo.issues.get(number);
  if (!issue) return null;
  issue.state = 'closed';
  issue.updatedSeq = store.nextSeq();
  repo.issueBodyCache.delete(number);
  return issue;
}

export function createPullInRepo(repo: Repo, title: string, body: string, head: string, base: string): Pull | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return { error: 'Head or base branch does not exist' };
  if ([...repo.pulls.values()].some(p => p.state === 'open' && p.head.ref === head && p.base.ref === base)) {
    return { error: 'A pull request already exists' };
  }
  const number = store.nextIssueNumber(repo);
  const pull: Pull = { id: store.nextItemId(), number, title, body, state: 'open', head: { ref: head, sha: headSha }, base: { ref: base, sha: baseSha }, merged: false, merged_at: null, merge_commit_sha: null, createdSeq: store.nextSeq(), nodeId: store.gid('PullRequest', repo, number) };
  repo.pulls.set(number, pull);
  return pull;
}

/** Squash-merge a pull request (same logic as the REST merge). */
export function squashMergePull(repo: Repo, pull: Pull): { sha: string } | { error: string } {
  const base = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const head = pull.head.sha;
  const common = mergeBase(repo, base, head) ?? base;
  const merged = mergedTree(repo, common, head, base);
  if (merged.conflict || !merged.tree) return { error: 'Pull request cannot be cleanly merged' };
  const sha = createSquash(repo, merged.tree, base, pull.number, store.viewerLogin ?? 'forge');
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  store.changedRefs(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = process.env.MAKEFUN_TRIAL_NOW || '2025-01-01T00:00:00.000Z';
  pull.merge_commit_sha = sha;
  return { sha };
}

export function addCommentToIssue(repo: Repo, number: number, body: string): Comment | null {
  if (!repo.issues.has(number) && !repo.pulls.has(number)) return null;
  const comment: Comment = { id: store.nextItemId(), body, createdSeq: store.nextSeq() };
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  repo.issueBodyCache.delete(number);
  return comment;
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request (same conflict check as the merge). */
export function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const base = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const common = mergeBase(repo, base, pull.head.sha) ?? base;
  const merged = mergedTree(repo, common, pull.head.sha, base);
  return merged.conflict || !merged.tree ? 'CONFLICTING' : 'MERGEABLE';
}
