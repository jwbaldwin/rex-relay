import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { z } from "zod";
import { Rex, type Snapshot } from "../src/rex.ts";
import { Options, State } from "../src/model.ts";
import { RexRelay } from "../src/rpc.ts";
import { runJSON } from "../src/process.ts";
import { resolveOpenCodeExecutable } from "../src/executable.ts";

const execute = promisify(execFile);
const opencode = process.env.OPENCODE_EXECUTABLE ?? "opencode";
const rex = process.env.REX_EXECUTABLE ?? "rex";
const packageDirectory = resolve(import.meta.dirname, "..");
const temporaryRoot = join(tmpdir(), "opencode");
await mkdir(temporaryRoot, { recursive: true });
const temporary = await mkdtemp(join(temporaryRoot, "rex-relay-integration-"));
const configHome = join(temporary, "config");
const stateHome = join(temporary, "state");
const project = join(temporary, "project");
const bridgeState = join(temporary, "rex-relay-state");
const wrapper = join(temporary, "opencode");
const xdgDirectories = {
  XDG_CONFIG_HOME: configHome,
  XDG_STATE_HOME: stateHome,
  XDG_DATA_HOME: join(temporary, "data"),
  XDG_CACHE_HOME: join(temporary, "cache"),
};
const env: NodeJS.ProcessEnv = { ...process.env, ...xdgDirectories };
delete env.OPENCODE_CONFIG;
delete env.OPENCODE_CONFIG_CONTENT;
delete env.OPENCODE_CLI_CONFIG_CONTENT;
const rexIdentity = await runJSON(
  rex,
  ["--autostart=false", "whoami", "--json"],
  z.object({ endpoint: z.string() }),
);
const rexCall = (method: string, input: object) =>
  runJSON(
    rex,
    [
      "--server",
      rexIdentity.endpoint,
      "--autostart=false",
      "api",
      "call",
      method,
      JSON.stringify(input),
    ],
    z.unknown(),
  );
let rexSessionID: string | undefined;
let serviceStarted = false;
let completed = false;

async function eventually<T>(
  label: string,
  read: () => Promise<T>,
  accept: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accept(value)) return value;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out: ${label}`);
}

try {
  await mkdir(join(configHome, "opencode"), { recursive: true });
  await mkdir(project);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  const created = z.object({ session_id: z.string() }).parse(
    await rexCall("session.create", {
      label: `rex-relay-verification-${Date.now()}`,
      initial_windows: [
        {
          window_label: "Keep focus here",
          layout: {
            block: {
              flavor: "com.superlogical.terminal.shell",
              options: {
                shell: "none",
                command: ["/bin/sleep", "300"],
                cwd: project,
              },
            },
          },
        },
      ],
    }),
  );
  rexSessionID = created.session_id;
  const executable = (
    await execute("/usr/bin/which", [opencode])
  ).stdout.trim();
  const resolvedExecutable = await resolveOpenCodeExecutable(
    "opencode",
    executable,
    "",
  );
  const launchProbe = z
    .object({ window_id: z.string(), block_ids: z.array(z.string()).length(1) })
    .parse(
      await rexCall("session.new_window", {
        session_id: rexSessionID,
        window_label: "Default executable probe",
        focus: false,
        layout: {
          block: {
            flavor: "com.superlogical.terminal.shell",
            options: {
              shell: "none",
              command: [resolvedExecutable, "--version"],
              exit: { on_completion: false },
            },
          },
        },
      }),
    );
  await eventually(
    "resolved default executable runs inside Rex",
    async () =>
      z
        .object({ last_exit: z.object({ exit_code: z.number() }).nullish() })
        .parse(
          await rexCall("com.superlogical.terminal.process", {
            session_id: rexSessionID,
            block_id: launchProbe.block_ids[0],
            args: {},
          }),
        ),
    (result) => result.last_exit?.exit_code === 0,
  );
  await rexCall("session.close_window", {
    session_id: rexSessionID,
    window_id: launchProbe.window_id,
  });
  const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const environment = Object.entries(xdgDirectories)
    .map(([key, directory]) => `${key}=${shellQuote(directory)}`)
    .join(" ");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/env ${environment} ${shellQuote(executable)} "$@"\n`,
    { mode: 0o700 },
  );
  const options = {
    rexExecutable: (await execute("/usr/bin/which", [rex])).stdout.trim(),
    rexServer: rexIdentity.endpoint,
    opencodeExecutable: wrapper,
    projects: { [project]: rexSessionID },
    stateDirectory: bridgeState,
    intervalMs: 1000,
  };
  await writeFile(
    join(configHome, "opencode", "opencode.json"),
    JSON.stringify({
      plugins: [{ package: packageDirectory, options }],
    }),
  );
  await writeFile(
    join(configHome, "opencode", "cli.json"),
    JSON.stringify({
      plugins: [{ package: packageDirectory, options }],
      tabs: { mode: "off" },
      attention: { notifications: false, sound: false },
    }),
  );
  await execute(executable, ["service", "set", "hostname", "127.0.0.1"], {
    env,
    cwd: project,
  });
  await execute(executable, ["service", "set", "port", String(port)], {
    env,
    cwd: project,
  });
  await execute(executable, ["service", "start"], {
    env,
    cwd: project,
    timeout: 30000,
  });
  serviceStarted = true;
  const endpoint = await Service.discover({
    file: join(stateHome, "opencode", "service.json"),
  });
  assert(endpoint, "isolated service registration exists");
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  const location = { directory: project };
  const conversation = await client.session.create({
    location,
    title: "Rex Relay verification",
  });
  await client.session.prompt({
    sessionID: conversation.id,
    text: "Laptop probe; do not execute.",
    resume: false,
  });
  const plugins = await client.plugin.list({ location });
  const loaded = plugins.data.find((plugin) => plugin.id === "rex-relay");
  assert(
    loaded?.state.status === "active",
    JSON.stringify(
      plugins.data.filter((plugin) => plugin.source.type !== "builtin"),
    ),
  );
  const rpc = client.rpc(RexRelay);
  const adapter = new Rex(Options.parse(options));
  const live = async (): Promise<Snapshot> => {
    const snapshot = await adapter.snapshot();
    return {
      ...snapshot,
      sessions: snapshot.sessions.filter(
        (session) => session.session_id === created.session_id,
      ),
      terminals: snapshot.terminals.filter(
        (terminal) => terminal.sessionID === created.session_id,
      ),
    };
  };
  const baseline = (await live()).sessions[0];
  const baselineView = z
    .object({ active_window_id: z.string() })
    .parse(await rexCall("session.view", { session_id: rexSessionID }));
  assert.equal(
    (await live()).sessions[0].windows.length,
    baseline.windows.length,
    "ordinary laptop prompt does not open a tab",
  );
  await client.session.prompt({
    sessionID: conversation.id,
    text: "Phone probe; do not execute.",
    resume: false,
    metadata: {
      notification: {
        callbackURL:
          "https://opencode-notify-relay.anomalyco.workers.dev/v1/notify/rex-relay-verification-not-a-device",
      },
    },
  });
  await eventually(
    "phone prompt creates Rex tab",
    live,
    (s) => s.sessions[0].windows.length === baseline.windows.length + 1,
  );
  const after = z
    .object({ active_window_id: z.string() })
    .parse(await rexCall("session.view", { session_id: rexSessionID }));
  assert.equal(
    after.active_window_id,
    baselineView.active_window_id,
    "automatic tab leaves focus unchanged",
  );
  const terminal = (await live()).terminals.find(
    (terminal) => terminal.label === `rex-relay:${conversation.id}`,
  );
  assert(terminal, "created block retains a stable recovery label");
  const rexWindow = terminal.windowID;
  await client.session.update({
    sessionID: conversation.id,
    title: "Rex Relay renamed",
  });
  await eventually("conversation title reaches Rex", live, (s) =>
    s.sessions[0].windows.some(
      (w) => w.window_id === rexWindow && w.label === "Rex Relay renamed",
    ),
  );
  await eventually(
    "Rex TUI registers its real process",
    async () => (await rpc.status(null, { location })).observed,
    (ids) => ids.includes(conversation.id),
  );
  await rpc.reopen({ sessionID: conversation.id }, { location });
  const stateFiles = await readdir(bridgeState);
  const stateFilename = stateFiles.find((name) => name.endsWith(".json"));
  assert(stateFilename);
  const statePath = join(bridgeState, stateFilename);
  const readState = async () =>
    State.parse(JSON.parse(await readFile(statePath, "utf8")));
  await eventually(
    "existing tab is reused",
    async () => (await readState()).entries[conversation.id],
    (entry) => entry?.status === "open",
  );
  assert.equal(
    (await live()).sessions[0].windows.length,
    baseline.windows.length + 1,
    "repeated phone activity reuses the tab",
  );
  const manual = await client.session.create({
    location,
    title: "Laptop to phone to laptop",
  });
  const manualPlacement = await adapter.open(
    {
      id: manual.id,
      title: "Manual Rex tab",
      directory: project,
      canonical: project,
    },
    await live(),
  );
  await eventually(
    "manual TUI announces its conversation",
    async () => (await rpc.status(null, { location })).observed,
    (ids) => ids.includes(manual.id),
  );
  const otherProject = join(temporary, "other-project");
  await mkdir(otherProject);
  const other = await client.session.create({
    location: { directory: otherProject },
    title: "Other location",
  });
  await client.session.prompt({
    sessionID: other.id,
    text: "Other location; do not execute.",
    resume: false,
  });
  assert(
    (
      await rpc.status(null, { location: { directory: otherProject } })
    ).observed.includes(manual.id),
    "separate location plugin loads share the same terminal registry",
  );
  const countBeforePhone = (await live()).sessions[0].windows.length;
  await client.session.prompt({
    sessionID: manual.id,
    text: "Continue on phone; do not execute.",
    resume: false,
    metadata: {
      notification: {
        callbackURL:
          "https://opencode-notify-relay.anomalyco.workers.dev/v1/notify/rex-relay-verification-not-a-device",
      },
    },
  });
  await eventually(
    "existing manual Rex tab is adopted",
    async () => (await readState()).entries[manual.id],
    (entry) => entry?.status === "open",
  );
  assert.equal(
    (await live()).sessions[0].windows.length,
    countBeforePhone,
    "laptop → phone does not duplicate the existing tab",
  );
  await rexCall("session.close_window", {
    session_id: rexSessionID,
    window_id: manualPlacement.windowID,
  });
  await eventually(
    "closed Rex tab is dismissed",
    async () => (await readState()).entries[manual.id],
    (entry) => entry?.status === "dismissed",
  );
  await rpc.reopen({ sessionID: manual.id }, { location });
  await eventually(
    "dismissed tab can be reopened",
    live,
    (s) => s.sessions[0].windows.length === countBeforePhone,
  );
  console.log(
    "Verified real OpenCode admission, Rex launch, unchanged focus, title sync, TUI registration, laptop/phone deduplication, dismissal, and reopening. No model requests were run.",
  );
  completed = true;
} finally {
  if (rexSessionID)
    await rexCall("session.destroy", { session_id: rexSessionID });
  if (serviceStarted)
    await execute(opencode, ["service", "stop"], {
      env,
      cwd: project,
      timeout: 30000,
    });
  if (completed) await rm(temporary, { recursive: true, force: true });
  else
    console.error(`Isolated verification artifacts retained at ${temporary}`);
}
