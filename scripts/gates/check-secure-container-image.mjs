import { spawnSync } from "node:child_process";

const imageTag = "legioncode-secure-agent-api:image-gate";
const imageBudgetBytes = 1_350_000_000;
const contextPath = "apps/secure-agent-api";

run("docker", [
  "build",
  "--platform",
  "linux/amd64",
  "--tag",
  imageTag,
  contextPath,
]);

const sizeOutput = run(
  "docker",
  ["image", "inspect", imageTag, "--format", "{{.Size}}"],
  { capture: true },
).trim();
const imageSizeBytes = Number(sizeOutput);

if (!Number.isSafeInteger(imageSizeBytes) || imageSizeBytes <= 0) {
  throw new Error(`Docker returned an invalid image size: ${sizeOutput}`);
}

if (imageSizeBytes > imageBudgetBytes) {
  throw new Error(
    `Secure container image is ${formatMiB(imageSizeBytes)}, exceeding the ${formatMiB(imageBudgetBytes)} release budget.`,
  );
}

run("docker", [
  "run",
  "--rm",
  "--platform",
  "linux/amd64",
  "--entrypoint",
  "/bin/sh",
  imageTag,
  "-c",
  [
    "set -eu",
    "node --version",
    "tsx --version",
    "python3 --version",
    "python3 -c 'import redis, requests; print(\"python-packages-ok\")' ",
    "rustc --version",
    "printf 'fn main(){println!(\"rust-ok\");}' >/tmp/main.rs",
    "rustc /tmp/main.rs -o /tmp/main",
    "/tmp/main",
    "git --version",
    "gh --version",
    "rg --version",
    "/usr/local/bin/my-redis-server >/tmp/redis.log 2>&1 & redis_pid=$!",
    "redis_ready=false",
    "for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if nc -z 127.0.0.1 6378; then redis_ready=true; break; fi; sleep 0.1; done",
    'kill "$redis_pid"',
    'wait "$redis_pid" || true',
    'test "$redis_ready" = true',
    'test -z "$(find /var/cache/apt /var/lib/apt/lists -type f -print -quit 2>/dev/null)"',
  ].join("; "),
]);

console.log(
  `Secure container image gate passed: size=${formatMiB(imageSizeBytes)}, budget=${formatMiB(imageBudgetBytes)}.`,
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}${stderr ? `: ${stderr}` : ""}`,
    );
  }

  return result.stdout ?? "";
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
