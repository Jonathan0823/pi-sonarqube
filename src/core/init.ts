import { basename, relative } from "node:path";
import {
  ensureDefaultSonarProjectProperties,
  loadProjectConfig,
  loadWorkspaceRegistry,
  normalizeServerUrl,
  projectConfigPath,
  resolveInitTarget,
  resolveProjectKey,
  saveProjectConfig,
  saveWorkspaceRegistry,
  slugify,
} from "./config.js";
import type { SonarInitConfig } from "./types.js";

export interface SonarInitRequest {
  path?: string;
  serverUrl?: string;
  projectKey?: string;
  token?: string;
}

/** Non-interactive project setup: writes project config and registers the target. */
export async function initProject(
  request: SonarInitRequest,
  env: { cwd: string; configDirName: string },
): Promise<string> {
  const { baseDir, repoRoot } = await resolveInitTarget(
    env,
    undefined,
    request.path,
  );
  const saved = await loadProjectConfig(baseDir, env.configDirName);
  const config: SonarInitConfig = {
    serverUrl: normalizeServerUrl(request.serverUrl || saved?.serverUrl),
    projectKey:
      request.projectKey?.trim() ||
      saved?.projectKey ||
      resolveProjectKey(baseDir, {}),
  };
  const token = request.token?.trim() || saved?.token;
  if (token) config.token = token;

  await saveProjectConfig(baseDir, config, env.configDirName);
  await ensureDefaultSonarProjectProperties(baseDir);
  const { registry } = await loadWorkspaceRegistry(repoRoot, env.configDirName);
  const baseAlias = slugify(basename(baseDir));
  const relBase = relative(repoRoot, baseDir) || ".";
  let alias = baseAlias;
  let n = 2;
  while (registry.workspaces[alias] && registry.workspaces[alias] !== relBase) {
    alias = `${baseAlias}-${n}`;
    n++;
  }
  await saveWorkspaceRegistry(repoRoot, alias, baseDir, env.configDirName);

  return [
    `SonarQube config saved to ${projectConfigPath(baseDir, env.configDirName)}`,
    token
      ? `The token was stored in that file. Add ${env.configDirName}/sonarqube.json to .gitignore so it is not committed, and prefer setting SONARQUBE_TOKEN or SONAR_TOKEN in your environment so it stays out of the transcript and project files.`
      : "No token stored. Set SONARQUBE_TOKEN or SONAR_TOKEN in your environment if the server requires authentication.",
  ].join("\n");
}
