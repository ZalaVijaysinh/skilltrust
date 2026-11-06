import type { APIRoute } from "astro";
import { loadData } from "../lib/data.js";

/** Compact leaderboard rows for the filter script. No descriptions: they are untrusted and not shown in the list. */
export const GET: APIRoute = () => {
  const { index, records } = loadData();
  const rows = index.map((e) => ({
    id: e.id, name: e.name, owner: e.owner, repo: e.repo, category: e.category,
    score: e.score, band: e.band, stars: e.stars,
    updated: records.get(e.id)?.scannedAt ?? "",
    stale: e.status === "unavailable", partial: e.incomplete, flagged: e.ruleIds.length,
  }));
  return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json" } });
};
