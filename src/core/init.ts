import { basename } from "node:path";
import {
  ensureDefaultSonarProjectProperties,
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
  const config: SonarInitConfig = {
    serverUrl: normalizeServerUrl(request.serverUrl),
    projectKey: request.projectKey?.trim() || resolveProjectKey(baseDir, {}),
  };
  const token = request.token?.trim();
  if (token) config.token = token;

  await saveProjectConfig(baseDir, config, env.configDirName);
  await ensureDefaultSonarProjectProperties(baseDir);
  await saveWorkspaceRegistry(
    repoRoot,
    slugify(basename(baseDir)),
    baseDir,
    env.configDirName,
  );

  return [
    `SonarQube config saved to ${projectConfigPath(baseDir, env.configDirName)}`,
    token
      ? "The token was stored in that file. Prefer setting SONARQUBE_TOKEN or SONAR_TOKEN in your environment so it stays out of the transcript and project files."
      : "No token stored. Set SONARQUBE_TOKEN or SONAR_TOKEN in your environment if the server requires authentication.",
  ].join("\n");
}
