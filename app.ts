import { createServer, type IncomingMessage, type Server } from 'node:http';
import { handleGit } from './src/git-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { nextRequestId, sendJson, errorMessage } from './src/util.ts';

const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

export function createApp(): Server {
  return createServer(async (req: IncomingMessage, res) => {
    const url = (() => { try { return new URL(req.url ?? '/', 'http://entry'); } catch { return new URL('/', 'http://entry'); } })();
    const path = url.pathname;
    if (req.method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
    const reqId = nextRequestId();
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || (expectedToken && token !== expectedToken)) {
      sendJson(res, 401, { message: 'Bad credentials' }, { 'x-github-request-id': reqId }); return;
    }
    try {
      if (await handleRest(req, res, path, url)) return;
      if (await handleGraphQL(req, res, path)) return;
      if (await handleMcp(req, res, path)) return;
      if (await handleGit(req, res, path, url)) return;
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': reqId });
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { message: errorMessage(error) }, { 'x-github-request-id': reqId });
      else res.end();
    }
  });
}
