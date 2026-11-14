import { DefaultGitService, type GitCommandExecutor, type GitRepositoryMetadataPaths } from "@repo/git-service";
import { clonePinnedWorkspace } from "@repo/git-service/pinned-checkout";
import { NativeBootstrapObservationSchema, NativeCheckoutBootstrapReceiptSchema,
  type NativeCheckoutBootstrapIntent, type NativeCheckoutBootstrapReceipt } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { NativeWorkspacePreparationSchema, NativeWorkspaceWriteReceiptSchema, sameNativeBinding,
  type NativeCommandBinding, type NativeCommandOriginal } from "../toolbox/contracts/OwnedSandboxCommand";

/** Fixed materialization policy; transport, Git auth, physical leases and intent
 * remain with their existing owners. No repository-supplied script is executed. */
export async function materializeNativeCheckout(input: {
  intent: NativeCheckoutBootstrapIntent; binding: NativeCommandBinding;
  authEnvironment?: Readonly<Record<string, string>>;
  original(argv: string[], body: unknown): Promise<NativeCommandOriginal>;
  git: GitCommandExecutor;
  gitReceipts: NativeCheckoutBootstrapReceipt["git"];
}) {
  const { intent, binding } = input;
  const helper = "/usr/local/libexec/legioncode-command-supervisor";
  const fixed = async (mode: string, body: unknown): Promise<unknown> => {
    const original = await input.original([helper, mode], body);
    if (original.exitCode !== 0 || original.stderr !== "") throw unavailable();
    return JSON.parse(original.stdout) as unknown;
  };
  const observation = NativeBootstrapObservationSchema.parse(await fixed("--bootstrap-workspace-root", { binding, root: intent.root }));
  if (!sameNativeBinding(observation.binding, binding)) throw unavailable();
  const cloned = await clonePinnedWorkspace({ url: intent.repositoryUrl, worktree: intent.root,
    authorizedCommitId: intent.authorizedCommitId, authEnvironment: input.authEnvironment }, input.git);
  if (cloned.exitCode !== 0) throw unavailable();
  const branch = await input.git.execute({ cwd: intent.root, args: ["checkout", "-b", intent.workingBranch, intent.authorizedCommitId] });
  if (branch.exitCode !== 0) throw unavailable();
  const read = async (args: string[]): Promise<string> => {
    const result = await input.git.execute({ cwd: intent.root, args, readOnlyProbe: true });
    if (result.exitCode !== 0 || result.stderr !== "" || !result.stdout.endsWith("\n")) throw unavailable();
    return result.stdout.slice(0, -1);
  };
  const head = await read(["rev-parse", "HEAD"]), tree = await read(["rev-parse", "HEAD^{tree}"]);
  const actualBranch = await read(["symbolic-ref", "--short", "HEAD"]);
  if (head !== intent.authorizedCommitId || tree !== intent.authorizedTreeId || actualBranch !== intent.workingBranch) throw unavailable();
  const metadataPaths: GitRepositoryMetadataPaths = await new DefaultGitService(input.git).readRepositoryMetadataPaths({ workspaceRoot: intent.root });
  const workspace = NativeWorkspacePreparationSchema.parse(await fixed("--prepare-workspace", { binding, root: intent.root, metadataPaths }));
  if (!sameNativeBinding(workspace.binding, binding) || workspace.root.device !== observation.root.device ||
    workspace.root.inode !== observation.root.inode || workspace.sandboxBootId !== observation.sandboxBootId) throw unavailable();
  const path = ".legioncode/native-bootstrap.json";
  const content = JSON.stringify({ version: 1, intent, observation, metadataIdentity: workspace.metadata.identity, head, tree, branch: actualBranch });
  const encoded = new TextEncoder().encode(content);
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoded))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const file = NativeWorkspaceWriteReceiptSchema.parse(await fixed("--write-workspace-file", {
    binding, root: intent.root, expectedRoot: workspace.root, expectedBootId: workspace.sandboxBootId,
    metadata: workspace.metadata, path, content, exclusive: true,
  }));
  if (!sameNativeBinding(file.binding, binding) || file.root.device !== observation.root.device || file.root.inode !== observation.root.inode ||
    file.sandboxBootId !== observation.sandboxBootId || file.metadataIdentity !== workspace.metadata.identity ||
    file.path !== path || file.bytes !== encoded.byteLength || file.sha256 !== sha256) throw unavailable();
  const receipt = NativeCheckoutBootstrapReceiptSchema.parse({ version: 1, intent, observation, metadataIdentity: workspace.metadata.identity,
    head, tree, branch: actualBranch, file: { path, file: file.file, bytes: file.bytes, sha256: file.sha256 },
    git: input.gitReceipts, originalTransportSettled: true });
  return { receipt, workspace };
}
function unavailable(): Error { return new Error("NATIVE_CHECKOUT_MATERIALIZATION_UNAVAILABLE"); }
