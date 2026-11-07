# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Set up

Needs Node 24 or newer.

```
npm ci
npm test
npx tsc --noEmit
SKILLTRUST_DATA=site/test/fixtures/data npm run site:build
```

Please don't run `npm run scan` against the live GitHub API for long: the daily scan runs in GitHub Actions.

## Rules the code keeps

These protect the people who use SkillTrust and the authors whose skills it describes. A change that breaks one will not be merged.

- The scanner never executes, imports or evaluates the code it scans, and every regular expression is bounded (there are adversarial performance tests).
- All text from scanned repositories is untrusted: it is escaped on the site and treated as data by the finder.
- Installs never delete or overwrite anything; the model never assembles an install command itself.
- Wording says what a skill **can do**, never that it is malware or that its author means harm.
- Any change to a rule or a penalty bumps `RULES_VERSION` in `scanner/src/rules.ts`, so every skill is rescanned.

## Disputing a score

If you wrote a skill and think its score is wrong, open a "This score is wrong" issue with a link to the skill page and the lines in question. If a rule misfires, the fix goes into the rule for everyone, not an exception for one skill.

## Pull requests

Keep each pull request to one change, with tests. Describe what changed and why in plain words.
