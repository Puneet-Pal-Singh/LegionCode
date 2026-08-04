import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ReasoningEffortPicker } from "./ReasoningEffortPicker";

describe("ReasoningEffortPicker", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("renders provider-owned effort labels without rewriting them", () => {
    render(
      <ReasoningEffortPicker
        providerId="openai"
        modelId="gpt-5.6-luna"
        efforts={["light", "high", "max"]}
        disabled={false}
      />,
    );

    const picker = screen.getByRole("button", { name: "Reasoning effort" });
    expect(picker).toHaveTextContent("Default");

    fireEvent.click(picker);
    expect(screen.getByRole("menuitemradio", { name: "light" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "max" })).toBeVisible();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "light" }));
    expect(picker).toHaveTextContent("light");
  });
});
