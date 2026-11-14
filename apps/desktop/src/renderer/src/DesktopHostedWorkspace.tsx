import {
  AuthorizedRepositoryPicker, ChatErrorNotice, ClientShell, ComposerWorkspaceBar,
  ConversationHero, EnvironmentSummaryMenu, PickerModal, ThreadSidebar,
  WorkspaceFrame, WorkspaceReviewControls, WorkspaceSummaryLayout, WorkspaceTopBar,
  clampRightSidebarWidth, getInitialRightSidebarWidth,
} from "@legioncode/client-ui";
import { projectThreadSidebar, RunIdSchema } from "@legioncode/sdk";
import { ThreadIdSchema } from "@repo/platform-protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BYOKResolution } from "@repo/shared-types";
import type { DesktopBuildInfo } from "../../shared/desktop-api";
import { createHostedDesktopClient } from "./createHostedDesktopClient";
import { DesktopHostedAccount } from "./DesktopHostedAccount";
import { DesktopHostedComposer, type DesktopHostedComposerDraft } from "./DesktopHostedComposer";
import { DesktopHostedConversation, type DesktopHostedReviewTurn } from "./DesktopHostedConversation";
import { DesktopHostedRightPanel } from "./DesktopHostedRightPanel";
import { useDesktopHostedInputQueueCustody } from "./DesktopHostedInputQueue";
import { DesktopHostedSettingsDialog } from "./DesktopHostedSettingsDialog";
import type { DesktopHostedAccountControls } from "./useDesktopHostedAccount";
import { useDesktopHostedComposerHandoff } from "./useDesktopHostedComposerHandoff";
import { useDesktopHostedProviderSettings } from "./useDesktopHostedProviderSettings";
import { useDesktopHostedSessions } from "./useDesktopHostedSessions";

const emptyDraft: DesktopHostedComposerDraft = { input: "", mode: "build", productMode: "ask_always" };

/** Hosted metadata and SDK commands adapt the same shared workspace used by Web. */
export function DesktopHostedWorkspace({ active, build, account, onPlacementChange }: {
  active: boolean;
  build: DesktopBuildInfo;
  account: DesktopHostedAccountControls;
  onPlacementChange: (placement: "local" | "cloud") => void;
}) {
  const snapshot = account.snapshot;
  const accountId = snapshot?.state === "signed_in" ? snapshot.account?.id ?? null : null;
  const target = snapshot?.target ?? null;
  const generation = snapshot?.generation ?? null;
  const binding = useMemo(() => accountId && target && generation !== null
    ? { target, accountId, generation } : null, [target, accountId, generation]);
  const accountKey = binding ? JSON.stringify([binding.target, binding.accountId, binding.generation]) : null;
  const inputQueueCustody = useDesktopHostedInputQueueCustody(accountKey);
  // Account-wide metadata must not depend on the selected workspace or reset its own hook.
  const metadataClient = useMemo(() => binding
    ? createHostedDesktopClient(binding, { clientVersion: build.version }) : null,
  [binding, build.version]);
  const sessions = useDesktopHostedSessions({ client: metadataClient, account: snapshot, enabled: Boolean(binding) });
  const [drafts, setDrafts] = useState<Record<string, DesktopHostedComposerDraft>>({});
  const [selections, setSelections] = useState<Record<string, BYOKResolution>>({});
  const draftRevisions = useRef(new Map<string, number>());
  const submittedDrafts = useRef(new Map<string, { key: string; revision: number }>());
  const draftKeyFor = (sessionId: string | null, workspaceId: string | null) =>
    JSON.stringify([accountKey, sessionId ?? "welcome", sessionId ? null : workspaceId]);
  const handoff = useDesktopHostedComposerHandoff({
    accountKey,
    accountId,
    createSession: sessions.createSession,
    retrySessionCreation: sessions.retryPendingCreation,
    onAccepted: (capture) => {
      // Clear only the admitted text. Typing a newer draft must survive a late acknowledgement.
      const source = submittedDrafts.current.get(capture.draft.id);
      const keys = capture.session ? [draftKeyFor(capture.session.id, capture.workspaceId)] : [];
      setSelections((previous) => ({ ...previous,
        ...Object.fromEntries(keys.map((key) => [key, capture.selection])) }));
      if (!source || (draftRevisions.current.get(source.key) ?? 0) !== source.revision) return;
      setDrafts((previous) => {
        return previous[source.key]?.input === capture.draft.prompt
          ? { ...previous, [source.key]: { ...previous[source.key]!, input: "" } } : previous;
      });
      submittedDrafts.current.delete(capture.draft.id);
    },
  });
  const actualSession = sessions.selectedSession;
  const session = actualSession ? handoff.bindingSessionFor(actualSession) : null;
  const savedRunId = session?.activeRunId ?? session?.latestRunId ?? null;
  const runId = savedRunId && RunIdSchema.safeParse(savedRunId).success ? savedRunId : null;
  const workspaceId = session?.workspaceId ?? sessions.workspaceSelection?.workspaceId ?? null;
  const captured = handoff.captureFor(session?.id ?? null, workspaceId ?? undefined);
  const pendingWelcome = handoff.captureFor(null);
  const creationRecovery = pendingWelcome?.phase === "creation-unconfirmed" ? pendingWelcome : null;
  const draftKey = draftKeyFor(session?.id ?? null, workspaceId);
  const initialSelection = captured?.selection ?? selections[draftKey];
  const workspaceClient = useMemo(() => binding && workspaceId
    ? createHostedDesktopClient({ ...binding, expectedWorkspaceId: workspaceId }, { clientVersion: build.version }) : null,
  [binding, workspaceId, build.version]);
  const provider = useDesktopHostedProviderSettings({ client: workspaceClient,
    binding: binding && workspaceId ? { ...binding, workspaceId,
      ...(runId ? { runId } : {}), ...(session ? { sessionId: session.id } : {}) } : null,
    enabled: Boolean(binding && workspaceId), initialSelection });
  const [sidebarOpen, setSidebarOpen] = useState(() => !window.matchMedia("(max-width: 1023px)").matches);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightWidth, setRightWidth] = useState(() => getInitialRightSidebarWidth(window.innerWidth));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settings, setSettings] = useState<"general" | "connect-only" | "manage-models-only" | null>(null);
  const [review, setReview] = useState<{ key: string; value: DesktopHostedReviewTurn } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const current = useRef({ active, accountKey, sessionId: session?.id ?? null, runId });
  current.current = { active, accountKey, sessionId: session?.id ?? null, runId };
  const viewKey = JSON.stringify([accountKey, workspaceId, session?.id, runId]);
  const selectedReview = review?.key === viewKey ? review.value : null;
  const projectName = session
    ? sessions.workspaceContext?.repository?.name ?? session.repository?.split("/").at(-1) ?? "Cloud project"
    : sessions.workspaceSelection?.workspaceName;
  const branch = session ? sessions.workspaceContext?.runBranch ?? sessions.workspaceContext?.selectedBranch ?? ""
    : sessions.workspaceSelection?.selectedBranch ?? "";
  const sidebarModel = useMemo(() => projectThreadSidebar({
    state: sessions.loading ? { status: "loading" } : { status: "ready" },
    workspaces: sessions.workspaces.map((item) => ({ workspaceId: null,
      workspaceSelectionId: item.workspace.id, label: item.workspace.name, placement: "hosted" as const })),
    threads: sessions.sessions.map((item) => ({
      selectionId: item.id, threadId: ThreadIdSchema.safeParse(item.threadId).success ? ThreadIdSchema.parse(item.threadId) : null,
      workspaceId: null, workspaceSelectionId: item.workspaceId ?? "hosted-projectless",
      title: item.title, updatedAt: item.updatedAt, pinnedAt: item.pinnedAt, archivedAt: item.archivedAt,
      displayStatus: item.status, isUnread: Boolean(item.lastTerminalTurnId && item.lastTerminalTurnId !== item.lastAcknowledgedTerminalTurnId),
    })), selectedSelectionId: session?.id ?? null,
  }), [sessions.loading, sessions.workspaces, sessions.sessions, session?.id]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const close = () => { if (query.matches) setSidebarOpen(false); };
    query.addEventListener("change", close);
    return () => query.removeEventListener("change", close);
  }, []);
  useEffect(() => { setSettings(null); setPickerOpen(false); setActionError(null); }, [accountKey]);
  const closeCompactSidebar = () => { if (window.matchMedia("(max-width: 1023px)").matches) setSidebarOpen(false); };
  const navigate = (operation: () => void) => {
    handoff.relinquishAutomaticHandoffOnNavigation();
    setActionError(null);
    closeCompactSidebar();
    operation();
  };
  const perform = async (operation: () => Promise<unknown>) => {
    const owner = accountKey;
    try { await operation(); }
    catch { if (current.current.accountKey === owner) setActionError("The cloud task change could not be confirmed. Reload before retrying."); }
  };
  const createNewChat = (selectedWorkspaceId?: string) => navigate(() => {
    if (selectedWorkspaceId && selectedWorkspaceId !== sessions.workspaceSelection?.workspaceId) {
      const item = sessions.workspaces.find((entry) => entry.workspace.id === selectedWorkspaceId);
      if (item) void perform(() => sessions.selectWorkspace({ repository: {
        owner: item.repository.owner, name: item.repository.name }, selectedBranch: item.workspace.lastSelectedBranch }));
    } else sessions.selectNewChat();
  });
  const openPicker = () => {
    if (!binding || sessions.pendingCreation || sessions.mutating) return;
    setPickerOpen(true);
  };
  const renderWorkspaceBar = () => <ComposerWorkspaceBar scopeKey={viewKey}
    project={{ label: projectName ?? "Choose project", onOpen: openPicker,
      unavailableReason: !binding ? "Connect your hosted account to choose a project."
        : sessions.pendingCreation ? "Confirm the pending task before changing projects." : undefined }}
    placement="cloud" placementOptions={[{ value: "local" }, { value: "cloud" }]}
    onPlacementChange={onPlacementChange}
    disabledReason={!active ? "This view is not active." : undefined} />;
  const draft = drafts[draftKey] ?? (captured && captured.phase !== "accepted" ? {
    input: captured.draft.prompt, mode: captured.draft.configuration.mode ?? "build",
    productMode: captured.draft.configuration.productMode ?? "ask_always",
    reasoningEffort: captured.draft.configuration.reasoningEffort,
  } : emptyDraft);
  const changeDraft = (patch: Partial<DesktopHostedComposerDraft>) => {
    draftRevisions.current.set(draftKey, (draftRevisions.current.get(draftKey) ?? 0) + 1);
    setDrafts((previous) => ({ ...previous, [draftKey]: { ...(previous[draftKey] ?? draft), ...patch } }));
  };
  const rememberDraft = (id: string) => submittedDrafts.current.set(id,
    { key: draftKey, revision: draftRevisions.current.get(draftKey) ?? 0 });
  const connectProvider = () => setSettings("connect-only");
  const manageModels = () => setSettings("manage-models-only");
  const metadataReads = useRef<{ owner: string | null; seen: Set<string> }>({ owner: accountKey, seen: new Set() });
  if (metadataReads.current.owner !== accountKey) metadataReads.current = { owner: accountKey, seen: new Set() };
  const observe = useCallback((controller: Parameters<typeof handoff.observe>[0] | null) => {
    if (!controller || !actualSession) return;
    handoff.observe(controller, actualSession);
    const projection = controller.activeProjection;
    if (!projection || projection.lastSequence === 0 || !controller.scope) return;
    const key = JSON.stringify([actualSession.id, controller.scope.turnId, Boolean(projection.terminal)]);
    if (metadataReads.current.owner !== accountKey || metadataReads.current.seen.has(key)) return;
    metadataReads.current.seen.add(key);
    void sessions.reload();
  }, [handoff.observe, actualSession, accountKey, sessions.reload]);

  return <>
    <ClientShell>
      <WorkspaceFrame className="desktop-workspace-frame" sidebarOpen={active && sidebarOpen}
        onSidebarOpenChange={setSidebarOpen}
        sidebar={<ThreadSidebar model={sidebarModel} visible={active && sidebarOpen} width={320}
          collapsibleProjects retainWorkspaceGroups mutationError={sessions.error ?? actionError}
          onSelect={(id) => navigate(() => sessions.selectSession(id))}
          onCreate={binding ? createNewChat : undefined}
          onAddWorkspace={binding ? openPicker : undefined}
          onRenameSession={async (id, title) => { await sessions.renameSession(id, title); }}
          onPin={(id) => perform(() => sessions.pinSession(id))}
          onUnpin={(id) => perform(() => sessions.unpinSession(id))}
          onArchive={(id) => perform(() => sessions.archiveSession(id))}
          onUnarchive={(id) => perform(() => sessions.unarchiveSession(id))}
          threadMutationUnavailableReason={() => !binding ? "Connect your hosted account first."
            : sessions.mutating ? "Wait for the current task change to finish." : undefined}
          pullRequestUnavailableReason="Pull request status has not been loaded."
          onOpenSettings={() => { closeCompactSidebar(); setSettings("general"); }}
          onClose={() => setSidebarOpen(false)} />}
        topBar={<WorkspaceTopBar title={session?.title ?? "New task"} actions={<>
          {active && session ? <EnvironmentSummaryMenu repo={branch ? { default_branch: branch } : null}
            branch={branch} readOnlyBranch changedFileCount={selectedReview?.files.length}
            onOpenChanges={() => setRightOpen(true)}
            pullRequestResult={{ status: "unavailable", sessionId: session.id }} /> : null}
          {!rightOpen ? <WorkspaceReviewControls onToggleRightSidebar={() => setRightOpen(true)} /> : null}
        </>} />}
        rightPanel={active && rightOpen ? <DesktopHostedRightPanel review={selectedReview}
          width={rightWidth} onClose={() => setRightOpen(false)}
          onResize={(delta) => setRightWidth((width) => clampRightSidebarWidth(width + delta))} /> : undefined}
        rightPanelWidth={rightWidth} rightPanelLabel="Saved cloud turn review">
        <WorkspaceSummaryLayout>
          {sessions.error || actionError ? <ChatErrorNotice message={actionError ?? sessions.error!}
            remediation="Your saved cloud tasks remain on the hosted service."
            actionLabel="Reload cloud tasks" onOpen={() => void sessions.reload()} /> : null}
          {creationRecovery?.error ? <ChatErrorNotice message={creationRecovery.error}
            remediation="Recover the same task creation before submitting its kept prompt."
            actionLabel="Retry unchanged task creation" onOpen={creationRecovery.retryable ? () => void handoff.retryCreation() : undefined} /> : null}
          {!session && pendingWelcome?.session && pendingWelcome.retryable ? <ChatErrorNotice
            message="Your kept message belongs to an existing cloud task."
            remediation="Open that task to send the unchanged message explicitly."
            actionLabel="Open kept task" onOpen={() => sessions.selectSession(pendingWelcome.session!.id)} /> : null}
          {captured?.error && captured.phase !== "creation-unconfirmed" ? <ChatErrorNotice message={captured.error}
            remediation="The unchanged message is retained. Confirm delivery before sending another prompt."
            actionLabel="Reload cloud tasks" onOpen={() => void sessions.reload()} /> : null}
          {binding && workspaceClient && session && runId ? <DesktopHostedConversation
            client={workspaceClient} binding={binding} session={session} runId={runId}
            inputQueueCustody={inputQueueCustody}
            active={active} projectName={projectName} onControllerReady={observe}
            onAcceptedDraft={(outgoing) => {
              if (current.current.accountKey !== accountKey) return;
              const source = submittedDrafts.current.get(outgoing.id);
              if (!source || (draftRevisions.current.get(source.key) ?? 0) !== source.revision) return;
              setDrafts((previous) => previous[source.key]?.input === outgoing.prompt
                ? { ...previous, [source.key]: { ...previous[source.key]!, input: "" } } : previous);
              submittedDrafts.current.delete(outgoing.id);
            }}
            onSessionRefresh={sessions.reload}
            onReviewTurn={(value) => {
              if (!current.current.active || current.current.accountKey !== accountKey || current.current.sessionId !== session.id || current.current.runId !== runId) return;
              setReview({ key: viewKey, value }); setRightOpen(true);
            }}
            renderComposer={({ layout, controller, approvalVisible, queuePanel, pendingDelivery, onFollowUpSubmit, canFollowUp }) => <>
              {queuePanel}
              {!controller.isSubmitting && captured?.retryable ? <ChatErrorNotice message={captured.phase === "waiting"
                ? "Your kept message is ready to send." : "The last message's delivery is not confirmed."}
                remediation="Retry only the unchanged message, or reload its saved status."
                actionLabel="Retry unchanged message" onOpen={() => void handoff.retryUnchanged(controller, session)} /> : null}
              <DesktopHostedComposer draft={draft} onDraftChange={changeDraft} controls={provider}
                scopeKey={viewKey} active={active} layout={layout} isHidden={approvalVisible}
                workspaceBar={layout === "hero" ? renderWorkspaceBar() : undefined}
                configurationLocked={Boolean(captured?.locked || controller.pendingDraft || pendingDelivery)}
                busy={controller.isSubmitting || controller.isStopping || controller.canStop} canStop={controller.canStop} onStop={controller.stop}
                onConnectProvider={connectProvider} onManageModels={manageModels}
                unavailableReason={pendingDelivery ? "Confirm the unchanged queued input before sending another."
                  : !controller.canSubmit && !canFollowUp ? "Read the current cloud task's saved status before sending." : undefined}
                onFollowUpSubmit={canFollowUp ? (outgoing, selection, delivery) => {
                  rememberDraft(outgoing.id);
                  return onFollowUpSubmit(outgoing, selection, delivery);
                } : undefined}
                onSubmit={(outgoing, selection) => {
                  rememberDraft(outgoing.id);
                  setSelections((previous) => ({ ...previous, [draftKey]: selection }));
                  return handoff.submit(controller, session, outgoing, selection);
                }} />
            </>} /> : <div className="flex min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6 sm:py-4">
            <ConversationHero projectName={projectName} showProjectChip={false} onProjectClick={openPicker}>
              {!binding ? <DesktopHostedAccount controls={account} /> : null}
              <DesktopHostedComposer draft={draft} onDraftChange={changeDraft} controls={provider}
                active={active} scopeKey={viewKey} layout="hero" workspaceBar={renderWorkspaceBar()}
                configurationLocked={sessions.pendingCreation} busy={sessions.mutating} canStop={false}
                onConnectProvider={connectProvider} onManageModels={manageModels}
                unavailableReason={!binding ? "Connect your hosted account before sending."
                  : session ? "This saved task needs a valid hosted run. Choose another task or start a new chat."
                  : !workspaceId ? "Choose a hosted project before sending."
                    : sessions.pendingCreation ? "Confirm the pending cloud task before sending again." : undefined}
                onSubmit={(outgoing, selection) => {
                  if (!workspaceId || session) return Promise.resolve(false);
                  rememberDraft(outgoing.id);
                  setSelections((previous) => ({ ...previous, [draftKey]: selection }));
                  return handoff.submitWelcome(outgoing, selection, workspaceId);
                }} />
            </ConversationHero>
          </div>}
        </WorkspaceSummaryLayout>
      </WorkspaceFrame>
    </ClientShell>
    {active && pickerOpen && metadataClient && binding ? <PickerModal>
      <AuthorizedRepositoryPicker accountId={binding.accountId} readPort={metadataClient}
        onManageGitHubAccess={() => { setPickerOpen(false); void account.perform("reauthorize"); }}
        onClose={() => setPickerOpen(false)} onRepoSelect={async (repo, selectedBranch) => {
          handoff.relinquishAutomaticHandoffOnNavigation();
          await sessions.selectWorkspace({ repository: { owner: repo.owner.login, name: repo.name }, selectedBranch });
          setPickerOpen(false);
          await sessions.reload();
        }} />
    </PickerModal> : null}
    <DesktopHostedSettingsDialog open={active && settings !== null} active={active}
      onClose={() => setSettings(null)} provider={provider.provider} hostedAccount={account}
      client={metadataClient} providerDialogVariant={settings === "general" ? null : settings}
      onSessionsChanged={sessions.reload} />
  </>;
}
