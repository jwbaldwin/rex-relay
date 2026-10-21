import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, resolve } from "node:path";

export async function resolveOpenCodeExecutable(
  configured: string,
  hostExecutable = process.execPath,
  searchPath = process.env.PATH ?? "",
): Promise<string> {
  const nativeHost =
    configured === "opencode" &&
    /^opencode(?:\.exe)?$/.test(basename(hostExecutable));
  const candidates = nativeHost
    ? [hostExecutable]
    : isAbsolute(configured) ||
        configured.includes("/") ||
        configured.includes("\\")
      ? [resolve(configured)]
      : searchPath
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, configured));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      return await realpath(candidate);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))
      )
        continue;
      throw error;
    }
  }
  throw new Error(
    `Rex Relay cannot find the OpenCode executable "${configured}"; set opencodeExecutable to its absolute path`,
  );
}
