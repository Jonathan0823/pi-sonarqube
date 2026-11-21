---
description: Run a SonarQube analysis and report issues and duplication
argument-hint: [target] [in:path] [type:|severity:|status:|rule:|quality:|impactSeverity:...]
allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube
---

Call the sonarqube tool with action "analyze".

Parse the arguments (`$ARGUMENTS`) as space-separated tokens:

- `in:<path>` sets `pathScope` (a file or directory inside the target).
- `type:`, `severity:`, `status:`, `rule:` set the legacy filters `types`, `severities`, `statuses`, `rules` (comma-separated values allowed).
- `quality:`, `impactSeverity:` set the MQR filters `softwareQualities`, `impactSeverities`. Never mix legacy and MQR filters.
- Any other bare token is the target (`path`): a configured alias or project root. Omit `path` if there is none.

Then summarize the issue counts and duplication metrics.
