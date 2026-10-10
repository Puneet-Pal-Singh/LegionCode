import { useEffect, useRef, useState, useCallback } from "react";
import type { Message } from "@ai-sdk/react";
import { ArtifactService } from "../services/ArtifactService";
import type { ArtifactState, ArtifactData } from "../types/chat";

interface UseChatArtifactsProps {
  messages: Message[];
  onFileCreated?: () => void;
}

/**
 * useChatArtifacts
 * Manages artifact state and tool call processing
 * Single Responsibility: Only manage artifact lifecycle
 */
export function useChatArtifacts({
  messages,
  onFileCreated,
}: UseChatArtifactsProps): ArtifactState {
  const artifactServiceRef = useRef(new ArtifactService(onFileCreated));
  const [artifact, setArtifactState] = useState<ArtifactData | null>(null);
  const [isArtifactOpen, setIsArtifactOpenState] = useState(false);

  useEffect(() => {
    artifactServiceRef.current.setOnArtifactCreatedCallback(onFileCreated);
  }, [onFileCreated]);

  // Process tool calls from messages
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    if (
      lastMessage.toolInvocations &&
      Array.isArray(lastMessage.toolInvocations)
    ) {
      for (const invocation of lastMessage.toolInvocations) {
        if ("toolName" in invocation && "args" in invocation) {
          artifactServiceRef.current.processToolCall(
            invocation.toolName as string,
            invocation.args as Record<string, unknown>,
          );
          // Sync service state to React state
          const newArtifact = artifactServiceRef.current.getArtifact();
          if (newArtifact) {
            setArtifactState(newArtifact);
          }
        }
      }
    }
  }, [messages]);

  const setArtifact = useCallback((newArtifact: ArtifactData | null) => {
    artifactServiceRef.current.setArtifact(newArtifact);
    setArtifactState(newArtifact);
  }, []);

  const setIsArtifactOpen = useCallback((isOpen: boolean) => {
    artifactServiceRef.current.setIsOpen(isOpen);
    setIsArtifactOpenState(isOpen);
  }, []);

  return {
    artifact,
    setArtifact,
    isArtifactOpen,
    setIsArtifactOpen,
  };
}
