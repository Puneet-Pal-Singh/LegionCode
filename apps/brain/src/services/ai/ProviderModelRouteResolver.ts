import {
  ProviderModelRouteResolver as CoreProviderModelRouteResolver,
} from "@repo/provider-core";
import { ValidationError } from "../../domain/errors";
import { ProviderRegistryService } from "../providers/ProviderRegistryService";

export type { ProviderModelRoute, ProviderModelRouteInput } from "@repo/provider-core";

/** Hosted registry and error binding; route policy is shared with native hosts. */
export class ProviderModelRouteResolver extends CoreProviderModelRouteResolver {
  constructor(registryService = new ProviderRegistryService()) {
    super(registryService, (message, code) => new ValidationError(message, code));
  }
}
