import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo } from './store.ts';
import { createIssueInRepo, createPullInRepo, squashMergePull } from './mutations.ts';
import { issueObject, pullObject, repoObject } from './rest.ts';
import { nextRequestId, readBody, sendJson } from './util.ts';

const SERVER_INFO = { name: 'makefun-git-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] };
}

/** The tool list is one static literal so two tools/list calls answer byte-identical JSON. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository under the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch.' },
        base: { type: 'string', description: 'The base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const normalize = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
function findTool(name: string): ToolDef | null {
  const wanted = normalize(name);
  for (const tool of TOOLS) if (normalize(tool.name) === wanted) return tool;
  for (const tool of TOOLS) if (normalize(tool.name).endsWith(wanted) || wanted.endsWith(normalize(tool.name))) return tool;
  return null;
}

type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string }
  | { ok: 'invalid'; message: string };

function resolveRepo(args: Record<string, unknown>): Repo | null {
  const owner = args.owner, name = args.repo;
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (!store.pin(owner)) return null;
  return store.repos.get(name) ?? null;
}

function missing(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (args[key] === undefined || args[key] === null || args[key] === '') return key;
  return null;
}

function callTool(name: string, args: Record<string, unknown>): ToolResult {
  const tool = findTool(name);
  if (!tool) return { ok: 'invalid', message: `Unknown tool ${name}` };
  switch (tool.name) {
    case 'create_repo': {
      const miss = missing(args, ['name']);
      if (miss) return { ok: 'invalid', message: `Missing required argument: ${miss}` };
      const repoName = String(args.name);
      if (store.repos.has(repoName)) return { ok: false, message: 'Repository already exists' };
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { ok: true, value: repoObject(repo) };
    }
    case 'get_repo': {
      const miss = missing(args, ['owner', 'repo']);
      if (miss) return { ok: 'invalid', message: `Missing required argument: ${miss}` };
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Not Found' };
      return { ok: true, value: repoObject(repo) };
    }
    case 'create_issue': {
      const miss = missing(args, ['owner', 'repo', 'title']);
      if (miss) return { ok: 'invalid', message: `Missing required argument: ${miss}` };
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Not Found' };
      const issue = createIssueInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '');
      return { ok: true, value: issueObject(repo, issue) };
    }
    case 'list_issues': {
      const miss = missing(args, ['owner', 'repo']);
      if (miss) return { ok: 'invalid', message: `Missing required argument: ${miss}` };
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Not Found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter(i => state === 'all' || i.state === state)
        .sort((a, b) => a.createdSeq - b.createdSeq)
        .map(i => issueObject(repo, i));
      return { ok: true, value: list };
    }
    case 'create_pull_request': {
      const miss = missing(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (miss) return { ok: 'invalid', message: `Missing required argument: ${miss}` };
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Not Found' };
      const pull = createPullInRepo(repo, String(args.title), typeof args.body === 'string' ? args.body : '', String(args.head), String(args.base));
      if ('error' in pull) return { ok: false, message: pull.error };
      return { ok: true, value: pullObject(repo, pull) };
    }
    case 'merge_pull_request': {
      const miss = missing(args, ['owner', 'repo', 'pull_number']);
      if (miss) return { ok: 'invalid', message: `Missing required argument: ${miss}` };
      const repo = resolveRepo(args);
      if (!repo) return { ok: false, message: 'Not Found' };
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return { ok: false, message: 'Not Found' };
      const merged = squashMergePull(repo, pull);
      if ('error' in merged) return { ok: false, message: merged.error };
      return { ok: true, value: { ...pullObject(repo, pull), merged: true, sha: merged.sha } };
    }
    default:
      return { ok: 'invalid', message: `Unknown tool ${name}` };
  }
}

interface JsonRpcRequest { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown }

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handleRequest(req: JsonRpcRequest): Record<string, unknown> | null {
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? req.params : {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<string, unknown>;
      if (!name) return rpcError(id, -32602, 'tools/call needs a tool name');
      const outcome = callTool(name, args);
      if (outcome.ok === 'invalid') {
        // Unknown tool -> -32601; missing argument -> -32602.
        const code = outcome.message.startsWith('Unknown tool') ? -32601 : -32602;
        return rpcError(id, code, outcome.message);
      }
      if (!outcome.ok) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
      });
    }
    case 'notifications/initialized':
      return null;
    default:
      if (method.startsWith('notifications/')) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path !== '/mcp') return false;
  const headers = { 'x-github-request-id': nextRequestId() };
  if (req.method === 'DELETE') { sendJson(res, 200, {}, headers); return true; }
  if (req.method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }, headers); return true; }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'), headers);
    return true;
  }
  const requests = Array.isArray(body) ? body : [body];
  const responses: Array<Record<string, unknown>> = [];
  for (const entry of requests) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      responses.push(rpcError(null, -32600, 'Invalid Request'));
      continue;
    }
    const rpc = entry as JsonRpcRequest;
    if (rpc.id === undefined) {
      // A notification gets no JSON-RPC response.
      handleRequest(rpc);
      continue;
    }
    const response = handleRequest(rpc);
    if (response) responses.push(response);
  }
  if (!responses.length) {
    // Notifications only: 202, empty body.
    res.writeHead(202, { 'content-length': '0', ...headers });
    res.end();
    return true;
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0], headers);
  return true;
}
