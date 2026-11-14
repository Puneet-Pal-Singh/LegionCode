import { dialog, type BrowserWindow, type MessageBoxOptions } from "electron";
import { constants } from "node:fs";
import { open, realpath, lstat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  MacHostBrokerClient,
  readInstalledMacHostBrokerDescriptor,
  type MacHostBrokerSetupClient,
  type MacHostSetupObservation,
} from "@legioncode/execution-engine/runtime/desktop/MacHostBrokerClient";
import {
  NativeHostSetupUnconfirmedError,
  runNativeHostConfigure,
  runNativeHostToolchainInspection,
} from "./native-host-setup-invocation";

const INSTALLED_APPLICATION = "/Library/Application Support/LegionCode/Applications/LegionCode Desktop.app";
const INSTALLED_INSTALLER = "/Library/PrivilegedHelperTools/dev.legioncode.desktop.native-host-installer";
type StartedQualification = {
  client: MacHostBrokerSetupClient;
  generation: string;
  qualificationId: string;
};
type NativeHostSetupDependencies = {
  readonly bundlePath: string;
  readonly bridgePath: string;
  readonly inspectorPath: string;
  readonly namespacePath: string;
  readonly getWindow: () => BrowserWindow | undefined;
  readonly canContinue: () => boolean;
  readonly stopLocalRuntime: () => Promise<void>;
  readonly refreshLocalRuntime: () => Promise<void>;
};

/** Owns only explicit setup. Normal startup/health checks never create accounts
 * or invoke authorization. Qualification stays with the installed C owner. */
export class DesktopNativeHostSetup {
  private active: Promise<void> | null = null;
  private closing = false;
  private cancelRequested = false;
  private uncertain = false;
  private namespace: FileHandle | null = null;
  private qualification: StartedQualification | null = null;

  constructor(private readonly dependencies: NativeHostSetupDependencies) {}

  get running(): boolean { return this.active !== null; }

  run(): Promise<void> {
    if (this.closing || !this.dependencies.canContinue())
      return Promise.reject(new Error("Local execution setup is unavailable during shutdown"));
    if (this.uncertain)
      return Promise.reject(new NativeHostSetupUnconfirmedError());
    if (this.active) return this.active;
    this.cancelRequested = false;
    // Install custody before invoking any dialog, runtime or OS collaborator.
    const operation = Promise.resolve().then(() => this.configure());
    this.active = operation;
    void operation.finally(() => {
      if (this.active === operation) this.active = null;
    }).catch(() => undefined);
    return operation;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.cancelRequested = true;
    // The original configure/Start may still be returning. Its owner observes
    // cancellation before the next effect; no replacement Start is dispatched.
    await this.active?.catch(() => undefined);
    if (this.uncertain || this.namespace)
      throw new NativeHostSetupUnconfirmedError();
  }

  private continueBeforeEffect(): void {
    if (this.closing || this.cancelRequested || !this.dependencies.canContinue())
      throw new Error("Local execution setup was cancelled");
  }

  private async message(options: MessageBoxOptions): Promise<number> {
    const window = this.dependencies.getWindow();
    if (!window || window.isDestroyed()) throw new Error("Desktop window is unavailable");
    return (await dialog.showMessageBox(window, options)).response;
  }

  private async configure(): Promise<void> {
    const options = this.dependencies;
    if (process.platform !== "darwin" || options.bundlePath !== INSTALLED_APPLICATION ||
        await realpath(options.bundlePath) !== INSTALLED_APPLICATION)
      throw new Error("Install the Native setup PKG, then open its installed LegionCode app before setting up local execution.");
    const accepted = await this.message({
      type: "question", title: "Set up local execution", message: "Set up LegionCode Native on this Mac?",
      detail: "Choose your Node and npm installation. LegionCode will capture these tools and ask macOS to create isolated execution accounts. Current local work will stop before setup begins.",
      buttons: ["Continue", "Cancel"], defaultId: 0, cancelId: 1,
    });
    if (accepted !== 0) return;
    this.continueBeforeEffect();
    const node = await dialog.showOpenDialog({ title: "Choose your Node executable", properties: ["openFile", "showHiddenFiles"] });
    if (node.canceled || !node.filePaths[0]) return;
    this.continueBeforeEffect();
    const nodePath = await realpath(node.filePaths[0]);
    const npm = await dialog.showOpenDialog({
      title: "Choose the npm package directory", properties: ["openDirectory", "showHiddenFiles"],
      defaultPath: join(dirname(dirname(nodePath)), "lib", "node_modules", "npm"),
    });
    if (npm.canceled || !npm.filePaths[0]) return;
    const npmDirectory = await realpath(npm.filePaths[0]);
    this.continueBeforeEffect();
    await runNativeHostToolchainInspection({ installerPath: options.inspectorPath, nodePath, npmDirectory });
    this.continueBeforeEffect();
    await options.stopLocalRuntime();
    this.continueBeforeEffect();
    const namespace = await open(options.namespacePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    this.namespace = namespace;
    const progress = new AbortController();
    let effectsMayExist = false, terminal = false;
    try {
      const held = await namespace.stat({ bigint: true });
      const named = await lstat(options.namespacePath, { bigint: true });
      const actorUid = process.getuid?.();
      if (actorUid === undefined || actorUid < 501 || !held.isDirectory() || held.uid !== BigInt(actorUid) ||
          (held.mode & 0o7777n) !== 0o700n || named.dev !== held.dev || named.ino !== held.ino ||
          named.isSymbolicLink() || await realpath(options.namespacePath) !== options.namespacePath)
        throw new Error("The original local writer namespace is unavailable");
      this.continueBeforeEffect();
      effectsMayExist = true;
      const permit = await runNativeHostConfigure({
        installerPath: INSTALLED_INSTALLER, actorUid, namespacePath: options.namespacePath, nodePath, npmDirectory,
      });
      // The positive configure receipt closes that original invocation. No
      // qualification resource exists until this owner actually dispatches Start.
      effectsMayExist = false;
      // Successful configuration created no qualification resources. A quit
      // during authorization must never create a new task after that seal.
      if (this.closing || this.cancelRequested || !options.canContinue()) {
        await namespace.close();
        this.namespace = null;
        effectsMayExist = false;
        return;
      }
      const descriptor = await readInstalledMacHostBrokerDescriptor({ trustedReaderPath: options.bridgePath });
      if (descriptor.state !== "configured" || descriptor.options.bridgePath !== options.bridgePath)
        throw new NativeHostSetupUnconfirmedError();
      const client = MacHostBrokerClient.setup(descriptor.options);
      const description = await client.describe();
      if (description.state !== "available" || description.generation !== descriptor.generation ||
          description.configurationSHA256 !== descriptor.configurationSHA256)
        throw new NativeHostSetupUnconfirmedError();
      // Only this original root-authorized permit and held namespace can Start.
      this.continueBeforeEffect();
      effectsMayExist = true;
      let observation = await client.start({ generation: descriptor.generation, setupPermitId: permit.setupPermitId, namespaceDirectory: namespace });
      if (observation.state === "not_started") throw new NativeHostSetupUnconfirmedError();
      this.qualification = { client, generation: observation.generation, qualificationId: observation.qualificationId };
      const window = options.getWindow();
      if (window && !window.isDestroyed()) {
        void dialog.showMessageBox(window, {
          type: "info", title: "Local execution setup", message: "Verifying local execution…",
          detail: "LegionCode is checking package scripts, sandbox boundaries and process cleanup in a disposable workspace.",
          buttons: ["Stop setup"], cancelId: 0, signal: progress.signal,
        }).then(() => { if (!terminal) this.cancelRequested = true; }).catch(() => { this.cancelRequested = true; });
      }
      observation = await this.waitForQualification(observation);
      terminal = true;
      if (observation.state !== "passed" && observation.state !== "cancelled")
        throw new NativeHostSetupUnconfirmedError();
      // Passed/cancelled are the C owner's positive resource-closure outcomes.
      // Subsequent read-only readiness failure cannot turn them into live work.
      effectsMayExist = false;
      if (observation.state === "passed") {
        if (!observation.receiptSHA256) throw new NativeHostSetupUnconfirmedError();
        const ready = await MacHostBrokerClient.connect(descriptor.options);
        if (ready.generation !== descriptor.generation) throw new NativeHostSetupUnconfirmedError();
      }
      await namespace.close();
      this.namespace = null;
      effectsMayExist = false;
      this.qualification = null;
      progress.abort();
      if (!this.closing && options.canContinue()) await options.refreshLocalRuntime();
      if (!this.closing && options.canContinue()) await this.message({
        type: "info", title: "Local execution setup",
        message: observation.state === "passed" ? "Local execution is ready" : "Local execution setup stopped",
        detail: observation.state === "passed" ? "LegionCode Native can now use the verified local execution boundary." : "The verification task stopped and its resources closed.",
        buttons: ["OK"],
      });
    } catch (error) {
      if (effectsMayExist) this.uncertain = true;
      else if (this.namespace) {
        try { await this.namespace.close(); this.namespace = null; }
        catch { this.uncertain = true; }
      }
      throw error;
    } finally {
      terminal = true;
      progress.abort();
    }
  }

  private async waitForQualification(initial: MacHostSetupObservation): Promise<MacHostSetupObservation> {
    const owner = this.qualification;
    if (!owner) throw new NativeHostSetupUnconfirmedError();
    let observation = initial, cancellationSent = false;
    const deadline = Date.now() + 5 * 60_000;
    while (observation.state === "running" || observation.state === "awaiting_bridge") {
      if (!cancellationSent && (this.cancelRequested || this.closing || Date.now() >= deadline)) {
        cancellationSent = true;
        observation = await owner.client.cancel(owner);
      } else observation = await owner.client.status(owner);
      if (observation.state === "running" || observation.state === "awaiting_bridge")
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    return observation;
  }
}
