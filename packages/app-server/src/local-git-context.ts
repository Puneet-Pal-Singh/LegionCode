import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { SingleExecutableProcessInput } from "@legioncode/execution-engine/runtime/desktop/SingleExecutableProcess";
import { gitConfigurationHome } from "@legioncode/execution-engine/runtime/desktop/GitConfigurationHome";

/** Host-only Git configuration context, never caller/model/environment passthrough. */
export function trustedLocalGitContext(): NonNullable<
  SingleExecutableProcessInput["trustedGitContext"]
> {
  const directory = (path: string) => {
    if (!isAbsolute(path) || path.includes("\0"))
      throw new Error("Trusted Git context requires an absolute directory");
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory())
      throw new Error("Trusted Git context directory is unavailable");
    return canonical;
  };
  // Read only the explicit host XDG selector. No ambient/provider/Git keys cross.
  const xdg = gitConfigurationHome(process.env.XDG_CONFIG_HOME);
  return {
    homeDirectory: directory(homedir()),
    temporaryDirectory: directory(tmpdir()),
    ...(xdg !== undefined ? { xdgConfigHome: xdg } : {}),
  };
}
