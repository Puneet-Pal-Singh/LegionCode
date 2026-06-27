import { registerLifecycleSettlementConformance } from "@repo/contract-conformance";
import { createLifecycleSink } from "./test-fixtures.js";

registerLifecycleSettlementConformance(
  "runtime lifecycle event sink",
  createLifecycleSink,
);
