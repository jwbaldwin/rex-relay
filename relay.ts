import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { Placement, type Conversation, type Observation } from "./rpc.ts";
import {
  isRelayTerminal,
  type RexPort,
  type Snapshot,
  type Terminal,
} from "./rex.ts";

const requested = { requestedAt: z.number() };
const Entry = z.discriminatedUnion("status", [
  z.object({ ...requested, status: z.literal("pending") }),
  z.object({
    ...requested,
    status: z.literal("open"),
    placement: Placement,
    owned: z.boolean(),
    title: z.string(),
  }),
  z.object({ ...requested, status: z.literal("dismissed") }),
]);
type Entry = z.infer<typeof Entry>;
export const State = z.object({
  version: z.literal(1),
  entries: z.record(z.string().startsWith("ses_"), Entry),
});
export type State = z.infer<typeof State>;

interface StateStore {
  load(): Promise<State>;
  save(state: State): Promise<void>;
}

export class FileState implements StateStore {
  constructor(readonly path: string) {}

  async load(): Promise<State> {
    try {
      return State.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { version: 1, entries: {} };
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

type FindConversation = (id: string) => Promise<Conversation | undefined>;

export class Bridge {
  private state: State = { version: 1, entries: {} };
  private observations = new Map<
    string,
    { claim: Observation; seen: number; sequence: number }
  >();
  private sequence = 0;
  private writes: Promise<void> = Promise.resolve();
  private running?: Promise<void>;
  private dirty = false;
  private stopped = false;
  private readyAt: number;

  constructor(
    private readonly store: StateStore,
    private readonly findConversation: FindConversation,
    private readonly rex: RexPort,
    private readonly now = Date.now,
  ) {
    this.readyAt = now() + 6000;
  }

  async start(): Promise<void> {
    this.state = await this.store.load();
  }

  private persist(): Promise<void> {
    const next = this.writes.then(async () => {
      if (!this.dirty) return;
      const snapshot = this.state;
      await this.store.save(snapshot);
      if (snapshot === this.state) this.dirty = false;
    });
    this.writes = next.catch(() => {});
    return next;
  }

  private async set(id: string, entry: Entry): Promise<void> {
    this.state = {
      ...this.state,
      entries: { ...this.state.entries, [id]: entry },
    };
    this.dirty = true;
    await this.persist();
  }

  async request(id: string, reopen = false): Promise<void> {
    if (this.stopped) return;
    if (!reopen && this.state.entries[id]) {
      if (this.dirty) await this.persist();
      return;
    }
    await this.set(id, { status: "pending", requestedAt: this.now() });
  }

  observe(claim: Observation): void {
    this.observations.set(claim.clientID, {
      claim,
      seen: this.now(),
      sequence: ++this.sequence,
    });
  }

  release(clientID: string): void {
    if (this.observations.delete(clientID)) this.sequence++;
  }

  status() {
    return {
      observed: [
        ...new Set(
          [...this.observations.values()]
            .filter((record) => this.now() - record.seen <= 30000)
            .flatMap((record) => record.claim.sessionIDs),
        ),
      ],
      entries: Object.fromEntries(
        Object.entries(this.state.entries).map(([id, entry]) => [
          id,
          entry.status,
        ]),
      ),
    };
  }

  private liveClaims(snapshot: Snapshot, terminals: Map<string, Terminal>) {
    const valid = new Map<string, { claim: Observation; sequence: number }>();
    let expiresAt = Infinity;
    const now = this.now();
    for (const [id, record] of this.observations) {
      if (now - record.seen > 30000) {
        this.observations.delete(id);
        continue;
      }
      expiresAt = Math.min(expiresAt, record.seen + 30000);
      const claim = record.claim;
      if (
        claim.hostID !== snapshot.identity.host_id ||
        claim.placement.instanceID !== snapshot.identity.instance_id
      )
        continue;
      const terminal = terminals.get(claim.placement.blockID);
      if (
        !terminal ||
        !matches(terminal, claim.placement) ||
        !terminal.processes.some((proc) => proc.pid === claim.pid)
      )
        continue;
      const previous = valid.get(claim.placement.blockID);
      if (!previous || previous.sequence < record.sequence)
        valid.set(claim.placement.blockID, record);
    }
    const byConversation = new Map<string, Observation>();
    for (const { claim } of valid.values()) {
      for (const id of claim.sessionIDs) {
        if (!byConversation.has(id)) byConversation.set(id, claim);
      }
    }
    return { byBlock: valid, byConversation, expiresAt, sequence: this.sequence };
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.synchronize().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async synchronize(): Promise<void> {
    if (this.dirty) await this.persist();
    if (
      !Object.values(this.state.entries).some(
        (entry) => entry.status !== "dismissed",
      )
    )
      return;
    let snapshot = await this.rex.snapshot();
    let terminals = new Map(
      snapshot.terminals.map((terminal) => [terminal.blockID, terminal]),
    );
    let claims = this.liveClaims(snapshot, terminals);
    const failures: unknown[] = [];
    for (const id of Object.keys(this.state.entries)) {
      try {
        if (this.stopped) break;
        if (this.state.entries[id].status === "dismissed") continue;
        const conversation = await this.findConversation(id);
        const entry = this.state.entries[id];
        if (claims.sequence !== this.sequence || this.now() > claims.expiresAt)
          claims = this.liveClaims(snapshot, terminals);
        if (
          !conversation ||
          conversation.parentID ||
          conversation.archived !== undefined
        ) {
          await this.set(id, {
            status: "dismissed",
            requestedAt: entry.requestedAt,
          });
          continue;
        }
        const title = conversation.title || "OpenCode";
        const existing = claims.byConversation.get(id);
        if (existing) {
          const same =
            entry.status === "open" &&
            matches(existing.placement, entry.placement);
          const owned =
            (same && entry.owned) ||
            isRelayTerminal(terminals.get(existing.placement.blockID)?.label, id);
          if (owned && (entry.status !== "open" || entry.title !== title))
            await this.rex.rename(existing.placement, title);
          if (!same || entry.title !== title) {
            await this.set(id, {
              status: "open",
              placement: existing.placement,
              owned,
              title,
              requestedAt: entry.requestedAt,
            });
          }
          continue;
        }
        if (entry.status === "open") {
          const window = snapshot.sessions
            .find((session) => session.session_id === entry.placement.sessionID)
            ?.windows.find(
              (window) => window.window_id === entry.placement.windowID,
            );
          const terminal = terminals.get(entry.placement.blockID);
          const claim = claims.byBlock.get(entry.placement.blockID)?.claim;
          const switched = claim && matches(claim.placement, entry.placement);
          if (
            window &&
            terminal &&
            matches(terminal, entry.placement) &&
            !switched
          ) {
            if (entry.owned && title !== entry.title) {
              await this.rex.rename(entry.placement, title);
              await this.set(id, { ...entry, title });
            }
            continue;
          }
          if (
            entry.placement.instanceID === snapshot.identity.instance_id ||
            switched
          ) {
            await this.set(id, {
              status: "dismissed",
              requestedAt: entry.requestedAt,
            });
            continue;
          }
          await this.set(id, {
            status: "pending",
            requestedAt: entry.requestedAt,
          });
        }
        if (
          this.stopped ||
          this.now() < Math.max(this.readyAt, entry.requestedAt + 6000)
        )
          continue;
        const recovered = snapshot.terminals.find(
          (terminal) =>
            isRelayTerminal(terminal.label, id) &&
            !claims.byBlock.has(terminal.blockID),
        );
        const placement = recovered
          ? {
              sessionID: recovered.sessionID,
              windowID: recovered.windowID,
              blockID: recovered.blockID,
              instanceID: snapshot.identity.instance_id,
            }
          : await this.rex.open(conversation, snapshot);
        await this.set(id, {
          status: "open",
          placement,
          owned: true,
          title,
          requestedAt: entry.requestedAt,
        });
        if (!recovered) {
          snapshot = await this.rex.snapshot();
          terminals = new Map(
            snapshot.terminals.map((terminal) => [terminal.blockID, terminal]),
          );
          claims = this.liveClaims(snapshot, terminals);
        }
      } catch (error) {
        if (this.dirty) throw error;
        failures.push(error);
      }
    }
    if (this.dirty) await this.persist();
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some Rex conversations could not synchronize",
      );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => {});
    await this.persist();
  }
}

function matches(
  left: Pick<Terminal, "sessionID" | "windowID" | "blockID">,
  right: Pick<Placement, "sessionID" | "windowID" | "blockID">,
): boolean {
  return (
    left.sessionID === right.sessionID &&
    left.windowID === right.windowID &&
    left.blockID === right.blockID
  );
}
