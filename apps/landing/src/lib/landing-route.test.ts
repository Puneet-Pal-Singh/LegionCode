import { describe, expect, it } from "vitest";
import { buildAgentsRedirectUrl, resolveLandingRoute } from "./landing-route";

describe("resolveLandingRoute", () => {
  it("serves the landing page at the root", () => {
    expect(resolveLandingRoute("/")).toEqual({ kind: "landing" });
  });

  it("keeps unknown public paths on the landing app", () => {
    expect(resolveLandingRoute("/")).toEqual({ kind: "landing" });
    expect(resolveLandingRoute("/pricing")).toEqual({ kind: "landing" });
  });

  it("redirects legacy app aliases to the agent route", () => {
    expect(resolveLandingRoute("/app")).toEqual({
      kind: "redirect",
      target: "/agents",
    });
    expect(resolveLandingRoute("/web-agents")).toEqual({
      kind: "redirect",
      target: "/agents",
    });
  });

  it("reserves /cloud for the future cloud agents page", () => {
    expect(resolveLandingRoute("/cloud")).toEqual({ kind: "cloud" });
    expect(resolveLandingRoute("/cloud/agents")).toEqual({ kind: "cloud" });
  });

  it("preserves search and hash when building the agent route", () => {
    expect(buildAgentsRedirectUrl("?run=1", "#review")).toBe(
      "/agents?run=1#review",
    );
  });
});
