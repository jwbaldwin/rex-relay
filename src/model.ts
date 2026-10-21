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

const requested = { requestedAt: z.number() };
export const Entry = z.discriminatedUnion("status", [
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
export type Entry = z.infer<typeof Entry>;
export const State = z.object({
  version: z.literal(1),
  entries: z.record(z.string().startsWith("ses_"), Entry),
});
export type State = z.infer<typeof State>;

export type Conversation = {
  id: string;
  directory: string;
  canonical: string;
  title?: string;
  parentID?: string;
  archived?: number;
};

export function isPhonePrompt(metadata: unknown): boolean {
  const marker = z
    .object({
      notification: z.object({ callbackURL: z.string() }),
    })
    .safeParse(metadata);
  if (!marker.success) return false;
  try {
    const url = new URL(marker.data.notification.callbackURL);
    return (
      url.protocol === "https:" &&
      url.hostname === "opencode-notify-relay.anomalyco.workers.dev" &&
      url.port === "" &&
      url.username === "" &&
      url.password === "" &&
      /^\/v1\/notify\/[^/]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
