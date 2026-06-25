export interface FileChange {
  name: string;
  added: number;
  removed: number;
}

export interface DiffLine {
  type: 'neutral' | 'addition' | 'deletion';
  lineNum: number;
  code: string;
}

export interface MockTask {
  id: string;
  title: string;
  timeAgo: string;
  duration: string;
  message: string;
  fileName: string;
  changes: { added: number; removed: number };
  filesList?: FileChange[];
  diffLines: DiffLine[];
}
