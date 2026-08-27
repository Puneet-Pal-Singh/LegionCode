import { describe, expect, it } from "vitest";

import {
  findMissingEndpointEnvVars,
  formatMissingEndpointEnvMessage,
  shouldFailFastEndpointBuild,
} from "./endpoint-config";

describe("endpoint-config", () => {
  it("returns every missing deploy endpoint variable", () => {
    expect(findMissingEndpointEnvVars({})).toEqual([
      "VITE_BRAIN_BASE_URL",
      "VITE_MUSCLE_BASE_URL",
      "VITE_MUSCLE_WS_URL",
    ]);
  });

  it("returns an empty list when all deploy endpoint variables are present", () => {
    expect(
      findMissingEndpointEnvVars({
        VITE_BRAIN_BASE_URL: "https://brain.example.com",
        VITE_MUSCLE_BASE_URL: "https://muscle.example.com",
        VITE_MUSCLE_WS_URL: "wss://muscle.example.com",
      }),
    ).toEqual([]);
  });

  it("treats whitespace-only endpoint values as missing", () => {
    expect(
      findMissingEndpointEnvVars({
        VITE_BRAIN_BASE_URL: "   ",
        VITE_MUSCLE_BASE_URL: "https://muscle.example.com",
        VITE_MUSCLE_WS_URL: "\n",
      }),
    ).toEqual(["VITE_BRAIN_BASE_URL", "VITE_MUSCLE_WS_URL"]);
  });

  it("formats a stable deploy validation message", () => {
    expect(
      formatMissingEndpointEnvMessage([
        "VITE_BRAIN_BASE_URL",
        "VITE_MUSCLE_WS_URL",
      ]),
    ).toBe(
      "[platform-endpoints] Missing required endpoint environment variables: VITE_BRAIN_BASE_URL, VITE_MUSCLE_WS_URL",
    );
  });

  it("enables fail-fast deploy builds only when explicitly requested", () => {
    expect(shouldFailFastEndpointBuild({})).toBe(false);
    expect(
      shouldFailFastEndpointBuild({
        LEGIONCODE_REQUIRE_DEPLOY_ENDPOINTS: "true",
      }),
    ).toBe(true);
  });
});
