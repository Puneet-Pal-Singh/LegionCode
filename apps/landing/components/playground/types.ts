export type HeroDemoStep =
  | 'idle'
  | 'task-submitted'
  | 'planning'
  | 'exploring'
  | 'editing'
  | 'testing'
  | 'completed'
  | 'review';

export interface FileChange {
  name: string;
  added: number;
  removed: number;
}

export interface DiffLine {
  type: 'neutral' | 'addition' | 'deletion' | 'header';
  lineNum?: number;
  code: string;
}

export interface ToolStep {
  type: 'explore' | 'read' | 'search' | 'edit' | 'run';
  text: string;
  added?: number;
  removed?: number;
  status?: string;
}

export interface ChatMessage {
  sender: 'user' | 'agent';
  text: string;
  link?: { label: string; url: string };
}

export interface MockTask {
  id: string;
  title: string;
  repo: string;
  timeAgo: string;
  duration: string;
  userPrompt: string;
  agentAck: string;
  summary: string;
  fileName: string;
  changes: { added: number; removed: number };
  filesList: FileChange[];
  fileDiffs: Record<string, DiffLine[]>;
  diffLines?: DiffLine[];
  messages?: ChatMessage[];
  toolSteps?: ToolStep[];
}

