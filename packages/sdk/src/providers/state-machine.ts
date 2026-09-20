import { ProviderClientTransitionError } from "./errors.js";

export const PROVIDER_LIFECYCLE_STEPS = [
  "discover_providers",
  "connect_credential",
  "validate_credential",
  "select_default",
  "resolve_for_run",
  "disconnect",
] as const;

export type ProviderLifecycleStep = (typeof PROVIDER_LIFECYCLE_STEPS)[number];

export interface ProviderLifecycleState {
  step: ProviderLifecycleStep;
  selectedCredentialId?: string;
  selectedProviderId?: string;
  selectedModelId?: string;
  connectedCredentialIds: string[];
  validatedCredentialIds: string[];
  lastResolvedAt?: string;
}

export interface ProviderLifecycleTransition {
  step: ProviderLifecycleStep;
  providerId?: string;
  modelId?: string;
  credentialId?: string;
  resolvedAt?: string;
}

export function createInitialProviderLifecycleState(): ProviderLifecycleState {
  return {
    step: "discover_providers",
    connectedCredentialIds: [],
    validatedCredentialIds: [],
  };
}

export function isProviderLifecycleStep(value: string): value is ProviderLifecycleStep {
  return PROVIDER_LIFECYCLE_STEPS.includes(value as ProviderLifecycleStep);
}

export function transitionProviderLifecycle(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  assertValidTransition(state.step, transition.step);
  const nextState = cloneState(state, transition.step);
  return applyTransition(nextState, transition);
}

function assertValidTransition(
  fromStep: ProviderLifecycleStep,
  toStep: ProviderLifecycleStep,
): void {
  if (fromStep === toStep) {
    return;
  }
  if (isNextStep(fromStep, toStep) || isAllowedReset(fromStep, toStep)) {
    return;
  }
  throw new ProviderClientTransitionError(
    fromStep,
    toStep,
    `Invalid lifecycle transition: ${fromStep} -> ${toStep}`,
  );
}

function isNextStep(fromStep: ProviderLifecycleStep, toStep: ProviderLifecycleStep): boolean {
  const fromIndex = PROVIDER_LIFECYCLE_STEPS.indexOf(fromStep);
  const toIndex = PROVIDER_LIFECYCLE_STEPS.indexOf(toStep);
  return toIndex - fromIndex === 1;
}

function isAllowedReset(
  fromStep: ProviderLifecycleStep,
  toStep: ProviderLifecycleStep,
): boolean {
  if (toStep === "disconnect") {
    return fromStep !== "discover_providers";
  }
  return fromStep === "disconnect" && toStep === "discover_providers";
}

function cloneState(
  state: ProviderLifecycleState,
  step: ProviderLifecycleStep,
): ProviderLifecycleState {
  return {
    step,
    selectedCredentialId: state.selectedCredentialId,
    selectedProviderId: state.selectedProviderId,
    selectedModelId: state.selectedModelId,
    connectedCredentialIds: [...state.connectedCredentialIds],
    validatedCredentialIds: [...state.validatedCredentialIds],
    lastResolvedAt: state.lastResolvedAt,
  };
}

function applyTransition(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  if (transition.step === "discover_providers") {
    return createInitialProviderLifecycleState();
  }
  if (transition.step === "connect_credential") {
    return connectCredential(state, transition);
  }
  if (transition.step === "validate_credential") {
    return validateCredential(state, transition);
  }
  if (transition.step === "select_default") {
    return selectDefault(state, transition);
  }
  if (transition.step === "resolve_for_run") {
    return resolveForRun(state, transition);
  }
  if (transition.step === "disconnect") {
    return disconnectCredential(state, transition);
  }
  return state;
}

function connectCredential(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  const credentialId = requireField(transition.credentialId, "credentialId", state.step);
  const providerId = requireField(transition.providerId, "providerId", state.step);
  addUnique(state.connectedCredentialIds, credentialId);
  state.selectedCredentialId = state.selectedCredentialId ?? credentialId;
  state.selectedProviderId = providerId;
  return state;
}

function validateCredential(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  const credentialId = requireField(transition.credentialId, "credentialId", state.step);
  if (!state.connectedCredentialIds.includes(credentialId)) {
    throw new ProviderClientTransitionError(
      "connect_credential",
      "validate_credential",
      `Cannot validate disconnected credential: ${credentialId}`,
    );
  }
  addUnique(state.validatedCredentialIds, credentialId);
  return state;
}

function selectDefault(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  const providerId = requireField(transition.providerId, "providerId", state.step);
  state.selectedProviderId = providerId;
  if (transition.modelId !== undefined) {
    state.selectedModelId = requireField(transition.modelId, "modelId", state.step);
  }
  if (transition.credentialId) {
    const credentialId = requireField(
      transition.credentialId,
      "credentialId",
      state.step,
    );
    ensureConnectedCredential(state, credentialId, "select_default");
    ensureValidatedCredential(state, credentialId, "select_default");
    state.selectedCredentialId = credentialId;
  } else if (state.selectedCredentialId) {
    ensureConnectedCredential(state, state.selectedCredentialId, "select_default");
    ensureValidatedCredential(state, state.selectedCredentialId, "select_default");
  }
  return state;
}

function resolveForRun(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  const providerId = resolveRequiredSelection({
    explicitValue: transition.providerId,
    fallbackValue: state.selectedProviderId,
    fieldName: "providerId",
    step: state.step,
  });
  if (!providerId) {
    throw new ProviderClientTransitionError(
      "select_default",
      "resolve_for_run",
      "Missing provider selection for resolve_for_run",
    );
  }
  const modelId = resolveRequiredSelection({
    explicitValue: transition.modelId,
    fallbackValue: state.selectedModelId,
    fieldName: "modelId",
    step: state.step,
  });
  if (!modelId) {
    throw new ProviderClientTransitionError(
      "select_default",
      "resolve_for_run",
      "Missing model selection for resolve_for_run",
    );
  }
  state.selectedProviderId = providerId;
  state.selectedModelId = modelId;
  const credentialId = transition.credentialId ?? state.selectedCredentialId;
  if (credentialId) {
    const normalizedCredentialId = requireField(
      credentialId,
      "credentialId",
      state.step,
    );
    ensureConnectedCredential(state, normalizedCredentialId, "resolve_for_run");
    ensureValidatedCredential(state, normalizedCredentialId, "resolve_for_run");
    state.selectedCredentialId = normalizedCredentialId;
  }
  state.lastResolvedAt = requireField(
    transition.resolvedAt,
    "resolvedAt",
    state.step,
  );
  return state;
}

function resolveRequiredSelection(params: {
  explicitValue: string | undefined;
  fallbackValue: string | undefined;
  fieldName: "providerId" | "modelId";
  step: ProviderLifecycleStep;
}): string | undefined {
  if (params.explicitValue !== undefined) {
    return requireField(params.explicitValue, params.fieldName, params.step);
  }
  if (params.fallbackValue !== undefined) {
    return requireField(params.fallbackValue, params.fieldName, params.step);
  }
  return undefined;
}

function disconnectCredential(
  state: ProviderLifecycleState,
  transition: ProviderLifecycleTransition,
): ProviderLifecycleState {
  if (!transition.credentialId) {
    return createInitialProviderLifecycleState();
  }
  const credentialId = requireField(
    transition.credentialId,
    "credentialId",
    state.step,
  );
  removeCredential(state.connectedCredentialIds, credentialId);
  removeCredential(state.validatedCredentialIds, credentialId);
  if (state.selectedCredentialId === credentialId) {
    state.selectedCredentialId = undefined;
    state.selectedModelId = undefined;
    state.selectedProviderId = undefined;
  }
  return state;
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function removeCredential(values: string[], credentialId: string): void {
  const index = values.indexOf(credentialId);
  if (index >= 0) {
    values.splice(index, 1);
  }
}

function requireField(
  value: string | undefined,
  fieldName: string,
  step: ProviderLifecycleStep,
): string {
  const normalizedValue = value?.trim();
  if (!normalizedValue || normalizedValue.length === 0) {
    throw new ProviderClientTransitionError(
      step,
      step,
      `Missing required ${fieldName} for ${step}`,
    );
  }
  return normalizedValue;
}

function ensureConnectedCredential(
  state: ProviderLifecycleState,
  credentialId: string,
  step: "select_default" | "resolve_for_run",
): void {
  if (!state.connectedCredentialIds.includes(credentialId)) {
    throw new ProviderClientTransitionError(
      "connect_credential",
      step,
      `Credential is not connected: ${credentialId}`,
    );
  }
}

function ensureValidatedCredential(
  state: ProviderLifecycleState,
  credentialId: string,
  step: "select_default" | "resolve_for_run",
): void {
  if (!state.validatedCredentialIds.includes(credentialId)) {
    throw new ProviderClientTransitionError(
      "validate_credential",
      step,
      `Credential is not validated: ${credentialId}`,
    );
  }
}
