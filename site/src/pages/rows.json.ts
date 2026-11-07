import type { APIRoute } from "astro";
import { loadData } from "../lib/data.js";

/** Compact leaderboard rows for the filter and search script. `d` is the start of the description, for search only:
 * it is untrusted and never shown. */
export const GET: APIRoute = () => {
  const { index, records } = loadData();
  const rows = index.map((e) => ({
    id: e.id, name: e.name, owner: e.owner, repo: e.repo, category: e.category,
    score: e.score, band: e.band, stars: e.stars,
    updated: records.get(e.id)?.scannedAt ?? "",
    stale: e.status === "unavailable", partial: e.incomplete, flagged: e.ruleIds.length,
    d: String(e.description ?? "").replace(/\s+/g, " ").slice(0, 80),
  }));
  return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
};
