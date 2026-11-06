import type { SqlMigration } from "./types.js";
export const harnessRecoveryReplyClaimsMigration:SqlMigration={id:"0039_harness_recovery_reply_claims",description:"Private recovery facts tied to canonical ingress receipts and single-use reply claims",statements:[
`ALTER TABLE harness_observation_receipts ADD COLUMN recovery_observation_json JSONB`,
`CREATE TABLE harness_reply_claims(turn_id TEXT NOT NULL,process_generation TEXT NOT NULL,request_sequence BIGINT NOT NULL,origin_json JSONB NOT NULL,claimed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(turn_id,process_generation,request_sequence),FOREIGN KEY(turn_id,process_generation,request_sequence) REFERENCES harness_observation_receipts(turn_id,process_generation,sequence) ON DELETE CASCADE)`,
]};
