export const DATABASE_MIGRATIONS_MODES = ["auto", "manual"] as const;

export type DatabaseMigrationsMode = (typeof DATABASE_MIGRATIONS_MODES)[number];

export interface HyperdriveConnectionBinding {
  connectionString?: string | null;
}

export interface WorkerDatabaseEnv {
  HYPERDRIVE?: HyperdriveConnectionBinding | null;
  DATABASE_MIGRATIONS_MODE?: string | null;
}

export interface WorkerDatabaseConfig {
  connectionString: string;
  migrationsMode: DatabaseMigrationsMode;
}

export class DatabaseConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export function readWorkerDatabaseConfig(
  env: WorkerDatabaseEnv,
): WorkerDatabaseConfig {
  const connectionString = env.HYPERDRIVE?.connectionString?.trim();
  if (!connectionString) {
    throw new DatabaseConfigurationError(
      "HYPERDRIVE binding is required for Postgres persistence",
      "HYPERDRIVE_BINDING_MISSING",
    );
  }

  return {
    connectionString,
    migrationsMode: readDatabaseMigrationsMode(env.DATABASE_MIGRATIONS_MODE),
  };
}

export function readDatabaseMigrationsMode(
  value: string | null | undefined,
): DatabaseMigrationsMode {
  const normalized = value === null ? null : value?.trim();

  if (normalized === undefined || normalized === null || normalized === "") {
    return "manual";
  }

  if (isDatabaseMigrationsMode(normalized)) {
    return normalized;
  }

  throw new DatabaseConfigurationError(
    `Invalid DATABASE_MIGRATIONS_MODE value: ${value}`,
    "DATABASE_MIGRATIONS_MODE_INVALID",
  );
}

function isDatabaseMigrationsMode(
  value: string,
): value is DatabaseMigrationsMode {
  return DATABASE_MIGRATIONS_MODES.includes(value as DatabaseMigrationsMode);
}
