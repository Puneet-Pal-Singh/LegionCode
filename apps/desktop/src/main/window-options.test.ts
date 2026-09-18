import { describe, expect, it } from "vitest";

import { createWindowOptions } from "./window-options";

describe("Desktop window security", () => {
  it("isolates and sandboxes the renderer without Node.js", () => {
    const options = createWindowOptions("/app/preload.js");

    expect(options.webPreferences).toMatchObject({
      preload: "/app/preload.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
  });
});
