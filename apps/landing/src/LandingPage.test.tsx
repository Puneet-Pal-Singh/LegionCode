import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LandingPage } from "./LandingPage";

describe("LandingPage", () => {
  it("renders the private alpha landing page with an agent CTA", () => {
    render(<LandingPage />);

    expect(
      screen.getByRole("heading", { name: /LegionCode/i }),
    ).toBeInTheDocument();
    const agentLinks = screen.getAllByRole("link", { name: /Open Agents/i });
    expect(agentLinks.length).toBeGreaterThan(0);
    for (const link of agentLinks) {
      expect(link).toHaveAttribute("href", "/agents");
    }
  });
});
