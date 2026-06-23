import { describe, it } from "vitest";
import {
  expectGoldenScenarioConformance,
  expectIllegalScenarioRejection,
  expectIsolationConformance,
  expectMalformedScenarioRejection,
} from "./lifecycle-golden-assertions.js";
import { createGoldenLifecycleMatrix } from "./lifecycle-golden-scenarios.js";
import type { LifecycleEventLogContract } from "./lifecycle.js";

export function registerLifecycleGoldenMatrixConformance(
  implementation: string,
  createLog: () => LifecycleEventLogContract | Promise<LifecycleEventLogContract>,
): void {
  const matrix = createGoldenLifecycleMatrix();

  describe(`${implementation} golden lifecycle matrix`, () => {
    for (const scenario of matrix.legal) {
      it(`conforms: ${scenario.name}`, async () => {
        const log = await createLog();
        await expectGoldenScenarioConformance(log, scenario);
      });
    }

    for (const scenario of matrix.illegal) {
      it(`rejects illegal stream: ${scenario.name}`, () => {
        expectIllegalScenarioRejection(scenario);
      });
    }

    for (const scenario of matrix.malformed) {
      it(`rejects malformed event: ${scenario.name}`, () => {
        expectMalformedScenarioRejection(scenario);
      });
    }

    it(`conforms: ${matrix.isolation.name}`, () => {
      expectIsolationConformance(matrix.isolation);
    });
  });
}
