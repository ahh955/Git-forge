// bench.ts — standalone latency benchmark for a running forge server.
//
// Measures per-path HTTP GET latency (mean, median, p95) and throughput
// (requests per second) against a server that is already running.
//
// Run:  npx tsx scripts/bench.ts <baseUrl> [repeats] <path> [<path> ...]
//   <baseUrl>  server origin, e.g. http://127.0.0.1:4000
//   [repeats]  optional positive integer, requests per path (default 20)
//   <path>     one or more request paths, e.g. /api/v3 /api/v3/meta
//
// Uses only Node built-in modules and imports nothing from the repository.

import { get } from "http";
import { performance } from "perf_hooks";

interface PathStats {
  path: string;
  samples: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  rps: number;
}

function usage(): never {
  console.error("usage: bench.ts <baseUrl> [repeats] <path> [<path> ...]");
  process.exit(2);
}

// One GET request; resolves with its latency in milliseconds.
function timeGet(url: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const start: number = performance.now();
    const req = get(url, (res) => {
      // Drain the body so the socket is released promptly.
      res.resume();
      res.on("end", () => resolve(performance.now() - start));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error(`timeout: ${url}`)));
  });
}

// Nearest-rank percentile over latencies already sorted ascending.
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank: number = Math.ceil((p / 100) * sorted.length);
  const index: number = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  const value: number | undefined = sorted[index];
  return value === undefined ? 0 : value;
}

// Mean, median, p95 and throughput from one path's latency samples.
function summarize(path: string, latencies: number[]): PathStats {
  const sorted: number[] = [...latencies].sort((a, b) => a - b);
  const totalMs: number = latencies.reduce((sum, value) => sum + value, 0);
  const meanMs: number = totalMs / latencies.length;
  const medianMs: number = percentile(sorted, 50);
  const p95Ms: number = percentile(sorted, 95);
  const rps: number = latencies.length / (totalMs / 1000);
  return { path, samples: latencies.length, meanMs, medianMs, p95Ms, rps };
}

async function main(): Promise<void> {
  const args: string[] = process.argv.slice(2);
  if (args.length < 2) usage();
  const baseRaw: string | undefined = args[0];
  if (baseRaw === undefined) usage();
  const baseUrl: string = baseRaw.replace(/\/+$/, "");
  // The second argument is a repeat count when it is a plain integer.
  let repeats: number = 20;
  let paths: string[] = args.slice(1);
  const second: string | undefined = args[1];
  if (second !== undefined && /^\d+$/.test(second) && args.length >= 3) {
    repeats = Number.parseInt(second, 10);
    paths = args.slice(2);
  }
  if (repeats < 1 || paths.length === 0) usage();

  const results: PathStats[] = [];
  for (const path of paths) {
    const url: string = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const latencies: number[] = [];
    // Sequential requests: one in flight at a time.
    for (let i = 0; i < repeats; i++) {
      latencies.push(await timeGet(url));
    }
    const stats: PathStats = summarize(path, latencies);
    results.push(stats);
    console.log(
      `${stats.path}: n=${stats.samples} ` +
        `mean=${stats.meanMs.toFixed(2)}ms ` +
        `median=${stats.medianMs.toFixed(2)}ms ` +
        `p95=${stats.p95Ms.toFixed(2)}ms ` +
        `${stats.rps.toFixed(1)} req/s`,
    );
  }
  // Short summary: the path with the slowest p95.
  const slowest: PathStats = results.reduce((a, b) => (a.p95Ms >= b.p95Ms ? a : b));
  console.log(
    `slowest p95: ${slowest.path} at ${slowest.p95Ms.toFixed(2)}ms across ${results.length} path(s)`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
