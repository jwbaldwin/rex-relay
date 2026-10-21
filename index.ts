import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { Plugin } from "@opencode/plugin";
import { z } from "zod";
import { Bridge, FileState } from "./relay.ts";
import { Options, RexRelay } from "./rpc.ts";
import { canonicalPath, Rex, resolveOpenCodeExecutable } from "./rex.ts";

type ManagedRuntime = { bridge: Bridge; wake(): void; stop(): Promise<void> };
type Owner = { options: string; users: number; runtime: ManagedRuntime };
type Registry = { pending: Promise<void>; owner?: Owner };

declare global {
  var __opencodeRexRelayV1: Registry | undefined;
}

function transition<T>(job: (state: Registry) => Promise<T>): Promise<T> {
  const state = (globalThis.__opencodeRexRelayV1 ??= {
    pending: Promise.resolve(),
  });
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
) {
  const owner = await transition(async (state) => {
    if (state.owner && state.owner.options !== options) {
      throw new Error("Rex Relay options must be the same in every project");
    }
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
          state.owner = undefined;
        }
      });
    },
  };
}

const PhonePromptMetadata = z.object({
  notification: z.object({ callbackURL: z.string() }),
});

export function isPhonePrompt(metadata: unknown): boolean {
  const marker = PhonePromptMetadata.safeParse(metadata);
  if (!marker.success) return false;
  try {
    const url = new URL(marker.data.notification.callbackURL);
    return (
      url.origin === "https://opencode-notify-relay.anomalyco.workers.dev" &&
      url.username === "" &&
      url.password === "" &&
      /^\/v1\/notify\/[^/]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function report(error: unknown): void {
  const failures = error instanceof AggregateError ? error.errors : [error];
  console.error(
    "[rex-relay] Synchronization failed; pending conversations will retry.",
    failures
      .map((failure) =>
        failure instanceof Error ? failure.message : "Unknown error",
      )
      .join("; "),
  );
}

async function start(options: Options): Promise<ManagedRuntime> {
  const endpoint = await Service.discover();
  if (!endpoint)
    throw new Error("Rex Relay requires the local shared OpenCode service");
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  const server = await client.server.info();
  if (server.pid !== process.pid)
    throw new Error(
      "Rex Relay must run in the local shared OpenCode service, not a private server",
    );
  const namespace = createHash("sha256")
    .update(endpoint.url)
    .digest("hex")
    .slice(0, 16);
  const stateDirectory =
    options.stateDirectory ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "rex-relay",
    );
  const projects: Record<string, string> = {};
  for (const [directory, target] of Object.entries(options.projects))
    projects[await canonicalPath(directory)] = target;
  const rex = new Rex({
    ...options,
    projects,
    opencodeExecutable: await resolveOpenCodeExecutable(
      options.opencodeExecutable,
    ),
  });
  const bridge = new Bridge(
    new FileState(join(stateDirectory, `${namespace}.json`)),
    async (id) => {
      try {
        const session = await client.session.get({ sessionID: id });
        const location = await client.location.get({
          location: session.location,
        });
        return {
          id: session.id,
          title: session.title,
          parentID: session.parentID,
          archived: session.time.archived,
          directory: await canonicalPath(session.location.directory),
          canonical: await canonicalPath(location.project.canonical),
        };
      } catch (error) {
        const missing = z
          .object({
            _tag: z.enum(["SessionNotFoundError", "Session.NotFoundError"]),
          })
          .safeParse(error);
        if (missing.success) return undefined;
        throw error;
      }
    },
    rex,
  );
  await bridge.start();
  const synchronize = () => void bridge.tick().catch(report);
  let followup: ReturnType<typeof setTimeout> | undefined;
  const timer = setInterval(synchronize, options.intervalMs);
  timer.unref();
  synchronize();
  return {
    bridge,
    wake() {
      synchronize();
      if (followup) return;
      followup = setTimeout(() => {
        followup = undefined;
        synchronize();
      }, 6500);
      followup.unref();
    },
    async stop() {
      clearInterval(timer);
      clearTimeout(followup);
      await bridge.stop();
    },
  };
}

export default Plugin.define({
  id: "rex-relay",
  async setup(context) {
    const options = Options.parse(context.options);
    const signature = JSON.stringify(options);
    const lease = await acquireRuntime(signature, () => start(options));
    const runtime = lease.runtime;
    try {
      await context.rpc.register(RexRelay, {
        async observe(claim) {
          runtime.bridge.observe(claim);
          return null;
        },
        async release({ clientID }) {
          runtime.bridge.release(clientID);
          return null;
        },
        async reopen({ sessionID }) {
          await runtime.bridge.request(sessionID, true);
          runtime.wake();
          return null;
        },
        async status() {
          return runtime.bridge.status();
        },
      });
      await context.session.hook("prompt", async (event) => {
        if (!isPhonePrompt(event.metadata)) return;
        try {
          await runtime.bridge.request(event.sessionID);
          runtime.wake();
        } catch (error) {
          report(error);
        }
      });
      await context.command.transform((editor) => {
        editor.add({
          name: "rex-relay",
          description: "Restore this conversation's Rex tab",
          async execute({ sessionID }) {
            await runtime.bridge.request(sessionID, true);
            runtime.wake();
          },
        });
      });
      return () => lease.release();
    } catch (error) {
      await lease.release();
      throw error;
    }
  },
});
