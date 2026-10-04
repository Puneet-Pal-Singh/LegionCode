#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { requireLocalPersistRoot } from "./local-persist.mjs";

const [role, ownerPidText, separator, command, ...args] = process.argv.slice(2);
const ownerPid = Number(ownerPidText);
const token = process.env.LEGIONCODE_LOCAL_PERSIST_LOCK_TOKEN;

if (!/^[a-z0-9-]+$/.test(role ?? "") || !Number.isInteger(ownerPid) || ownerPid <= 0 || separator !== "--" || !command || !token) {
  console.error("[local-dev] worker supervisor requires a role, owner PID, lock token, and command");
  process.exit(2);
}

const lockPath = path.join(requireLocalPersistRoot(), ".legioncode-worker-locks", `${role}.json`);
const deadline = Date.now() + 30_000;

try {
  while (Date.now() < deadline) {
    const ownerState = processState(ownerPid);
    if (ownerState !== "alive") {
      console.error(`[local-dev] worker supervisor canceled before startup: launcher PID ${ownerPid} is ${ownerState}`);
      process.exit(0);
    }
    let lock;
    try { lock = JSON.parse(readFileSync(lockPath, "utf8")); }
    catch { process.exit(1); }
    if (lock.format !== 3 || lock.role !== role || lock.ownerPid !== ownerPid || lock.host !== hostname() || lock.token !== token) process.exit(1);
    if (lock.workerGroupPid === process.pid) break;
    if (lock.workerGroupPid != null) process.exit(1);
    await delay(20);
  }

  const current = JSON.parse(readFileSync(lockPath, "utf8"));
  if (current.workerGroupPid !== process.pid || current.ownerPid !== ownerPid || current.token !== token || current.host !== hostname()) {
    console.error("[local-dev] startup ownership handshake was not completed; worker was not started");
    process.exit(1);
  }

  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.once("error", (error) => {
    console.error(`[local-dev] worker command failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(`[local-dev] worker supervisor failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}

function processState(pid) {
  try { process.kill(pid, 0); return "alive"; }
  catch (error) {
    if (error?.code === "ESRCH") return "dead";
    return "unknown";
  }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
