import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileState } from "../src/state.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true });
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "rex-relay-state-test-"));
  directories.push(directory);
  return new FileState(join(directory, "state.json"));
}

test("persists only local mappings with owner-only access", async () => {
  const store = await fixture();
  expect(await store.load()).toEqual({ version: 1, entries: {} });
  const state = {
    version: 1 as const,
    entries: { ses_test: { status: "dismissed" as const, requestedAt: 123 } },
  };
  await store.save(state);
  expect(await store.load()).toEqual(state);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
});

test("refuses corrupt state without replacing the original", async () => {
  const store = await fixture();
  await writeFile(store.path, "broken");
  await expect(store.load()).rejects.toThrow("refusing to overwrite");
  expect(await readFile(store.path, "utf8")).toBe("broken");
});
