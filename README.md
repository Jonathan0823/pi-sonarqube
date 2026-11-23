# pi-sonarqube

Run local SonarQube analysis and browse the resulting issues from within Pi or Claude Code. The package ships a Pi extension and a Claude Code plugin (MCP server plus slash commands).

## Requirements

- [Pi](https://github.com/earendil-works/pi) or Claude Code installed
- Node.js (the Claude Code plugin launches its MCP server via `npx`; Pi packages are not needed for it)
- A running SonarQube server (e.g. `http://localhost:9000`)
- `sonar-scanner` available in `$PATH`

## Install

### Pi

```bash
pi install npm:@jonathan0823/pi-sonarqube
```

Or add it to your `settings.json`:

```json
{
  "packages": ["npm:@jonathan0823/pi-sonarqube"]
}
```

Then `/reload` in Pi.

### Claude Code

The repo is also a Claude Code plugin marketplace. The plugin starts the MCP server from the published npm package via `npx`, so Node.js and network access to npm are required.

```
/plugin marketplace add Jonathan0823/pi-sonarqube
/plugin install sonarqube@pi-sonarqube
```

Run `/sonarqube-init [path] [serverUrl] [projectKey]` once per project (defaults: `http://localhost:9000` and the directory slug). It writes `.claude/sonarqube.json` and registers the target in `.claude/sonarqube.workspaces.json`. The Claude Code adapter reads `.claude` first and falls back to existing `.pi` config. Provide tokens through `SONARQUBE_TOKEN` / `SONAR_TOKEN` in your environment rather than in chat, so they stay out of the transcript. If you do store a token in `.claude/sonarqube.json`, add that file to `.gitignore`.

Use `/sonarqube-duplications [target] [file number]` to list duplicated files, or pass a file number to see that file's duplicated blocks and line ranges. Then run `/sonarqube-metrics [target]` (target is a configured alias or project root; omit for the current directory). Set `SONAR_HOST_URL` and credentials as for the Pi extension.

Also available: `/sonarqube-analyze [target] [in:path] [filters]` runs `sonar-scanner`, waits for the SonarQube task, and reports issues and duplication; `/sonarqube-issues [target] [in:path] [filters]` lists the latest issues. Filters are `type:`, `severity:` (legacy), `status:`, `rule:` (either family), and `quality:`, `impactSeverity:` (MQR); `type:` and `severity:` cannot be combined with `quality:` or `impactSeverity:`. `path` must be a target alias or project root, never a source path; use `in:` to scope inside it.

Use `/sonarqube-open [target] <n>` or `/sonarqube-open [target] issue:<keys>` to look at issues and fix them. The agent lists issues (using `issueKeys` for stable keys, up to 10, comma-separated), then reads the source at each reported `file:line` with its own file tools. The MCP tool has no `open` action.

### Claude Code commands

| Command                                           | Description                               |
| ------------------------------------------------- | ----------------------------------------- |
| `/sonarqube-init [path] [serverUrl] [projectKey]` | Set up project config                     |
| `/sonarqube-analyze [target] [in:path] [filters]` | Run analysis, show issues and duplication |
| `/sonarqube-issues [target] [in:path] [filters]`  | List the latest issues                    |
| `/sonarqube-metrics [target]`                     | Show project metrics (no scanner)         |
| `/sonarqube-duplications [target] [file number]`  | Browse duplicated files and blocks        |
| `/sonarqube-open [target] <n>` or `issue:<keys>`  | Look at and fix issues                    |

The `sonarqube` MCP tool exposes the same actions (`analyze`, `issues`, `metrics`, `duplications`) to Claude directly and is always available once the plugin is installed. To test a local build, point `.mcp.json` at `node dist/mcp/server.js`.

## Quick start

The examples below use Pi syntax (`/sonarqube <action>`). In Claude Code use the matching `/sonarqube-<action>` command listed above.

### 1. Init project config

Inside a project directory, run:

```
/sonarqube init
```

For monorepos, you can point at a path directly:

```
/sonarqube init apps/web
/sonarqube init apps/api
```

Pi will ask you for:

- **SonarQube server URL** (prefilled with `http://localhost:9000`)
- **Project key** (default: derived from directory name)
- **Token** (optional, used when your server requires auth)

The config is saved to `<project>/.pi/sonarqube.json`.

### 2. Run analysis

```
/sonarqube analyze
/sonarqube analyze apps/web
/sonarqube analyze apps/api
```

Pi will:

1. Run `sonar-scanner` against your server
2. Wait for the analysis to complete
3. Fetch the latest issues
4. Return a concise summary with issues and duplication metrics

### 3. Browse issues

```
/sonarqube issues
/sonarqube issues apps/web
/sonarqube issues apps/web in:src/components/
```

The target (`apps/web` above) is a configured alias or SonarQube project root. Use `in:` to scope issues to a file or directory inside that project.

Use **Up/Down** to move, **Enter** to preview the affected source code, **Esc** to close, and type to search by issue key, file, rule, severity, status, or message.

Tip: Tab-complete `/sonarqube` subcommands and filters in the editor.

### 4. View project metrics

```
/sonarqube metrics
/sonarqube metrics apps/web
```

Shows coverage percentage, duplicated lines, and issue severity breakdown — no scanner needed.

### 5. Browse duplicated files

```
/sonarqube duplications
/sonarqube duplications apps/web
```

Use **Up/Down** to move, **Enter** for block locations and line ranges, and type to search by file path or duplication stats. Pass a file number directly to skip the browser: `/sonarqube duplications 1`.

### 6. Open a specific issue

```
/sonarqube open 3
/sonarqube open apps/web 3
/sonarqube open apps/web issue:AZ123
/sonarqube open apps/web issue:AZ123,AZ456
```

Issue keys are stable across filtered queries; numeric positions refer only to the current query result.

## Commands (Pi)

| Command                                   | Description                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `/sonarqube init [path]`                  | Set up project config for a path                                           |
| `/sonarqube analyze [target]`             | Run analysis and show issues + duplication metrics                         |
| `/sonarqube issues [target] [in:<scope>]` | Browse project issues, optionally scoped to a file or directory            |
| `/sonarqube metrics [target]`             | Show project metrics (coverage %, duplication %, issue counts, no scanner) |
| `/sonarqube duplications [target]`        | Browse duplicated files and blocks with drill-down                         |
| `/sonarqube open [target] <n>`            | Preview source at positional issue #n                                      |
| `/sonarqube open [target] issue:<keys>`   | Preview source for one or more stable issue keys                           |
| `/sonarqube on\|off\|status`              | Toggle the LLM `sonarqube` tool and scanning/query commands                |
| `/sonarqube`                              | Show help                                                                  |

## Tool (for the LLM)

In Claude Code the `sonarqube` tool is served by the MCP server and is always on; the token-cost note below applies to Pi only.

In Pi, the extension also registers a `sonarqube` tool that the LLM can call with actions. It is disabled by default to keep its prompt guidance and schema out of the active tool context. Use `/sonarqube on`, `/sonarqube off`, or `/sonarqube status` to control it. Project setup and help remain available while disabled; run `/sonarqube on` before scanning or querying results. **Pi only:** as a rough reference, the tool definition and prompt guidance add about 562 tokens per request when enabled, estimated with OpenAI's `o200k_base` tokenizer; actual `gpt-6-luna` token accounting may differ.

- `analyze` — run analysis
- `issues` — list issues in a compact form (`file`, then `key SEVERITY :line rule message`); page with `limit` (default 10, values above 100 are clamped) and `offset`; when more remain, the response ends with a breakdown of the rest by severity, rule and file. `issueKeys` (up to 10) filters to specific issues and reports keys that were not found.
- `metrics` — show project-level coverage, duplication & issue counts
- `duplications` — list duplicated files by default; pass `fileIndex` for that file's duplicated blocks (one readable copy shown, other locations listed)

The `open` action and `issueIndex` were removed from the agent tools; calling them returns a guiding error. The Pi `/sonarqube open` command is unchanged.

For tool calls, `path` selects a configured target alias or SonarQube project root. `pathScope` selects a file or directory inside that project; do not pass source scopes as `path`.

The tool accepts optional issue filters (`severities`, `statuses`, `types`, `rules`, `softwareQualities`, `impactSeverities`) so the agent can fetch just the most relevant issues.

### Filter families

SonarQube supports two filter families depending on the server mode:

- **Standard Experience** (legacy): `type` (BUG, VULNERABILITY, CODE_SMELL) and `severity` (BLOCKER, CRITICAL, MAJOR, MINOR, INFO)
- **MQR mode**: `quality` (MAINTAINABILITY, RELIABILITY, SECURITY) and `impactSeverity` (BLOCKER, HIGH, MEDIUM, LOW, INFO)

Both families can be used from the `/sonarqube issues` command:

```
/sonarqube issues type:BUG
/sonarqube issues severity:CRITICAL status:OPEN
/sonarqube issues quality:RELIABILITY
/sonarqube issues quality:SECURITY impactSeverity:HIGH
```

**Important:** `type:` and `severity:` cannot be combined with `quality:` or `impactSeverity:` in the same query. `status:` and `rule:` work with either family. If you mix them (e.g., `type:BUG quality:SECURITY`), you'll see an error telling you to pick one family.

The server mode is auto-detected via the `api/v2/clean-code-policy/mode` endpoint and cached per session.

Use project-root paths directly for targets and `in:` / `pathScope` for source scopes.

## Configuration sources (precedence order)

1. **Environment variables** (highest)
   - `SONARQUBE_URL` / `SONAR_HOST_URL`
   - `SONARQUBE_TOKEN` / `SONAR_TOKEN`
   - `SONAR_PROJECT_KEY`
2. **Project config** — `.pi/sonarqube.json` (set via `/sonarqube init`); in Claude Code, `.claude/sonarqube.json` (set via `/sonarqube-init`) with `.pi` as fallback. Prefer environment variables for tokens; if a token is stored in `.claude/sonarqube.json`, gitignore that file.
3. **Scan properties** — `sonar-project.properties`
4. **Defaults** — `http://localhost:9000`, project key from directory slug

## Project structure

```
packages/pi-sonarqube/
├── src/
│   ├── index.ts          # Pi adapter: tool, /sonarqube command, session state
│   ├── ui.ts             # Pi TUI: browsers, analysis widget
│   └── core/             # Host-agnostic core (no Pi imports); runSonarAction entry
├── dist/
│   ├── index.js          # Compiled output
│   ├── index.d.ts        # Type declarations
│   └── index.js.map      # Source map
├── fixtures/
│   ├── issue-project/    # Test project with known issues
│   └── clean-project/    # Test project with no issues
├── README.md
├── LICENSE
├── package.json
└── tsconfig.json
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
