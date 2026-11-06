import { expect, test } from "vitest";
import { PENALTIES, scoreFindings } from "../src/score.js";
import type { Finding, RuleId } from "../src/types.js";

const f = (ruleId: RuleId, disclosed = false): Finding =>
  ({ ruleId, file: "a.sh", line: 1, excerpt: "", disclosed, automatic: false });

test("no findings scores 100, low", () => expect(scoreFindings([])).toEqual({ score: 100, band: "low" }));
test("each rule counts once", () =>
  expect(scoreFindings([f("network"), f("network"), f("shell")]).score).toBe(90));
test("disclosed rule costs half, rounded up", () =>
  expect(scoreFindings([f("browser-secrets", true)]).score).toBe(87));
test("one disclosed + one undisclosed match of the same rule costs the full penalty", () =>
  expect(scoreFindings([f("downloads-code", true), f("downloads-code")]).score).toBe(85));
test("band edges", () => {
  expect(scoreFindings([f("paid-api"), f("network"), f("shell")]).band).toBe("low");
  expect(scoreFindings([f("obfuscated"), f("browser-secrets")]).band).toBe("review");
  expect(scoreFindings([f("obfuscated"), f("browser-secrets"), f("shell")]).band).toBe("high");
});
test("floors at 0", () =>
  expect(scoreFindings((Object.keys(PENALTIES) as RuleId[]).flatMap(r => [f(r), f(r)])).score).toBe(0));
