import { PostgresHarnessAdmissionBindingPort } from "@repo/persistence";
import { HarnessSelectionSchema } from "@repo/platform-protocol";
import type {
  HarnessAdmissionAccountPort,
  HarnessAdmissionBindingPort,
} from "../../runtime/CloudHarnessAdmissionPorts";
import type { Env } from "../../types/ai";
import { withBrainPersistenceRepository } from "../persistence/BrainPersistenceRepositoryFactory";
import { createPostgresHarnessAdmissionAccounts } from "./PostgresHostedHarnessControlPlane";

/** Production uses the existing account and canonical binding owners. Env's
 * designated authority overrides remain explicit dependency injection only;
 * Wrangler does not need to supply JavaScript-function bindings. */
export function composeHostedHarnessAdmission(env: Env): {
  accounts: HarnessAdmissionAccountPort;
  bindings: HarnessAdmissionBindingPort;
} {
  return {
    accounts:
      env.HARNESS_ADMISSION_ACCOUNTS ??
      createPostgresHarnessAdmissionAccounts(env),
    bindings:
      env.AUTH_HARNESS_ADMISSION_BINDINGS ??
      createPostgresHarnessAdmissionBindings(env),
  };
}

function createPostgresHarnessAdmissionBindings(
  env: Env,
): HarnessAdmissionBindingPort {
  const withBindings = <T>(
    action: (bindings: PostgresHarnessAdmissionBindingPort) => Promise<T>,
  ) =>
    withBrainPersistenceRepository(
      env,
      undefined,
      (client) => new PostgresHarnessAdmissionBindingPort(client),
      action,
    );

  return {
    lookupImmutable: (...args) =>
      withBindings((bindings) => bindings.lookupImmutable(...args)),
    freezeAndClaim: (input) =>
      withBindings((bindings) => bindings.freezeAndClaim(input)),
    reserveOpening: (input) => withBindings((bindings) => bindings.reserveOpening(input)),
    beginOpeningDispatch: (input) => withBindings((bindings) => bindings.beginOpeningDispatch(input)),
    acknowledgeOpening: (input) => withBindings((bindings) => bindings.acknowledgeOpening(input)),
    attach: (input) => withBindings((bindings) => bindings.attach(input)),
    assertActive: (...args) =>
      withBindings((bindings) => bindings.assertActive(...args)),
    observationsForAttempt(principal, selection) {
      const attempt = { ...principal };
      const selected = HarnessSelectionSchema.parse(selection);
      // This wrapper owns only immutable attempt data. Never return the SQL-backed
      // observation port from withBindings: its client is released on return.
      // Each lazy operation awaits its canonical owner's transaction while the
      // current factory callback still owns the client, including commit ACKs.
      return {
        recover: (session) =>
          withBindings((bindings) =>
            bindings.observationsForAttempt(attempt, selected).recover(session),
          ),
        lookup: (observation) =>
          withBindings((bindings) =>
            bindings
              .observationsForAttempt(attempt, selected)
              .lookup(observation),
          ),
        commit: (input) =>
          withBindings((bindings) =>
            bindings.observationsForAttempt(attempt, selected).commit(input),
          ),
        claimReply: (origin) =>
          withBindings((bindings) =>
            bindings
              .observationsForAttempt(attempt, selected)
              .claimReply(origin),
          ),
      };
    },
  };
}
