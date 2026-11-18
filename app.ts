import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { nextRequestId, sendJson, errorMessage, Query } from './src/util.ts';

const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res) => {
    // No `new URL()` per request: clients send origin-form URLs, so the path is
    // everything before the first '?' and the query everything after it. (An
    // absolute-form URL falls back to URL parsing, as before.)
    const raw = req.url ?? '/';
    let path: string;
    let query: Query;
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const url = (() => { try { return new URL(raw); } catch { return new URL('/', 'http://entry'); } })();
      path = url.pathname;
      query = new Query(url.search.slice(1));
    } else {
      const q = raw.indexOf('?');
      path = q < 0 ? raw : raw.slice(0, q);
      if (!path) path = '/';
      query = new Query(q < 0 ? '' : raw.slice(q + 1));
    }
    if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    const reqId = nextRequestId();
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || (expectedToken && token !== expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': reqId }); return;
    }
    try {
      if (await handleRest(req, res, path, query)) return;
      if (await handleGraphQL(req, res, path)) return;
      if (await handleMcp(req, res, path)) return;
      if (await handleGit(req, res, path, query)) return;
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': reqId });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { message: errorMessage(error) }, { 'x-github-request-id': reqId });
      else res.end();
    }
  });
}
