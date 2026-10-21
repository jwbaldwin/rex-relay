import type { Observation } from "./model.ts";

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
