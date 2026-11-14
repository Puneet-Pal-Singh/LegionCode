/* Privileged Native command resource service and its unprivileged XPC bridge.
 * Build only; packaging/setup owns installation, approval and launchd. Never
 * setid this binary. Missing setup, writer ABI or qualification fails closed. */
#include "legioncode-host-recovery.h"
#include "legioncode-host-retirement.h"
#include "legioncode-host-setup-auth.h"
#include "legioncode-host-setup-metadata.h"
#include <stdatomic.h>

static lc_host_approval approval;
static lc_host_scope scopes[LC_HOST_MAX_SCOPES];
static xpc_connection_t owners[LC_HOST_MAX_SCOPES];
static int state_directory = -1;

static const char *phase_name(lc_host_scope *scope) {
  if (scope->record.phase == LC_HOST_UNKNOWN) return "unknown";
  if (scope->record.phase == LC_HOST_CLOSED) return "closed";
  if (scope->record.phase == LC_HOST_CLOSING) return "closing";
  if (scope->record.phase == LC_HOST_RUNNING) return "running";
  if (scope->record.phase == LC_HOST_PREPARED) return "prepared";
  return scope->child && scope->reaped ? "commandComplete" : "idle";
}
static xpc_object_t scope_reply(lc_host_scope *scope) {
  xpc_object_t reply = lc_host_reply(phase_name(scope), "okay");
  lc_host_put(reply, "generation", approval.generation); lc_host_put(reply, "policy", approval.policy);
  lc_host_put(reply, "policyGeneration", approval.policy_generation);
  lc_host_put(reply, "capability", scope->capability);
  char digest[65]; lc_host_hex(scope->record.binding.scope_sha256, 32, digest, sizeof(digest)); lc_host_put(reply, "scopeSHA256", digest);
  lc_host_put_number(reply, "rootDevice", scope->record.binding.root.device); lc_host_put_number(reply, "rootInode", scope->record.binding.root.inode);
  lc_host_put_number(reply, "namespaceDevice", scope->record.binding.namespace.device); lc_host_put_number(reply, "namespaceInode", scope->record.binding.namespace.inode);
  lc_host_put_number(reply, "fenceDevice", scope->record.binding.fence.device); lc_host_put_number(reply, "fenceInode", scope->record.binding.fence.inode);
  lc_host_hex(scope->record.binding.resource_id, 32, digest, sizeof(digest)); lc_host_put(reply, "resourceId", digest);
  lc_host_hex(scope->record.binding.broker_resource_generation, 32, digest, sizeof(digest)); lc_host_put(reply, "resourceGeneration", digest);
  lc_host_hex(scope->record.metadata.digest, 32, digest, sizeof(digest)); lc_host_put(reply, "metadataSHA256", digest);
  lc_host_put_number(reply, "slotGeneration", scope->record.uid_slot_generation);
  lc_host_hex(scope->record.cleanup_receipt, 32, digest, sizeof(digest)); lc_host_put(reply, "cleanupReceipt", digest);
  lc_host_hex(scope->record.retirement_nonce, 32, digest, sizeof(digest)); lc_host_put(reply, "retirementNonce", digest);
  lc_host_put(reply, "commandId", scope->command_id); lc_host_put(reply, "commandDigest", scope->command_digest);
  lc_host_put(reply, "quiescent", scope->released ? "true" : "false");
  lc_host_put(reply, "commandClosed", scope->record.phase == LC_HOST_IDLE && scope->child && scope->reaped ? "true" : "false");
  lc_host_put(reply, "timedOut", scope->timed_out ? "true" : "false");
  lc_host_put(reply, "truncated", scope->truncated || scope->stdout_size > 32768 || scope->stderr_size > 32768 ? "true" : "false");
  lc_host_put_number(reply, "exitCode", scope->reaped && WIFEXITED(scope->wait_status) ? (uint64_t)WEXITSTATUS(scope->wait_status) : 256);
  lc_host_put_number(reply, "signal", scope->reaped && WIFSIGNALED(scope->wait_status) ? (uint64_t)WTERMSIG(scope->wait_status) : 0);
  xpc_dictionary_set_data(reply, "stdout", scope->stdout_bytes, scope->stdout_size > 32768 ? 32768 : scope->stdout_size);
  xpc_dictionary_set_data(reply, "stderr", scope->stderr_bytes, scope->stderr_size > 32768 ? 32768 : scope->stderr_size);
  return reply;
}
static xpc_object_t serve_request(xpc_connection_t peer, xpc_object_t request) {
  char operation[40], version[8], generation[65];
  if (!lc_host_authorize(&approval, peer, request) || !lc_host_get(request, "version", version, sizeof(version)) ||
      strcmp(version, "1") || !lc_host_get(request, "operation", operation, sizeof(operation))) return lc_host_reply("unavailable", "unauthorized");
  if (!strcmp(operation, "status")) {
    static const char *const fields[] = { "version", "operation" };
    if (!lc_host_fields(request, fields, 2)) return lc_host_reply("unavailable", "invalidRequest");
    bool ready = approval.qualified && lc_host_writer_supported();
    xpc_object_t reply = lc_host_reply(ready ? "ready" : "unavailable", !approval.qualified ? "qualificationRequired" :
      !lc_host_writer_supported() ? "writerABIUnavailable" : "okay");
    lc_host_put(reply, "generation", approval.generation); lc_host_put(reply, "policy", approval.policy);
    lc_host_put(reply, "policyGeneration", approval.policy_generation); return reply;
  }
  if (!strcmp(operation, "setupQualificationDescribe") || !strcmp(operation, "setupQualificationStart") ||
      !strcmp(operation, "setupQualificationStatus") || !strcmp(operation, "setupQualificationCancel"))
    return lc_host_setup_request(&approval, request, operation);
  if (!approval.qualified || !lc_host_writer_supported() ||
      !lc_host_get(request, "generation", generation, sizeof(generation)) || strcmp(generation, approval.generation)) return lc_host_reply("unavailable", "serviceGenerationChanged");
  if (!strcmp(operation, "recoveryDescribe") || !strcmp(operation, "recoverySeal"))
    return lc_host_recovery(state_directory, &approval, request, scopes, !strcmp(operation, "recoverySeal"));
  if (!strcmp(operation, "prepareScope")) {
    for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) {
      if (scopes[i].used) continue;
      if (!lc_host_scope_open(state_directory, &approval, request, &scopes[i])) return lc_host_reply("unknown", "scopePreparationUnconfirmed");
      owners[i] = peer; xpc_retain(peer); return scope_reply(&scopes[i]);
    }
    return lc_host_reply("unavailable", "resourceLimit");
  }
  char capability[65];
  if (!lc_host_get(request, "capability", capability, sizeof(capability)) || strlen(capability) != 64) return lc_host_reply("unavailable", "invalidRequest");
  lc_host_scope *scope = NULL;
  for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) if (scopes[i].used && !strcmp(scopes[i].capability, capability)) { scope = &scopes[i]; break; }
  if (!scope && !strcmp(operation, "confirmResourceRetirement")) {
    /* Repeated confirmation after a lost ACK is read-only historical lookup.
     * It never examines the current occupant of this resource's former UID. */
    unsigned char raw[32], hash[32]; char name[80], hex[65]; lc_host_scope_record record;
    if (!lc_host_unhex(capability, raw, 32)) return lc_host_reply("unavailable", "invalidRequest");
    CC_SHA256(raw, 32, hash); lc_host_hex(hash, 32, hex, sizeof(hex)); snprintf(name, sizeof(name), "resource.%s", hex);
    if (!lc_host_record_read(state_directory, name, &record) || record.purpose != LC_HOST_RESOURCE_NATIVE ||
        record.binding.actor_uid != approval.actor || strcmp(record.origin_generation, approval.generation) ||
        !record.retirement_confirmed || !lc_host_retirement_matches(&record, request)) return lc_host_reply("unknown", "retirementUnconfirmed");
    return lc_host_reply("retired", "okay");
  }
  if (!scope) return lc_host_reply("unknown", "resourceRecoveryRequired");
  if (scope->record.purpose != LC_HOST_RESOURCE_NATIVE) return lc_host_reply("unavailable", "resourcePurposeConflict");
  if (!strcmp(operation, "retireScope")) {
    static const char *const fields[] = { "version", "operation", "generation", "capability" };
    if (!lc_host_fields(request, fields, 4) || !lc_host_retirement_begin(state_directory, scope))
      return lc_host_reply("unknown", "retirementUnconfirmed");
    /* Retain the original owner/projection and UID slot. This ACK only gives
     * the host a one-shot nonce; it is NOT final physical-writer retirement. */
    return scope_reply(scope);
  }
  if (!strcmp(operation, "confirmResourceRetirement")) {
    if (!lc_host_retirement_matches(&scope->record, request)) return lc_host_reply("unknown", "retirementIdentityConflict");
    if (!scope->owner_disconnected) return lc_host_reply("retirementPending", "okay");
    if (!lc_host_retirement_finish(state_directory, &approval, scope, request)) return lc_host_reply("unknown", "retirementUnconfirmed");
    for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) if (&scopes[i] == scope) {
      scope->used = false; if (owners[i]) xpc_release(owners[i]); owners[i] = NULL; break;
    }
    return lc_host_reply("retired", "okay");
  }
  if (!strcmp(operation, "prepareCommand")) {
    if (!lc_host_prepare_command(state_directory, &approval, scope, request)) return lc_host_reply("unknown", "commandPreparationRejected");
    return scope_reply(scope);
  }
  if (!strcmp(operation, "releaseCommand")) {
    static const char *const fields[] = { "version", "operation", "generation", "capability", "commandId", "commandDigest" };
    char id[257], digest[65];
    if (!lc_host_fields(request, fields, 6) || !lc_host_get(request, "commandId", id, sizeof(id)) ||
        !lc_host_get(request, "commandDigest", digest, sizeof(digest)) || strcmp(id, scope->command_id) || strcmp(digest, scope->command_digest)) return lc_host_reply("unavailable", "commandIdentityConflict");
    /* A matching repeated release observes the original; it never forks twice. */
    if (scope->record.phase == LC_HOST_PREPARED && !lc_host_release_command(state_directory, &approval, scope)) return lc_host_reply("unknown", "commandStartUnconfirmed");
    return scope_reply(scope);
  }
  if (!strcmp(operation, "scopeStatus") || !strcmp(operation, "seal")) {
    static const char *const fields[] = { "version", "operation", "generation", "capability" };
    if (!lc_host_fields(request, fields, 4)) return lc_host_reply("unavailable", "invalidRequest");
    if (!strcmp(operation, "seal")) (void)lc_host_scope_seal(state_directory, scope);
    lc_host_scope_tick(state_directory, scope); return scope_reply(scope);
  }
  return lc_host_reply("unavailable", "unknownOperation");
}

static int serve(void) {
  if (getuid() != 0 || geteuid() != 0 || !lc_host_load_approval(&approval)) return 78;
  /* Setup-created roots only. Starting/health checking never installs accounts,
   * creates protected directories, alters grants or allocates an execution UID. */
  state_directory = lc_host_open_protected(LC_HOST_STATE, true);
  int work = lc_host_open_protected(LC_HOST_WORK, true);
  if (state_directory < 0 || work < 0) return 78;
  close(work);
  if (!lc_host_installed_broker_valid(&approval)) return 78;
  signal(SIGPIPE, SIG_IGN);
  dispatch_queue_t queue = dispatch_queue_create("dev.legioncode.native-host.resources", DISPATCH_QUEUE_SERIAL);
  xpc_connection_t listener = xpc_connection_create_mach_service(LC_HOST_SERVICE, queue, XPC_CONNECTION_MACH_SERVICE_LISTENER);
  if (!listener) return 78;
  xpc_connection_set_event_handler(listener, ^(xpc_object_t event) {
    if (xpc_get_type(event) != XPC_TYPE_CONNECTION) return;
    xpc_connection_t peer = event;
    xpc_connection_set_target_queue(peer, queue);
    xpc_connection_set_event_handler(peer, ^(xpc_object_t request) {
      if (xpc_get_type(request) == XPC_TYPE_ERROR) {
        for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) if (owners[i] == peer && scopes[i].used) {
          scopes[i].owner_disconnected = true;
          if (!scopes[i].released) (void)lc_host_scope_seal(state_directory, &scopes[i]);
        }
        return;
      }
      if (xpc_get_type(request) != XPC_TYPE_DICTIONARY) { xpc_connection_cancel(peer); return; }
      xpc_object_t reply = serve_request(peer, request), envelope = xpc_dictionary_create_reply(request);
      if (!envelope) { xpc_release(reply); return; }
      xpc_dictionary_apply(reply, ^bool(const char *key, xpc_object_t value) { xpc_dictionary_set_value(envelope, key, value); return true; });
      xpc_connection_send_message(peer, envelope); xpc_release(envelope); xpc_release(reply);
    });
    xpc_connection_resume(peer);
  });
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
  if (!timer) return 78;
  dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 20000000, 1000000);
  dispatch_source_set_event_handler(timer, ^{
    for (size_t i = 0; i < LC_HOST_MAX_SCOPES; i++) lc_host_scope_tick(state_directory, &scopes[i]);
  });
  dispatch_resume(timer); xpc_connection_resume(listener); dispatch_main();
}

static int bridge(const char *service_requirement) {
  if (getuid() == 0 || geteuid() != getuid() || !service_requirement || !service_requirement[0] || strlen(service_requirement) > 4096) return 64;
  signal(SIGPIPE, SIG_IGN);
  xpc_connection_t connection = xpc_connection_create_mach_service(LC_HOST_SERVICE, NULL, XPC_CONNECTION_MACH_SERVICE_PRIVILEGED);
  if (!connection || xpc_connection_set_peer_code_signing_requirement(connection, service_requirement)) return 78;
  __block atomic_bool broken = false;
  xpc_connection_set_event_handler(connection, ^(xpc_object_t event) { if (xpc_get_type(event) == XPC_TYPE_ERROR) atomic_store(&broken, true); });
  xpc_connection_resume(connection);
  for (;;) {
    unsigned char length[4]; ssize_t first;
    do { first = read(0, length, sizeof(length)); } while (first < 0 && errno == EINTR);
    if (first == 0) break;
    if (first < 0 || (first < 4 && !lc_host_io(0, length + first, 4 - (size_t)first, false))) return 74;
    uint32_t size = lc_host_read32(length);
    if (!size || size > LC_HOST_MAX_FRAME) return 64;
    unsigned char *body = malloc(size); if (!body) return 70;
    bool read = lc_host_io(0, body, size, false); xpc_object_t request = read ? lc_host_decode(body, size) : NULL; free(body);
    if (!request || atomic_load(&broken)) { if (request) xpc_release(request); return 74; }
    char operation[40];
    if (!lc_host_get(request, "operation", operation, sizeof(operation))) { xpc_release(request); return 64; }
    if (!strcmp(operation, "setupQualificationStart")) {
      xpc_object_t namespace = xpc_fd_create(7);
      if (!namespace) { xpc_release(request); return 64; }
      xpc_dictionary_set_value(request, "namespaceFd", namespace); xpc_release(namespace);
    }
    if (!strcmp(operation, "prepareScope")) {
      xpc_object_t root = xpc_fd_create(5), fence = xpc_fd_create(6), namespace = xpc_fd_create(7);
      if (!root || !fence || !namespace) { if(root)xpc_release(root); if(fence)xpc_release(fence); if(namespace)xpc_release(namespace); xpc_release(request); return 64; }
      xpc_dictionary_set_value(request, "rootFd", root); xpc_dictionary_set_value(request, "fenceFd", fence);
      xpc_dictionary_set_value(request, "namespaceFd", namespace); xpc_release(root); xpc_release(fence); xpc_release(namespace);
    }
    xpc_object_t reply = xpc_connection_send_message_with_reply_sync(connection, request); xpc_release(request);
    if (!reply || xpc_get_type(reply) != XPC_TYPE_DICTIONARY || !lc_host_send_frame(1, reply)) { if(reply)xpc_release(reply); return 74; }
    xpc_release(reply);
  }
  xpc_connection_cancel(connection); xpc_release(connection); return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--serve")) return serve();
  if (argc == 2 && !strcmp(argv[1], "--bootstrap")) return lc_host_bootstrap_target();
  if (argc == 3 && !strcmp(argv[1], "--bridge")) return bridge(argv[2]);
  return 64;
}
