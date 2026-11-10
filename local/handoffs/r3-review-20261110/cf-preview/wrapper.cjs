'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const CLI = '/Users/puneetpalsingh/Documents/Code/dev/LegionCode/LegionCode/apps/secure-agent-api/node_modules/wrangler/wrangler-dist/cli.js';
const ORIGINAL_SHA256 = '3df343f7390ca138b0ce9282f0a420fab2261cd518857a74ba82097fc3e20810';
const helper = path.join(__dirname, 'protocol.cjs');
const {record: stage}=require('./stages.cjs');
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function one(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Compatibility preimage is not unique');
  return source.replace(before, after);
}
function prepareReviewedSource(workerName) {
  if (typeof workerName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(workerName)) throw new Error('Explicit reviewed Worker name required');
  const original = fs.readFileSync(CLI, 'utf8');
  if (digest(original) !== ORIGINAL_SHA256) throw new Error('Installed Wrangler source changed');
  let source = original;
  const start = source.indexOf('async function createPreviewSession(complianceConfig, account, ctx, abortSignal, tailLogs) {');
  const end = source.indexOf('async function createPreviewToken(', start);
  if (start < 0 || end <= start) throw new Error('Preview function boundary unavailable');
  source = source.slice(0, start) + `async function createPreviewSession(complianceConfig, account, ctx, abortSignal, name) {
  return require(${JSON.stringify(helper)}).createProtocol({
    fetchResult,
    exchangeFetch: (...args) => import_undici26.fetch(...args),
    getAccessToken,
    getComplianceRegionSubdomain
  }, ${JSON.stringify(workerName)}).createPreviewSession(complianceConfig, account, ctx, abortSignal, name);
}
` + source.slice(end);
  source = one(source, 'const { value, host, inspectorUrl, prewarmUrl } = session;', 'const { value, host } = session;');
  source = one(source, 'host: ctx.host ?? (worker.name ? `${worker.name}.${host.split(".").slice(1).join(".")}` : host),\n    inspectorUrl,\n    prewarmUrl,', 'host,');
  const prewarmStart = source.indexOf('  const accessToken = await getAccessToken(token.prewarmUrl.hostname);');
  const prewarmEnd = source.indexOf('  return token;\n}', prewarmStart);
  if (prewarmStart < 0 || prewarmEnd <= prewarmStart) throw new Error('Prewarm boundary unavailable');
  source = source.slice(0, prewarmStart) + source.slice(prewarmEnd);
  source = one(source, 'this.#abortController.signal,\n            props.tail_logs\n          );', 'this.#abortController.signal,\n            props.name\n          );');
  source = one(source, 'configPath: config.config,\n          tail_logs: !!config.experimental?.tailLogs\n        });', 'configPath: config.config,\n          name: config.name\n        });');
  // Only a fixed named Worker is allowed; no fallback to a random session identity.
  source = one(source, 'const scriptId = props.name || (workerContext.zone ? this.#session.id : this.#session.host.split(".")[0]);', 'const scriptId = props.name;');
  source = one(source, `      get inspectorEnabled() {
        const inVscodeJsDebugTerminal = !!process.env.VSCODE_INSPECTOR_OPTIONS;
        const shouldEnableInspector = this.latestConfig?.dev.inspector !== false && !inVscodeJsDebugTerminal;
        if (this.latestConfig?.dev.remote) {
          return shouldEnableInspector && !this.latestConfig?.experimental?.tailLogs;
        }
        return shouldEnableInspector;
      }`, `      get inspectorEnabled() {
        if (this.latestConfig?.dev.remote) return false;
        const inVscodeJsDebugTerminal = !!process.env.VSCODE_INSPECTOR_OPTIONS;
        return this.latestConfig?.dev.inspector !== false && !inVscodeJsDebugTerminal;
      }`);
  source = one(source, 'main(hideBin(process9__default.default.argv)).catch((e9) => {', 'main(hideBin(process9__default.default.argv)).catch((e9) => {\n    require(' + JSON.stringify(path.join(__dirname, 'stages.cjs')) + ').record(\"cli_main_rejected\", e9);');
  if (/token\.prewarmUrl|const \{ value, host, inspectorUrl, prewarmUrl \} = session/.test(source)) throw new Error('Legacy preview dependency retained');
  return { source, originalSha256: ORIGINAL_SHA256, transformedSha256: digest(source), originalFilename: fs.realpathSync(CLI),
    originalDirectory: path.dirname(fs.realpathSync(CLI)), helperSha256: digest(fs.readFileSync(helper)), workerName };
}
// Explicit function only: direct execution, including --help, never loads Wrangler.
// Root must independently approve the transformed/helper hashes before invoking.
function runReviewedCLI(approval) {
  stage('wrapper_entered');
  approval = structuredClone(approval);
  const prepared = prepareReviewedSource(approval.workerName);
  stage('wrapper_prepared');
  if (approval.transformedSha256 !== prepared.transformedSha256 || approval.helperSha256 !== prepared.helperSha256)
    throw new Error('Independent compatibility hash approval required');
  if (!Array.isArray(approval.argv) || approval.argv[0] !== 'dev' || !approval.argv.includes('--remote') || !approval.argv.includes('--no-bundle'))
    throw new Error('Only reviewed private dev command is supported');
  const values = new Map();
  const allowedValues = new Set(['--config','--ip','--port','--inspector-ip','--inspector-port','--log-level']);
  const allowedSwitches = new Set(['--remote','--no-bundle','--show-interactive-dev-session=false']);
  for (let i=1;i<approval.argv.length;i++) {
    const arg=approval.argv[i];
    if (allowedSwitches.has(arg)) { if(values.has(arg)) throw new Error('Duplicate private dev option'); values.set(arg,true); }
    else if (allowedValues.has(arg) && typeof approval.argv[i+1]==='string') { if(values.has(arg)) throw new Error('Duplicate private dev option');values.set(arg,approval.argv[++i]); }
    else throw new Error('Unreviewed CLI option');
  }
  if (values.get('--ip')!=='127.0.0.1' || values.get('--inspector-ip')!=='127.0.0.1' || values.get('--log-level')!=='error' ||
      !values.has('--show-interactive-dev-session=false') || !/^\/(?:private\/)?tmp\//u.test(values.get('--config')??''))
    throw new Error('Private controller options required');
  const ports=['--port','--inspector-port'].map(k=>Number(values.get(k)));
  if(ports.some(p=>!Number.isInteger(p)||p<1024||p>65535)||ports[0]===ports[1]) throw new Error('Distinct private ports required');
  if(!process.execArgv.includes('--experimental-vm-modules')) throw new Error('Preserve official Node bootstrap VM flag');
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node20 or newer required');
  stage('guard_passed');
  const Module = require('node:module'); const compiled = new Module('.', null);
  compiled.filename = prepared.originalFilename;
  compiled.paths = Module._nodeModulePaths(prepared.originalDirectory);
  // Preserve original __filename/__dirname, require resolution and CLI main guard.
  process.argv = [process.execPath, prepared.originalFilename, ...approval.argv];
  process.mainModule = compiled;
  stage('compile_entered');
  try { compiled._compile(prepared.source, prepared.originalFilename); stage('compile_returned'); }
  catch(error) { stage('compile_failed',error); throw error; }
}
module.exports = { prepareReviewedSource, runReviewedCLI, digest, CLI, ORIGINAL_SHA256 };
if (require.main === module) { process.stderr.write('Review-only wrapper: authenticated execution is disabled by default.\n'); process.exitCode = 64; }
