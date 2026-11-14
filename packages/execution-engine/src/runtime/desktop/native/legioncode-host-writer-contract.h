#ifndef LEGIONCODE_HOST_WRITER_CONTRACT_H
#define LEGIONCODE_HOST_WRITER_CONTRACT_H
#include <stdbool.h>
#include <stdint.h>

/* Minimal private interop header, usable by the existing physical writer
 * without adding XPC/Security/framework dependencies to its ordinary helper. */
typedef struct { uint64_t device, inode; } lc_host_file_identity;
typedef struct {
  uint32_t abi, actor_uid, execution_uid, reserved;
  lc_host_file_identity root, namespace, fence;
  unsigned char principal_guid[16];
  unsigned char scope_sha256[32], capability_sha256[32], policy_sha256[32];
  unsigned char resource_id[32], broker_resource_generation[32], approved_policy_generation[32];
} lc_host_writer_binding;
_Static_assert(sizeof(lc_host_writer_binding) == 272, "Native host writer binding ABI");

/* Implemented ONLY by the canonical writer/WAL owner. No successful stub or
 * undefined-symbol linker bypass is permitted when integration is absent.
 *
 * prepare verifies ORIGINAL namespace/root/fence identity and persists the UID
 * obligation before access provisioning/children. OFD locking is not provenance.
 * Ordinary actor acquisition retains its geteuid checks; this is a separate
 * privileged path. Root-protected issuer/reservation/gate authorizes cleanup;
 * actor-owned WAL only denies conflicting acquisition.
 *
 * complete follows zero UID membership, bootstrap/control reaping, pipe closure
 * and access restoration. It discharges ONLY UID/access obligation, not original
 * operation drainage, broker FD close, whole-attempt settlement or writer release.
 * Unknown/conflicting/unsupported WAL records fail closed for every profile. */
/* The canonical implementation defines LC_HOST_WRITER_PROVIDER before including
 * this header. Only the broker consumer has optional-import declarations. */
#if defined(LC_HOST_WRITER_PROVIDER)
#define LC_HOST_WRITER_IMPORT
#elif defined(__APPLE__)
#define LC_HOST_WRITER_IMPORT __attribute__((weak_import))
#else
#define LC_HOST_WRITER_IMPORT __attribute__((weak))
#endif
extern bool lc_writer_host_resource_prepare(int fence_fd, int root_fd, int namespace_fd, const lc_host_writer_binding *) LC_HOST_WRITER_IMPORT;
extern bool lc_writer_host_resource_assert(int fence_fd, int root_fd, int namespace_fd, const lc_host_writer_binding *) LC_HOST_WRITER_IMPORT;
extern bool lc_writer_host_resource_complete(int fence_fd, int root_fd, int namespace_fd, const lc_host_writer_binding *) LC_HOST_WRITER_IMPORT;
#undef LC_HOST_WRITER_IMPORT
#endif
