import { readJsonc } from "../local-dev/local-wrangler-config.mjs";

const root = new URL("../../", import.meta.url);
const paths = {
  productionBrain: new URL("apps/brain/wrangler.production.jsonc", root),
  productionApi: new URL(
    "apps/secure-agent-api/wrangler.production.jsonc",
    root,
  ),
  devBrain: new URL("apps/brain/wrangler.dev.jsonc", root),
  devApi: new URL("apps/secure-agent-api/wrangler.dev.jsonc", root),
  devWeb: new URL("apps/web/wrangler.dev.jsonc", root),
};

function config(path) {
  return readJsonc(path.pathname);
}

function service(configValue, binding) {
  return configValue.services?.find((entry) => entry.binding === binding)
    ?.service;
}

function route(configValue) {
  return configValue.routes?.[0]?.pattern;
}

function resourceId(configValue, section, binding, key = "id") {
  return configValue[section]?.find((entry) => entry.binding === binding)?.[
    key
  ];
}

function isPlaceholder(value) {
  return (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.startsWith("REPLACE_WITH_") ||
    /^0{8}(?:-0{4}){3}-0{12}$/.test(value)
  );
}

export function validateCloudflareDevIsolation() {
  const productionBrain = config(paths.productionBrain);
  const productionApi = config(paths.productionApi);
  const devBrain = config(paths.devBrain);
  const devApi = config(paths.devApi);
  const devWeb = config(paths.devWeb);
  const errors = [];

  if (productionBrain.name !== "legioncode-brain") {
    errors.push("production Brain name must be legioncode-brain");
  }
  if (productionApi.name !== "legioncode-api") {
    errors.push("production API name must be legioncode-api");
  }
  if (devBrain.name !== "legioncode-brain-dev") {
    errors.push("dev Brain name must be legioncode-brain-dev");
  }
  if (devApi.name !== "legioncode-api-dev") {
    errors.push("dev API name must be legioncode-api-dev");
  }
  if (devApi.containers?.[0]?.name !== "legioncode-api-sandbox-dev") {
    errors.push("dev container name must be legioncode-api-sandbox-dev");
  }
  if (devWeb.name !== "legioncode-web-dev") {
    errors.push("dev Pages project name must be legioncode-web-dev");
  }

  if (route(devBrain) !== "brain-dev.legioncode.dev") {
    errors.push("dev Brain route must be brain-dev.legioncode.dev");
  }
  if (route(devApi) !== "api-dev.legioncode.dev") {
    errors.push("dev API route must be api-dev.legioncode.dev");
  }
  if (
    devBrain.vars?.FRONTEND_URL !==
    "https://legioncode-web-dev.pages.dev/agents"
  ) {
    errors.push("dev Brain frontend URL must use legioncode-web-dev.pages.dev");
  }
  if (
    devBrain.vars?.CORS_ALLOWED_ORIGINS !==
      "https://legioncode-web-dev.pages.dev" ||
    devApi.vars?.CORS_ALLOWED_ORIGINS !==
      "https://legioncode-web-dev.pages.dev"
  ) {
    errors.push("dev Workers must allow the deployed dev Pages origin");
  }
  if (service(devBrain, "SECURE_API") !== "legioncode-api-dev") {
    errors.push("dev Brain must bind SECURE_API to legioncode-api-dev");
  }
  if (service(devApi, "BRAIN") !== "legioncode-brain-dev") {
    errors.push("dev API must bind BRAIN to legioncode-brain-dev");
  }

  const devHyperdriveId = resourceId(devBrain, "hyperdrive", "HYPERDRIVE");
  const devKvId = resourceId(devBrain, "kv_namespaces", "SESSIONS");
  if (devHyperdriveId !== undefined && isPlaceholder(devHyperdriveId)) {
    errors.push("dev Hyperdrive ID must be a provisioned Cloudflare resource");
  }
  if (isPlaceholder(devKvId)) {
    errors.push(
      "dev KV namespace ID is not provisioned; deploy:dev remains blocked",
    );
  }

  const devArtifactBucket = resourceId(
    devBrain,
    "r2_buckets",
    "EDIT_ARTIFACTS",
    "bucket_name",
  );
  const devApiArtifactBucket = resourceId(
    devApi,
    "r2_buckets",
    "ARTIFACTS",
    "bucket_name",
  );
  if (devArtifactBucket !== "legioncode-artifacts-dev") {
    errors.push("dev Brain must use legioncode-artifacts-dev");
  }
  if (devApiArtifactBucket !== "legioncode-artifacts-dev") {
    errors.push("dev API must use legioncode-artifacts-dev");
  }
  const devAdmission = Number(
    devBrain.vars?.CLOUDFLARE_SANDBOX_MAX_CONCURRENT_RUNS,
  );
  const devCapacity = Number(devApi.containers?.[0]?.max_instances);
  if (!Number.isInteger(devAdmission) || devAdmission <= 0) {
    errors.push("dev sandbox admission must be a positive integer");
  }
  if (!Number.isInteger(devCapacity) || devCapacity <= 0) {
    errors.push("dev sandbox capacity must be a positive integer");
  } else if (Number.isInteger(devAdmission) && devAdmission >= devCapacity) {
    errors.push("dev sandbox admission must remain below dev capacity");
  }
  if (devBrain.triggers) {
    errors.push("dev Brain must not configure cron triggers");
  }
  if (devApi.triggers) {
    errors.push("dev API must not configure cron triggers");
  }

  const productionBucket = resourceId(
    productionBrain,
    "r2_buckets",
    "EDIT_ARTIFACTS",
    "bucket_name",
  );
  if (productionBucket === devArtifactBucket) {
    errors.push("production and dev Brain artifact buckets must differ");
  }
  const productionKvId = resourceId(
    productionBrain,
    "kv_namespaces",
    "SESSIONS",
  );
  if (!isPlaceholder(devKvId) && productionKvId === devKvId) {
    errors.push("production and dev KV namespace IDs must differ");
  }
  const productionHyperdriveId = resourceId(
    productionBrain,
    "hyperdrive",
    "HYPERDRIVE",
  );
  if (
    devHyperdriveId !== undefined &&
    !isPlaceholder(devHyperdriveId) &&
    productionHyperdriveId === devHyperdriveId
  ) {
    errors.push("production and dev Hyperdrive IDs must differ");
  }

  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const errors = validateCloudflareDevIsolation();
  if (errors.length > 0) {
    console.error(
      `Cloudflare dev isolation is not deployable:\n- ${errors.join("\n- ")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("Cloudflare dev isolation configuration is deployable.");
  }
}
