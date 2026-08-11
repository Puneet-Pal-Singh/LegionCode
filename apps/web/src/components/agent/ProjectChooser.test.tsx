import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectChooser } from "./ProjectChooser";

describe("ProjectChooser", () => {
  it("switches projects without routing through repository onboarding", () => {
    const onSelect = vi.fn();
    const onNewProject = vi.fn();

    render(
      <ProjectChooser
        currentProject="owner/shadowbox"
        projects={["shadowbox", "Sketch"]}
        onSelect={onSelect}
        onNewProject={onNewProject}
        onNoProject={vi.fn()}
      >
        <button type="button">shadowbox</button>
      </ProjectChooser>,
    );

    fireEvent.click(screen.getByRole("button", { name: "shadowbox" }));

    const dialog = screen.getByRole("dialog", { name: "Choose project" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "shadowbox" })).toContainElement(
      screen.getByTestId("project-chooser-current"),
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Sketch" }));

    expect(onSelect).toHaveBeenCalledWith("Sketch");
    expect(onNewProject).not.toHaveBeenCalled();
  });

  it("keeps repository onboarding as an explicit new-project action", () => {
    const onNewProject = vi.fn();

    render(
      <ProjectChooser
        projects={[]}
        onSelect={vi.fn()}
        onNewProject={onNewProject}
        onNoProject={vi.fn()}
      >
        <button type="button">Choose project</button>
      </ProjectChooser>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose project" }));
    fireEvent.click(screen.getByRole("button", { name: "New project" }));

    expect(onNewProject).toHaveBeenCalledOnce();
  });
});
