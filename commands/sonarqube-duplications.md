---
description: Show SonarQube duplications for a target, optionally drilling into one file
argument-hint: [target] [file number]
allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube
---

Call the sonarqube tool with action "duplications". Parse "$ARGUMENTS": a numeric argument is the file number (pass it as fileIndex to see that file's duplicated blocks and line ranges); any other argument is the target (pass it as path). If no file number is given, pass view "list" to list the duplicated files with their stats. Omit anything not provided. Then summarize the result.
