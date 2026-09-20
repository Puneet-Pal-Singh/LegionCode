import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EnvironmentStatus } from "./EnvironmentStatus.js";

describe("EnvironmentStatus", () => {
  it("does not imply local capabilities are ready when they are unavailable", () => {
    render(
      <EnvironmentStatus
        snapshot={{
          kind: "local",
          status: "ready",
          protocolVersion: "1.0.0",
          serverVersion: "0.1.0",
          capabilities: [],
          unavailableCapabilities: [
            {
              capability: "workspace-selection-v1",
              reason: "Planned for a later local slice",
            },
          ],
          reason: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Environment status")).toHaveAttribute(
      "data-environment-status",
      "ready",
    );
    expect(screen.getByText("1 capability slices unavailable")).toBeVisible();
  });
});
