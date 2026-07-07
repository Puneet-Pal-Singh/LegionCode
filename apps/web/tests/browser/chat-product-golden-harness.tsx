import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { useTurnLifecycleProjection } from "../../src/hooks/useTurnLifecycleProjection";

const TURN_ID = "trn_productgolden_001";

function ChatProductGoldenHarness() {
  const { projection, error } = useTurnLifecycleProjection(TURN_ID, true);
  const terminal = projection?.terminal;
  const thinking = projection?.activeThinking ?? false;
  const items = projection?.items ?? [];
  const diffFiles = projection?.turnDiff?.files ?? [];
  const pendingApproval = projection?.pendingApproval;

  return (
    <main>
      <p data-testid="turn-id">{projection?.turnId ?? "pending"}</p>
      <p data-testid="thinking-active">{thinking ? "yes" : "no"}</p>
      <p data-testid="error-text">{error ?? ""}</p>
      {pendingApproval ? (
        <section data-testid="chat-approval">
          <p>{pendingApproval.question}</p>
        </section>
      ) : null}
      <section data-testid="chat-workflow">
        {items.map((item) => (
          <article
            data-testid={`item-${item.kind}`}
            key={item.itemId}
          >{`${item.kind}:${item.status}`}</article>
        ))}
      </section>
      <section data-testid="chat-diff-files">
        {diffFiles.map((file) => (
          <span key={file.path} data-testid="diff-file">
            {file.path}
          </span>
        ))}
      </section>
      <section data-testid="chat-terminal">
        {terminal
          ? `${terminal.state}:completed`
          : thinking
            ? "active"
            : "idle"}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatProductGoldenHarness />
  </StrictMode>,
);
