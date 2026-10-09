import {
  ProviderRouteResolutionError,
  resolveProviderModelRoute,
  type ProviderModelRoute,
  type ProviderModelRouteInput,
} from "@repo/provider-core";
import { ValidationError } from "../../domain/errors";
import { ProviderRegistryService } from "../providers";

export type { ProviderModelRoute, ProviderModelRouteInput };

export class ProviderModelRouteResolver {
  constructor(
    private readonly registryService = new ProviderRegistryService(),
  ) {}

  resolve(input: ProviderModelRouteInput): ProviderModelRoute {
    try {
      return resolveProviderModelRoute(input, (providerId) =>
        this.registryService.getProvider(providerId),
      );
    } catch (error) {
      if (!(error instanceof ProviderRouteResolutionError)) {
        throw error;
      }
      throw new ValidationError(error.message, error.code);
    }
  }
}
