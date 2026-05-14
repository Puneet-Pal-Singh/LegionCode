import { describe, expect, it } from "vitest";
import {
  DatabaseConfigurationError,
  readDatabaseMigrationsMode,
  readWorkerDatabaseConfig,
} from "./database.js";

describe("database configuration", () => {
  it("reads Hyperdrive connection details for Worker runtime traffic", () => {
    expect(
      readWorkerDatabaseConfig({
        HYPERDRIVE: {
          connectionString:
            " postgres://postgres:postgres@localhost:5432/shadowbox ",
        },
        DATABASE_MIGRATIONS_MODE: "auto",
      }),
    ).toEqual({
      connectionString: "postgres://postgres:postgres@localhost:5432/shadowbox",
      migrationsMode: "auto",
    });
  });

  it("defaults migration mode to manual", () => {
    expect(readDatabaseMigrationsMode(undefined)).toBe("manual");
  });

  it("rejects missing Hyperdrive binding", () => {
    expect(() => readWorkerDatabaseConfig({})).toThrow(
      DatabaseConfigurationError,
    );
  });

  it("rejects invalid migration modes", () => {
    expect(() => readDatabaseMigrationsMode("sometimes")).toThrow(
      "Invalid DATABASE_MIGRATIONS_MODE value: sometimes",
    );
  });
});
