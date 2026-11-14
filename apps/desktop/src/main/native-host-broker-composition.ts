import {
  MacHostBrokerClient,
  readInstalledMacHostBrokerDescriptor,
} from "@legioncode/execution-engine/runtime/desktop/MacHostBrokerClient";
import { MacHostBrokerError } from "@legioncode/execution-engine/runtime/desktop/MacHostBrokerProtocol";
import {
  NativeHostBrokerConfigurationSchema,
  type NativeHostBrokerConfiguration,
} from "../shared/native-host-broker-config";

/** Read-only setup observation. The C owner validates installed code, protected
 * ancestors and the actual service; Main never creates or repairs setup here. */
export async function resolveDesktopNativeHostBrokerConfiguration(
  currentBridgePath: string | undefined,
): Promise<NativeHostBrokerConfiguration | undefined> {
  if (process.platform !== "darwin" || !currentBridgePath) return undefined;
  const descriptor = await readInstalledMacHostBrokerDescriptor({ trustedReaderPath: currentBridgePath });
  if (descriptor.state !== "configured") return undefined;
  // An older installed approval must not select another application's bridge.
  if (descriptor.options.bridgePath !== currentBridgePath) return undefined;
  return NativeHostBrokerConfigurationSchema.parse({
    ...descriptor.options,
    generation: descriptor.generation,
    configurationSHA256: descriptor.configurationSHA256,
  });
}

/** Configured is not qualified. Only the normal authenticated ready response
 * may supply the captured runtime's optional host backend. */
export async function connectDesktopNativeHostBroker(
  configuration: NativeHostBrokerConfiguration | undefined,
): Promise<MacHostBrokerClient | undefined> {
  if (!configuration) return undefined;
  const captured = NativeHostBrokerConfigurationSchema.parse(configuration);
  let broker: MacHostBrokerClient;
  try {
    broker = await MacHostBrokerClient.connect({
      bridgePath: captured.bridgePath,
      serviceCodeRequirement: captured.serviceCodeRequirement,
      expectedPolicySHA256: captured.expectedPolicySHA256,
      expectedPolicyGeneration: captured.expectedPolicyGeneration,
    });
  } catch (error) {
    // These explicit setup states cannot advertise general commands. Unknown
    // transport, identity or resource outcomes are never silently downgraded.
    if (error instanceof MacHostBrokerError && !error.outcomeUnknown &&
        (error.reason === "qualificationRequired" || error.reason === "writerABIUnavailable")) return undefined;
    throw error;
  }
  if (broker.generation !== captured.generation)
    throw new Error("Native host setup changed before runtime composition");
  return broker;
}
