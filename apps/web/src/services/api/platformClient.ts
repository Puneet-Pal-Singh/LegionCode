import {
  createPlatformClient,
  createPlatformHttpTransport,
  type PlatformClient,
  type PlatformHttpTransportOptions,
} from "@legioncode/sdk";
import { getBrainHttpBase } from "../../lib/platform-endpoints.js";

export function createWebPlatformClient(options?: Pick<PlatformHttpTransportOptions, "prepareRequest">): PlatformClient {
  return createPlatformClient(
    createPlatformHttpTransport({
      baseUrl: getBrainHttpBase(),
      prepareRequest: options?.prepareRequest,
    }),
  );
}
