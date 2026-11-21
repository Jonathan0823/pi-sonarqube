---
description: Initialize SonarQube config for a project path
argument-hint: [path] [serverUrl] [projectKey]
allowed-tools: mcp__plugin_sonarqube_sonarqube__sonarqube
---

Call the sonarqube tool with action "init", using the arguments "$ARGUMENTS" as path, serverUrl and projectKey in that order. Omit any that are empty. Do not ask for or pass a token; tell the user to set SONARQUBE_TOKEN or SONAR_TOKEN in their environment instead. Then report where the config was written.
