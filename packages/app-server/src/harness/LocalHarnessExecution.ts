import type { LocalPersistence } from "@repo/event-store/local";
import type { DelegatedHarnessPort } from "@repo/runtime-kernel";

/** Bind a learned external identity to the already claimed local attempt before
 * the kernel can execute its prompt or acknowledge any observation. Node drivers
 * never acquire a persistence authority of their own.
 */
export class LocalHarnessExecution implements DelegatedHarnessPort {
  constructor(
    _persistence: LocalPersistence,
    private readonly harness: DelegatedHarnessPort,
  ) {}

  async open(input: Parameters<DelegatedHarnessPort["open"]>[0]) {
    // Core's required opening authority reserves the actual host generation and
    // commits native identity before journal registration. Never attach after open.
    return this.harness.open(input);
  }

  execute(input: Parameters<DelegatedHarnessPort["execute"]>[0]) {
    return this.harness.execute(input);
  }
  observeExisting(input: Parameters<DelegatedHarnessPort["observeExisting"]>[0]) {
    return this.harness.observeExisting(input);
  }
  control(input: Parameters<DelegatedHarnessPort["control"]>[0]) {
    return this.harness.control(input);
  }
  awaitQuiescence(input: Parameters<DelegatedHarnessPort["awaitQuiescence"]>[0]) {
    return this.harness.awaitQuiescence(input);
  }
}
