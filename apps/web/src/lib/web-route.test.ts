import { describe, expect, it } from "vitest";
import { buildAgentsRedirectUrl, resolveWebRoute } from "./web-route";

describe("resolveWebRoute", () => {
  it("serves the landing page at the root", () => {
    expect(resolveWebRoute("/")).toEqual({ kind: "landing" });
  });

  it("serves the agent app under /agents", () => {
    expect(resolveWebRoute("/agents")).toEqual({ kind: "agents" });
    expect(resolveWebRoute("/agents/")).toEqual({ kind: "agents" });
    expect(resolveWebRoute("/agents/run/demo")).toEqual({ kind: "agents" });
  });

  it("redirects legacy app aliases to /agents", () => {
    expect(resolveWebRoute("/app")).toEqual({
      kind: "redirect",
      target: "/agents",
    });
    expect(resolveWebRoute("/web-agents")).toEqual({
      kind: "redirect",
      target: "/agents",
    });
  });

  it("reserves /cloud for the future cloud agents page", () => {
    expect(resolveWebRoute("/cloud")).toEqual({ kind: "cloud" });
  });

  it("preserves search and hash when building the agents redirect", () => {
    expect(buildAgentsRedirectUrl("?run=1", "#review")).toBe(
      "/agents?run=1#review",
    );
  });
});
