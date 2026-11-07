import type { OpenCodeEvent } from "@opencode/client";
import { OpenCodeTransportError } from "./OpenCodeClient.js";

/** Advisory liveness in the attempt's fresh private server. Host OS scope proof remains mandatory. */
export class OpenCodeWorkTracker {
  private readonly active = new Set<string>();

  observe(event: OpenCodeEvent): void {
    switch (event.type) {
      case "shell.created":
        this.update(
          `shell:${event.data.info.id}`,
          event.data.info.status === "running",
        );
        break;
      case "shell.exited":
        this.update(`shell:${event.data.id}`, event.data.status === "running");
        break;
      case "shell.deleted":
        this.update(`shell:${event.data.id}`, false);
        break;
      case "session.shell.started":
      case "session.shell.ended":
        this.update(
          `shell:${event.data.shell.id}`,
          event.data.shell.status === "running",
        );
        break;
      case "pty.created":
      case "pty.updated":
        this.update(
          `pty:${event.data.info.id}`,
          event.data.info.status === "running",
        );
        break;
      case "pty.exited":
      case "pty.deleted":
        this.update(`pty:${event.data.id}`, false);
        break;
      case "persistent-pty.added":
      case "persistent-pty.updated":
        this.update(
          `persistent:${event.data.terminal.id}`,
          event.data.terminal.status === "running",
        );
        break;
      case "persistent-pty.removed":
        this.update(`persistent:${event.data.ptyID}`, false);
        break;
    }
  }

  get pending(): number {
    return this.active.size;
  }

  private update(id: string, running: boolean): void {
    if (!running) {
      this.active.delete(id);
      return;
    }
    if (!this.active.has(id) && this.active.size >= 1000)
      throw new OpenCodeTransportError("background work bound", true);
    this.active.add(id);
  }
}
