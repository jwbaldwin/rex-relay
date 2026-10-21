import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { resolveOpenCodeExecutable } from "../rex.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true });
});

async function executable(name: string) {
  const directory = await mkdtemp(join(tmpdir(), "rex-relay-executable-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return { directory, path, canonical: await realpath(path) };
}

test("uses the native OpenCode service executable even when it is absent from PATH", async () => {
  const host = await executable("opencode");
  expect(await resolveOpenCodeExecutable("opencode", host.path, "")).toBe(
    host.canonical,
  );
});

test("resolves OpenCode from the service PATH when hosted by another runtime", async () => {
  const cli = await executable("opencode");
  expect(
    await resolveOpenCodeExecutable("opencode", "/usr/bin/bun", cli.directory),
  ).toBe(cli.canonical);
});

test("keeps an explicitly configured executable instead of replacing it with the host", async () => {
  const cli = await executable("custom-opencode");
  expect(await resolveOpenCodeExecutable(cli.path, "/other/opencode", "")).toBe(
    cli.canonical,
  );
  expect(
    await resolveOpenCodeExecutable(
      "custom-opencode",
      "/other/opencode",
      cli.directory,
    ),
  ).toBe(cli.canonical);
});

test("resolves an explicitly configured relative path without searching PATH", async () => {
  const cli = await executable("custom-opencode");
  const configured = relative(process.cwd(), cli.path);
  expect(
    await resolveOpenCodeExecutable(configured, "/other/opencode", ""),
  ).toBe(cli.canonical);
});

test("reports a missing configured executable before asking Rex to launch it", async () => {
  const cli = await executable("other");
  await expect(
    resolveOpenCodeExecutable(
      "missing-opencode",
      "/usr/bin/bun",
      cli.directory,
    ),
  ).rejects.toThrow("absolute path");
});

test("does not treat a directory as an executable", async () => {
  const cli = await executable("other");
  const directory = join(cli.directory, "opencode");
  await mkdir(directory);
  await expect(
    resolveOpenCodeExecutable("opencode", "/usr/bin/bun", cli.directory),
  ).rejects.toThrow();
});
