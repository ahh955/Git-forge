import { b64url } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject { type: ObjectType; data: Buffer }
export interface Issue { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; labels: string[]; createdSeq: number; updatedSeq: number }
export interface Pull { id: number; number: number; title: string; body: string; state: 'open' | 'closed'; head: { ref: string; sha: string }; base: { ref: string; sha: string }; merged: boolean; merged_at: string | null; merge_commit_sha: string | null; createdSeq: number }
export interface Comment { id: number; body: string; createdSeq: number }
export interface Repo {
  id: number; name: string; description: string; private: boolean; defaultBranch: string; createdSeq: number;
  objects: Map<string, GitObject>; refs: Map<string, string>; labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>; pulls: Map<number, Pull>; comments: Map<number, Comment[]>; nextNumber: number;
  fetchPackCache: Map<string, { pack: Buffer; shallow: string[]; framed: Buffer }>; lsRefsCache: Map<string, Buffer>; advertCache: Map<string, Buffer>; version: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  private repoId = 5000;
  private itemId = 1;
  private sequence = 0;

  pin(login: string): boolean {
    if (!this.viewerLogin) this.viewerLogin = login;
    return this.viewerLogin === login;
  }

  createRepo(name: string, description = '', isPrivate = false): Repo {
    const repo: Repo = {
      id: this.repoId++, name, description, private: isPrivate, defaultBranch: 'main', createdSeq: ++this.sequence,
      objects: new Map(), refs: new Map(), labels: new Map(), issues: new Map(), pulls: new Map(), comments: new Map(),
      nextNumber: 1, fetchPackCache: new Map(), lsRefsCache: new Map(), advertCache: new Map(), version: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  nextItemId(): number { return this.itemId++; }
  nextSeq(): number { return ++this.sequence; }
  nextIssueNumber(repo: Repo): number { return repo.nextNumber++; }
  changedRefs(repo: Repo): void { repo.version++; repo.lsRefsCache.clear(); repo.advertCache.clear(); repo.fetchPackCache.clear(); }
  gid(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repo: Repo, n?: number, comment?: number): string {
    if (kind === 'Repository') return b64url(`${kind}:${repo.id}`);
    if (kind === 'Issue') return b64url(`${kind}:${repo.id}:${n}`);
    if (kind === 'PullRequest') return b64url(`${kind}:${repo.id}:${n}`);
    return b64url(`${kind}:${repo.id}:${n}:${comment}`);
  }
}

export const store = new Store();
