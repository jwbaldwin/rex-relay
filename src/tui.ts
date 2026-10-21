import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createRoot } from "solid-js";
import { Options } from "./model.ts";
import { terminalIdentity } from "./rex.ts";
import { RexRelay } from "./rpc.ts";
import { TerminalPresence } from "./presence.ts";

export default Plugin.define({
  id: "rex-relay.tui",
  async setup(context) {
    const options = Options.parse(context.options);
    const identity = await terminalIdentity(options.rexExecutable);
    if (!identity?.session_id || !identity.window_id || !identity.block_id)
      return;
    const placement = {
      sessionID: identity.session_id,
      windowID: identity.window_id,
      blockID: identity.block_id,
      instanceID: identity.instance_id,
    };
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
        hostID: identity.host_id,
        placement,
        sessionIDs: [...sessionIDs],
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
