import { expect, test } from "bun:test";
import { Bridge } from "../src/bridge.ts";
import { acquireRuntime } from "../src/runtime.ts";

function fixture() {
  const bridge = new Bridge(
    {
      async load() {
        return { version: 1, entries: {} };
      },
      async save() {},
    },
    {
      async conversation() {
        return undefined;
      },
    },
    {
      async snapshot() {
        throw new Error("unused");
      },
      async open() {
        throw new Error("unused");
      },
      async rename() {},
    },
  );
  let starts = 0;
  let stops = 0;
  return {
    bridge,
    starts: () => starts,
    stops: () => stops,
    async start() {
      starts++;
      return {
        bridge,
        wake() {},
        async stop() {
          stops++;
        },
      };
    },
  };
}

test("project locations share one runtime until the last releases it", async () => {
  const f = fixture();
  const [first, second] = await Promise.all([
    acquireRuntime("shared", f.start),
    acquireRuntime("shared", f.start),
  ]);
  expect(f.starts()).toBe(1);
  expect(first.runtime.bridge).toBe(second.runtime.bridge);
  await first.release();
  expect(f.stops()).toBe(0);
  await expect(acquireRuntime("different", f.start)).rejects.toThrow(
    "same in every project",
  );
  await second.release();
  expect(f.stops()).toBe(1);
  await second.release();
  expect(f.stops()).toBe(1);
});

test("failed startup does not prevent a subsequent plugin load", async () => {
  await expect(
    acquireRuntime("failure", async () => {
      throw new Error("startup failure");
    }),
  ).rejects.toThrow("startup failure");
  const f = fixture();
  const lease = await acquireRuntime("recovery", f.start);
  expect(f.starts()).toBe(1);
  await lease.release();
});

test("reload waits for the previous runtime to finish saving state", async () => {
  const f = fixture();
  const finished = Promise.withResolvers<void>();
  const first = await acquireRuntime("before", async () => ({
    bridge: f.bridge,
    wake() {},
    stop: () => finished.promise,
  }));
  const closing = first.release();
  const loading = acquireRuntime("after", f.start);
  expect(f.starts()).toBe(0);
  finished.resolve();
  await closing;
  const second = await loading;
  expect(f.starts()).toBe(1);
  await second.release();
});
