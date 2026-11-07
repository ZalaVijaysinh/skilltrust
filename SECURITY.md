# Security

## Reporting a problem in SkillTrust itself

Please report security problems privately, not in a public issue: open the repository's **Security** tab and choose **Report a vulnerability**, or go to https://github.com/ZalaVijaysinh/skilltrust/security/advisories/new.

Examples of what to report this way:

- the finder skill printing or running an install command that does something other than copy the scored commit into `~/.agents/skills` and link it
- the finder or the site trusting text from a scanned skill (names, descriptions, file contents) as instructions or markup
- the scanner executing, importing or evaluating anything it scans
- a way to make the site show a wrong score for a skill you do not control

This is a personal open-source project. I aim to reply within a week and will credit you in the fix unless you ask me not to.

## A skill that is dangerous but scored as low risk

SkillTrust reads files without running them, so it can miss things. If a skill is actively stealing data or installing malware, report it privately as above, and also to GitHub (https://github.com/contact/report-abuse) so the repository can be taken down. For a score you think is wrong but not urgent, open a "This score is wrong" issue.
