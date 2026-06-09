export const ALLOCATE_CANONICAL_EVENT_SEQUENCE_SQL = `
  INSERT INTO canonical_event_scope_sequences (
    scope_type,
    scope_id,
    next_sequence
  )
  VALUES ($1::text, $2::text, 2)
  ON CONFLICT (scope_type, scope_id)
  DO UPDATE SET
    next_sequence = canonical_event_scope_sequences.next_sequence + 1,
    updated_at = now()
  RETURNING next_sequence - 1 AS sequence
`;
