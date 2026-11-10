'use strict';
const {record:stage}=require('./stages.cjs');
// Narrow custom backport of official workers-sdk b8c33f/dc24057. No I/O until
// injected Wrangler-owned APIs are called. This module never loads credentials.
class CompatibilityFailure extends Error {
  constructor(category) { super(category); this.name = 'CompatibilityFailure'; this.category = category; }
}
function fail(category) { throw new CompatibilityFailure(category); }
function token(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 65536 && !/[\s\x00-\x1f\x7f]/u.test(value);
}
function checkAbort(signal) { signal.throwIfAborted(); }
function createProtocol(deps, expectedWorkerName) {
  if (typeof expectedWorkerName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(expectedWorkerName)) fail('unrecognized_worker_name');
  async function expand(exchangeUrl, ctx, signal) {
    stage('exchange_enter');
    let url;
    try { url = new URL(exchangeUrl); } catch { fail('unrecognized_exchange_url'); }
    // This administrative probe supports workers.dev only, no custom/zone host.
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev') || url.username || url.password || url.hash || (url.port !== '' && url.port !== '443'))
      fail('unrecognized_exchange_host');
    const headers = {};
    const access = await deps.getAccessToken(url.hostname);
    checkAbort(signal);
    if (access) headers.cookie = `CF_Authorization=${access}`;
    try {
      let response;
      try { response = await deps.exchangeFetch(url, { signal, headers, redirect: 'manual' }); stage('exchange_request_ok'); }
      catch(error) { stage('exchange_request_fail',error); throw error; }
      checkAbort(signal);
      if (!response.ok) { stage('exchange_unavailable'); await response.body?.cancel(); return null; }
      // Bound private response in RAM. Never log text, URL, cookie or token.
      if (!response.body) return null;
      const reader = response.body.getReader(); const parts = []; let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read(); checkAbort(signal);
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 65536) { await reader.cancel(); fail('exchange_response_overflow'); }
          parts.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const combined = new Uint8Array(bytes); let offset = 0;
      for (const part of parts) { combined.set(part, offset); offset += part.byteLength; }
      let value;
      try { value = JSON.parse(new TextDecoder().decode(combined)); } catch { return null; }
      stage(token(value?.token)?'exchange_token':'exchange_unavailable');
      return token(value?.token) ? value.token : null;
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') throw error;
      if (error instanceof CompatibilityFailure) throw error;
      return null; // Official optional expansion; initializer token is already required.
    }
  }
  return {
    async createPreviewSession(complianceConfig, account, ctx, signal, name) {
      stage('createPreviewSession_entered');
      checkAbort(signal);
      if (name !== expectedWorkerName || ctx.zone !== undefined || ctx.host !== undefined ||
          (ctx.routes !== undefined && (!Array.isArray(ctx.routes) || ctx.routes.length !== 0)) || ctx.useServiceEnvironments)
        fail('unrecognized_preview_context');
      if (!/^[a-f0-9]{32}$/u.test(account.accountId)) fail('unrecognized_account_id');
      stage('initializer_request_enter');
      let response;
      try { response = await deps.fetchResult(complianceConfig,
        `/accounts/${account.accountId}/workers/scripts/${name}/subdomain/edge-preview`,
        undefined, undefined, signal, account.apiToken); stage('initializer_request_ok'); }
      catch(error) { stage('initializer_request_fail',error); throw error; }
      checkAbort(signal);
      if (!response || !token(response.token) ||
          (response.exchange_url !== undefined && (typeof response.exchange_url !== 'string' || response.exchange_url.length === 0)))
        fail('unrecognized_initializer_response');
      stage('initializer_validated');
      const selected = response.exchange_url
        ? (await expand(response.exchange_url, ctx, signal)) ?? response.token
        : response.token;
      checkAbort(signal);
      // Read-only authenticated lookup: never call the old onboarding helper.
      stage('subdomain_enter');
      let info;
      try { info = await deps.fetchResult(complianceConfig,
        `/accounts/${account.accountId}/workers/subdomain`,
        undefined, undefined, signal, account.apiToken); stage('subdomain_ok'); }
      catch(error) { stage('subdomain_fail',error); throw error; }
      checkAbort(signal);
      if (!info || typeof info.subdomain !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(info.subdomain)) fail('unrecognized_account_subdomain');
      const region = deps.getComplianceRegionSubdomain(complianceConfig);
      if (!['', '.eu', '.fed'].includes(region)) fail('unrecognized_compliance_region');
      stage('protocol_returned');
      return { value: selected, host: `${name}.${info.subdomain}${region}.workers.dev`, name };
    },
  };
}
module.exports = { createProtocol, CompatibilityFailure };
