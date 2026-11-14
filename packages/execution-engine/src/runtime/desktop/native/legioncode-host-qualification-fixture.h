#ifndef LEGIONCODE_HOST_QUALIFICATION_FIXTURE_H
#define LEGIONCODE_HOST_QUALIFICATION_FIXTURE_H
#include "legioncode-host-qualification-toolchain.h"

/* Fixed production setup recipe data, never caller-supplied scripts or argv. */
static const char lc_qualification_test_script[] =
  "\"use strict\";\n"
  "const fs=require(\"node:fs\"),cp=require(\"node:child_process\"),net=require(\"node:net\");\n"
  "const cfg=JSON.parse(fs.readFileSync(\".qualifier-config.json\",\"utf8\"));\n"
  "const nonce=Buffer.from(cfg.nonce,\"hex\");\n"
  "if(process.argv[2]===\"detached\"){\n"
  " const marker=Buffer.alloc(40);marker.write(\"LCQD\");nonce.copy(marker,4);marker.writeUInt32BE(process.pid,36);fs.writeFileSync(\".qualifier-descendant.next\",marker);fs.renameSync(\".qualifier-descendant.next\",\".qualifier-descendant\");setInterval(()=>{},1000);\n"
  "}else{\n"
  " const assert=(v,m)=>{if(!v)throw Error(m)};\n"
  " const closed=(p)=>new Promise((resolve,reject)=>{p.on(\"error\",reject);p.on(\"close\",(c,s)=>c===0&&s===null?resolve():reject(Error(\"child closure\")))});\n"
  " const denied=(f)=>{try{f()}catch(e){if(e.code===\"EPERM\"||e.code===\"EACCES\")return;throw e}throw Error(\"access unexpectedly allowed\")};\n"
  " (async()=>{\n"
  "  assert(process.execPath===cfg.node,\"selected Node identity\");\n"
  "  const left=cp.spawn(cfg.node,[\"-e\",\"process.stdout.write('native-pipeline\\\\n')\"],{env:{},stdio:[\"ignore\",\"pipe\",\"pipe\"]});\n"
  "  const right=cp.spawn(\"/bin/bash\",[\"--noprofile\",\"--norc\",\"-c\",\"IFS= read -r value; printf '%s' \\\"$value\\\"\"],{env:{},stdio:[\"pipe\",\"pipe\",\"pipe\"]});\n"
  "  const lc=closed(left),rc=closed(right);let output=\"\",diagnostics=\"\";\n"
  "  left.stderr.on(\"data\",b=>diagnostics+=b);right.stderr.on(\"data\",b=>diagnostics+=b);right.stdout.on(\"data\",b=>{output+=b;if(output.length>4096)throw Error(\"pipeline bound\")});\n"
  "  left.stdout.pipe(right.stdin);await Promise.all([lc,rc]);assert(output===\"native-pipeline\"&&!diagnostics,\"real subprocess pipeline\");\n"
  "  const detached=cp.spawn(cfg.node,[__filename,\"detached\"],{env:{},detached:true,stdio:\"ignore\"});detached.on(\"error\",e=>{throw e});detached.unref();\n"
  "  const until=Date.now()+5000;while(!fs.existsSync(\".qualifier-detached-ack\")&&Date.now()<until)await new Promise(r=>setTimeout(r,20));\n"
  "  const marker=fs.readFileSync(\".qualifier-descendant\");assert(marker.length===40&&marker.subarray(0,4).toString()===\"LCQD\"&&marker.subarray(4,36).equals(nonce)&&marker.readUInt32BE(36)===detached.pid&&fs.readFileSync(\".qualifier-detached-ack\").equals(nonce),\"ROOT observed detached child\");\n"
  "  fs.writeFileSync(\".qualifier-write\",nonce);assert(fs.readFileSync(\".qualifier-write\").equals(nonce),\"workspace write positive\");\n"
  "  denied(()=>fs.linkSync(\".qualifier-write\",\".qualifier-hardlink\"));denied(()=>fs.symlinkSync(cfg.outside,\".qualifier-symlink\"));\n"
  "  denied(()=>fs.writeFileSync(\".git/qualification-canary\",\"must remain unchanged\"));\n"
  "  denied(()=>fs.renameSync(\".git\",\".qualifier-moved-git\"));\n"
  "  denied(()=>fs.readFileSync(cfg.outside));denied(()=>fs.writeFileSync(cfg.outside,\"must remain unchanged\"));\n"
  "  for(const path of cfg.protected)denied(()=>fs.readdirSync(path));\n"
  "  await new Promise((resolve,reject)=>{\n"
  "   const socket=net.connect({host:\"127.0.0.1\",port:cfg.port});let expected=false;\n"
  "   const timer=setTimeout(()=>{socket.destroy();reject(Error(\"network denial timeout\"))},1500);\n"
  "   socket.on(\"connect\",()=>{socket.destroy();reject(Error(\"network unexpectedly allowed\"))});\n"
  "   socket.on(\"error\",e=>{if(e.code===\"EPERM\"||e.code===\"EACCES\")expected=true;else reject(e);socket.destroy()});\n"
  "   socket.on(\"close\",()=>{clearTimeout(timer);expected?resolve():reject(Error(\"network denial unconfirmed\"))});\n"
  "  });\n"
  "  const result=Buffer.alloc(40);result.write(\"LCQ1\");nonce.copy(result,4);result.writeUInt32BE(511,36);fs.writeFileSync(\".qualifier-result\",result);\n"
  " })().catch(()=>{process.exitCode=1});\n"
  "}\n"
;
static const char lc_qualification_build_script[] =
  "\"use strict\";\n"
  "const fs=require(\"node:fs\"),crypto=require(\"node:crypto\");\n"
  "const cfg=JSON.parse(fs.readFileSync(\".qualifier-config.json\",\"utf8\")),nonce=Buffer.from(cfg.nonce,\"hex\");\n"
  "const result=fs.readFileSync(\".qualifier-result\");\n"
  "if(process.execPath!==cfg.node||result.length!==40||result.subarray(0,4).toString()!==\"LCQ1\"||!result.subarray(4,36).equals(nonce)||result.readUInt32BE(36)!==511||!fs.readFileSync(\".qualifier-descendant\").subarray(4,36).equals(nonce))throw Error(\"package result identity\");\n"
  "fs.writeFileSync(\".qualifier-build\",crypto.createHash(\"sha256\").update(result).digest());\n"
;
static const char lc_qualification_flood_script[] =
  "\"use strict\";\n"
  "const chunk=Buffer.alloc(8192,120);\n"
  "function flood(){for(let i=0;i<64;i++){if(!process.stdout.write(chunk)){process.stdout.once(\"drain\",flood);return}}setImmediate(flood)}\n"
  "flood();\n"
;

static inline bool lc_qualification_json(const char *text, char *out, size_t bound) {
  size_t at = 0; if (bound < 3) return false; out[at++] = 34;
  for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
    if (*p < 32 || *p == 127 || at + 3 >= bound) return false;
    if (*p == 34 || *p == 92) out[at++] = 92;
    out[at++] = (char)*p;
  }
  out[at++] = 34; out[at] = 0; return true;
}
static inline bool lc_qualification_quote(const char *text, char *out, size_t bound) {
  size_t at = 0; if (bound < 3) return false; out[at++] = 39;
  for (const char *p = text; *p; p++) {
    size_t size = *p == 39 ? 4 : 1; if (at + size + 2 > bound) return false;
    if (*p == 39) { out[at++] = 39; out[at++] = 92; out[at++] = 39; out[at++] = 39; }
    else out[at++] = *p;
  }
  out[at++] = 39; out[at] = 0; return true;
}
static inline bool lc_qualification_write(int root, const char *name, const void *bytes, size_t size, uid_t actor, gid_t group, mode_t mode) {
  int fd = openat(root, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode);
  if (fd < 0) return false;
  bool okay = lc_host_io(fd, (void *)bytes, size, true) && !fchown(fd, actor, group) && !fchmod(fd, mode) && lc_host_sync(fd);
  if (close(fd)) okay = false; return okay;
}
static inline bool lc_qualification_directory(int root, const char *name, uid_t actor, gid_t group) {
  if (mkdirat(root, name, 0755)) return false;
  int fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return false;
  bool okay = !fchown(fd, actor, group) && !fchmod(fd, 0755) && lc_host_sync(fd);
  if (close(fd)) okay = false; return okay;
}
#endif
