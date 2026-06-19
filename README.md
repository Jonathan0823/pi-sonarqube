# @jonathan0823/pi-sonarqube

A Pi extension to run local SonarQube analysis and browse the resulting issues — all from within Pi.

## Requirements

- [Pi](https://github.com/earendil-works/pi-coding-agent) installed
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

Pi will ask you for:
- **SonarQube server URL** (default: `http://localhost:9000`)
- **Project key** (default: derived from directory name)
- **Token** (optional, used when your server requires auth)

The config is saved to `<project>/.pi/sonarqube.json` and stays out of version control by default.

### 2. Run analysis

```
/sonarqube analyze
```

Or point to a different directory:

```
/sonarqube analyze /path/to/project
```

Pi will:
1. Run `sonar-scanner` against your server
2. Wait for the analysis to complete
3. Fetch the latest issues
4. Show a browseable issue list

### 3. Browse issues

```
/sonarqube issues
```

Use **Up/Down** to move, **Enter** to preview the affected source code, and **Esc** to close.

### 4. Open a specific issue

```
/sonarqube open 3
```

## Commands

| Command | Description |
|---------|-------------|
| `/sonarqube init` | Set up project-local SonarQube config |
| `/sonarqube analyze [path]` | Run analysis and browse issues |
| `/sonarqube issues` | Browse the latest analysis results |
| `/sonarqube open <n>` | Preview source at issue #n |

## Tool (for the LLM)

The extension also registers a `sonarqube` tool that the LLM can call with actions:
- `analyze` — run analysis
- `issues` — list issues
- `open` — open an issue with its index

## Configuration sources (precedence order)

1. **Environment variables** (highest)
   - `SONARQUBE_URL` / `SONAR_HOST_URL`
   - `SONARQUBE_TOKEN` / `SONAR_TOKEN`
   - `SONAR_PROJECT_KEY`
2. **Project config** — `.pi/sonarqube.json` (set via `/sonarqube init`)
3. **Scan properties** — `sonar-project.properties`
4. **Defaults** — `http://localhost:9000`, project key from directory slug

## Publishing

### Prerequisites

- An [npm](https://www.npmjs.com/) account
- The npm scope `@jonathan0823` assigned to your npm user

### Publish

```bash
cd packages/pi-sonarqube

# Login if needed
npm login

# Publish (builds automatically via prepack)
npm publish
```

### Publish a new version

```bash
# Update version in package.json
npm version patch  # or minor / major

# Publish
npm publish
```

### Test locally before publishing

```bash
cd packages/pi-sonarqube

# Create a tarball
npm pack

# Install it in a test project
cd /tmp/test-project
npm install /path/to/pi-sonarqube-0.1.0.tgz
```

## Manual via `pi install`

You can also install directly from a local path:

```bash
pi install /path/to/packages/pi-sonarqube
```

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

## License

MIT
