import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";

export const Options = z.object({
  rexExecutable: z.string().min(1).default("rex"),
  rexServer: z.string().min(1).optional(),
  opencodeExecutable: z.string().min(1).default("opencode"),
  fallbackSession: z.string().min(1).default("OpenCode"),
  projects: z.record(z.string(), z.string().min(1)).default({}),
  stateDirectory: z.string().min(1).optional(),
  intervalMs: z.number().int().min(1000).default(15000),
});
export type Options = z.infer<typeof Options>;

export const Placement = z.object({
  sessionID: z.string().startsWith("session:"),
  windowID: z.string().startsWith("window:"),
  blockID: z.string().startsWith("block:"),
  instanceID: z.string().min(1),
});
export type Placement = z.infer<typeof Placement>;

export const Observation = z.object({
  clientID: z.string().uuid(),
  pid: z.number().int().positive(),
  hostID: z.string().min(1),
  placement: Placement,
  sessionIDs: z.array(z.string().startsWith("ses_")).max(200),
});
export type Observation = z.infer<typeof Observation>;

export type Conversation = {
  id: string;
  directory: string;
  canonical: string;
  title?: string;
  parentID?: string;
  archived?: number;
};

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
