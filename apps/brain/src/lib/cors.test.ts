import { describe, expect, it } from "vitest";
import { getCorsHeaders, handleOptions } from "./cors";

describe("brain cors policy", () => {
  it("allows configured origins", () => {
    const request = new Request("https://brain.test/chat", {
      headers: { Origin: "https://app.shadowbox.dev" },
    });

    const headers = getCorsHeaders(request, {
      CORS_ALLOWED_ORIGINS:
        "https://app.shadowbox.dev,https://staging.shadowbox.dev",
    });

    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://app.shadowbox.dev",
    );
    expect(headers["Access-Control-Allow-Credentials"]).toBe("true");
    expect(headers["Access-Control-Allow-Headers"]).toContain("X-Run-Id");
    expect(headers["Access-Control-Allow-Methods"]).toContain("PATCH");
  });

  it("silently blocks non-allowlisted origin on preflight", async () => {
    const request = new Request("https://brain.test/chat", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });

    const response = handleOptions(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
    });

    expect(response).not.toBeNull();
    expect(response?.status).toBe(204);
    expect(response?.headers.get("Vary")).toBe("Origin");
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response?.text()).toBe("");
  });

  it("allows localhost origins only when explicit dev override is enabled", () => {
    const request = new Request("https://brain.test/chat", {
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

  it("allows localhost origin by default when Brain request host is localhost", () => {
    const request = new Request("http://localhost:8788/chat", {
      headers: { Origin: "http://localhost:5173" },
    });

    const headers = getCorsHeaders(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("allows IPv6 loopback origin by default when Brain request host is IPv6 loopback", () => {
    const request = new Request("http://[::1]:8788/chat", {
      headers: { Origin: "http://[::1]:5173" },
    });

    const headers = getCorsHeaders(request, {
      CORS_ALLOWED_ORIGINS: "https://app.shadowbox.dev",
    });
    expect(headers["Access-Control-Allow-Origin"]).toBe("http://[::1]:5173");
  });
});
