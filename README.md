# pi-sonarqube

A Pi extension to run local SonarQube analysis and browse the resulting issues — all from within Pi.

## Requirements

- [Pi](https://github.com/earendil-works/pi) installed
- A running SonarQube server (e.g. `http://localhost:9000`)
- `sonar-scanner` available in `$PATH`

## Install

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

## Quick start

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
```

Use **Up/Down** to move, **Enter** to preview the affected source code, and **Esc** to close.

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

Use **Up/Down** to move, **Enter** for block locations and line ranges. Pass a file number directly to skip the browser: `/sonarqube duplications 1`.

### 6. Open a specific issue

```
/sonarqube open 3
/sonarqube open apps/web 3
```

## Commands

| Command                          | Description                                     |
| -------------------------------- | ----------------------------------------------- |
| `/sonarqube init [path]`         | Set up project config for a path               |
| `/sonarqube analyze [target]`    | Run analysis and show issues + duplication metrics |
| `/sonarqube issues [target]`     | Browse the latest analysis results for a target |
| `/sonarqube metrics [target]`    | Show project metrics (coverage %, duplication %, issue counts, no scanner) |
| `/sonarqube duplications [target]` | Browse duplicated files and blocks with drill-down         |
| `/sonarqube open [target] <n>`   | Preview source at issue #n                     |

## Tool (for the LLM)

The extension also registers a `sonarqube` tool that the LLM can call with actions:

- `analyze` — run analysis
- `issues` — list issues
- `metrics` — show project-level coverage, duplication & issue counts
- `duplications` — list duplicated files and block details
- `open` — open an issue with its index

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

**Important:** Legacy filters and MQR filters cannot be combined in the same query. If you mix them (e.g., `type:BUG quality:SECURITY`), you'll see an error telling you to pick one family.

The server mode is auto-detected via the `api/v2/clean-code-policy/mode` endpoint and cached per session.

Use paths directly.

## Configuration sources (precedence order)

1. **Environment variables** (highest)
   - `SONARQUBE_URL` / `SONAR_HOST_URL`
   - `SONARQUBE_TOKEN` / `SONAR_TOKEN`
   - `SONAR_PROJECT_KEY`
2. **Project config** — `.pi/sonarqube.json` (set via `/sonarqube init`)
3. **Scan properties** — `sonar-project.properties`
4. **Defaults** — `http://localhost:9000`, project key from directory slug

## Project structure

```
packages/pi-sonarqube/
├── src/
│   └── index.ts          # Extension source + init command + config
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
