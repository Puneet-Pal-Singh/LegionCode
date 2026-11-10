import { useEffect, useId, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import type { HostedWorkspaceConfiguration } from "@legioncode/sdk";
import { WorkspaceBranchField } from "./WorkspaceBranchField.js";
import { WorkspaceDialogFrame } from "./WorkspaceDialogFrame.js";
import { useHostedWorkspaceConfiguration, type HostedWorkspaceConfigurationClient } from "./useHostedWorkspaceConfiguration.js";

export interface HostedWorkspaceConfigurationEditorProps {
  client: HostedWorkspaceConfigurationClient;
  workspaceId: string;
  /** Changes when the authenticated account/session or hosted environment changes. */
  scopeKey: string;
  onClose: () => void;
  onSaved?: (configuration: HostedWorkspaceConfiguration) => void | Promise<void>;
}

/** Hosts mount this in their existing modal/portal, with their authenticated SDK binding. */
export function HostedWorkspaceConfigurationEditor(props: HostedWorkspaceConfigurationEditorProps) {
  const editor = useHostedWorkspaceConfiguration(props);
  const titleId = useId();
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const visible = editor.configuration !== null;
  const locked = editor.status !== "ready";
  useEffect(() => {
    if (editor.status === "ready") nameRef.current?.focus();
  }, [editor.scope, editor.status]);

  return (
    <WorkspaceDialogFrame labelledBy={titleId} onClose={props.onClose} closeLabel="Close project settings">
      <section className="flex min-h-0 flex-col overflow-y-auto px-5 py-6 sm:px-7">
        <div className="shrink-0 pr-10">
          <h1 id={titleId} className="text-2xl font-medium tracking-tight sm:text-[28px] sm:leading-[34px]">Project settings</h1>
          <p className="mt-2 text-sm text-[#969daa]">Name and starting branch for future tasks.</p>
        </div>
        {editor.status === "loading" ? (
          <p role="status" className="flex min-h-32 items-center gap-2 text-sm text-[#969daa]">
            <LoaderCircle className="animate-spin" size={17} /> Loading project settings…
          </p>
        ) : null}
        {visible ? (
          <form className="mt-7 min-w-0 space-y-5" onSubmit={(event) => { event.preventDefault(); void editor.save(); }}>
            <p className="truncate text-sm text-[#969daa]">{editor.configuration?.repository.fullName}</p>
            <div>
              <label htmlFor={nameId} className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.12em] text-[#969daa]">Project name</label>
              <input id={nameId} ref={nameRef} value={editor.name} onChange={(event) => editor.changeName(event.target.value)}
                required maxLength={200} disabled={locked}
                className="h-10 w-full rounded-md border border-[#343943] bg-[#111318] px-3 text-sm text-white focus:border-[#65b8ff] focus:outline-none disabled:opacity-40" />
            </div>
            <WorkspaceBranchField state={editor.branchState} value={editor.branch} branches={editor.branches}
              defaultBranch={editor.configuration?.repository.defaultBranch ?? ""} disabled={locked}
              onChange={editor.changeBranch} onRetry={editor.retryBranches} />
            <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 pt-4">
              <button type="button" onClick={props.onClose} className="rounded-md px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800">Cancel</button>
              <button type="submit" disabled={!editor.canSave}
                className="flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#f2f4f7] px-5 text-sm font-semibold text-[#090a0c] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40">
                {editor.status === "saving" ? <LoaderCircle className="animate-spin" size={15} /> : null}
                {editor.status === "saving" ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        ) : null}
        {editor.error ? (
          <div className="mt-4 space-y-2">
            <p role="alert" className="text-xs text-[#f06a6a]">{editor.error.message}</p>
            {editor.error.recovery === "reload" ? (
              <button type="button" onClick={() => void editor.reload()} className="min-h-10 text-sm text-[#65b8ff] hover:text-white">Reload saved settings</button>
            ) : null}
          </div>
        ) : null}
        {editor.notice ? <p role="status" className="mt-4 text-xs text-[#969daa]">{editor.notice}</p> : null}
      </section>
    </WorkspaceDialogFrame>
  );
}
