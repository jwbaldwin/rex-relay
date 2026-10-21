import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);

export function rexEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["REX_SERVER", "REX_SESSION", "REX_BLOCK", "REX_CLIENT"])
    delete env[name];
  return env;
}

export async function runJSON<T>(
  executable: string,
  args: string[],
  schema: z.ZodType<T>,
  env = rexEnvironment(),
): Promise<T> {
  const { stdout } = await execute(executable, args, {
    env,
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return schema.parse(JSON.parse(stdout));
}
