# @legioncode/repo-awareness

Lightweight repository structure awareness without loading file contents.

Provides deterministic scanning and classification of repository files to enable smarter context selection and massive token savings.

## Features

- **Cheap**: Metadata-only scanning, no file contents loaded
- **Deterministic**: Same repo → identical output every scan
- **Fast**: Scan 1000+ files in < 1 second
- **Composable**: Returns structured data ready for ContextBuilder integration

## Installation

```bash
pnpm add @legioncode/repo-awareness
```

## Usage

### Basic Scan

```typescript
import { scanRepo } from "@legioncode/repo-awareness";

const summary = await scanRepo({
  rootPath: "/path/to/repo",
});

console.log(summary.totalFiles); // 214
console.log(summary.entryPoints); // [RepoFileMeta, ...]
```

### Advanced Usage

```typescript
import {
  RepoScanner,
  RepoIndexBuilder,
  RepoSummaryFormatter,
  FileClassifier,
} from "@legioncode/repo-awareness";

// 1. Scan
const scanner = new RepoScanner({
  rootPath: "/path/to/repo",
  respectGitignore: true,
  calculateLoc: false,
});
const files = await scanner.scan();

// 2. Build index
const builder = new RepoIndexBuilder(files, "/path/to/repo");
const summary = builder.build();

// 3. Format output
const text = RepoSummaryFormatter.formatText(summary);
console.log(text);
```

### File Classification

```typescript
import { FileClassifier } from "@legioncode/repo-awareness";

const kind = FileClassifier.classify("src/main.ts");
// → FileKind.SOURCE

const isEntry = FileClassifier.isEntryPoint("src/index.ts");
// → true
```

### Importance Scoring

```typescript
import { ImportanceScorer } from "@legioncode/repo-awareness";
import type { RepoFileMeta } from "@legioncode/repo-awareness";
import { FileKind } from "@legioncode/repo-awareness";

const fileMeta: RepoFileMeta = {
  path: "src/index.ts",
  ext: "ts",
  size: 156,
  loc: 156,
  kind: FileKind.SOURCE,
  importance: 0,
};

const score = ImportanceScorer.score(fileMeta);
// → 0.95 (high importance for entry point)
```

## API

### scanRepo(options)

Convenience function: scan repo and get summary.

```typescript
async function scanRepo(options: ScanOptions): Promise<RepoSummary>
```

### RepoScanner

Walks file system and collects metadata.

```typescript
import { RepoScanner } from "@legioncode/repo-awareness";
import type { ScanOptions } from "@legioncode/repo-awareness";

const options: ScanOptions = {
  rootPath: "/path/to/repo",
  respectGitignore: true,
  calculateLoc: false,
};

const scanner = new RepoScanner(options);
const files = await scanner.scan();
```

### FileClassifier

Classifies files by path and extension.

```typescript
const kind = FileClassifier.classify(path);
const isEntry = FileClassifier.isEntryPoint(path);
```

### ImportanceScorer

Assigns importance scores (0-1).

```typescript
const score = ImportanceScorer.score(fileMeta);
```

### RepoIndexBuilder

Aggregates files into RepoSummary.

```typescript
const builder = new RepoIndexBuilder(files, rootPath);
const summary = builder.build();
```

### RepoSummaryFormatter

Serializes to text/JSON.

```typescript
const text = RepoSummaryFormatter.formatText(summary);
const json = RepoSummaryFormatter.formatJson(summary);
const debug = RepoSummaryFormatter.formatDebug(summary);
```

## Types

```typescript
enum FileKind {
  SOURCE = "SOURCE",
  TEST = "TEST",
  DOC = "DOC",
  CONFIG = "CONFIG",
  DB = "DB",
  TOOLING = "TOOLING",
  OTHER = "OTHER",
}

interface RepoFileMeta {
  path: string;
  ext: string;
  size: number;
  loc?: number;
  kind: FileKind;
  importance: number;
  lastModified?: string;
}

interface RepoSummary {
  rootPath: string;
  scannedAt: string;
  totalFiles: number;
  byKind: Record<FileKind, number>;
  largestFiles: RepoFileMeta[];
  entryPoints: RepoFileMeta[];
  importantFiles: RepoFileMeta[];
  allFiles: RepoFileMeta[];
}
```

## Philosophy

- **No file contents**: Only metadata (size, mtime, path)
- **Deterministic**: Same repo → identical output
- **Cheap**: Fast scanning, minimal memory
- **Composable**: Plugs into ContextBuilder and other systems

## License

Private - LegionCode project
