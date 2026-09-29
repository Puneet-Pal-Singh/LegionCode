import type {
  ILLMGateway,
  LLMTextRequest,
  LLMTextResponse,
} from "../llm/types.js";
import { shouldForceNativeFinalSynthesis } from "./NativeProviderStepBudget.js";

export function initialNativeFinalRecoveryAttempts(
  stepsExecuted: number,
  maxSteps: number,
): 0 | 1 {
  return shouldForceNativeFinalSynthesis(stepsExecuted, maxSteps) ? 1 : 0;
}

export type NativeProviderFinalRecoveryRequest = Omit<
  LLMTextRequest,
  "tools"
>;

/** Final recovery is plain provider text and deliberately has no tools. */
export function generateNativeProviderFinalRecovery(
  gateway: Pick<ILLMGateway, "generateText">,
  request: NativeProviderFinalRecoveryRequest,
): Promise<LLMTextResponse> {
  return gateway.generateText({ ...request, tools: undefined });
}
