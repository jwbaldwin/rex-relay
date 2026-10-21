import type {
  Conversation,
  Entry,
  Observation,
  Placement,
  State,
} from "./model.ts";
import {
  isRelayTerminal,
  type RexPort,
  type Snapshot,
  type Terminal,
} from "./rex.ts";
import type { StateStore } from "./state.ts";

export type OpenCodePort = {
  conversation(id: string): Promise<Conversation | undefined>;
};

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
    private readonly opencode: OpenCodePort,
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
    this.observations.delete(clientID);
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

  private liveClaims(snapshot: Snapshot): Observation[] {
    const valid = new Map<string, { claim: Observation; sequence: number }>();
    for (const [id, record] of this.observations) {
      if (this.now() - record.seen > 30000) {
        this.observations.delete(id);
        continue;
      }
      const claim = record.claim;
      if (
        claim.hostID !== snapshot.identity.host_id ||
        claim.placement.instanceID !== snapshot.identity.instance_id
      )
        continue;
      const terminal = snapshot.terminals.find((terminal) =>
        matches(terminal, claim.placement),
      );
      if (!terminal?.processes.some((proc) => proc.pid === claim.pid)) continue;
      const previous = valid.get(claim.placement.blockID);
      if (!previous || previous.sequence < record.sequence)
        valid.set(claim.placement.blockID, record);
    }
    return [...valid.values()].map((record) => record.claim);
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
    const failures: unknown[] = [];
    for (const [id] of Object.entries(this.state.entries)) {
      try {
        if (this.stopped) break;
        if (this.state.entries[id].status === "dismissed") continue;
        const conversation = await this.opencode.conversation(id);
        const entry = this.state.entries[id];
        const claims = this.liveClaims(snapshot);
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
        const existing = claims.find((claim) => claim.sessionIDs.includes(id));
        if (existing) {
          const same =
            entry.status === "open" &&
            matches(existing.placement, entry.placement);
          const owned =
            (same && entry.owned) ||
            snapshot.terminals.some(
              (terminal) =>
                matches(terminal, existing.placement) &&
                isRelayTerminal(terminal.label, id),
            );
          const title = conversation.title || "OpenCode";
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
          const terminal = snapshot.terminals.find((terminal) =>
            matches(terminal, entry.placement),
          );
          const switched = claims.some((claim) =>
            matches(claim.placement, entry.placement),
          );
          if (window && terminal && !switched) {
            const title = conversation.title || "OpenCode";
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
            !claims.some((claim) => matches(claim.placement, terminal)),
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
          title: conversation.title || "OpenCode",
          requestedAt: entry.requestedAt,
        });
        if (!recovered) snapshot = await this.rex.snapshot();
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
