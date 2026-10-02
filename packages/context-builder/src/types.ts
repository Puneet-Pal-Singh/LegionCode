/**
 * Context Builder Types
 *
 * Core type definitions for the ContextBuilder service.
 * All types are strict and non-negotiable.
 */

// Import from workspace packages where available, otherwise define locally
import type { IntentClassification } from '@legioncode/intent-classifier';
import type { RepoSummary } from '@legioncode/repo-awareness';

/**
 * Input to ContextBuilder.build()
 */
export interface ContextBuilderInput {
  /** Current user message */
  userMessage: string;

  /** Pre-classified intent from IntentClassifier */
  intent: IntentClassification;

  /** Repo metadata from RepoScanner */
  repoSummary: RepoSummary;

  /** Chat history from current run (optional) */
  chatHistory?: ChatTurn[];

  /** Maximum tokens allowed for context (optional, defaults to 13500) */
  maxTokens?: number;

  /** Execution context for logging and tracking */
  cacheKey?: string;
}

/**
 * A single turn in the chat history
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}

/**
 * A normalized context block with priority and metadata
 */
export interface ContextBlock {
  /** Unique identifier for this block */
  id: string;

  /** Type of content in this block */
  type: ContextBlockType;

  /** Priority for truncation (0-10, higher = more important) */
  priority: number;

  /** Actual content */
  content: string;

  /** Estimated token count */
  tokenEstimate: number;

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Types of context blocks
 */
export type ContextBlockType =
  | 'REPO_SUMMARY'
  | 'FILE_LIST'
  | 'TESTS'
  | 'DIFFS'
  | 'CHAT';

/**
 * Intent-based strategy for context assembly
 */
export interface ContextStrategy {
  intent: string;
  includeRepoSummary: boolean;
  includeFileList: boolean;
  includeTests: boolean;
  includeDiffs: boolean;
  includeChat: boolean;
  chatDepth: number;
  blockPriorities: Record<ContextBlockType, number>;
}

/**
 * Token bucket for budget enforcement
 */
export interface TokenBucket {
  name: BucketType;
  limit: number;
  policy: 'REJECT' | 'DROP' | 'TRUNCATE';
  current: number;
}

/**
 * Types of token buckets
 */
export type BucketType =
  | 'SYSTEM'
  | 'USER'
  | 'REPO_SUMMARY'
  | 'CONTEXT_BLOCKS'
  | 'CHAT_HISTORY'
  | 'OPTIONAL';

/**
 * Detailed token usage report
 */
export interface TokenBudgetReport {
  totalUsed: number;
  perBucket: Record<BucketType, number>;
  droppedBlocks: string[];
  truncatedBlocks: string[];
  warnings: string[];
}

/**
 * Final output from ContextBuilder.build()
 */
export interface ContextBuilderOutput {
  systemPrompt: string;
  userPrompt: string;
  contextBlocks: ContextBlock[];
  tokenReport: TokenBudgetReport;
  metadata: {
    intent: string;
    strategyUsed: string;
    timestamp: number;
  };
}
