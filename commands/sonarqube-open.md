---
description: Open SonarQube issue source by position or issue key
argument-hint: [target] <n> | [target] issue:<keys>
allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube
---

Call the sonarqube tool with action "open".

Parse the arguments (`$ARGUMENTS`) as space-separated tokens:

- A number `<n>` sets `issueIndex`: the 1-based position in the latest issue list for the target in this session. If no analysis has been run yet, report that and suggest `/sonarqube-analyze` or `/sonarqube-issues`.
- `issue:<keys>` sets `issueKeys` (comma-separated stable issue keys, up to 10). Prefer this form. Never pass both `issueIndex` and `issueKeys`.
- Any other bare token is the target (`path`): a configured alias or project root. Omit `path` if there is none.

Then show the returned source snippets and use them to fix the issues.
