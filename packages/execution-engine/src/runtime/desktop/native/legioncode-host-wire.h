#ifndef LEGIONCODE_HOST_WIRE_H
#define LEGIONCODE_HOST_WIRE_H
#include "legioncode-host-contract.h"

/* One bounded binary field map per bridge invocation. Values are byte strings;
 * control fields require valid UTF-8 without embedded NUL. No JSON parser or
 * shell is involved. Descriptor fields are injected by the bridge, never input.
 * Frame: u32be body-size; u16be count; [u8 key-size,key,u32be size,value]*. */
static inline uint32_t lc_host_read32(const unsigned char *p) {
  return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3];
}
static inline void lc_host_write32(unsigned char *p, uint32_t n) {
  p[0] = (unsigned char)(n >> 24); p[1] = (unsigned char)(n >> 16);
  p[2] = (unsigned char)(n >> 8); p[3] = (unsigned char)n;
}
static inline bool lc_host_key(const char *value, size_t size) {
  if (!size || size > 63) return false;
  for (size_t i = 0; i < size; i++) {
    char c = value[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) return false;
  }
  return true;
}
static inline xpc_object_t lc_host_decode(const unsigned char *body, size_t size) {
  if (size < 2 || size > LC_HOST_MAX_FRAME) return NULL;
  unsigned int count = (unsigned)body[0] * 256 + body[1];
  if (!count || count > LC_HOST_MAX_FIELDS) return NULL;
  size_t at = 2; xpc_object_t result = xpc_dictionary_create(NULL, NULL, 0);
  for (unsigned int i = 0; i < count; i++) {
    if (at >= size) goto failed;
    size_t n = body[at++];
    if (at + n + 4 > size || !lc_host_key((const char *)body + at, n)) goto failed;
    char key[64]; memcpy(key, body + at, n); key[n] = 0; at += n;
    if (!strcmp(key, "rootFd") || !strcmp(key, "fenceFd") || !strcmp(key, "namespaceFd") || xpc_dictionary_get_value(result, key)) goto failed;
    uint32_t bytes = lc_host_read32(body + at); at += 4;
    if (bytes > LC_HOST_MAX_FRAME || at + bytes > size) goto failed;
    xpc_dictionary_set_data(result, key, body + at, bytes); at += bytes;
  }
  if (at != size) goto failed;
  return result;
failed:
  xpc_release(result); return NULL;
}
static inline bool lc_host_send_frame(int fd, xpc_object_t dictionary) {
  if (!dictionary || xpc_get_type(dictionary) != XPC_TYPE_DICTIONARY) return false;
  unsigned char *body = calloc(1, LC_HOST_MAX_FRAME + 4);
  if (!body) return false;
  __block size_t at = 6; __block unsigned int count = 0; __block bool okay = true;
  xpc_dictionary_apply(dictionary, ^bool(const char *key, xpc_object_t value) {
    size_t n = strlen(key), bytes = xpc_data_get_length(value);
    if (xpc_get_type(value) != XPC_TYPE_DATA || !lc_host_key(key, n) ||
        ++count > LC_HOST_MAX_FIELDS || at + n + bytes + 5 > LC_HOST_MAX_FRAME + 4) { okay = false; return false; }
    body[at++] = (unsigned char)n; memcpy(body + at, key, n); at += n;
    lc_host_write32(body + at, (uint32_t)bytes); at += 4;
    if (bytes) { memcpy(body + at, xpc_data_get_bytes_ptr(value), bytes); at += bytes; }
    return true;
  });
  body[4] = (unsigned char)(count >> 8); body[5] = (unsigned char)count;
  lc_host_write32(body, (uint32_t)(at - 4));
  okay = okay && lc_host_io(fd, body, at, true); free(body); return okay;
}
static inline bool lc_host_get(xpc_object_t request, const char *key, char *out, size_t bound) {
  xpc_object_t value = xpc_dictionary_get_value(request, key);
  if (!value || xpc_get_type(value) != XPC_TYPE_DATA) return false;
  size_t n = xpc_data_get_length(value); const void *bytes = xpc_data_get_bytes_ptr(value);
  if (!n || n >= bound || memchr(bytes, 0, n)) return false;
  CFStringRef text = CFStringCreateWithBytes(NULL, bytes, (CFIndex)n, kCFStringEncodingUTF8, false);
  if (!text) return false;
  CFRelease(text); memcpy(out, bytes, n); out[n] = 0; return true;
}
static inline void lc_host_put(xpc_object_t reply, const char *key, const char *value) {
  xpc_dictionary_set_data(reply, key, value, strlen(value));
}
static inline void lc_host_put_number(xpc_object_t reply, const char *key, uint64_t n) {
  char text[32]; snprintf(text, sizeof(text), "%llu", (unsigned long long)n); lc_host_put(reply, key, text);
}
static inline xpc_object_t lc_host_reply(const char *state, const char *code) {
  xpc_object_t result = xpc_dictionary_create(NULL, NULL, 0);
  lc_host_put(result, "version", "1"); lc_host_put(result, "state", state); lc_host_put(result, "code", code); return result;
}
static inline bool lc_host_fields(xpc_object_t request, const char *const *allowed, size_t count) {
  __block bool okay = true; __block size_t observed = 0;
  xpc_dictionary_apply(request, ^bool(const char *key, xpc_object_t value) {
    bool found = false;
    for (size_t i = 0; i < count; i++) if (!strcmp(key, allowed[i])) { found = true; break; }
    if (!found || !value || ++observed > count) { okay = false; return false; }
    return true;
  });
  return okay && observed == count;
}
#endif
