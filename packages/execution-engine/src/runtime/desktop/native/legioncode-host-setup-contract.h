#ifndef LEGIONCODE_HOST_SETUP_CONTRACT_H
#define LEGIONCODE_HOST_SETUP_CONTRACT_H
#include "legioncode-host-writer-contract.h"

#define LC_HOST_RESOURCE_RECORD_VERSION 4U
#define LC_HOST_RESOURCE_STATE_DIRECTORY "/Library/Application Support/LegionCode/NativeExecution/resources"
typedef enum { LC_HOST_RESOURCE_NATIVE = 1, LC_HOST_RESOURCE_SETUP_QUALIFICATION = 2 } lc_host_resource_purpose;
/* Fixed prefix shared with the setup-only physical writer adapter. digest_offset
 * is explicit: native record padding must never be mistaken for digest bytes. */
#define LC_HOST_RESOURCE_PREFIX_FIELDS \
  uint32_t version, bytes, digest_offset, purpose, phase, command_count, cleanup_closed; \
  char boot[40], origin_generation[65]; \
  unsigned char cleanup_receipt[32]; \
  lc_host_writer_binding binding

typedef struct { LC_HOST_RESOURCE_PREFIX_FIELDS; } lc_host_resource_record_prefix;

typedef enum {
  LC_WRITER_SETUP_NOT_STARTED = 0, LC_WRITER_SETUP_PENDING,
  LC_WRITER_SETUP_ACQUIRED, LC_WRITER_SETUP_UNKNOWN,
} lc_writer_setup_acquisition_phase;
/* Original authority, owned by the same setup resource until positively closed.
 * A false result NEVER transfers/closes/unlocks the root/fence/namespace loan.
 * UNKNOWN is sticky; PID/FD numbers are not reusable recovery capabilities. */
typedef struct {
  uint32_t version, phase;
  int root_fd, fence_fd, namespace_fd;
  int reservation_fd, reservation_directory_fd;
  lc_host_file_identity reservation_identity, reservation_directory_identity;
  unsigned char reservation_sha256[32];
  lc_host_writer_binding binding;
  int64_t child;
  int control_fd, control_write_fd;
  bool control_write_close_attempted, control_write_closed, control_nonblocking;
  bool child_reaped, child_identity_lost, control_eof, control_closed, report_valid;
  int child_status;
  unsigned char report[9];
  uint32_t report_bytes;
  uint64_t deadline_milliseconds;
} lc_writer_setup_acquisition;

/* Caller first persists+fsyncs a ROOT-protected v4 setup-purpose reservation and
 * its directory, retaining those exact original descriptors and digest here.
 * The adapter MUST validate that record/named inode and actor/root/namespace/
 * fence binding BEFORE fork. Only a fully dropped actor child may invoke the
 * UNCHANGED canonical lc_intent_acquire on the SAME inherited description.
 * True requires the original private report, actual EOF/control close and exact
 * successful child reap plus canonical H validation. Pending/unknown retains
 * the original child, pipe, record and all borrowed authorities for its owner.
 * These are setup-only ports; the three ABI272 borrow callbacks are unchanged.
 * No caller join is allowed until the complete adapter and canonical metadata
 * inspection transport have passed their independent owner review. */
extern bool lc_writer_setup_qualification_acquire(int fence_fd, int root_fd, int namespace_fd,
  uint32_t actor_uid, lc_writer_setup_acquisition *state);
extern bool lc_writer_setup_qualification_poll(lc_writer_setup_acquisition *state);
extern void lc_writer_setup_qualification_cancel(lc_writer_setup_acquisition *state);
#endif
