# makefun git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ahh955/Git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ahh955/Git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process — no UI, no git
binary, no dependencies, no network at runtime. Built as an entry for the make.fun
bounty **“Build a GitHub-compatible git forge”**
(https://make.fun/bounty/github-core-clone-01).

It serves, from its own in-memory object store:

| Surface | What it does |
| --- | --- |
| Git smart HTTP at `/<owner>/<repo>.git` | `git-upload-pack` protocol v2 (ls-refs, fetch, shallow/deepen) and `git-receive-pack` v0 (push with per-ref report-status, fast-forward enforcement) |
| REST v3 under `/api/v3` | Repositories, branches, commits, contents, labels, issues, comments, pull requests, files, squash merges |
| GraphQL v4 at `/api/graphql` | The documents `gh` and `github-mcp-server` send, plus introspection, cursor pagination, and operation batching |
| MCP at `/mcp` | Model Context Protocol (JSON-RPC 2.0, revision 2026-07-28) with `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| `GET /healthz` | `200 {"ok":true}` boot probe |

Every API call takes `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a repository belongs
to the login that token names. All state lives in memory: the forge is deterministic
(fixed timestamps, no randomness in responses) so a trial and its replay agree.

## Run it

```sh
node main.ts
```

Requires Node 22.18+ (type stripping is on by default) and the environment variables
the trial provides: `MAKEFUN_ENV_URL` (the harness to register with) and
`MAKEFUN_SHOP_TOKEN` (the bearer token the suite presents). There is nothing to
install: the program imports `node:http`, `node:crypto`, `node:zlib` and its own
modules only. `main.ts` binds an ephemeral port, registers it with the env, serves
until the env reports done, and exits 0.

For local development, run just the server on a fixed port with a small script that
imports `createApp` from `app.ts` and listens on `127.0.0.1:4123` (the grading
runner below is pointed at that origin):

```js
import { createApp } from './app.ts';
createApp().listen(4123, '127.0.0.1');
```

with `MAKEFUN_SHOP_TOKEN` set to whatever token the test client sends.

## Test it

The kit ships the exact conformance suite the grader runs (120 checks) plus four
timed workloads (push / clone / read / write). Against a locally running server:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:4123 --token test-token-123 [--perf]
```

Local result (2026-11-17, fresh server, one run with `--perf`): **120/120 checks
pass** — git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, graphql
20/20, mcp 15/15 — with perf 191/200 (push 50, clone 46, read 50, write 45), for a
total score of **991/1000** against the kit's shipped suite. The house reference
forge scores about 900 on the same scale, so this entry clears the bar of scoring
strictly above it — on the kit's suite; the sealed grader may differ.

## Layout

- `main.ts` — entry ↔ env lifecycle (bind, register, wait for done). Kept as shipped.
- `app.ts` — the HTTP server and router.
- `src/store.ts` — the in-memory store: repositories, issues, pull requests, labels.
- `src/git-objects.ts` — git objects (commit/tree/blob/tag), hashing, parsing.
- `src/git-pack.ts` — pkt-line codec, packfile read (with deltas) and write, sideband.
- `src/git-ops.ts` — reachability, merge-base, tree diff, three-way merge.
- `src/git-http.ts` — smart-HTTP handlers (info/refs, upload-pack, receive-pack).
- `src/rest.ts` — the REST v3 API.
- `src/graphql.ts` — the GraphQL v4 API (small parser + executor).
- `src/mcp.ts` — the MCP endpoint and tools.
- `src/mutations.ts` — shared create/close/merge logic used by GraphQL and MCP.
- `src/util.ts` — JSON replies, request ids, fixed timestamps, base64 helpers.

## Links

- Bounty: https://make.fun/bounty/github-core-clone-01
- make.fun referral link: https://make.fun/r/xsff4jzh

## License

MIT — see [LICENSE](LICENSE).
