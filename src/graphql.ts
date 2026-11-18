import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Issue, type Pull, type Repo } from './store.ts';
import { diffTrees, mergeBase } from './git-ops.ts';
import { addCommentToIssue, closeIssueInRepo, createIssueInRepo, createPullInRepo, decodeGid, findRepoById, pullMergeable, squashMergePull } from './mutations.ts';
import { b64url, fixedNow, nextRequestId, readBody, sendJson, unb64url } from './util.ts';

// --------------------------------------------------------------------------- parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'ellipsis' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { tokens.push({ kind: 'ellipsis' }); i += 3; continue; }
    if (ch === '"') {
      let out = '';
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const esc = src[i + 1]!;
          if (esc === 'u') { out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; }
          else { out += { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' }[esc] ?? esc; i += 2; }
        } else { out += src[i]; i += 1; }
      }
      i += 1;
      tokens.push({ kind: 'string', value: out });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.' && src[j + 1]! >= '0' && src[j + 1]! <= '9') {
        isFloat = true;
        j += 1;
        while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}():$!=@[]|&'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldSel { kind: 'field'; name: string; alias: string | null; args: Array<{ name: string; value: ValueNode }>; selections: Sel[] }
interface FragSel { kind: 'fragment'; typeCondition: string; selections: Sel[] }
type Sel = FieldSel | FragSel;
interface Operation { type: 'query' | 'mutation'; name: string | null; selections: Sel[] }

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return t;
  }
  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`Expected '${value}' in GraphQL document`);
  }
  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name' || (value !== undefined && t.value !== value)) throw new Error(`Expected ${value ?? 'a name'} in GraphQL document`);
    return t.value;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const after = this.peek();
        if (after?.kind === 'name') name = this.next().value;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') this.skipVarDefs();
        ops.push({ type, name, selections: this.parseSelectionSet() });
      } else if (t.kind === 'punct' && t.value === '{') {
        ops.push({ type: 'query', name: null, selections: this.parseSelectionSet() });
      } else {
        throw new Error('Only query/mutation operations are supported');
      }
    }
    if (!ops.length) throw new Error('Empty GraphQL document');
    return ops;
  }

  private skipVarDefs(): void {
    // ($name: Type! = default, ...) — types and defaults are not needed; skip balanced parens.
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): Sel[] {
    this.expectPunct('{');
    const sels: Sel[] = [];
    for (;;) {
      const t = this.peek();
      if (!t) throw new Error('Unterminated selection set');
      if (t.kind === 'punct' && t.value === '}') { this.next(); return sels; }
      if (t.kind === 'ellipsis') {
        this.next();
        this.expectName('on');
        const typeCondition = this.expectName();
        sels.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      const first = this.expectName();
      let alias: string | null = null;
      let name = first;
      const colon = this.peek();
      if (colon?.kind === 'punct' && colon.value === ':') {
        this.next();
        alias = first;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      const open = this.peek();
      if (open?.kind === 'punct' && open.value === '(') {
        this.next();
        for (;;) {
          const p = this.peek();
          if (!p) throw new Error('Unterminated argument list');
          if (p.kind === 'punct' && p.value === ')') { this.next(); break; }
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      let selections: Sel[] = [];
      const brace = this.peek();
      if (brace?.kind === 'punct' && brace.value === '{') selections = this.parseSelectionSet();
      sels.push({ kind: 'field', name, alias, args, selections });
    }
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      for (;;) {
        const p = this.peek();
        if (!p) throw new Error('Unterminated list value');
        if (p.kind === 'punct' && p.value === ']') { this.next(); return { kind: 'list', items }; }
        items.push(this.parseValue());
      }
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const p = this.peek();
        if (!p) throw new Error('Unterminated object value');
        if (p.kind === 'punct' && p.value === '}') { this.next(); return { kind: 'object', fields }; }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    throw new Error('Unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return vars[node.name] ?? null;
    case 'string': return node.value;
    case 'int': case 'float': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map(x => resolveValue(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, vars);
      return out;
    }
  }
}

// --------------------------------------------------------------------------- schema

interface GqlObject { __gqlType: string; value: unknown }
const wrap = (type: string, value: unknown): GqlObject => ({ __gqlType: type, value });
const isGqlObject = (v: unknown): v is GqlObject =>
  v !== null && typeof v === 'object' && '__gqlType' in (v as Record<string, unknown>);

type Resolver = (value: any, args: Record<string, unknown>) => unknown;
const FIELDS: Record<string, Record<string, Resolver>> = {};

const issueState = (issue: Issue): string => (issue.state === 'open' ? 'OPEN' : 'CLOSED');
const pullState = (pull: Pull): string => (pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED');
const cursorOf = (n: number): string => b64url(`cursor:${n}`);
function cursorNumber(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const text = unb64url(cursor);
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch { return null; }
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let items = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states)) items = items.filter(i => states.includes(issueState(i)));
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  items.sort((a, b) => a.createdSeq - b.createdSeq);
  if (orderBy?.direction === 'DESC') items.reverse();
  const afterN = cursorNumber(args.after as string | null | undefined);
  if (afterN !== null) {
    const idx = items.findIndex(i => i.number === afterN);
    if (idx >= 0) items = items.slice(idx + 1);
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  return wrap('IssueConnection', {
    nodes: page.map(issue => wrap('Issue', { repo, issue })),
    pageInfo: { hasNextPage: items.length > first, endCursor: page.length ? cursorOf(page[page.length - 1]!.number) : null },
  });
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): GqlObject {
  let items = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states)) items = items.filter(p => states.includes(pullState(p)));
  items.sort((a, b) => a.createdSeq - b.createdSeq);
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  return wrap('PullRequestConnection', {
    nodes: page.map(pull => wrap('PullRequest', { repo, pull })),
    pageInfo: { hasNextPage: items.length > first, endCursor: page.length ? cursorOf(page[page.length - 1]!.number) : null },
  });
}

const FIELD_TABLES: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
};
const ENUM_TABLES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

FIELDS.Query = {
  viewer: () => wrap('User', { login: store.viewerLogin }),
  repository: (_v, args) => {
    const owner = args.owner as string, name = args.name as string;
    if (typeof owner !== 'string' || typeof name !== 'string' || !store.pin(owner)) return null;
    const repo = store.repos.get(name);
    return repo ? wrap('Repository', repo) : null;
  },
  node: (_v, args) => {
    const decoded = typeof args.id === 'string' ? decodeGid(args.id) : null;
    if (!decoded) return null;
    const repo = findRepoById(decoded.repoId);
    if (!repo) return null;
    if (decoded.kind === 'Repository') return wrap('Repository', repo);
    if (decoded.kind === 'Issue' && decoded.n !== undefined) {
      const issue = repo.issues.get(decoded.n);
      return issue ? wrap('Issue', { repo, issue }) : null;
    }
    if (decoded.kind === 'PullRequest' && decoded.n !== undefined) {
      const pull = repo.pulls.get(decoded.n);
      return pull ? wrap('PullRequest', { repo, pull }) : null;
    }
    return null;
  },
  __type: (_v, args) => wrap('__Type', { name: args.name as string }),
};

FIELDS.Mutation = {
  createIssue: (_v, args) => {
    const input = args.input as Record<string, unknown>;
    const decoded = typeof input?.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
    if (!decoded || decoded.kind !== 'Repository') throw new GqlError('Unknown repository id');
    const repo = findRepoById(decoded.repoId);
    if (!repo) throw new GqlError('Unknown repository id');
    const issue = createIssueInRepo(repo, String(input.title ?? ''), String(input.body ?? ''));
    return wrap('CreateIssuePayload', { issue: wrap('Issue', { repo, issue }) });
  },
  closeIssue: (_v, args) => {
    const input = args.input as Record<string, unknown>;
    const decoded = typeof input?.issueId === 'string' ? decodeGid(input.issueId) : null;
    if (!decoded || decoded.kind !== 'Issue' || decoded.n === undefined) throw new GqlError('Unknown issue id');
    const repo = findRepoById(decoded.repoId);
    const issue = repo ? closeIssueInRepo(repo, decoded.n) : null;
    if (!repo || !issue) throw new GqlError('Unknown issue id');
    return wrap('CloseIssuePayload', { issue: wrap('Issue', { repo, issue }) });
  },
  createPullRequest: (_v, args) => {
    const input = args.input as Record<string, unknown>;
    const decoded = typeof input?.repositoryId === 'string' ? decodeGid(input.repositoryId) : null;
    if (!decoded || decoded.kind !== 'Repository') throw new GqlError('Unknown repository id');
    const repo = findRepoById(decoded.repoId);
    if (!repo) throw new GqlError('Unknown repository id');
    const pull = createPullInRepo(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
    if ('error' in pull) throw new GqlError(pull.error);
    return wrap('CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pull }) });
  },
  mergePullRequest: (_v, args) => {
    const input = args.input as Record<string, unknown>;
    const decoded = typeof input?.pullRequestId === 'string' ? decodeGid(input.pullRequestId) : null;
    if (!decoded || decoded.kind !== 'PullRequest' || decoded.n === undefined) throw new GqlError('Unknown pull request id');
    const repo = findRepoById(decoded.repoId);
    const pull = repo?.pulls.get(decoded.n);
    if (!repo || !pull) throw new GqlError('Unknown pull request id');
    const merged = squashMergePull(repo, pull);
    if ('error' in merged) throw new GqlError(merged.error);
    return wrap('MergePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pull }) });
  },
  addComment: (_v, args) => {
    const input = args.input as Record<string, unknown>;
    const decoded = typeof input?.subjectId === 'string' ? decodeGid(input.subjectId) : null;
    if (!decoded || decoded.kind !== 'Issue' || decoded.n === undefined) throw new GqlError('Unknown subject id');
    const repo = findRepoById(decoded.repoId);
    const comment = repo ? addCommentToIssue(repo, decoded.n, String(input.body ?? '')) : null;
    if (!repo || !comment) throw new GqlError('Unknown subject id');
    return wrap('AddCommentPayload', { commentEdge: wrap('IssueCommentEdge', { node: wrap('IssueComment', { repo, number: decoded.n, comment }) }) });
  },
};

FIELDS.User = {
  id: (v) => b64url(`User:${v.login ?? ''}`),
  login: (v) => v.login ?? null,
  name: (v) => v.login ?? null,
  email: (v) => (v.login ? `${v.login}@example.invalid` : null),
};

FIELDS.Repository = {
  id: (repo: Repo) => repo.nodeId,
  databaseId: (repo: Repo) => repo.id,
  name: (repo: Repo) => repo.name,
  nameWithOwner: (repo: Repo) => `${store.viewerLogin ?? 'viewer'}/${repo.name}`,
  owner: () => wrap('User', { login: store.viewerLogin }),
  defaultBranchRef: (repo: Repo) => (repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? wrap('Ref', { name: repo.defaultBranch }) : null),
  viewerPermission: () => 'ADMIN',
  hasIssuesEnabled: () => true,
  description: (repo: Repo) => repo.description,
  isPrivate: (repo: Repo) => repo.private,
  createdAt: () => fixedNow(),
  updatedAt: () => fixedNow(),
  issue: (repo: Repo, args) => {
    const issue = repo.issues.get(args.number as number);
    return issue ? wrap('Issue', { repo, issue }) : null;
  },
  issues: (repo: Repo, args) => issuesConnection(repo, args),
  pullRequests: (repo: Repo, args) => pullsConnection(repo, args),
  pullRequest: (repo: Repo, args) => {
    const pull = repo.pulls.get(args.number as number);
    return pull ? wrap('PullRequest', { repo, pull }) : null;
  },
};

FIELDS.Issue = {
  id: (v) => v.issue.nodeId,
  number: (v) => v.issue.number,
  title: (v) => v.issue.title,
  body: (v) => v.issue.body,
  state: (v) => issueState(v.issue),
  createdAt: () => fixedNow(),
  updatedAt: () => fixedNow(),
  author: () => wrap('User', { login: store.viewerLogin }),
  labels: () => [],
  comments: (v) => wrap('IssueCommentConnection', { nodes: (v.repo.comments.get(v.issue.number) ?? []).map((comment: { id: number }) => wrap('IssueComment', { repo: v.repo, number: v.issue.number, comment })) }),
};

FIELDS.PullRequest = {
  id: (v) => v.pull.nodeId,
  number: (v) => v.pull.number,
  title: (v) => v.pull.title,
  body: (v) => v.pull.body,
  state: (v) => pullState(v.pull),
  headRefName: (v) => v.pull.head.ref,
  baseRefName: (v) => v.pull.base.ref,
  mergeable: (v) => pullMergeable(v.repo, v.pull),
  merged: (v) => v.pull.merged,
  mergedAt: (v) => v.pull.merged_at,
  author: () => wrap('User', { login: store.viewerLogin }),
  createdAt: () => fixedNow(),
  updatedAt: () => fixedNow(),
  files: (v, args) => {
    const base = mergeBase(v.repo, v.pull.base.sha, v.pull.head.sha);
    const all = diffTrees(v.repo, base, v.pull.head.sha);
    const first = typeof args.first === 'number' ? args.first : all.length;
    return wrap('PullRequestFileConnection', { nodes: all.slice(0, first).map(f => wrap('PullRequestFile', f)) });
  },
};

FIELDS.IssueConnection = {
  nodes: (v) => v.nodes,
  pageInfo: (v) => wrap('PageInfo', v.pageInfo),
  totalCount: (v) => v.nodes.length,
};
FIELDS.PullRequestConnection = {
  nodes: (v) => v.nodes,
  pageInfo: (v) => wrap('PageInfo', v.pageInfo),
  totalCount: (v) => v.nodes.length,
};
FIELDS.PullRequestFileConnection = { nodes: (v) => v.nodes };
FIELDS.PullRequestFile = {
  path: (v) => v.filename,
  additions: (v) => v.additions,
  deletions: (v) => v.deletions,
  changeType: (v) => v.status,
};
FIELDS.PageInfo = {
  hasNextPage: (v) => v.hasNextPage,
  endCursor: (v) => v.endCursor ?? null,
  hasPreviousPage: () => false,
  startCursor: (v) => v.startCursor ?? null,
};
FIELDS.Ref = { name: (v) => v.name };
FIELDS.IssueCommentConnection = { nodes: (v) => v.nodes };
FIELDS.IssueComment = {
  id: (v) => store.gid('IssueComment', v.repo, v.number, v.comment.id),
  body: (v) => v.comment.body,
  author: () => wrap('User', { login: store.viewerLogin }),
  createdAt: () => fixedNow(),
};
FIELDS.IssueCommentEdge = {
  node: (v) => v.node,
  cursor: () => null,
};
FIELDS.CreateIssuePayload = { issue: (v) => v.issue, clientMutationId: () => null };
FIELDS.CloseIssuePayload = { issue: (v) => v.issue, clientMutationId: () => null };
FIELDS.CreatePullRequestPayload = { pullRequest: (v) => v.pullRequest, clientMutationId: () => null };
FIELDS.MergePullRequestPayload = { pullRequest: (v) => v.pullRequest, clientMutationId: () => null };
FIELDS.AddCommentPayload = { commentEdge: (v) => v.commentEdge, subject: () => null, clientMutationId: () => null };
FIELDS.__Type = {
  name: (v) => v.name,
  kind: (v) => (ENUM_TABLES[v.name] ? 'ENUM' : 'OBJECT'),
  description: () => null,
  fields: (v) => (FIELD_TABLES[v.name] ?? []).map(name => wrap('__Field', { name })),
  enumValues: (v) => (ENUM_TABLES[v.name] ?? []).map(name => wrap('__EnumValue', { name })),
};
FIELDS.__Field = { name: (v) => v.name, description: () => null };
FIELDS.__EnumValue = { name: (v) => v.name, description: () => null };

// --------------------------------------------------------------------------- executor

class GqlError extends Error {}

function executeSelections(typeName: string, value: unknown, sels: Sel[], vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (sel.typeCondition === typeName) Object.assign(out, executeSelections(typeName, value, sel.selections, vars));
      continue;
    }
    const table = FIELDS[typeName];
    const resolver = table?.[sel.name];
    if (!resolver) throw new GqlError(`Cannot query field "${sel.name}" on type "${typeName}".`);
    const args: Record<string, unknown> = {};
    for (const a of sel.args) args[a.name] = resolveValue(a.value, vars);
    const resolved = resolver(value, args);
    out[sel.alias ?? sel.name] = resolveFieldValue(resolved, sel.selections, vars);
  }
  return out;
}

function resolveFieldValue(resolved: unknown, sels: Sel[], vars: Record<string, unknown>): unknown {
  if (resolved === null || resolved === undefined) return null;
  if (isGqlObject(resolved)) {
    if (!sels.length) return null;
    return executeSelections(resolved.__gqlType, resolved.value, sels, vars);
  }
  if (Array.isArray(resolved)) {
    return resolved.map(item => (isGqlObject(item) ? (sels.length ? executeSelections(item.__gqlType, item.value, sels, vars) : null) : item));
  }
  return resolved;
}

function executeOperation(op: { query: string; variables?: Record<string, unknown>; operationName?: string }): { data: unknown; errors?: Array<{ message: string }> } {
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(op.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const vars = op.variables ?? {};
  const selected = op.operationName ? operations.find(o => o.name === op.operationName) : operations[0];
  if (!selected) return { data: null, errors: [{ message: `Unknown operation ${op.operationName ?? ''}` }] };
  const rootType = selected.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    return { data: executeSelections(rootType, null, selected.selections, vars) };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

// --------------------------------------------------------------------------- handler

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== '/api/graphql') return false;
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, { 'x-github-request-id': nextRequestId() }); return true; }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] }, { 'x-github-request-id': nextRequestId() });
    return true;
  }
  const ops = Array.isArray(body) ? body : [body];
  const results = ops.map((entry) => {
    if (entry === null || typeof entry !== 'object' || typeof (entry as { query?: unknown }).query !== 'string') {
      return { data: null, errors: [{ message: 'A GraphQL operation needs a query string' }] };
    }
    return executeOperation(entry as { query: string; variables?: Record<string, unknown>; operationName?: string });
  });
  sendJson(res, 200, Array.isArray(body) ? results : results[0], { 'x-github-request-id': nextRequestId() });
  return true;
}
