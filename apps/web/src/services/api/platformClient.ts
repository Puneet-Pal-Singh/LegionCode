import {
  createPlatformClient,
  createPlatformHttpTransport,
  type PlatformClient,
} from "@legioncode/sdk";
import { getBrainHttpBase } from "../../lib/platform-endpoints.js";

export function createWebPlatformClient(): PlatformClient {
  return createPlatformClient(
    createPlatformHttpTransport({
      baseUrl: getBrainHttpBase(),
    }),
  );
}
