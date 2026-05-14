import { defineConfig } from "drizzle-kit";

const DEFAULT_LOCAL_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/shadowbox";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    // Local fallback only. CI/prod migration runners should set DATABASE_URL.
    url: process.env.DATABASE_URL ?? DEFAULT_LOCAL_DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
