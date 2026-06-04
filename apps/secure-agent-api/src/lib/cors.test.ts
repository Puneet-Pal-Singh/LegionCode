import { describe, expect, it } from "vitest";
import { getCorsHeaders, handleCorsPreflight } from "./cors";

describe("secure-agent-api cors policy", () => {
  it("allows configured origin", () => {
    const request = new Request("https://api.shadowbox.dev/tools", {
      headers: { Origin: "https://app.shadowbox.dev" },
    });

    const headers = getCorsHeaders(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
    });

    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://app.shadowbox.dev",
    );
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
  });

  it("silently blocks non-allowlisted preflight origin", async () => {
    const request = new Request("https://api.shadowbox.dev/tools", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });

    const response = handleCorsPreflight(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
    });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(204);
    expect(response?.headers.get("Vary")).toBe("Origin");
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const body = await response?.text();
    expect(body).toBe("");
  });

  it("allows localhost only with explicit dev override", () => {
    const request = new Request("https://api.shadowbox.dev/tools", {
      headers: { Origin: "http://localhost:5173" },
    });

    const strictHeaders = getCorsHeaders(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
    });
    expect(strictHeaders["Access-Control-Allow-Origin"]).toBeUndefined();

    const devHeaders = getCorsHeaders(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
      CORS_ALLOW_DEV_ORIGINS: "true",
    });
    expect(devHeaders["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:5173",
    );
  });
});
