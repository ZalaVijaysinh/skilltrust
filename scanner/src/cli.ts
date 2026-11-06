import { createGitHub } from "./github.js";
import { runScan } from "./pipeline.js";

const token = process.env.SKILLTRUST_TOKEN || process.env.GITHUB_TOKEN;
if (!token) console.warn("skilltrust: no SKILLTRUST_TOKEN or GITHUB_TOKEN set; code search will fail");
/** empty counts as unset */
const num = (name: string, dflt: number) => {
  const v = Number(process.env[name] || dflt);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
};
const minStars = num("SKILLTRUST_MIN_STARS", 10);
const maxMinutes = num("SKILLTRUST_MAX_MINUTES", 240);
const r = await runScan({
  gh: createGitHub({ token, deadline: Date.now() + maxMinutes * 60_000 }), dataDir: "data", now: new Date(), minStars,
  searchBudget: num("SKILLTRUST_SEARCH_BUDGET", 120), maxMinutes,
});
console.log(`skilltrust: scanned ${r.scanned}, skipped ${r.skipped}, unavailable ${r.unavailable}, stoppedEarly ${r.stoppedEarly}`);
if (r.writeSkipped.length) console.log(`skilltrust: write skipped: ${r.writeSkipped.join(", ")}`);
