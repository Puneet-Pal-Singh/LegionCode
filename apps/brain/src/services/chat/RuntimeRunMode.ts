export type RuntimeRunMode = "build" | "plan";

/** Lower persisted chat modes to the narrower execution-engine mode contract. */
export function toRuntimeRunMode(mode: string | undefined): RuntimeRunMode {
  switch (mode) {
    case undefined:
    case "build":
    case "auto_edit":
      return "build";
    case "plan":
      return "plan";
    default:
      throw new Error(`Unsupported run mode for runtime execution: ${mode}`);
  }
}
