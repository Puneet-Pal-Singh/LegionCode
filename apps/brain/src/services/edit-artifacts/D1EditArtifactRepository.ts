import type { D1Database } from "@cloudflare/workers-types";
import type {
  CreateEditArtifactInput,
  EditArtifactEvent,
  EditArtifactRecord,
  EditArtifactStatus,
} from "@repo/shared-types";
import { EditArtifactReader } from "./EditArtifactReader";
import { type AppendArtifactEventInput } from "./EditArtifactRows";
import { EditArtifactWriter } from "./EditArtifactWriter";

export class D1EditArtifactRepository {
  private readonly reader: EditArtifactReader;
  private readonly writer: EditArtifactWriter;

  constructor(db: D1Database) {
    this.reader = new EditArtifactReader(db);
    this.writer = new EditArtifactWriter(db);
  }

  createPendingArtifact(
    input: CreateEditArtifactInput,
  ): Promise<EditArtifactRecord> {
    return this.writer.createPendingArtifact(input);
  }

  appendEvent(input: AppendArtifactEventInput): Promise<EditArtifactEvent> {
    return this.writer.appendEvent(input);
  }

  updateStatus(input: {
    artifactId: string;
    status: EditArtifactStatus;
    headCommitSha?: string | null;
  }): Promise<void> {
    return this.writer.updateStatus(input);
  }

  getLatestRestorableArtifact(
    runId: string,
  ): Promise<EditArtifactRecord | null> {
    return this.reader.getLatestRestorableArtifact(runId);
  }

  listExpiredArtifacts(now: string): Promise<EditArtifactRecord[]> {
    return this.reader.listExpiredArtifacts(now);
  }

  listStalePendingArtifacts(cutoff: string): Promise<EditArtifactRecord[]> {
    return this.reader.listStalePendingArtifacts(cutoff);
  }
}
