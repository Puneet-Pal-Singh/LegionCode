import { spawn } from "node:child_process";

const environment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" };

/** A deadline is failure, never proof that a child or its descendants closed. */
export function nativePackageCommand(file, args, ownership, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { env: environment, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
    catch { reject(new Error("Package tool could not start")); return; }
    let output = "", size = 0, failure = null, finished = false, stopping = false, forceTimer, closeTimer;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(closeTimer);
      error ? reject(error) : resolve(output);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      ownership.unknownClosure = true;
      failure = new Error("Package tool closure is unconfirmed; staging is retained");
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
      closeTimer = setTimeout(() => finish(failure), 5_000);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.on("error", () => { failure ??= new Error("Package tool failed"); });
    child.stdout.on("error", stop); child.stderr.on("error", stop);
    child.stdout.on("data", bytes => {
      size += bytes.length;
      if (size > 64 * 1024) stop(); else output += bytes.toString("utf8");
    });
    child.stderr.on("data", bytes => { size += bytes.length; if (size > 64 * 1024) stop(); });
    child.once("close", (code, signal) => finish(failure ?? (code === 0 && signal === null
      ? null : new Error("Package tool returned a failure"))));
  });
}
