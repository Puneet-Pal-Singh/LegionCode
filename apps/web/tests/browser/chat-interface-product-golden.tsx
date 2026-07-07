import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatInterface } from "../../src/components/chat/ChatInterface";

const TURN_ID = "trn_chatproduct_001";
const RUN_ID = "run_chatproduct_001";
const SESSION_ID = "session_product_001";

function ChatInterfaceProductGoldenHarness() {
  return (
    <ChatInterface
      chatProps={{
        messages: [
          {
            id: "user-1",
            role: "user",
            content: "Review the landing page hero section",
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "I have reviewed the landing page hero section.",
          },
        ],
        runId: RUN_ID,
        input: "",
        handleInputChange: () => {},
        handleSubmit: async () => true,
        append: async () => {},
        stop: () => {},
        isLoading: false,
        hasHydrated: true,
        error: null,
        debugEvents: [],
        serverTurnId: TURN_ID,
      }}
      sessionId={SESSION_ID}
      hasStartedSession
      mode="build"
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ChatInterfaceProductGoldenHarness />
  </StrictMode>,
);
