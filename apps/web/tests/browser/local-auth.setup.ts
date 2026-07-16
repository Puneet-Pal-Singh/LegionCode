import { request } from "@playwright/test";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

export const LOCAL_AUTH_STATE_PATH = `${tmpdir()}/shadowbox-039-local-auth-state.json`;

export default async function localAuthSetup(): Promise<void> {
  if (process.env.SHADOWBOX_LOCAL_AUTH_FIXTURE !== "1") {
    return;
  }

  const baseURL =
    process.env.VITE_BRAIN_BASE_URL ?? "http://127.0.0.1:8788";
  const context = await request.newContext({ baseURL });
  try {
    const response = await context.post("/auth/local-test/session", {
      headers: { "X-Shadowbox-Local-Auth": "1" },
    });
    if (!response.ok()) {
      throw new Error(
        `Local auth fixture failed with HTTP ${response.status()}.`,
      );
    }

    const body = (await response.json()) as { authenticated?: boolean };
    if (body.authenticated !== true) {
      throw new Error("Local auth fixture did not create an authenticated session.");
    }

    await mkdir(dirname(LOCAL_AUTH_STATE_PATH), { recursive: true });
    await context.storageState({ path: LOCAL_AUTH_STATE_PATH });
  } finally {
    await context.dispose();
  }
}
