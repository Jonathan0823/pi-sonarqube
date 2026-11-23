---
description: Look at and fix SonarQube issues by position or issue key
argument-hint: [target] <n> | [target] issue:<keys>
allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube, Read, Grep, Edit
---

Parse the arguments (`$ARGUMENTS`) as space-separated tokens:

- A number `<n>`: use the nth issue from the latest issue list in this conversation. If there is no list yet, call the sonarqube tool with action "issues" first.
- `issue:<keys>`: call the sonarqube tool with action "issues" and `issueKeys` (comma-separated stable issue keys, up to 10).
- Any other bare token is the target (`path`): a configured alias or project root. Omit `path` if there is none.

Then read the source at each issue's reported `file:line` yourself with your file tools, and fix the issue.
