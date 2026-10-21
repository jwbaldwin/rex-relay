import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { Conversation, Observation, Options, Placement } from "./rpc.ts";

const execute = promisify(execFile);

export async function runRexCommand<T>(
  executable: string,
  args: string[],
  schema: z.ZodType<T>,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const environment = { ...(env ?? process.env) };
  if (!env) {
    for (const name of ["REX_SERVER", "REX_SESSION", "REX_BLOCK", "REX_CLIENT"])
      delete environment[name];
  }
  const { stdout } = await execute(executable, args, {
    env: environment,
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return schema.parse(JSON.parse(stdout));
}

export async function resolveOpenCodeExecutable(
  configured: string,
  hostExecutable = process.execPath,
  searchPath = process.env.PATH ?? "",
): Promise<string> {
  const nativeHost =
    configured === "opencode" &&
    /^opencode(?:\.exe)?$/.test(basename(hostExecutable));
  let candidates: string[];
  if (nativeHost) candidates = [hostExecutable];
  else if (
    isAbsolute(configured) ||
    configured.includes("/") ||
    configured.includes("\\")
  )
    candidates = [resolve(configured)];
  else
    candidates = searchPath
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

const Process = z.object({
  pid: z.number(),
  name: z.string(),
  cwd: z.string().optional(),
});
const Processes = z.object({
  foreground: Process.nullish(),
  child: Process.nullish(),
  ancestors: z.array(Process).nullish(),
});
const Block = z.object({
  block_id: z.string(),
  flavor: z.string(),
  label: z.string().optional(),
  host_id: z.string().optional(),
});
const Window = z.object({
  window_id: z.string(),
  label: z.string().optional(),
  layers: z.array(z.object({ blocks: z.array(Block) })),
});
const View = z.object({
  session_id: z.string(),
  label: z.string(),
  windows: z.array(Window),
});
const Identity = z.object({
  endpoint: z.string(),
  instance_id: z.string(),
  host_id: z.string(),
  session_id: z.string().optional(),
  window_id: z.string().optional(),
  block_id: z.string().optional(),
});
export type RexIdentity = z.infer<typeof Identity>;
export type Terminal = {
  sessionID: string;
  windowID: string;
  blockID: string;
  label?: string;
  processes: z.infer<typeof Process>[];
};
export type Snapshot = {
  identity: RexIdentity;
  sessions: z.infer<typeof View>[];
  terminals: Terminal[];
};

export interface RexPort {
  snapshot(): Promise<Snapshot>;
  open(conversation: Conversation, snapshot: Snapshot): Promise<Placement>;
  rename(placement: Placement, title: string): Promise<void>;
}

export function isRelayTerminal(
  label: string | undefined,
  sessionID: string,
): boolean {
  return label === `rex-relay:${sessionID}` || label === `openrex:${sessionID}`;
}

export function contains(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

export async function canonicalPath(directory: string): Promise<string> {
  return realpath(resolve(directory));
}

export function selectProjectSession(
  conversation: Conversation,
  snapshot: Snapshot,
  projects: Record<string, string>,
): string | undefined {
  const configured = Object.entries(projects)
    .filter(
      ([directory]) =>
        contains(directory, conversation.directory) ||
        contains(directory, conversation.canonical),
    )
    .sort(([left], [right]) => right.length - left.length);
  if (configured[0]) {
    const target = configured[0][1];
    const matches = snapshot.sessions.filter(
      (session) => session.session_id === target || session.label === target,
    );
    if (matches.length !== 1)
      throw new Error(
        "Rex Relay project mapping does not identify one Rex session",
      );
    return matches[0].session_id;
  }
  const matches = new Set(
    snapshot.terminals
      .filter((terminal) =>
        terminal.processes.some(
          (proc) =>
            proc.cwd &&
            (contains(conversation.canonical, proc.cwd) ||
              contains(conversation.directory, proc.cwd)),
        ),
      )
      .map((terminal) => terminal.sessionID),
  );
  return matches.size === 1 ? [...matches][0] : undefined;
}

export class Rex implements RexPort {
  private endpoint?: string;
  constructor(readonly options: Options) {
    this.endpoint = options.rexServer;
  }

  private call<T>(
    method: string,
    input: object,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return runRexCommand(
      this.options.rexExecutable,
      [
        ...(this.endpoint ? ["--server", this.endpoint] : []),
        "--autostart=false",
        "api",
        "call",
        method,
        JSON.stringify(input),
      ],
      schema,
    );
  }

  async snapshot(): Promise<Snapshot> {
    const identity = await runRexCommand(
      this.options.rexExecutable,
      [
        ...(this.endpoint ? ["--server", this.endpoint] : []),
        "--autostart=false",
        "whoami",
        "--json",
      ],
      Identity,
    );
    this.endpoint = identity.endpoint;
    const listed = await this.call(
      "session.list",
      {},
      z.object({
        sessions: z.array(z.object({ session_id: z.string() })),
      }),
    );
    const sessions = await Promise.all(
      listed.sessions.map((session) =>
        this.call("session.view", { session_id: session.session_id }, View),
      ),
    );
    const terminals: Terminal[] = [];
    for (const session of sessions) {
      for (const window of session.windows) {
        for (const block of window.layers.flatMap((layer) => layer.blocks)) {
          if (
            block.flavor !== "com.superlogical.terminal.shell" ||
            (block.host_id && block.host_id !== identity.host_id)
          )
            continue;
          const procs = await this.call(
            "com.superlogical.terminal.process",
            {
              session_id: session.session_id,
              block_id: block.block_id,
              args: {},
            },
            Processes,
          );
          const processes = [
            procs.foreground,
            ...(procs.ancestors ?? []),
            procs.child,
          ].filter((proc): proc is z.infer<typeof Process> => proc != null);
          for (const proc of processes) {
            if (proc.cwd)
              proc.cwd = await canonicalPath(proc.cwd).catch(() => undefined);
          }
          terminals.push({
            sessionID: session.session_id,
            windowID: window.window_id,
            blockID: block.block_id,
            label: block.label,
            processes,
          });
        }
      }
    }
    return { identity, sessions, terminals };
  }

  async open(
    conversation: Conversation,
    snapshot: Snapshot,
  ): Promise<Placement> {
    const title = conversation.title || "OpenCode";
    const layout = {
      block: {
        label: `rex-relay:${conversation.id}`,
        flavor: "com.superlogical.terminal.shell",
        options: {
          cwd: conversation.directory,
          shell: "none",
          command: [
            this.options.opencodeExecutable,
            "--session",
            conversation.id,
            conversation.directory,
          ],
        },
      },
    };
    let sessionID = selectProjectSession(
      conversation,
      snapshot,
      this.options.projects,
    );
    if (!sessionID) {
      const matches = snapshot.sessions.filter(
        (session) => session.label === this.options.fallbackSession,
      );
      if (matches.length > 1)
        throw new Error("Rex Relay fallback session name is ambiguous");
      sessionID = matches[0]?.session_id;
    }
    const windowSchema = z.object({
      window_id: z.string(),
      block_ids: z.array(z.string()).length(1),
    });
    if (sessionID) {
      const created = await this.call(
        "session.new_window",
        {
          session_id: sessionID,
          window_label: title,
          focus: false,
          layout,
        },
        windowSchema,
      );
      return {
        sessionID,
        windowID: created.window_id,
        blockID: created.block_ids[0],
        instanceID: snapshot.identity.instance_id,
      };
    }
    const created = await this.call(
      "session.create",
      {
        label: this.options.fallbackSession,
        initial_windows: [{ window_label: title, layout }],
      },
      z.object({
        session_id: z.string(),
        initial_windows: z.array(windowSchema).length(1),
      }),
    );
    return {
      sessionID: created.session_id,
      windowID: created.initial_windows[0].window_id,
      blockID: created.initial_windows[0].block_ids[0],
      instanceID: snapshot.identity.instance_id,
    };
  }

  async rename(placement: Placement, title: string): Promise<void> {
    await this.call(
      "session.set_window_label",
      {
        session_id: placement.sessionID,
        window_id: placement.windowID,
        label: title,
      },
      z.unknown(),
    );
  }
}

export async function terminalIdentity(
  executable: string,
): Promise<Pick<Observation, "hostID" | "placement"> | undefined> {
  if (!process.env.REX_BLOCK) return;
  const identity = await runRexCommand(
    executable,
    ["--autostart=false", "whoami", "--json"],
    Identity,
    process.env,
  );
  if (!identity.session_id || !identity.window_id || !identity.block_id) return;
  return {
    hostID: identity.host_id,
    placement: {
      sessionID: identity.session_id,
      windowID: identity.window_id,
      blockID: identity.block_id,
      instanceID: identity.instance_id,
    },
  };
}
