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
const physical = positiveInt(
  secureApi.containers?.[0]?.max_instances,
  "Secure API containers[0].max_instances",
);

if (admission > physical) {
  throw new Error(
    `Cloudflare admission (${admission}) exceeds deployed sandbox capacity (${physical}).`,
  );
}

console.log(
  `Cloudflare capacity contract: admission=${admission}, max_instances=${physical}`,
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
