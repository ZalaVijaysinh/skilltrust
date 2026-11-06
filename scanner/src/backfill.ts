import type { StarsFile } from "./stars.js";

// OSS Insight backfill: currently a stub (probed 2026-11-07: 3 of 3 requests returned HTTP 500; may be transient).
// Docs (https://ossinsight.io/docs/api, /docs/api/stargazers-history) list
//   GET https://api.ossinsight.io/v1/repos/{owner}/{repo}/stargazers/history/?per=<period>&from=<date>&to=<date>
// with no documented response example; limits: 600 req/hour/IP, 1000/min global, no auth in beta, no other terms stated.
// Probes: per=day for mvanhorn/last30days-skill (x2) and the docs' own example for pingcap/tidb (per=month)
// all returned HTTP 500 {"message":"Internal Server Error"}. The response shape (cumulative vs
// increments) is therefore unconfirmed, so we do not guess a parser.
// shortcut: no-op until the endpoint works. Re-probe it (e.g. when trending still shows only "New and rising"
// after launch), confirm the shape, then implement the full contract:
//   - run only when s.backfilledAt is unset; take the top (default 300) repos by latest stars
//   - sequential requests, at least 200 ms apart (injectable sleep/fetchImpl)
//   - fill dates in the last 40 days with source "o"; never overwrite own points
//   - stop on the first 429 / 5xx / network error, warn, keep points so far, leave backfilledAt unset
//   - set backfilledAt = today only on completion
export async function backfillStars(
  _s: StarsFile,
  opts: { fetchImpl?: typeof fetch; today: string; top?: number; warn: (m: string) => void },
): Promise<{ filled: number; skipped: boolean }> {
  opts.warn("skilltrust: OSS Insight star-history endpoint not usable (probed 2026-11-07: HTTP 500, may be transient; shape unconfirmed); backfill skipped");
  return { filled: 0, skipped: true };
}
