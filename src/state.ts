import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { State } from "./model.ts";

export interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

export class FileState implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<State> {
    try {
      return State.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { version: 1, entries: {} };
      }
      throw new Error(
        "Rex Relay could not read its state; refusing to overwrite it",
        { cause: error },
      );
    }
  }

  async save(state: State): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
