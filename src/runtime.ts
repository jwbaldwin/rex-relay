import type { Bridge } from "./bridge.ts";

export type ManagedRuntime = {
  bridge: Bridge;
  wake(): void;
  stop(): Promise<void>;
};
type Owner = { options: string; users: number; runtime: ManagedRuntime };
type Registry = { pending: Promise<void>; owner?: Owner };

declare global {
  var __opencodeRexRelayV1: Registry | undefined;
}

function registry(): Registry {
  return (globalThis.__opencodeRexRelayV1 ??= { pending: Promise.resolve() });
}

function transition<T>(job: (state: Registry) => Promise<T>): Promise<T> {
  const state = registry();
  const next = state.pending.then(() => job(state));
  state.pending = next.then(
    () => {},
    () => {},
  );
  return next;
}

export async function acquireRuntime(
  options: string,
  start: () => Promise<ManagedRuntime>,
): Promise<{ runtime: ManagedRuntime; release(): Promise<void> }> {
  const owner = await transition(async (state) => {
    if (state.owner && state.owner.options !== options)
      throw new Error("Rex Relay options must be the same in every project");
    if (!state.owner)
      state.owner = { options, users: 0, runtime: await start() };
    state.owner.users++;
    return state.owner;
  });
  let released = false;
  return {
    runtime: owner.runtime,
    async release() {
      await transition(async (state) => {
        if (released) return;
        released = true;
        if (--owner.users !== 0) return;
        try {
          await owner.runtime.stop();
        } finally {
          if (state.owner === owner) state.owner = undefined;
        }
      });
    },
  };
}
