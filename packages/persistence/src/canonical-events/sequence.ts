export const ENSURE_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL = `
  INSERT INTO canonical_event_scope_sequences (scope_type, scope_id)
  VALUES ($1::text, $2::text)
  ON CONFLICT (scope_type, scope_id) DO NOTHING
`;

export const LOCK_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL = `
  SELECT next_sequence
  FROM canonical_event_scope_sequences
  WHERE scope_type = $1::text
    AND scope_id = $2::text
  FOR UPDATE
`;

export const ADVANCE_CANONICAL_EVENT_SCOPE_SEQUENCE_SQL = `
  UPDATE canonical_event_scope_sequences
  SET
    next_sequence = $3::bigint + 1,
    updated_at = now()
  WHERE scope_type = $1::text
    AND scope_id = $2::text
    AND next_sequence = $3::bigint
`;
