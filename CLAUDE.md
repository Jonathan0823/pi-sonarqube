# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Tests run against compiled `dist/`, not `src/`: `npm test` builds first. Single file: `npm run build && node --test test/<name>.test.mjs`
- CI also runs `npm run format:check` (Prettier defaults) and `npx oxlint@latest --quiet`. Run both before pushing.

## Gotchas

- Never hand-edit `dist/`; edit `src/` and rebuild.
- Pi host packages (`@earendil-works/*`, `typebox`) are peer dependencies. Don't move them to `dependencies`.
- When behavior changes, update README and help text in the same change.
- `tasks/` and `.pi/` are gitignored local working state; don't commit them.

## Git

- Conventional commits with scopes, e.g. `feat(sonar): …`, `fix(ui): …`, `chore(deps): …`.
- Branch `feat/…`, `fix/…`, or `chore/…` off `main`, then open a PR to `main`.
- Releases: a `chore(release): x.y.z` commit bumps `package.json`; publishing to npm happens when a GitHub release is created.

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on Jonathan0823/pi-sonarqube via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` + `docs/adr/`. See `docs/agents/domain.md`.
