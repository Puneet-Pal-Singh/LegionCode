import { describe, expect, it } from "vitest";
import {
  PROVIDER_LIFECYCLE_STEPS,
  createInitialProviderLifecycleState,
  isProviderLifecycleStep,
  transitionProviderLifecycle,
} from "./state-machine.js";
import { ProviderClientTransitionError } from "./errors.js";

describe("provider lifecycle state machine baseline", () => {
  it("exposes canonical lifecycle order", () => {
    expect(PROVIDER_LIFECYCLE_STEPS).toEqual([
      "discover_providers",
      "connect_credential",
      "validate_credential",
      "select_default",
      "resolve_for_run",
      "disconnect",
    ]);
  });

  it("builds deterministic initial state", () => {
    expect(createInitialProviderLifecycleState()).toEqual({
      step: "discover_providers",
      connectedCredentialIds: [],
      validatedCredentialIds: [],
    });
  });

  it("guards lifecycle step checks", () => {
    expect(isProviderLifecycleStep("connect_credential")).toBe(true);
    expect(isProviderLifecycleStep("unknown_step")).toBe(false);
  });

  it("applies deterministic lifecycle transitions", () => {
    const connected = transitionProviderLifecycle(
      createInitialProviderLifecycleState(),
      {
        step: "connect_credential",
        providerId: "openai",
        credentialId: "cred-1",
      },
    );
    const validated = transitionProviderLifecycle(connected, {
      step: "validate_credential",
      credentialId: "cred-1",
    });
    const selected = transitionProviderLifecycle(validated, {
      step: "select_default",
      providerId: "openai",
      credentialId: "cred-1",
      modelId: "gpt-4o",
    });
    const resolved = transitionProviderLifecycle(selected, {
      step: "resolve_for_run",
      resolvedAt: "2026-03-06T00:00:00.000Z",
    });

    expect(resolved.step).toBe("resolve_for_run");
    expect(resolved.selectedProviderId).toBe("openai");
    expect(resolved.selectedModelId).toBe("gpt-4o");
    expect(resolved.connectedCredentialIds).toEqual(["cred-1"]);
    expect(resolved.validatedCredentialIds).toEqual(["cred-1"]);
    expect(resolved.lastResolvedAt).toBe("2026-03-06T00:00:00.000Z");
  });

  it("keeps idempotent connect calls deterministic", () => {
    const connected = transitionProviderLifecycle(
      createInitialProviderLifecycleState(),
      {
        step: "connect_credential",
        providerId: "openai",
        credentialId: "cred-1",
      },
    );
    const connectedAgain = transitionProviderLifecycle(connected, {
      step: "connect_credential",
      providerId: "openai",
      credentialId: "cred-1",
    });

    expect(connectedAgain.connectedCredentialIds).toEqual(["cred-1"]);
  });

  it("rejects invalid lifecycle transitions with typed error", () => {
    expect(() =>
      transitionProviderLifecycle(createInitialProviderLifecycleState(), {
        step: "resolve_for_run",
      }),
    ).toThrow(ProviderClientTransitionError);
  });

  it("requires resolvedAt for resolve_for_run transitions", () => {
    const selected = transitionProviderLifecycle(
      transitionProviderLifecycle(
        transitionProviderLifecycle(createInitialProviderLifecycleState(), {
          step: "connect_credential",
          providerId: "openai",
          credentialId: "cred-1",
        }),
        {
          step: "validate_credential",
          credentialId: "cred-1",
        },
      ),
      {
        step: "select_default",
        providerId: "openai",
        credentialId: "cred-1",
        modelId: "gpt-4o",
      },
    );

    expect(() =>
      transitionProviderLifecycle(selected, {
        step: "resolve_for_run",
      }),
    ).toThrow(ProviderClientTransitionError);
  });

  it("supports disconnect reset and explicit disconnect", () => {
    const resolved = transitionProviderLifecycle(
      transitionProviderLifecycle(
        transitionProviderLifecycle(
          transitionProviderLifecycle(createInitialProviderLifecycleState(), {
            step: "connect_credential",
            providerId: "openai",
            credentialId: "cred-1",
          }),
          {
            step: "validate_credential",
            credentialId: "cred-1",
          },
        ),
        {
          step: "select_default",
          providerId: "openai",
          credentialId: "cred-1",
          modelId: "gpt-4o",
        },
      ),
      {
        step: "resolve_for_run",
        resolvedAt: "2026-03-06T00:00:00.000Z",
      },
    );

    const disconnectedOne = transitionProviderLifecycle(resolved, {
      step: "disconnect",
      credentialId: "cred-1",
    });
    expect(disconnectedOne.connectedCredentialIds).toEqual([]);
    expect(disconnectedOne.validatedCredentialIds).toEqual([]);
    expect(disconnectedOne.selectedCredentialId).toBeUndefined();

    const reset = transitionProviderLifecycle(disconnectedOne, {
      step: "discover_providers",
    });
    expect(reset).toEqual(createInitialProviderLifecycleState());
  });

  it("normalizes credential identifiers across transitions", () => {
    const connected = transitionProviderLifecycle(
      createInitialProviderLifecycleState(),
      {
        step: "connect_credential",
        providerId: "openai",
        credentialId: " cred-1 ",
      },
    );

    const validated = transitionProviderLifecycle(connected, {
      step: "validate_credential",
      credentialId: "cred-1",
    });

    expect(validated.connectedCredentialIds).toEqual(["cred-1"]);
    expect(validated.validatedCredentialIds).toEqual(["cred-1"]);
  });

  it("rejects selecting or resolving with unvalidated credentials", () => {
    const connected = transitionProviderLifecycle(
      createInitialProviderLifecycleState(),
      {
        step: "connect_credential",
        providerId: "openai",
        credentialId: "cred-a",
      },
    );
    const connectedAgain = transitionProviderLifecycle(connected, {
      step: "connect_credential",
      providerId: "openai",
      credentialId: "cred-b",
    });
    const validatedA = transitionProviderLifecycle(connectedAgain, {
      step: "validate_credential",
      credentialId: "cred-a",
    });

    expect(() =>
      transitionProviderLifecycle(validatedA, {
        step: "select_default",
        providerId: "openai",
        credentialId: "cred-b",
        modelId: "gpt-4o",
      }),
    ).toThrow(ProviderClientTransitionError);

    const invalidSelectedState = {
      step: "select_default" as const,
      connectedCredentialIds: ["cred-b"],
      validatedCredentialIds: [],
      selectedCredentialId: "cred-b",
      providerId: "openai",
      selectedProviderId: "openai",
      selectedModelId: "gpt-4o",
    };

    expect(() =>
      transitionProviderLifecycle(invalidSelectedState, {
        step: "resolve_for_run",
        resolvedAt: "2026-03-06T00:00:00.000Z",
      }),
    ).toThrow(ProviderClientTransitionError);
  });

  it("rejects blank provider/model selections", () => {
    const validated = transitionProviderLifecycle(
      transitionProviderLifecycle(createInitialProviderLifecycleState(), {
        step: "connect_credential",
        providerId: "openai",
        credentialId: "cred-1",
      }),
      {
        step: "validate_credential",
        credentialId: "cred-1",
      },
    );

    expect(() =>
      transitionProviderLifecycle(validated, {
        step: "select_default",
        providerId: "openai",
        credentialId: "cred-1",
        modelId: "   ",
      }),
    ).toThrow(ProviderClientTransitionError);

    const selected = transitionProviderLifecycle(validated, {
      step: "select_default",
      providerId: "openai",
      credentialId: "cred-1",
      modelId: "gpt-4o",
    });
    expect(() =>
      transitionProviderLifecycle(selected, {
        step: "resolve_for_run",
        providerId: "   ",
        resolvedAt: "2026-03-06T00:00:00.000Z",
      }),
    ).toThrow(ProviderClientTransitionError);
  });
});
