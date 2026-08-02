import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

const brain = await readJsonc("apps/brain/wrangler.production.jsonc");
const secureApi = await readJsonc(
  "apps/secure-agent-api/wrangler.production.jsonc",
);

const admission = positiveInt(
  brain.vars?.CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS,
  "Brain CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS",
);
const perUser = positiveInt(
  brain.vars?.ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX,
  "Brain ACTIVE_EXPENSIVE_RUNS_PER_USER_MAX",
);
const perWorkspace = positiveInt(
  brain.vars?.ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX,
  "Brain ACTIVE_EXPENSIVE_RUNS_PER_WORKSPACE_MAX",
);
const physical = positiveInt(
  secureApi.containers?.[0]?.max_instances,
  "Secure API containers[0].max_instances",
);

if (admission !== 5 || perUser !== 5 || perWorkspace !== 5) {
  throw new Error(
    `Initial alpha admission must be exactly five globally, per user, and per workspace; received global=${admission}, user=${perUser}, workspace=${perWorkspace}.`,
  );
}

if (admission >= physical) {
  throw new Error(
    `Cloudflare admission (${admission}) must remain below deployed sandbox capacity (${physical}) to preserve recovery headroom.`,
  );
}

console.log(
  `Cloudflare capacity contract: admission=${admission}, per_user=${perUser}, per_workspace=${perWorkspace}, max_instances=${physical}`,
);

async function readJsonc(relativePath) {
  const source = await readFile(resolve(root, relativePath), "utf8");
  const withoutLineComments = source.replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(withoutLineComments.replace(/,\s*([}\]])/g, "$1"));
}

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}
