import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { Observation } from "./model.ts";

export const RexRelay = Rpc.define({
  id: "rex-relay",
  events: {},
  methods: {
    observe: { input: Observation, output: z.null() },
    release: {
      input: z.object({ clientID: z.string().uuid() }),
      output: z.null(),
    },
    reopen: {
      input: z.object({ sessionID: z.string().startsWith("ses_") }),
      output: z.null(),
    },
    status: {
      input: z.null(),
      output: z.object({
        observed: z.array(z.string()),
        entries: z.record(z.string(), z.enum(["pending", "open", "dismissed"])),
      }),
    },
  },
});
