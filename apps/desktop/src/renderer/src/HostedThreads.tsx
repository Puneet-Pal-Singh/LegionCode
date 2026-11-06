import { useEffect, useRef, useState } from "react";
import { MarkdownMessageContent } from "@legioncode/client-ui";
import {
  projectConversationHistoryMessages,
  readConversationHistory,
  type AppServerClient,
} from "@legioncode/sdk";
import type {
  ConversationHistoryMessage,
  HostedSession,
} from "@repo/platform-protocol";

/** Reads existing hosted identities; never creates a local mirror of a Web Thread. */
export function HostedThreads({
  client,
}: {
  client: AppServerClient;
}): React.JSX.Element {
  const [sessions, setSessions] = useState<HostedSession[]>([]);
  const [selected, setSelected] = useState<HostedSession | null>(null);
  const [history, setHistory] = useState<ConversationHistoryMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    void client
      .listSessions()
      .then((items) => {
        if (active) setSessions(items);
      })
      .catch(() => {
        if (active) setError("Cloud Threads could not be loaded.");
      });
    return () => {
      active = false;
      generation.current += 1;
    };
  }, [client]);

  async function open(item: HostedSession): Promise<void> {
    const requestGeneration = ++generation.current;
    setError(null);
    setSelected(item);
    setHistory([]);
    try {
      // Resolve the same saved session's owned workspace; do not use the current
      // local folder or silently switch its hosted execution binding.
      await client.getSessionWorkspaceContext(item.id);
      const result = await readConversationHistory<ConversationHistoryMessage>(
        (cursor, snapshot) => {
          if (requestGeneration !== generation.current)
            throw new Error("Thread selection changed");
          return client.getConversationHistoryPage({
            session: item.id,
            limit: 100,
            ...(cursor !== null && snapshot !== null
              ? { cursor, snapshot }
              : {}),
          });
        },
      );
      if (requestGeneration !== generation.current) return;
      setHistory(result.messages);
    } catch {
      if (requestGeneration === generation.current)
        setError("This cloud Thread could not be opened.");
    }
  }

  return (
    <section aria-label="Cloud Threads">
      <h2>Cloud Threads</h2>
      <p>Open a saved Thread from your Web account.</p>
      <ul>
        {sessions.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              aria-pressed={selected?.id === item.id}
              onClick={() => void open(item)}
            >
              {item.title}
            </button>
          </li>
        ))}
      </ul>
      {error ? <p role="alert">{error}</p> : null}
      {selected ? (
        <section aria-label="Saved cloud conversation">
          <h3>{selected.title}</h3>
          {projectConversationHistoryMessages(history).map((record) => (
            <article key={record.source.id}>
              <p>{record.source.role}</p>
              {record.parts.map((part, index) =>
                part.kind === "text" ? (
                  <MarkdownMessageContent
                    key={index}
                    content={part.text ?? ""}
                    isUser={record.source.role === "user"}
                  />
                ) : (
                  <details key={index}>
                    <summary>Saved message detail</summary>
                    <pre>{JSON.stringify(part.source, null, 2)}</pre>
                  </details>
                ),
              )}
            </article>
          ))}
        </section>
      ) : null}
    </section>
  );
}
