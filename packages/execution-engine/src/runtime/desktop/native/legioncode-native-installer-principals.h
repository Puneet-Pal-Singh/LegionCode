#ifndef LEGIONCODE_NATIVE_INSTALLER_PRINCIPALS_H
#define LEGIONCODE_NATIVE_INSTALLER_PRINCIPALS_H
#include <OpenDirectory/OpenDirectory.h>
#include <grp.h>

static bool cfg_od_count(ODNodeRef node, CFStringRef type, CFStringRef attribute, CFStringRef value, CFIndex expected) {
  CFErrorRef error = NULL;
  ODQueryRef query = ODQueryCreateWithNode(NULL, node, type, attribute, kODMatchEqualTo, value,
    kODAttributeTypeRecordName, 2, &error);
  CFArrayRef records = query && !error ? ODQueryCopyResults(query, false, &error) : NULL;
  bool okay = records && !error && CFArrayGetCount(records) == expected;
  if (records) CFRelease(records); if (query) CFRelease(query); if (error) CFRelease(error);
  return okay;
}
static bool cfg_od_attribute(CFMutableDictionaryRef attributes, CFStringRef key, CFStringRef value) {
  const void *values[] = { value };
  CFArrayRef array = CFArrayCreate(NULL, values, 1, &kCFTypeArrayCallBacks);
  if (!array) return false;
  CFDictionarySetValue(attributes, key, array); CFRelease(array); return true;
}
static bool cfg_od_value(ODRecordRef record, CFStringRef attribute, CFStringRef expected) {
  CFErrorRef error = NULL; CFArrayRef values = ODRecordCopyValues(record, attribute, &error);
  bool okay = values && !error && CFArrayGetCount(values) == 1 && CFEqual(CFArrayGetValueAtIndex(values, 0), expected);
  if (values) CFRelease(values); if (error) CFRelease(error); return okay;
}
static bool cfg_principal_identity(ODRecordRef user, const char *name, const char *group_name, uid_t uid, gid_t gid, const uuid_t expected_group_guid, uuid_t guid) {
  struct passwd password, *found = NULL; char user_bytes[16384];
  struct group group, *found_group = NULL; char group_bytes[16384]; uuid_t actual; id_t resolved; int type;
  CFErrorRef error = NULL; CFArrayRef values = ODRecordCopyValues(user, kODAttributeTypeGUID, &error);
  char uuid[37];
  bool okay = values && !error && CFArrayGetCount(values) == 1 &&
    lc_host_text(CFArrayGetValueAtIndex(values, 0), uuid, sizeof(uuid)) && !uuid_parse(uuid, guid) && !uuid_is_null(guid) &&
    !getpwuid_r(uid, &password, user_bytes, sizeof(user_bytes), &found) && found && !strcmp(password.pw_name, name) &&
    password.pw_uid == uid && password.pw_gid == gid && !strcmp(password.pw_shell, "/usr/bin/false") && !strcmp(password.pw_dir, "/var/empty") &&
    !getgrgid_r(gid, &group, group_bytes, sizeof(group_bytes), &found_group) && found_group && group.gr_gid == gid && !strcmp(group.gr_name, group_name) && (!group.gr_mem || !group.gr_mem[0]) &&
    !mbr_uid_to_uuid(uid, actual) && !memcmp(actual, guid, sizeof(uuid_t)) &&
    !mbr_uuid_to_id(guid, &resolved, &type) && type == ID_TYPE_UID && resolved == uid;
  if (values) CFRelease(values); if (error) CFRelease(error);
  uuid_t group_guid; id_t group_id; int group_type;
  okay = okay && !mbr_gid_to_uuid(gid, group_guid) && !uuid_is_null(group_guid) && !memcmp(group_guid, expected_group_guid, sizeof(uuid_t)) &&
    !mbr_uuid_to_id(group_guid, &group_id, &group_type) && group_type == ID_TYPE_GID && group_id == gid;
  int groups[2], count = 2; pid_t process = -1; errno = 0;
  okay = okay && gid <= INT_MAX && getgrouplist(name, (int)gid, groups, &count) >= 0 && count == 1 && groups[0] == (int)gid;
  errno = 0; int bytes = proc_listpids(PROC_RUID_ONLY, uid, &process, sizeof(process));
  return okay && bytes == 0 && errno == 0;
}
/* Intent is durable before OD's first effect. Partial creation is retained;
 * neither a failed create nor a stale cache authorizes account deletion/reuse. */
static CFArrayRef cfg_create_principals(int state, uid_t actor, const char *nonce) {
  CFErrorRef error = NULL;
  ODNodeRef local = ODNodeCreateWithName(NULL, kODSessionDefault, CFSTR("/Local/Default"), &error);
  ODNodeRef search = !error ? ODNodeCreateWithNodeType(NULL, kODSessionDefault, kODNodeTypeAuthentication, &error) : NULL;
  CFMutableArrayRef principals = cfg_array();
  bool okay = local && search && !error && principals;
  uint32_t candidate = 60000;
  for (unsigned index = 0; okay && index < 4; index++) {
    char number[16], name[96], group_name[100];
    CFStringRef id = NULL;
    for (; candidate < 65000; candidate++) {
      if (candidate == actor) continue;
      snprintf(number, sizeof(number), "%u", candidate); id = cfg_string(number);
      bool unused = id && cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypeUniqueID, id, 0) &&
        cfg_od_count(search, kODRecordTypeGroups, kODAttributeTypePrimaryGroupID, id, 0) &&
        cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypePrimaryGroupID, id, 0);
      if (unused) break;
      if (id) CFRelease(id); id = NULL;
    }
    snprintf(name, sizeof(name), "_lc_native_%.16s_%u", nonce, index);
    snprintf(group_name, sizeof(group_name), "%s_g", name);
    uuid_t user_guid, group_guid; char user_uuid[37], group_uuid[37];
    uuid_generate_random(user_guid); uuid_generate_random(group_guid);
    uuid_unparse_lower(user_guid, user_uuid); uuid_unparse_lower(group_guid, group_uuid);
    CFStringRef user_guid_value = cfg_string(user_uuid), group_guid_value = cfg_string(group_uuid);
    CFStringRef user_name = cfg_string(name), group_name_value = cfg_string(group_name);
    okay = id && candidate < 65000 && user_name && group_name_value && user_guid_value && group_guid_value &&
      cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypeGUID, user_guid_value, 0) &&
      cfg_od_count(search, kODRecordTypeGroups, kODAttributeTypeGUID, user_guid_value, 0) &&
      cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypeGUID, group_guid_value, 0) &&
      cfg_od_count(search, kODRecordTypeGroups, kODAttributeTypeGUID, group_guid_value, 0) &&
      cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypeRecordName, user_name, 0) &&
      cfg_od_count(search, kODRecordTypeGroups, kODAttributeTypeRecordName, user_name, 0) &&
      cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypeRecordName, group_name_value, 0) &&
      cfg_od_count(search, kODRecordTypeGroups, kODAttributeTypeRecordName, group_name_value, 0);
    CFMutableDictionaryRef intent = cfg_dictionary(); char file[64];
    if (okay && intent) {
      cfg_put_number(intent, CFSTR("Version"), 1); cfg_put_number(intent, CFSTR("ActorUID"), actor);
      cfg_put_number(intent, CFSTR("UID"), candidate); cfg_put_number(intent, CFSTR("GID"), candidate);
      CFDictionarySetValue(intent, CFSTR("UserGUID"), user_guid_value); CFDictionarySetValue(intent, CFSTR("GroupGUID"), group_guid_value);
      CFDictionarySetValue(intent, CFSTR("UserName"), user_name); CFDictionarySetValue(intent, CFSTR("GroupName"), group_name_value);
      snprintf(file, sizeof(file), "configure.allocation.%u.pending.plist", index);
      okay = cfg_write_plist(state, file, intent);
    } else okay = false;
    CFMutableDictionaryRef group_attributes = cfg_dictionary(), user_attributes = cfg_dictionary();
    ODRecordRef created_group = NULL, created_user = NULL;
    /* Build every mandatory field before either create. No account with OD's
     * defaults is permitted when allocation of a disabled-login attribute fails. */
    okay = okay && group_attributes && user_attributes &&
      cfg_od_attribute(group_attributes, kODAttributeTypePrimaryGroupID, id) &&
      cfg_od_attribute(group_attributes, kODAttributeTypeGUID, group_guid_value) &&
      cfg_od_attribute(group_attributes, kODAttributeTypePassword, CFSTR("*")) &&
      cfg_od_attribute(user_attributes, kODAttributeTypeUniqueID, id) &&
      cfg_od_attribute(user_attributes, kODAttributeTypePrimaryGroupID, id) &&
      cfg_od_attribute(user_attributes, kODAttributeTypeGUID, user_guid_value) &&
      cfg_od_attribute(user_attributes, kODAttributeTypeUserShell, CFSTR("/usr/bin/false")) &&
      cfg_od_attribute(user_attributes, kODAttributeTypeNFSHomeDirectory, CFSTR("/var/empty")) &&
      cfg_od_attribute(user_attributes, kODAttributeTypePassword, CFSTR("*")) &&
      cfg_od_attribute(user_attributes, kODAttributeTypeAuthenticationAuthority, CFSTR(";DisabledUser;")) &&
      cfg_od_attribute(user_attributes, CFSTR("dsAttrTypeNative:IsHidden"), CFSTR("1"));
    if (okay) {
      created_group = ODNodeCreateRecord(local, kODRecordTypeGroups, group_name_value, group_attributes, &error);
      okay = created_group && !error && ODRecordSynchronize(created_group, &error) && !error;
    }
    if (okay) {
      created_user = ODNodeCreateRecord(local, kODRecordTypeUsers, user_name, user_attributes, &error);
      okay = created_user && !error && ODRecordSynchronize(created_user, &error) && !error;
    }
    uuid_t guid;
    okay = okay && cfg_od_count(search, kODRecordTypeUsers, kODAttributeTypeUniqueID, id, 1) &&
      cfg_od_count(search, kODRecordTypeGroups, kODAttributeTypePrimaryGroupID, id, 1) &&
      cfg_od_value(created_user, kODAttributeTypeAuthenticationAuthority, CFSTR(";DisabledUser;")) &&
      cfg_od_value(created_user, kODAttributeTypePassword, CFSTR("*")) &&
      cfg_od_value(created_user, CFSTR("dsAttrTypeNative:IsHidden"), CFSTR("1")) &&
      cfg_od_value(created_user, kODAttributeTypeGUID, user_guid_value) &&
      cfg_od_value(created_group, kODAttributeTypeGUID, group_guid_value) &&
      cfg_principal_identity(created_user, name, group_name, candidate, candidate, group_guid, guid);
    if (okay) {
      CFMutableDictionaryRef principal = cfg_dictionary(); char uuid[37]; uuid_unparse_lower(guid, uuid);
      if (principal) {
        cfg_put_number(principal, CFSTR("UID"), candidate); cfg_put_number(principal, CFSTR("GID"), candidate);
        cfg_put_string(principal, CFSTR("GUID"), uuid); CFArrayAppendValue(principals, principal); CFRelease(principal);
      } else okay = false;
    }
    if (created_user) CFRelease(created_user); if (created_group) CFRelease(created_group);
    if (user_attributes) CFRelease(user_attributes); if (group_attributes) CFRelease(group_attributes);
    if (user_guid_value) CFRelease(user_guid_value); if (group_guid_value) CFRelease(group_guid_value);
    if (intent) CFRelease(intent); if (id) CFRelease(id); if (user_name) CFRelease(user_name); if (group_name_value) CFRelease(group_name_value);
    candidate++;
  }
  if (error) CFRelease(error); if (search) CFRelease(search); if (local) CFRelease(local);
  if (!okay || CFArrayGetCount(principals) != 4) { if (principals) CFRelease(principals); return NULL; }
  return principals;
}
#endif
