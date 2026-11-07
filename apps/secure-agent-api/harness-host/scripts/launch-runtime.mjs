import { fileURLToPath } from "node:url";

// Sandbox's control process retains its existing startup privileges. Only the
// packaged Node entry drops identity, before loading any host/driver/SDK code.
const uid = 65532;
const gid = 65532;
if (process.getuid() === 0) {
  process.setgroups([]);
  process.setgid(gid);
  process.setuid(uid);
}
if (
  process.getuid() !== uid ||
  process.getgid() !== gid ||
  process.getgroups().some((group) => group !== gid)
) {
  throw new Error("Cloud harness requires its dedicated execution identity");
}
process.umask(0o077);
const retained = new Set([
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);
for (const name of Object.keys(process.env)) {
  if (!retained.has(name)) delete process.env[name];
}
// This is the account's actual passwd HOME, not a copied provider home. Selected
// per-instance CODEX_HOME/CLAUDE_CONFIG_DIR/XDG paths still come from host authority.
process.env.HOME = "/home/legion-harness";
process.env.PATH = "/usr/local/bin:/usr/bin:/bin";
process.chdir(process.env.HOME);
process.argv[1] = fileURLToPath(new URL("./host.mjs", import.meta.url));
await import("./host.mjs");
