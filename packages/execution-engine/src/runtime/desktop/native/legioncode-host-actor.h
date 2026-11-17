#ifndef LEGIONCODE_HOST_ACTOR_H
#define LEGIONCODE_HOST_ACTOR_H
#include "legioncode-host-contract.h"
#include <grp.h>
#include <sys/resource.h>
extern int lc_host_actor_groups(int, gid_t []) __asm("_getgroups");
/* Trusted acquisition/metadata child only. No target, caller environment or
 * privileged descriptor may survive into this fully dropped actor identity. */
static inline bool lc_host_drop_actor(uid_t actor, gid_t gid) {
  struct proc_bsdinfo credentials; gid_t groups[NGROUPS_MAX]; struct rlimit core = { 0, 0 };
  return !setrlimit(RLIMIT_CORE, &core) && !setgroups(0, NULL) && !setgid(gid) && !setuid(actor) &&
    proc_pidinfo(getpid(), PROC_PIDTBSDINFO, 0, &credentials, sizeof(credentials)) == sizeof(credentials) &&
    credentials.pbi_uid == actor && credentials.pbi_ruid == actor && credentials.pbi_svuid == actor &&
    credentials.pbi_gid == gid && credentials.pbi_rgid == gid && credentials.pbi_svgid == gid &&
    lc_host_actor_groups(NGROUPS_MAX, groups) == 0;
}
#endif
