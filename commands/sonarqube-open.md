---
description: Look at and fix SonarQube issues by position or issue key
argument-hint: [target] <n> | [target] issue:<keys>
allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube, Read, Grep, Edit
---

Parse the arguments (`$ARGUMENTS`) as space-separated tokens:

- Any bare token that is not a number or `issue:<keys>` is the target (`path`): a configured alias or project root. Omit `path` if there is none.
- A number `<n>` is a 1-based position in the issue list for that target:
  - Use the latest issue list in this conversation only if it was fetched for the same target (same `path`, or both without one) and its shown range includes position `n`.
  - Otherwise call the sonarqube tool with action "issues", `path` set to the target (if any), the same filters as that earlier list (if any), and `offset: n - 1`, `limit: 1`. The single issue returned is issue `n`.
- `issue:<keys>`: call the sonarqube tool with action "issues", `path` set to the target (if any), and `issueKeys` (comma-separated stable issue keys, up to 10).

Then read the source at each issue's reported `file:line` yourself with your file tools, and fix the issue.
