import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readJsonc } from "../local-dev/local-wrangler-config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const qualificationConfigPath = resolve(root, "apps/secure-agent-api/wrangler.native-qualification.jsonc");
const environment = "native-boundary-qualification";
const prefix = "NATIVE_QUALIFICATION_";
const identityVars = ["ENVIRONMENT_ID", "OPERATOR_ACCOUNT_ID", "CONTROL_PRINCIPAL"];
const pinVars = ["IMAGE_DIGEST", "HELPER_SHA256", "POLICY_SHA256", "AUTHORITY_RECEIPT_SHA256"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sha = /^[a-f0-9]{64}$/;
const account = /^[a-f0-9]{32}$/;
const principal = /^[A-Za-z0-9_.:-]{1,256}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function keys(value, allowed, path, errors) {
  if (!object(value)) { errors.push(`${path}: object required`); return false; }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${path}: unexpected field ${key}`);
  return true;
}
function valid(value, pattern) {
  if (typeof value !== "string" || !pattern.test(value) || /REPLACE|EXAMPLE|PLACEHOLDER/i.test(value)) return false;
  const identity = value.includes("sha256:") ? value.split("sha256:").at(-1) : value;
  return !/^(.)\1+$/.test(identity);
}
function otherTargets(configPath) {
  const workers = new Set();
  const containers = new Set();
  for (const app of ["brain", "secure-agent-api", "web"]) {
    const directory = resolve(root, "apps", app);
    for (const name of readdirSync(directory)) {
      const path = resolve(directory, name);
      if (!/^wrangler(?:\.[\w-]+)?\.jsonc$/.test(name) || path === resolve(configPath)) continue;
      const config = readJsonc(path);
      if (typeof config.name === "string") workers.add(config.name);
      for (const container of config.containers ?? []) if (typeof container.name === "string") containers.add(container.name);
    }
  }
  return { workers, containers };
}

/** Static isolation only. Neither accepted config nor expected pins prove a
 * resource was freshly created, a secret was installed, or an image is running. */
export function validateNativeQualificationIsolation({ configPath = qualificationConfigPath, mode = "active" } = {}) {
  const config = readJsonc(configPath);
  const errors = [];
  if (!["sealed", "active"].includes(mode)) errors.push("mode: sealed or active required");
  const allowed = ["$schema", "name", "account_id", "main", "compatibility_date", "compatibility_flags", "workers_dev", "preview_urls", "observability", "containers", "durable_objects", "migrations", "vars"];
  if (!keys(config, allowed, "config", errors)) return { errors, config };
  if (config.$schema !== "./node_modules/wrangler/config-schema.json") errors.push("schema: existing local Wrangler schema required");
  const canonical = readJsonc(resolve(root, "apps/secure-agent-api/wrangler.dev.jsonc"));
  if (typeof config.main !== "string" || resolve(dirname(configPath), config.main) !== resolve(root, "apps/secure-agent-api/src/qualification.ts")) errors.push("main: qualification-only canonical entrypoint required");
  if (config.compatibility_date !== canonical.compatibility_date || !equal(config.compatibility_flags, canonical.compatibility_flags)) errors.push("compatibility: existing hosted platform settings required");
  if (config.workers_dev !== false || config.preview_urls !== false) errors.push("public access: workers_dev and preview_urls must be false");
  if (!equal(config.observability, { enabled: false })) errors.push("observability: qualification payload logging must be disabled");
  if (!valid(config.account_id, account)) errors.push("account_id: actual operator account required");
  if (!valid(config.name, /^legioncode-nq-[a-f0-9]{32}$/)) errors.push("name: isolated qualification Worker identity required");
  const vars = config.vars;
  if (keys(vars, ["ENVIRONMENT", ...identityVars.map(name => prefix + name), ...(mode === "active" ? pinVars.map(name => prefix + name) : [])], "vars", errors)) {
    if (vars.ENVIRONMENT !== environment) errors.push("ENVIRONMENT: qualification-only value required");
    if (!valid(vars[prefix + "ENVIRONMENT_ID"], uuid)) errors.push("environment: actual UUID required");
    if (!valid(vars[prefix + "OPERATOR_ACCOUNT_ID"], account) || vars[prefix + "OPERATOR_ACCOUNT_ID"] !== config.account_id) errors.push("operator account: exact config account required");
    if ((mode === "active" || vars[prefix + "CONTROL_PRINCIPAL"] !== undefined) && !valid(vars[prefix + "CONTROL_PRINCIPAL"], principal)) errors.push("control principal: actual provider-controlled caller required");
    if (typeof vars[prefix + "ENVIRONMENT_ID"] === "string" && config.name !== `legioncode-nq-${vars[prefix + "ENVIRONMENT_ID"].replaceAll("-", "")}`) errors.push("name: environment identity mismatch");
    if (mode === "active") for (const name of pinVars) {
      if (!valid(vars[prefix + name], name === "IMAGE_DIGEST" ? /^sha256:[a-f0-9]{64}$/ : sha)) errors.push(`${name}: actual nonplaceholder pin required`);
    }
  }
  const container = Array.isArray(config.containers) && config.containers.length === 1 ? config.containers[0] : null;
  if (keys(container, ["name", "class_name", "image", "scheduling_policy", "instance_type", "max_instances"], "container", errors)) {
    if (container.name !== `${config.name}-sandbox`) errors.push("container name: isolated Worker-specific identity required");
    if (container.class_name !== "Sandbox" || container.scheduling_policy !== "default" || container.instance_type !== "basic" || container.max_instances !== 1) errors.push("container: same Sandbox/default policy with one basic instance required");
    if (!valid(container.image, /^[A-Za-z0-9][A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$/)) errors.push("container image: final immutable published image required");
    if (mode === "active" && typeof container.image === "string" && !container.image.endsWith(`@${vars?.[prefix + "IMAGE_DIGEST"]}`)) errors.push("container image: expected digest mismatch");
  }
  if (!equal(config.durable_objects, { bindings: [{ name: "AGENT_RUNTIME", class_name: "AgentRuntime" }, { name: "Sandbox", class_name: "Sandbox" }] })) errors.push("Durable Objects: exactly two new Worker-local existing classes required");
  if (!equal(config.migrations, [{ tag: "native-qualification-v1", new_sqlite_classes: ["AgentRuntime", "Sandbox"] }])) errors.push("migrations: isolated initial namespace creation required");
  const targets = otherTargets(configPath);
  if (targets.workers.has(config.name) || targets.containers.has(container?.name)) errors.push("identity: collision with another checked-in target");
  const pkg = JSON.parse(readFileSync(resolve(root, "apps/secure-agent-api/package.json"), "utf8"));
  if (pkg.devDependencies?.["@cloudflare/sandbox"] !== "0.12.3") errors.push("SDK: reviewed 0.12.3 contract required");
  return { errors, config };
}

export function qualificationControlProps(config) {
  const vars = config.vars;
  return { purpose: "native_boundary_qualification", operatorAccountId: vars[prefix + "OPERATOR_ACCOUNT_ID"], controlPrincipal: vars[prefix + "CONTROL_PRINCIPAL"], environmentId: vars[prefix + "ENVIRONMENT_ID"], authorityReceiptSha256: vars[prefix + "AUTHORITY_RECEIPT_SHA256"] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 2 || (args[1] !== undefined && !["sealed", "active"].includes(args[1]))) throw new Error("arguments");
    const { errors } = validateNativeQualificationIsolation({ configPath: args[0] ?? qualificationConfigPath, mode: args[1] ?? "active" });
    if (errors.length) { console.error(`Native qualification isolation blocked:\n- ${errors.join("\n- ")}`); process.exitCode = 1; }
    else console.log("Static qualification isolation accepted; provider freshness and runtime qualification remain unproved.");
  } catch { console.error("Native qualification isolation blocked: config unavailable or malformed."); process.exitCode = 1; }
}
