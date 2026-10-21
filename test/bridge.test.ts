import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { isPhonePrompt } from "../index.ts";
import { Bridge, type State } from "../relay.ts";
import { type Conversation, type Placement } from "../rpc.ts";
import { selectProjectSession, type RexPort, type Snapshot } from "../rex.ts";

const id = "ses_conversation";
const placement: Placement = {
  sessionID: "session:project",
  windowID: "window:conversation",
  blockID: "block:conversation",
  instanceID: "instance-1",
};

function fixture() {
  let now = 10000;
  let saved: State = { version: 1, entries: {} };
  let failSnapshot = false;
  let failSave = false;
  let snapshotCalls = 0;
  let snapshotWait: Promise<void> | undefined;
  let snapshotStarted: (() => void) | undefined;
  const failedConversations = new Set<string>();
  const opened: string[] = [];
  const renamed: string[] = [];
  const conversations = new Map<string, Conversation>([
    [
      id,
      {
        id,
        title: "A conversation",
        directory: "/projects/app/worktrees/fix",
        canonical: "/projects/app",
      },
    ],
  ]);
  const snapshot: Snapshot = {
    identity: {
      endpoint: "unix:///rex.sock",
      host_id: "host",
      instance_id: "instance-1",
    },
    sessions: [{ session_id: "session:project", label: "app", windows: [] }],
    terminals: [],
  };
  const addTerminal = (target = placement, label?: string) => {
    snapshot.sessions[0].windows.push({
      window_id: target.windowID,
      label: "Rex tab",
      layers: [],
    });
    snapshot.terminals.push({
      ...target,
      label,
      processes: [{ pid: 123, name: "opencode", cwd: "/projects/app" }],
    });
  };
  const rex: RexPort = {
    async snapshot() {
      snapshotCalls++;
      snapshotStarted?.();
      await snapshotWait;
      if (failSnapshot) throw new Error("offline");
      return snapshot;
    },
    async open(conversation) {
      opened.push(conversation.id);
      addTerminal(placement, `rex-relay:${conversation.id}`);
      return placement;
    },
    async rename(_, title) {
      renamed.push(title);
    },
  };
  const store = {
    async load() {
      return structuredClone(saved);
    },
    async save(state: State) {
      if (failSave) throw new Error("disk unavailable");
      saved = structuredClone(state);
    },
  };
  const create = async () => {
    const bridge = new Bridge(
      store,
      async (id) => {
        if (failedConversations.has(id)) throw new Error("missing checkout");
        return conversations.get(id);
      },
      rex,
      () => now,
    );
    await bridge.start();
    return bridge;
  };
  const observe = (bridge: Bridge, sessionIDs = [id], pid = 123) =>
    bridge.observe({
      clientID: randomUUID(),
      pid,
      hostID: "host",
      placement,
      sessionIDs,
    });
  return {
    create,
    opened,
    renamed,
    conversations,
    snapshot,
    addTerminal,
    observe,
    failedConversations,
    snapshotCalls: () => snapshotCalls,
    blockSnapshot() {
      const entered = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      snapshotWait = released.promise;
      snapshotStarted = () => entered.resolve();
      return { entered: entered.promise, release: () => released.resolve() };
    },
    advance: (ms = 7000) => {
      now += ms;
    },
    saved: () => saved,
    offline: (value: boolean) => {
      failSnapshot = value;
    },
    diskFailure: (value: boolean) => {
      failSave = value;
    },
  };
}

describe("phone prompt detection", () => {
  test("accepts an explicit HTTPS default port", () => {
    expect(
      isPhonePrompt({
        notification: {
          callbackURL:
            "https://opencode-notify-relay.anomalyco.workers.dev:443/v1/notify/test",
        },
      }),
    ).toBe(true);
  });

  test("rejects password-only callback credentials", () => {
    expect(
      isPhonePrompt({
        notification: {
          callbackURL:
            "https://:password@opencode-notify-relay.anomalyco.workers.dev/v1/notify/test",
        },
      }),
    ).toBe(false);
  });

  test("uses the callback marker, not session creation or ordinary laptop metadata", () => {
    expect(isPhonePrompt(undefined)).toBe(false);
    expect(isPhonePrompt({})).toBe(false);
    expect(
      isPhonePrompt({
        notification: {
          callbackURL:
            "https://opencode-notify-relay.anomalyco.workers.dev/v1/notify/test",
        },
      }),
    ).toBe(true);
    for (const callbackURL of [
      "http://opencode-notify-relay.anomalyco.workers.dev/v1/notify/test",
      "https://opencode-notify-relay.anomalyco.workers.dev.attacker.test/v1/notify/test",
      "https://user@opencode-notify-relay.anomalyco.workers.dev/v1/notify/test",
      "https://opencode-notify-relay.anomalyco.workers.dev:8443/v1/notify/test",
      "https://opencode-notify-relay.anomalyco.workers.dev/other/test",
      "invalid",
    ])
      expect(isPhonePrompt({ notification: { callbackURL } })).toBe(false);
  });
});

describe("conversation to Rex tab", () => {
  test.each(["created", "adopted"])(
    "empty titles use the fallback in %s tabs",
    async (kind) => {
      const f = fixture();
      const bridge = await f.create();
      const adopted = kind === "adopted";
      f.conversations.get(id)!.title = "";
      if (adopted) {
        f.addTerminal();
        f.observe(bridge);
      }
      await bridge.request(id);
      f.advance();
      await bridge.tick();
      expect(f.saved().entries[id]).toMatchObject({
        status: "open",
        title: "OpenCode",
        owned: !adopted,
      });
      f.conversations.get(id)!.title = "Changed title";
      await bridge.tick();
      f.conversations.get(id)!.title = "";
      await bridge.tick();
      expect(f.renamed).toEqual(adopted ? [] : ["Changed title", "OpenCode"]);
    },
  );

  test("recognizes tabs created before the rename without opening duplicates", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.addTerminal(placement, `openrex:${id}`);
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([]);
    expect(f.saved().entries[id]).toMatchObject({
      status: "open",
      owned: true,
      placement,
    });
  });
  test("slow Rex queries neither queue redundant ticks nor block phone admission", async () => {
    const f = fixture();
    const bridge = await f.create();
    await bridge.request(id);
    f.advance();
    const barrier = f.blockSnapshot();
    const syncing = bridge.tick();
    await barrier.entered;
    const redundant = Array.from({ length: 50 }, () => bridge.tick());
    await bridge.request("ses_second");
    expect(f.saved().entries.ses_second.status).toBe("pending");
    barrier.release();
    await Promise.all([syncing, ...redundant]);
    expect(f.snapshotCalls()).toBeLessThanOrEqual(2);
  });

  test("a bad checkout does not starve other conversations", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.failedConversations.add("ses_bad");
    await bridge.request("ses_bad");
    await bridge.request(id);
    f.advance();
    await expect(bridge.tick()).rejects.toBeInstanceOf(AggregateError);
    expect(f.opened).toEqual([id]);
    expect(f.saved().entries.ses_bad.status).toBe("pending");
  });

  test("a failed dismissal save retries even when no active conversations remain", async () => {
    const f = fixture();
    const bridge = await f.create();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.snapshot.sessions[0].windows = [];
    f.snapshot.terminals = [];
    f.diskFailure(true);
    await expect(bridge.tick()).rejects.toThrow();
    f.diskFailure(false);
    await bridge.tick();
    expect(f.saved().entries[id].status).toBe("dismissed");
    const restarted = await f.create();
    f.snapshot.identity.instance_id = "replacement";
    f.advance();
    await restarted.tick();
    expect(f.opened).toEqual([id]);
  });

  test("the newest terminal claim wins after a TUI reload and session switch", async () => {
    const f = fixture();
    const bridge = await f.create();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.observe(bridge, [id]);
    f.observe(bridge, ["ses_other"]);
    f.conversations.get(id)!.title =
      "Do not put this on the other conversation";
    await bridge.tick();
    expect(f.saved().entries[id].status).toBe("dismissed");
    expect(f.renamed).toEqual([]);
  });

  test("explicit reopen retains title ownership of an existing managed tab", async () => {
    const f = fixture();
    const bridge = await f.create();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.observe(bridge);
    await bridge.request(id, true);
    await bridge.tick();
    f.conversations.get(id)!.title = "Still managed";
    await bridge.tick();
    expect(f.renamed.at(-1)).toBe("Still managed");
    expect(f.saved().entries[id]).toMatchObject({
      status: "open",
      owned: true,
    });
  });

  test("allows a sleeping Rex terminal to renew its claim before opening a duplicate", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.addTerminal();
    f.observe(bridge);
    f.advance(31000);
    await bridge.request(id);
    await bridge.tick();
    expect(f.opened).toEqual([]);
    f.observe(bridge);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([]);
  });
  test("does nothing for a laptop conversation with no mobile request", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([]);
  });

  test("adopts the existing Rex tab after laptop → phone → laptop", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.addTerminal();
    f.observe(bridge);
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    await bridge.request(id);
    await bridge.tick();
    expect(f.opened).toEqual([]);
    expect(f.saved().entries[id]).toMatchObject({
      status: "open",
      owned: false,
      placement,
    });
    expect(f.renamed).toEqual([]);
  });

  test("opens once despite concurrent requests, retries, and ticks", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.advance();
    await Promise.all([
      bridge.request(id),
      bridge.request(id),
      bridge.tick(),
      bridge.tick(),
    ]);
    f.advance();
    await Promise.all([bridge.tick(), bridge.tick()]);
    expect(f.opened).toEqual([id]);
  });

  test("waits for terminal registration on startup instead of racing existing tabs", async () => {
    const f = fixture();
    const bridge = await f.create();
    await bridge.request(id);
    await bridge.tick();
    expect(f.opened).toEqual([]);
    f.addTerminal();
    f.observe(bridge);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([]);
  });

  test("does not trust a stale or foreign process claiming a Rex tab", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.addTerminal();
    f.observe(bridge, [id], 999);
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([id]);
  });

  test("tracks session switches and inactive OpenCode tabs", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.addTerminal();
    f.observe(bridge, ["ses_other", id]);
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([]);
  });

  test("respects a deliberately closed tab, including after plugin restart", async () => {
    const f = fixture();
    let bridge = await f.create();
    f.advance();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.snapshot.sessions[0].windows = [];
    f.snapshot.terminals = [];
    await bridge.tick();
    await bridge.stop();
    bridge = await f.create();
    f.advance();
    await bridge.request(id);
    await bridge.tick();
    expect(f.opened).toEqual([id]);
    expect(f.saved().entries[id].status).toBe("dismissed");
    await bridge.request(id, true);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([id, id]);
  });

  test("does not rename a tab that has switched to another conversation", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.advance();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.observe(bridge, ["ses_other"]);
    f.conversations.get(id)!.title = "Updated title";
    await bridge.tick();
    expect(f.renamed).toEqual([]);
    expect(f.saved().entries[id].status).toBe("dismissed");
  });

  test("keeps pending requests across outages and restarts", async () => {
    const f = fixture();
    let bridge = await f.create();
    f.advance();
    await bridge.request(id);
    f.offline(true);
    await expect(bridge.tick()).rejects.toThrow("offline");
    await bridge.stop();
    bridge = await f.create();
    f.offline(false);
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([id]);
  });

  test("restores missing windows after Rex server replacement, not after ordinary closure", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.advance();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.snapshot.identity.instance_id = "instance-2";
    f.snapshot.sessions[0].windows = [];
    f.snapshot.terminals = [];
    await bridge.tick();
    expect(f.opened).toEqual([id, id]);
  });

  test("updates titles only for plugin-owned tabs", async () => {
    const f = fixture();
    const bridge = await f.create();
    f.advance();
    await bridge.request(id);
    f.advance();
    await bridge.tick();
    f.conversations.get(id)!.title = "New title";
    await bridge.tick();
    expect(f.renamed).toEqual(["New title"]);
  });

  test("recovers an already-created terminal instead of creating a second after a lost save", async () => {
    const f = fixture();
    let bridge = await f.create();
    f.advance();
    await bridge.request(id);
    f.advance();
    f.diskFailure(true);
    await expect(bridge.tick()).rejects.toThrow("disk unavailable");
    expect(f.opened).toEqual([id]);
    f.diskFailure(false);
    bridge = await f.create();
    f.advance();
    await bridge.tick();
    expect(f.opened).toEqual([id]);
  });

  test.each(["child", "archived", "removed"])(
    "ignores %s conversations",
    async (kind) => {
      const f = fixture();
      const bridge = await f.create();
      f.advance();
      if (kind === "child") f.conversations.get(id)!.parentID = "ses_parent";
      if (kind === "archived") f.conversations.get(id)!.archived = 1;
      if (kind === "removed") f.conversations.delete(id);
      await bridge.request(id);
      await bridge.tick();
      expect(f.opened).toEqual([]);
    },
  );
});

describe("project routing", () => {
  test("matches canonical roots across worktrees, not similar directory names", () => {
    const f = fixture();
    f.addTerminal();
    expect(selectProjectSession(f.conversations.get(id)!, f.snapshot, {})).toBe(
      "session:project",
    );
    f.snapshot.terminals[0].processes[0].cwd = "/projects/application";
    expect(
      selectProjectSession(f.conversations.get(id)!, f.snapshot, {}),
    ).toBeUndefined();
  });

  test("leaves ambiguous inferred matches to the fallback", () => {
    const f = fixture();
    f.addTerminal();
    f.snapshot.terminals.push({
      ...f.snapshot.terminals[0],
      sessionID: "session:other",
    });
    expect(
      selectProjectSession(f.conversations.get(id)!, f.snapshot, {}),
    ).toBeUndefined();
  });

  test("uses the most specific explicit directory mapping", () => {
    const f = fixture();
    expect(
      selectProjectSession(f.conversations.get(id)!, f.snapshot, {
        "/projects": "not-a-session",
        "/projects/app": "app",
      }),
    ).toBe("session:project");
  });
});
