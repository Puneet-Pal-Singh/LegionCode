import type { SqlClient } from "../sql.js";
export interface CredentialDefaultScope {
  readonly userId: string;
  readonly providerId: string;
}
export type CredentialDefaultWriteResult<T> =
  | { readonly status: "applied"; readonly value: T }
  | { readonly status: "conflict" };
/** This is default-slot metadata, not secret custody or a replacement credential store. */
export class PostgresCredentialDefaultFence {
  constructor(private readonly client: SqlClient) {}
  /** Capture BEFORE asynchronous encryption. Does not advance a live ownership epoch. */
  async capture(scope: CredentialDefaultScope): Promise<number> {
    validate(scope);
    const result = await this.client.query<{ generation: string | number }>(
      `INSERT INTO provider_credential_default_epochs(user_id,provider_id)
      VALUES ($1,$2) ON CONFLICT (user_id,provider_id) DO UPDATE
      SET generation=provider_credential_default_epochs.generation RETURNING generation`,
      [scope.userId, scope.providerId],
    );
    return generation(result.rows[0]?.generation);
  }
  /** Callback MUST use the supplied tx for its final credential insert/update.
   * Do encryption/provider work before this transaction, never inside callback. */
  async commitIfCurrent<T>(
    scope: CredentialDefaultScope,
    expectedGeneration: number,
    write: (tx: SqlClient) => Promise<T>,
  ): Promise<CredentialDefaultWriteResult<T>> {
    validate(scope);
    generation(expectedGeneration);
    return this.client.transaction(async (tx) => {
      const result = await tx.query<{ generation: string | number }>(
        "SELECT generation FROM provider_credential_default_epochs WHERE user_id=$1 AND provider_id=$2 FOR UPDATE",
        [scope.userId, scope.providerId],
      );
      if (
        !result.rows[0] ||
        generation(result.rows[0].generation) !== expectedGeneration
      )
        return { status: "conflict" };
      return { status: "applied", value: await write(tx) };
    });
  }
  /** Always advance, even if no credential row exists; revoke uses this SAME tx. */
  async advance<T>(
    scope: CredentialDefaultScope,
    revoke: (tx: SqlClient) => Promise<T>,
  ): Promise<{ generation: number; value: T }> {
    validate(scope);
    return this.client.transaction(async (tx) => {
      const result = await tx.query<{ generation: string | number }>(
        `INSERT INTO provider_credential_default_epochs(user_id,provider_id,generation)
        VALUES ($1,$2,2) ON CONFLICT (user_id,provider_id) DO UPDATE
        SET generation=provider_credential_default_epochs.generation+1,updated_at=now() RETURNING generation`,
        [scope.userId, scope.providerId],
      );
      const next = generation(result.rows[0]?.generation);
      return { generation: next, value: await revoke(tx) };
    });
  }
}
function validate(scope: CredentialDefaultScope): void {
  if (
    typeof scope.userId !== "string" ||
    scope.userId.length === 0 ||
    scope.userId.length > 256 ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(scope.providerId)
  )
    throw new Error("Invalid credential default scope");
}
function generation(value: string | number | undefined): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1)
    throw new Error("Invalid credential default generation");
  return result;
}
