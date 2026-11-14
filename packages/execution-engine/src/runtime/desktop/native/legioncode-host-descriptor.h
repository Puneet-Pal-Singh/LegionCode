#ifndef LEGIONCODE_HOST_DESCRIPTOR_H
#define LEGIONCODE_HOST_DESCRIPTOR_H
#include "legioncode-host-approval.h"
#include "legioncode-host-wire.h"

/* Nonsecret read-only projection of the SAME installed ROOT authority. It does
 * not grant execution, reveal the manifest, or claim sandbox qualification. The
 * actual installed broker is the only descriptor reader executable. */
static inline bool lc_host_descriptor_requirement(char out[4097], SecRequirementRef *requirement) {
  int fd = lc_host_open_protected(LC_HOST_INSTALLED_BROKER, false);
  if (fd < 0) return false;
  CFURLRef url = CFURLCreateFromFileSystemRepresentation(NULL,
    (const unsigned char *)LC_HOST_INSTALLED_BROKER, strlen(LC_HOST_INSTALLED_BROKER), false);
  SecStaticCodeRef code = NULL; CFDictionaryRef info = NULL; CFStringRef text = NULL;
  bool okay = url && SecStaticCodeCreateWithPath(url, kSecCSDefaultFlags, &code) == errSecSuccess &&
    SecStaticCodeCheckValidity(code, kSecCSStrictValidate | kSecCSCheckAllArchitectures, NULL) == errSecSuccess &&
    SecCodeCopySigningInformation(code, kSecCSSigningInformation, &info) == errSecSuccess;
  CFDataRef hash = okay ? CFDictionaryGetValue(info, kSecCodeInfoUnique) : NULL;
  char hex[129];
  okay = okay && hash && CFGetTypeID(hash) == CFDataGetTypeID() && CFDataGetLength(hash) > 0 && CFDataGetLength(hash) <= 64 &&
    lc_host_hex(CFDataGetBytePtr(hash), (size_t)CFDataGetLength(hash), hex, sizeof(hex)) &&
    snprintf(out, 4097, "cdhash H\"%s\"", hex) < 4097;
  if (okay) text = CFStringCreateWithCString(NULL, out, kCFStringEncodingUTF8);
  okay = okay && text && SecRequirementCreateWithString(text, kSecCSDefaultFlags, requirement) == errSecSuccess;
  if (text) CFRelease(text); if (info) CFRelease(info); if (code) CFRelease(code); if (url) CFRelease(url);
  if (close(fd)) okay = false; return okay;
}
static inline bool lc_host_descriptor_code(SecCodeRef code, SecRequirementRef requirement) {
  CFURLRef path = NULL; char actual[PATH_MAX];
  bool okay = code && SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) == errSecSuccess &&
    SecCodeCopyPath(code, kSecCSDefaultFlags, &path) == errSecSuccess &&
    CFURLGetFileSystemRepresentation(path, true, (unsigned char *)actual, sizeof(actual)) &&
    !strcmp(actual, LC_HOST_INSTALLED_BROKER);
  if (path) CFRelease(path); return okay;
}
static inline xpc_object_t lc_host_descriptor_reply(lc_host_approval *approval, xpc_connection_t peer, xpc_object_t request) {
  static const char *const fields[] = { "version", "operation" };
  char version[8], requirement_text[4097]; SecRequirementRef requirement = NULL; SecCodeRef code = NULL;
  bool okay = lc_host_fields(request, fields, 2) && lc_host_get(request, "version", version, sizeof(version)) &&
    !strcmp(version, "1") && xpc_connection_get_euid(peer) == approval->actor &&
    lc_host_installed_broker_valid(approval) && lc_host_bundle_valid(approval) &&
    lc_host_descriptor_requirement(requirement_text, &requirement) &&
    SecCodeCreateWithXPCMessage(request, kSecCSDefaultFlags, &code) == errSecSuccess && lc_host_descriptor_code(code, requirement);
  if (code) CFRelease(code); if (requirement) CFRelease(requirement);
  if (!okay) return lc_host_reply("unconfigured", "installedAuthorityUnavailable");
  xpc_object_t reply = lc_host_reply("configured", "okay");
  lc_host_put(reply, "serviceCodeRequirement", requirement_text); lc_host_put(reply, "bridgePath", approval->bridge);
  lc_host_put(reply, "policy", approval->policy); lc_host_put(reply, "policyGeneration", approval->policy_generation);
  lc_host_put(reply, "generation", approval->generation);
  char digest[65]; lc_host_hex(approval->manifest_sha256, 32, digest, sizeof(digest)); lc_host_put(reply, "configurationSHA256", digest);
  return reply;
}
static inline int lc_host_describe_installed(void) {
  char requirement_text[4097]; SecRequirementRef requirement = NULL; SecCodeRef self = NULL;
  bool okay = getuid() != 0 && geteuid() == getuid() && lc_host_descriptor_requirement(requirement_text, &requirement) &&
    SecCodeCopySelf(kSecCSDefaultFlags, &self) == errSecSuccess && lc_host_descriptor_code(self, requirement);
  if (self) CFRelease(self); if (requirement) CFRelease(requirement);
  xpc_object_t reply = NULL;
  if (okay) {
    xpc_connection_t connection = xpc_connection_create_mach_service(LC_HOST_SERVICE, NULL, XPC_CONNECTION_MACH_SERVICE_PRIVILEGED);
    if (connection && !xpc_connection_set_peer_code_signing_requirement(connection, requirement_text)) {
      xpc_connection_set_event_handler(connection, ^(xpc_object_t event) { (void)event; });
      xpc_connection_resume(connection);
      xpc_object_t request = xpc_dictionary_create(NULL, NULL, 0);
      lc_host_put(request, "version", "1"); lc_host_put(request, "operation", "installedDescriptor");
      reply = xpc_connection_send_message_with_reply_sync(connection, request); xpc_release(request);
      xpc_connection_cancel(connection);
    }
    if (connection) xpc_release(connection);
  }
  if (!reply || xpc_get_type(reply) != XPC_TYPE_DICTIONARY) {
    if (reply) xpc_release(reply);
    reply = lc_host_reply("unconfigured", okay ? "installedServiceUnavailable" : "installedBrokerUnavailable");
  }
  bool written = lc_host_send_frame(STDOUT_FILENO, reply); xpc_release(reply); return written ? 0 : 74;
}
#endif
