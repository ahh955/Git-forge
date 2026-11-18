import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo, type Issue, type Pull } from './store.ts';
import { addObject, buildCommit, buildTreeFromFiles, flattenTree, parseCommit, readTreePath, type ObjectType } from './git-objects.ts';
import { createSquash, diffTrees, mergeBase, mergedTree, treeOid } from './git-ops.ts';
import { fixedNow, nextRequestId, readJson, sendEmpty, sendJson } from './util.ts';

function headers(extra: Record<string, string> = {}): Record<string, string> { return { 'x-github-request-id': nextRequestId(), ...extra }; }
function reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void { sendJson(res, status, body, headers(extra)); }
function fail(res: ServerResponse, status: number, message: string): void { reply(res, status, { message }); }
export function repoObject(repo: Repo): unknown {
  const owner = store.viewerLogin ?? 'viewer', now = fixedNow();
  return { id: repo.id, node_id: Buffer.from(`Repository:${repo.id}`).toString('base64url'), name: repo.name, full_name: `${owner}/${repo.name}`, owner: { login: owner, id: 1000, type: 'User' }, private: repo.private, description: repo.description, default_branch: repo.defaultBranch, has_issues: true, created_at: now, updated_at: now, html_url: `http://github.com/${owner}/${repo.name}`, url: `/api/v3/repos/${owner}/${repo.name}`, clone_url: `http://forge/${owner}/${repo.name}.git` };
}
export function issueObject(repo: Repo, issue: Issue): unknown { return { id: issue.id, node_id: store.gid('Issue', repo, issue.number), number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels.map(name => repo.labels.get(name) ?? { name, color: 'ededed' }), user: { login: store.viewerLogin ?? 'viewer' }, created_at: fixedNow(), updated_at: fixedNow(), comments: (repo.comments.get(issue.number) ?? []).length }; }
export function pullObject(repo: Repo, pull: Pull): unknown { return { id: pull.id, node_id: store.gid('PullRequest', repo, pull.number), number: pull.number, title: pull.title, body: pull.body, state: pull.state, user: { login: store.viewerLogin ?? 'viewer' }, head: { ref: pull.head.ref, sha: pull.head.sha, repo: { full_name: `${store.viewerLogin}/${repo.name}` } }, base: { ref: pull.base.ref, sha: pull.base.sha }, merged: pull.merged, merged_at: pull.merged_at, merge_commit_sha: pull.merge_commit_sha, mergeable: true, created_at: fixedNow(), updated_at: fixedNow() }; }
function commitRef(repo: Repo, ref?: string | null): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  return repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`) ?? (repo.objects.get(ref)?.type === 'commit' ? ref : null);
}
function pathSegments(raw: string): string { if (!raw.includes('%')) return raw.replace(/^\/+|\/+$/g, ''); try { return decodeURIComponent(raw).replace(/^\/+|\/+$/g, ''); } catch { return raw; } }
function commitContent(repo: Repo, branch: string, path: string, bytes: Buffer, message: string): { blob: string; commit: string; created: boolean } {
  let tip = repo.refs.get(`refs/heads/${branch}`); if (!tip && branch !== repo.defaultBranch) tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const oldTree = tip ? treeOid(repo, tip) : null, files = oldTree ? flattenTree(repo, oldTree) : new Map<string, { oid: string; mode: string }>();
  const old = files.get(path); files.set(path, { oid: addObject(repo, 'blob', bytes), mode: '100644' });
  const tree = buildTreeFromFiles(repo, files), login = store.viewerLogin ?? 'forge', identity = `${login} <${login}@example.invalid>`;
  const commit = addObject(repo, 'commit', buildCommit({ tree, parents: tip ? [tip] : [], message, identity }));
  repo.refs.set(`refs/heads/${branch}`, commit); store.changedRefs(repo);
  return { blob: files.get(path)!.oid, commit, created: !old };
}
function commitDelete(repo: Repo, branch: string, path: string, message: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`), tree = tip ? treeOid(repo, tip) : null; if (!tree) return null;
  const files = flattenTree(repo, tree); if (!files.delete(path)) return null;
  const newTree = buildTreeFromFiles(repo, files), login = store.viewerLogin ?? 'forge';
  const sha = addObject(repo, 'commit', buildCommit({ tree: newTree, parents: [tip!], message, identity: `${login} <${login}@example.invalid>` }));
  repo.refs.set(`refs/heads/${branch}`, sha); store.changedRefs(repo); return sha;
}

export async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  if (!path.startsWith('/api/v3')) return false;
  const parts = path.slice('/api/v3'.length).split('/').filter(Boolean).map(x => { if (!x.includes('%')) return x; try { return decodeURIComponent(x); } catch { return x; } });
  const method = req.method ?? 'GET';
  if (!parts.length && method === 'GET') { reply(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return true; }
  if (parts[0] === 'meta' && method === 'GET') { reply(res, 200, { installed_version: '1.0.0' }); return true; }
  if (parts[0] === 'user' && parts[1] === 'repos' && method === 'POST') {
    let body: Record<string, unknown>; try { body = await readJson(req); } catch { fail(res, 400, 'Malformed JSON'); return true; }
    const name = typeof body.name === 'string' ? body.name : ''; if (!name) { fail(res, 422, 'name is required'); return true; }
    if (store.repos.has(name)) { fail(res, 422, 'Repository already exists'); return true; }
    const repo = store.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true); reply(res, 201, repoObject(repo)); return true;
  }
  if (parts[0] === 'user' && parts[1] === 'repos' && method === 'GET') {
    const owner = store.viewerLogin; const all = [...store.repos.values()].sort((a,b)=>a.createdSeq-b.createdSeq);
    const per = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? 30) || 30)), page = Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1), list = all.slice((page-1)*per,page*per);
    const extra: Record<string,string> = {};
    if ((page * per) < all.length) { const base = `${url.protocol}//${req.headers.host ?? '127.0.0.1'}/api/v3/user/repos`; extra.link = `<${base}?per_page=${per}&page=${page+1}>; rel="next"`; }
    reply(res, 200, list.map(repoObject), extra); return true;
  }
  if (parts[0] === 'user' && method === 'GET') {
    if (!store.viewerLogin) fail(res, 404, 'Not Found'); else reply(res, 200, { login: store.viewerLogin, id: 1000, name: store.viewerLogin, email: `${store.viewerLogin}@example.invalid`, type: 'User' }); return true;
  }
  if (parts[0] !== 'repos' || parts.length < 3) { fail(res, 404, 'Not Found'); return true; }
  const [, owner, name, ...tail] = parts; if (!store.pin(owner!)) { fail(res, 404, 'Not Found'); return true; }
  const repo = store.repos.get(name!); if (!repo) { fail(res, 404, 'Not Found'); return true; }
  if (!tail.length) {
    if (method === 'GET') { reply(res, 200, repoObject(repo)); return true; }
    if (method === 'PATCH') { let b; try { b = await readJson(req); } catch { fail(res,400,'Malformed JSON'); return true; } if (typeof b.description === 'string') repo.description=b.description; if (typeof b.private==='boolean') repo.private=b.private; reply(res,200,repoObject(repo)); return true; }
    if (method === 'DELETE') { store.repos.delete(repo.name); sendEmpty(res,204,headers()); return true; }
  }
  if (tail[0] === 'branches' && method === 'GET') {
    const branches = [...repo.refs].filter(([r])=>r.startsWith('refs/heads/')).sort((a,b)=>a[0].localeCompare(b[0]));
    if (tail.length === 1) reply(res,200,branches.map(([r,sha])=>({name:r.slice(11),commit:{sha}})));
    else { const ref = `refs/heads/${tail.slice(1).join('/')}`, sha=repo.refs.get(ref); if(!sha) fail(res,404,'Not Found'); else { const c=repo.objects.get(sha); reply(res,200,{name:ref.slice(11),commit:{sha,commit:{message:c?.type==='commit'?parseCommit(c.data).message:''}}}); } } return true;
  }
  if (tail[0] === 'commits' && method === 'GET') {
    let tip=commitRef(repo,url.searchParams.get('sha')); if(url.searchParams.has('sha')&&!tip){fail(res,404,'Not Found');return true;} const result=[]; const seen=new Set<string>();
    while(tip&&!seen.has(tip)){seen.add(tip);const o=repo.objects.get(tip);if(!o||o.type!=='commit')break;const c=parseCommit(o.data);result.push({sha:tip,commit:{message:c.message.replace(/\n$/,''),author:{name:c.author},committer:{name:c.committer}}});tip=c.parents[0]??null;}
    reply(res,200,result); return true;
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) { let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const ref=String(b.ref??''),sha=String(b.sha??'');if(!ref.startsWith('refs/')||!repo.objects.has(sha)||repo.refs.has(ref)){fail(res,422,'Invalid ref or object');return true;}repo.refs.set(ref,sha);store.changedRefs(repo);reply(res,201,{ref,object:{sha}});return true; }
    if (method === 'GET') { const ref=`refs/${tail.slice(2).join('/')}`,sha=repo.refs.get(ref);if(!sha)fail(res,404,'Not Found');else reply(res,200,{ref,object:{sha}});return true; }
  }
  if (tail[0] === 'contents') {
    const rel=pathSegments(tail.slice(1).join('/'));
    if(method==='PUT') { let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const branch=String(b.branch??repo.defaultBranch),tip=repo.refs.get(`refs/heads/${branch}`),tree=tip?treeOid(repo,tip):null,existing=tree?flattenTree(repo,tree).get(rel):undefined;if(existing&&b.sha!==existing.oid){fail(res,409,'sha does not match current file');return true;}if(typeof b.content!=='string'){fail(res,422,'content is required');return true;}const bytes=Buffer.from(b.content.replace(/[\r\n\t ]/g,''),'base64'),made=commitContent(repo,branch,rel,bytes,String(b.message??''));reply(res,made.created?201:200,{content:{name:rel.split('/').at(-1),path:rel,sha:made.blob,size:bytes.length,encoding:'base64',content:bytes.toString('base64'),type:'file'},commit:{sha:made.commit}});return true; }
    if(method==='DELETE') { let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const sha=commitDelete(repo,String(b.branch??repo.defaultBranch),rel,String(b.message??''));if(!sha)fail(res,404,'Not Found');else reply(res,200,{commit:{sha}});return true; }
    if(method==='GET') { const tip=commitRef(repo,url.searchParams.get('ref')),tree=tip?treeOid(repo,tip):null;if(!tree){fail(res,404,'Not Found');return true;}const files=flattenTree(repo,tree),entry=files.get(rel);if(entry){const blob=repo.objects.get(entry.oid);if(!blob){fail(res,404,'Not Found');return true;}const bytes=blob.data;reply(res,200,{type:'file',encoding:'base64',content:bytes.toString('base64'),sha:entry.oid,size:bytes.length,name:rel.split('/').at(-1),path:rel});return true;}const entries=readTreePath(repo,tree,rel);if(!entries){fail(res,404,'Not Found');return true;}const list=entries.map(e=>e.mode==='40000'?{type:'dir',name:e.name,path:rel?`${rel}/${e.name}`:e.name,sha:e.oid}:{type:'file',name:e.name,path:rel?`${rel}/${e.name}`:e.name,sha:e.oid,size:repo.objects.get(e.oid)?.data.length??0});reply(res,200,list.sort((a,b)=>a.name.localeCompare(b.name)));return true; }
  }
  if (tail[0] === 'labels') {
    if(method==='POST'){let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const name=String(b.name??'');if(!name){fail(res,422,'name is required');return true;}if(repo.labels.has(name)){fail(res,422,'Label already exists');return true;}const label={name,color:String(b.color??'ededed').replace(/^#/,'')};repo.labels.set(name,label);reply(res,201,label);return true;}
    if(method==='GET'){reply(res,200,[...repo.labels.values()]);return true;}
  }
  if (tail[0] === 'issues') {
    if(tail.length===1&&method==='POST'){let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const labels=Array.isArray(b.labels)?b.labels.map(String):[];if(labels.some(x=>!repo.labels.has(x))){fail(res,422,'Label does not exist');return true;}const number=store.nextIssueNumber(repo),issue:Issue={id:store.nextItemId(),number,title:String(b.title??''),body:String(b.body??''),state:'open',labels,createdSeq:store.nextSeq(),updatedSeq:store.nextSeq()};repo.issues.set(number,issue);reply(res,201,issueObject(repo,issue));return true;}
    if(tail.length===1&&method==='GET'){const state=url.searchParams.get('state')??'open',direction=url.searchParams.get('direction')??'desc',per=Math.max(1,Number(url.searchParams.get('per_page')??30)||30),page=Math.max(1,Number(url.searchParams.get('page')??1)||1);let items=[...repo.issues.values()].filter(i=>state==='all'||i.state===state).sort((a,b)=>a.createdSeq-b.createdSeq);if(direction==='desc')items.reverse();reply(res,200,items.slice((page-1)*per,page*per).map(i=>issueObject(repo,i)));return true;}
    const number=Number(tail[1]),issue=repo.issues.get(number);if(!issue){fail(res,404,'Not Found');return true;}
    if(tail.length===2&&method==='GET'){reply(res,200,issueObject(repo,issue));return true;}
    if(tail.length===2&&method==='PATCH'){let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}if(b.state==='open'||b.state==='closed')issue.state=b.state;if(typeof b.title==='string')issue.title=b.title;if(typeof b.body==='string')issue.body=b.body;issue.updatedSeq=store.nextSeq();reply(res,200,issueObject(repo,issue));return true;}
    if(tail[2]==='comments'&&method==='POST'){let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const comment={id:store.nextItemId(),body:String(b.body??''),createdSeq:store.nextSeq()};const list=repo.comments.get(number)??[];list.push(comment);repo.comments.set(number,list);reply(res,201,{...comment,user:{login:store.viewerLogin},created_at:fixedNow()});return true;}
    if(tail[2]==='comments'&&method==='GET'){reply(res,200,(repo.comments.get(number)??[]).map(c=>({...c,user:{login:store.viewerLogin},created_at:fixedNow()})));return true;}
  }
  if (tail[0] === 'pulls') {
    if(tail.length===1&&method==='POST'){let b;try{b=await readJson(req);}catch{fail(res,400,'Malformed JSON');return true;}const head=String(b.head??''),base=String(b.base??repo.defaultBranch),headSha=repo.refs.get(`refs/heads/${head}`),baseSha=repo.refs.get(`refs/heads/${base}`);if(!headSha||!baseSha){fail(res,422,'Head or base branch does not exist');return true;}if([...repo.pulls.values()].some(p=>p.state==='open'&&p.head.ref===head&&p.base.ref===base)){fail(res,422,'A pull request already exists');return true;}const number=store.nextIssueNumber(repo),pull:Pull={id:store.nextItemId(),number,title:String(b.title??''),body:String(b.body??''),state:'open',head:{ref:head,sha:headSha},base:{ref:base,sha:baseSha},merged:false,merged_at:null,merge_commit_sha:null,createdSeq:store.nextSeq()};repo.pulls.set(number,pull);reply(res,201,pullObject(repo,pull));return true;}
    if(tail.length===1&&method==='GET'){const state=url.searchParams.get('state')??'open',per=Math.max(1,Number(url.searchParams.get('per_page')??30)||30),page=Math.max(1,Number(url.searchParams.get('page')??1)||1),items=[...repo.pulls.values()].filter(p=>state==='all'||p.state===state).sort((a,b)=>a.createdSeq-b.createdSeq);reply(res,200,items.slice((page-1)*per,page*per).map(p=>pullObject(repo,p)));return true;}
    const n=Number(tail[1]),pull=repo.pulls.get(n);if(!pull){fail(res,404,'Not Found');return true;}
    if(tail.length===2&&method==='GET'){reply(res,200,pullObject(repo,pull));return true;}
    if(tail[2]==='files'&&method==='GET'){reply(res,200,diffTrees(repo,mergeBase(repo,pull.base.sha,pull.head.sha),pull.head.sha));return true;}
    if(tail[2]==='merge'&&method==='PUT'){const base=repo.refs.get(`refs/heads/${pull.base.ref}`)??pull.base.sha,head=pull.head.sha,common=mergeBase(repo,base,head)??base,merged=mergedTree(repo,common,head,base);if(merged.conflict||!merged.tree){fail(res,405,'Pull request cannot be cleanly merged');return true;}const sha=createSquash(repo,merged.tree,base,n,store.viewerLogin??'forge');repo.refs.set(`refs/heads/${pull.base.ref}`,sha);store.changedRefs(repo);pull.state='closed';pull.merged=true;pull.merged_at=fixedNow();pull.merge_commit_sha=sha;reply(res,200,{merged:true,sha,message:'Pull request successfully merged'});return true;}
  }
  fail(res,404,'Not Found'); return true;
}
