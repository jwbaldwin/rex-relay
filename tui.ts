import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createRoot } from "solid-js";
import { Options, RexRelay, type Observation } from "./rpc.ts";
import { terminalIdentity } from "./rex.ts";

export class TerminalPresence {
  private latest?: Observation;
  private sending?: Promise<void>;
  private controller = new AbortController();

  constructor(
    private readonly send: (
      claim: Observation,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly report: () => void,
  ) {}

  publish(claim: Observation): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    this.latest = claim;
    if (this.sending) return this.sending;
    this.sending = this.flush().finally(() => {
      this.sending = undefined;
      if (this.latest && !this.controller.signal.aborted)
        void this.publish(this.latest);
    });
    return this.sending;
  }

  private async flush(): Promise<void> {
    while (this.latest && !this.controller.signal.aborted) {
      const claim = this.latest;
      this.latest = undefined;
      try {
        await this.send(
          claim,
          AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]),
        );
      } catch {
        if (!this.controller.signal.aborted) this.report();
      }
    }
  }

  async stop(): Promise<void> {
    this.latest = undefined;
    this.controller.abort();
    await this.sending;
  }
}

export default Plugin.define({
  id: "rex-relay.tui",
  async setup(context) {
    const options = Options.parse(context.options);
    const terminal = await terminalIdentity(options.rexExecutable);
    if (!terminal) return;
    const rpc = context.client.rpc(RexRelay);
    const clientID = randomUUID();
    let sessionIDs: string[] = [];
    let lastError = 0;
    const presence = new TerminalPresence(
      async (claim, signal) => {
        await rpc.observe(claim, {
          location: context.location ?? context.data.location.default(),
          signal,
        });
      },
      () => {
        if (Date.now() - lastError < 60000) return;
        lastError = Date.now();
        context.ui.toast.show({
          title: "Rex Relay",
          message: "Could not register this Rex tab; will retry.",
          variant: "warning",
        });
      },
    );
    const publish = () => {
      void presence.publish({
        clientID,
        pid: process.pid,
        ...terminal,
        sessionIDs,
      });
    };
    const dispose = createRoot((dispose) => {
      createEffect(() => {
        const route = context.ui.router.current();
        const root =
          route.type === "session"
            ? context.data.session.root(route.sessionID)
            : undefined;
        sessionIDs = [
          ...new Set([
            ...(context.ui.tabs.enabled()
              ? context.ui.tabs.list().map((tab) => tab.sessionID)
              : []),
            ...(route.type === "session" ? [route.sessionID] : []),
            ...(root ? [root] : []),
          ]),
        ];
        publish();
      });
      return dispose;
    });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "rex-relay.reopen",
          title: "Rex Relay: Reopen in Rex",
          group: "Rex Relay",
          palette: true,
          slash: { name: "rex-relay" },
          run: async () => {
            const route = context.ui.router.current();
            if (route.type !== "session") return;
            try {
              await rpc.reopen(
                { sessionID: route.sessionID },
                {
                  location: context.location ?? context.data.location.default(),
                },
              );
              context.ui.toast.show({
                title: "Rex Relay",
                message: "Rex tab requested.",
                variant: "success",
              });
            } catch {
              context.ui.toast.show({
                title: "Rex Relay",
                message: "Could not reopen this conversation in Rex.",
                variant: "error",
              });
            }
          },
        },
      ],
    }));
    const timer = setInterval(publish, 5000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      dispose();
      await presence.stop();
      await rpc
        .release(
          { clientID },
          {
            location: context.location ?? context.data.location.default(),
            signal: AbortSignal.timeout(2000),
          },
        )
        .catch(() => {});
    };
  },
});
