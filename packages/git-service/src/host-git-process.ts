/** Trusted Git environment preparation shared by canonical host executors. */
export function gitCommandEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  provided: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(ambient)) {
    if (value !== undefined && !key.toUpperCase().startsWith("GIT_"))
      result[key] = value;
  }
  const auth =
    provided.GIT_CONFIG_COUNT === "1" &&
    provided.GIT_CONFIG_KEY_0?.toLowerCase() === "http.extraheader" &&
    provided.GIT_CONFIG_VALUE_0?.toLowerCase().startsWith(
      "authorization: basic ",
    );
  for (const [key, value] of Object.entries(provided)) {
    if (
      key === "GIT_INDEX_FILE" ||
      (auth &&
        ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"].includes(
          key,
        ))
    ) {
      if (value.includes("\0"))
        throw new Error("Invalid canonical Git environment value");
      result[key] = value;
    } else throw new Error("Unsupported canonical Git environment override");
  }
  return result;
}

/** Linux kernel subreaper. No session/process-group heuristic is used as exit proof. */
export const LINUX_GIT_SUPERVISOR = String.raw`
import ctypes, errno, glob, json, os, signal, subprocess, sys, time
request = json.loads(sys.argv[1])
if sys.platform != "linux" or not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
    print("Git containment unavailable: Linux subreaper/pidfd required", file=sys.stderr)
    sys.exit(126)
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    print("Git containment unavailable: PR_SET_CHILD_SUBREAPER denied", file=sys.stderr)
    sys.exit(126)
enabled = ctypes.c_int()
if libc.prctl(37, ctypes.byref(enabled), 0, 0, 0) != 0 or enabled.value != 1:
    print("Git containment unavailable: subreaper state not established", file=sys.stderr)
    sys.exit(126)
try:
    probe = os.pidfd_open(os.getpid())
    signal.pidfd_send_signal(probe, 0)
    os.close(probe)
except OSError:
    print("Git containment unavailable: pidfd signaling denied", file=sys.stderr)
    sys.exit(126)
environment = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
if request.get("trustedAuthEnvironment"):
    auth = {key: os.environ.get(key, "") for key in ("GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0")}
    if auth["GIT_CONFIG_COUNT"] != "1" or auth["GIT_CONFIG_KEY_0"].lower() != "http.extraheader" or not auth["GIT_CONFIG_VALUE_0"].lower().startswith("authorization: basic "):
        print("Git containment unavailable: invalid canonical auth environment", file=sys.stderr)
        sys.exit(126)
    environment.update(auth)
if request.get("indexFile"):
    environment["GIT_INDEX_FILE"] = request["indexFile"]
child = subprocess.Popen(["git", *request["args"]], cwd=request["cwd"], env=environment, start_new_session=True)
deadline = time.monotonic() + request["timeoutMs"] / 1000
git_status = None
timed_out = False
background = False

def process_tree():
    found = {}
    for filename in glob.glob("/proc/[0-9]*/stat"):
        try:
            with open(filename) as stream:
                fields = stream.read().rsplit(")", 1)[1].split()
            pid = int(filename.split("/")[2])
            found[pid] = (int(fields[1]), fields[19])
        except (FileNotFoundError, ProcessLookupError, ValueError, IndexError):
            pass
    return found

def children(pid, tree):
    return [candidate for candidate, identity in tree.items() if identity[0] == pid]

def terminate(pid, tree):
    for descendant in children(pid, tree):
        terminate(descendant, tree)
    try:
        descriptor = os.pidfd_open(pid)
    except ProcessLookupError:
        return
    try:
        current = process_tree().get(pid)
        if current is not None and current[1] == tree[pid][1]:
            signal.pidfd_send_signal(descriptor, signal.SIGKILL)
    except ProcessLookupError:
        pass
    finally:
        os.close(descriptor)

while True:
    no_children = False
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            no_children = True
            break
        if pid == 0:
            break
        if pid == child.pid:
            git_status = os.waitstatus_to_exitcode(status)
    if no_children:
        break
    if time.monotonic() >= deadline:
        timed_out = True
    tree = process_tree()
    adopted_children = children(os.getpid(), tree)
    if any(pid != child.pid for pid in adopted_children) or (git_status is not None and adopted_children):
        background = True
    if timed_out or background:
        for adopted in adopted_children:
            terminate(adopted, tree)
    time.sleep(0.005)
os.write(3, b"quiescent")
if timed_out:
    print("Git command timed out; all descendants killed and reaped", file=sys.stderr)
    sys.exit(124)
if background:
    print("Git hook left background descendants; all descendants killed and reaped", file=sys.stderr)
    sys.exit(125)
sys.exit(git_status if git_status is not None and git_status >= 0 else 1)
`;
