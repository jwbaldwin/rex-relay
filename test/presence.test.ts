import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Observation } from "../rpc.ts";
import { TerminalPresence } from "../tui.ts";

const claim: Observation = {
  clientID: randomUUID(),
  pid: 123,
  hostID: "host",
  sessionIDs: ["ses_first"],
  placement: {
    sessionID: "session:project",
    windowID: "window:tab",
    blockID: "block:terminal",
    instanceID: "instance",
  },
};

test("slow RPCs send the latest conversation selection, not a backlog of stale routes", async () => {
  const released = Promise.withResolvers<void>();
  const sent: string[][] = [];
  const presence = new TerminalPresence(
    async (claim) => {
      sent.push(claim.sessionIDs);
      if (sent.length === 1) await released.promise;
    },
    () => {},
  );
  const publishing = presence.publish(claim);
  void presence.publish({ ...claim, sessionIDs: ["ses_intermediate"] });
  void presence.publish({ ...claim, sessionIDs: ["ses_latest"] });
  released.resolve();
  await publishing;
  expect(sent).toEqual([["ses_first"], ["ses_latest"]]);
  await presence.stop();
});

test("plugin cleanup cancels an in-flight observation and discards unsent routes", async () => {
  let cancelled = false;
  let sent = 0;
  const presence = new TerminalPresence(
    async (_, signal) => {
      sent++;
      await new Promise<void>((_, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    },
    () => {},
  );
  void presence.publish(claim);
  void presence.publish({ ...claim, sessionIDs: ["ses_next"] });
  await presence.stop();
  expect(cancelled).toBe(true);
  expect(sent).toBe(1);
});
