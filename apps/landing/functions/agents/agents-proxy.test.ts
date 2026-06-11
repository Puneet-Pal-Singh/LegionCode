import { describe, expect, it } from "vitest";

import { buildAgentsTarget } from "./[[path]]";

describe("buildAgentsTarget", () => {
  it("maps the public agents root to the upstream root", () => {
    const requestUrl = new URL("https://legioncode.dev/agents/");

    expect(buildAgentsTarget("https://agents.legioncode.dev", requestUrl)).toBe(
      "https://agents.legioncode.dev/",
    );
  });

  it("strips the public agents prefix from upstream asset requests", () => {
    const requestUrl = new URL(
      "https://legioncode.dev/agents/assets/index.js?v=1",
    );

    expect(buildAgentsTarget("https://agents.legioncode.dev", requestUrl)).toBe(
      "https://agents.legioncode.dev/assets/index.js?v=1",
    );
  });
});
