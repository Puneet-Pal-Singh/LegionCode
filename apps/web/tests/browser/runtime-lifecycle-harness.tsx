import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useTurnLifecycleProjection } from "../../src/hooks/useTurnLifecycleProjection";

const TURN_ID = "trn_run_browsergolden1";
const USER_PROMPT = "Make the deterministic browser golden edit";

function RuntimeLifecycleHarness() {
  const { projection, error } = useTurnLifecycleProjection(TURN_ID, true);
  const diffPaths = projection?.turnDiff?.files.map((file) => file.path) ?? [];

  return (
    <main>
      <p data-testid="user-prompt">{USER_PROMPT}</p>
      <p data-testid="last-sequence">{projection?.lastSequence ?? 0}</p>
      <p data-testid="error">{error ?? ""}</p>
      <p data-testid="thinking">
        {projection?.activeThinking ? "thinking" : "idle"}
      </p>
      {projection?.pendingApproval ? (
        <section data-testid="approval">
          <p>{projection.pendingApproval.question}</p>
          <p>{projection.pendingApproval.options.join(",")}</p>
        </section>
      ) : null}
      <section data-testid="workflow">
        {(projection?.items ?? []).map((item) => (
          <article
            data-testid={`item-${item.kind}`}
            key={item.itemId}
          >{`${item.kind}:${item.status}:${item.text}`}</article>
        ))}
      </section>
      <section data-testid="artifact-diff">{diffPaths.join("|")}</section>
      <section data-testid="review-diff">{diffPaths.join("|")}</section>
      <section data-testid="sidebar-diff">{diffPaths.join("|")}</section>
      <section data-testid="terminal">
        {projection?.terminal
          ? `${projection.terminal.state}:${projection.terminal.content}`
          : ""}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RuntimeLifecycleHarness />
  </StrictMode>,
);
