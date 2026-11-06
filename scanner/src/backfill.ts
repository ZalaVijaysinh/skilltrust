import type { StarsFile } from "./stars.js";

// OSS Insight backfill: SKIPPED (verified 2026-11-07).
// Docs (https://ossinsight.io/docs/api, /docs/api/stargazers-history) list
//   GET https://api.ossinsight.io/v1/repos/{owner}/{repo}/stargazers/history/?per=<period>&from=<date>&to=<date>
// with no documented response example; limits: 600 req/hour/IP, 1000/min global, no auth in beta, no other terms stated.
// Live check (3 requests): per=day for mvanhorn/last30days-skill (x2) and the docs' own example for pingcap/tidb
// (per=month) all returned HTTP 500 {"message":"Internal Server Error"}. The response shape (cumulative vs
// increments) is therefore unconfirmed, so we do not guess a parser.
// shortcut: no-op until the endpoint works; re-verify the shape, then implement fetch + "o" points.
export async function backfillStars(
  _s: StarsFile,
  opts: { fetchImpl?: typeof fetch; today: string; top?: number; warn: (m: string) => void },
): Promise<{ filled: number; skipped: boolean }> {
  opts.warn("skilltrust: OSS Insight star-history endpoint unavailable (HTTP 500, shape unconfirmed); backfill skipped");
  return { filled: 0, skipped: true };
}
