export { createCloudHarnessAuthenticator } from "./authentication";
import { createServer, type IncomingMessage } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import type { CloudHarnessAuthenticatedContext } from "./authentication";
import { attachCloudHarnessBridge } from "./bridge";
import { CloudHarnessComposition } from "./composition";
import { CLOUD_HARNESS_BRIDGE_LIMITS } from "../src/harness/CloudHarnessBridgeLimits";
import {
  assertCloudHarnessLaunchAvailable,
  CLOUD_HARNESS_AVAILABILITY,
  CloudHarnessUnavailableError,
} from "../src/harness/CloudHarnessAvailability";

/** Trusted Node entry. No environment variable, HTTP payload or CLI argument can
 * enable execution or inject a driver/credential. A reviewed composition root
 * must supply the existing durable authority; current launch still fails closed.
 */
export function startCloudHarnessHost(options?: {
  authenticate(
    request: IncomingMessage,
  ): Promise<CloudHarnessAuthenticatedContext>;
}) {
  const disabled = new CloudHarnessComposition({
    assertActive: async () => assertCloudHarnessLaunchAvailable(),
    assertCleanup: async () => {
      throw new CloudHarnessUnavailableError();
    },
    configureHost: async () => {
      throw new CloudHarnessUnavailableError();
    },
    // Disabled status composition cannot acknowledge or retire a damaged stream.
    resolveObservationIntegrity: async () => {
      throw new CloudHarnessUnavailableError();
    },
  });
  const server = createServer((request, response) => {
    if (
      request.method === "GET" &&
      (request.url === "/healthz" || request.url === "/status")
    ) {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify(disabled.status()));
    } else {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ code: "not_found" }));
    }
  });
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: CLOUD_HARNESS_BRIDGE_LIMITS.maxFrameBytes,
    perMessageDeflate: false,
  });
  let upgrading = 0;
  server.on("upgrade", (request, socket, head) => {
    const destroy = () => {
      try {
        socket.destroy();
      } catch {
        /* Keep cleanup errors private. */
      }
    };
    socket.on("error", destroy);
    if (upgrading >= 8 || request.url !== "/bridge") {
      destroy();
      return;
    }
    upgrading++;
    void (async () => {
      // Deny BEFORE calling credential/custody authority or accepting a private
      // execution connection. The status-only entry never boots provider state.
      const cleanupOnly =
        request.headers["x-legion-harness-intent"] === "cleanup";
      if (!cleanupOnly) assertCloudHarnessLaunchAvailable();
      if (!options) throw new Error("Cloud harness authority unavailable");
      const context = await options.authenticate(request);
      if (context.cleanupOnly !== cleanupOnly)
        throw new Error("Cloud harness capability intent mismatch");
      sockets.handleUpgrade(request, socket, head, (connection) =>
        attachCloudHarnessBridge(
          connection,
          context.composition,
          context.command,
          context.cleanupOnly,
          context.cleanupSession,
        ),
      );
    })()
      .catch(() => {
        // Fixed response only. No authorization exception/payload reaches a peer.
        try {
          socket.end(
            "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
          );
        } catch {
          destroy();
        }
      })
      .finally(() => {
        upgrading--;
      });
  });
  server.listen(4319, "0.0.0.0");
  return { server, sockets, status: CLOUD_HARNESS_AVAILABILITY };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startCloudHarnessHost();
}
