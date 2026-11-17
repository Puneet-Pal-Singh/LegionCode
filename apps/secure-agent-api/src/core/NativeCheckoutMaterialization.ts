import type { NativeSandboxPhysicalBinding } from "@repo/worker-protocol/private/native-sandbox-binding";
import { DefaultGitService, type GitCommandExecutor, type GitRepositoryMetadataPaths } from "@repo/git-service";
import { clonePinnedWorkspace } from "@repo/git-service/pinned-checkout";
import { NativeBootstrapObservationSchema, NativeBootstrapWitnessSchema, NativeCheckoutBootstrapReceiptSchema,
  type NativeCheckoutBootstrapIntent, type NativeCheckoutBootstrapReceipt } from "@repo/worker-protocol/private/native-checkout-bootstrap";
import { NativeWorkspacePreparationSchema, sameNativeBinding,
  type NativeCommandBinding, type NativeCommandOriginal } from "../toolbox/contracts/OwnedSandboxCommand";

/** Fixed materialization policy; transport, Git auth, physical leases and intent
 * remain with their existing owners. No repository-supplied script is executed. */
export async function materializeNativeCheckout(input: {
  intent: NativeCheckoutBootstrapIntent; binding: NativeCommandBinding; physicalBinding: NativeSandboxPhysicalBinding;
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
  // Physical witness custody is outside canonical Git/snapshot/resume contents.
  const materialization = JSON.stringify({ version: 2, physicalBinding: input.physicalBinding, intent, observation, metadataIdentity: workspace.metadata.identity, head, tree, branch: actualBranch });
  const hash = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const materializationSha256 = await hash(materialization);
  const witness = NativeBootstrapWitnessSchema.parse(await fixed("--write-bootstrap-witness", {
    binding, root: intent.root, expectedRoot: workspace.root, expectedBootId: workspace.sandboxBootId,
    metadata: workspace.metadata, materializationSha256,
  }));
  const expectedBody = JSON.stringify({ binding, workspaceRoot: observation.root, sandboxBootId: observation.sandboxBootId,
    metadataIdentity: workspace.metadata.identity, materializationSha256 });
  if (!sameNativeBinding(witness.binding, binding) || witness.key !== `bootstrap-${binding.nonce}.json` ||
    witness.workspaceRoot.device !== observation.root.device || witness.workspaceRoot.inode !== observation.root.inode ||
    witness.sandboxBootId !== observation.sandboxBootId || witness.metadataIdentity !== workspace.metadata.identity ||
    witness.materializationSha256 !== materializationSha256 || witness.bytes !== new TextEncoder().encode(expectedBody).byteLength ||
    witness.sha256 !== await hash(expectedBody)) throw unavailable();
  const receipt = NativeCheckoutBootstrapReceiptSchema.parse({ version: 2, physicalBinding: input.physicalBinding, intent, observation, metadataIdentity: workspace.metadata.identity,
    head, tree, branch: actualBranch, witness, git: input.gitReceipts, originalTransportSettled: true });
  return { receipt, workspace };
}
function unavailable(): Error { return new Error("NATIVE_CHECKOUT_MATERIALIZATION_UNAVAILABLE"); }
