import { afterEach, expect, test, vi } from "vitest";
import { getAccountRow } from "../../src/lib/db/accounts.js";
import { getAuthConfig, setAuthToken } from "../../src/lib/db/auth.js";
import { setUserInfo } from "../../src/lib/db/user.js";
import {
  captureEnvTokenHost,
  resetEnvTokenHostForTesting,
} from "../../src/lib/env-token-host.js";
import { bootstrapAuthentication } from "../../src/lib/setup-code.js";
import { resetLoginTrustAnchorForTesting } from "../../src/lib/token-host.js";
import { useEnvSandbox, useTestConfigDir } from "../helpers.js";

useTestConfigDir("bootstrap-");
useEnvSandbox([
  "SENTRY_URL",
  "SENTRY_HOST",
  "SENTRY_SETUP_CODE",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_TOKEN",
  "SENTRY_FORCE_ENV_TOKEN",
  "SENTRY_CUSTOM_HEADERS",
]);
const host = "https://sentry.example.com";
const codeFor = (url: string) =>
  `sntryc_${Buffer.from(JSON.stringify({ url })).toString("base64")}_${"a".repeat(43)}`;
const token = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  user: { id: "42", name: "Example", email: "user@example.com" },
};

afterEach(() => {
  resetEnvTokenHostForTesting();
  resetLoginTrustAnchorForTesting();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("stores refreshable credentials and reports safe account identity", async () => {
  vi.stubEnv("SENTRY_SETUP_CODE", codeFor(host));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(token)));
  const result = await bootstrapAuthentication();
  expect(getAuthConfig()).toMatchObject({
    token: token.access_token,
    refreshToken: token.refresh_token,
  });
  expect(result.user?.id).toBe("42");
  expect(JSON.stringify(result)).not.toContain(token.access_token);
});

test.each([token.user, undefined])(
  "forced setup preserves other accounts and identities",
  async (user) => {
    const target = setAuthToken("old-target", undefined, undefined, { host });
    setUserInfo({ userId: "old-target-user" });
    const other = setAuthToken("other-token", undefined, undefined, {
      host: "https://other.example.com",
      newAccount: true,
    });
    setUserInfo({ userId: "other-user" });
    vi.stubEnv("SENTRY_HOST", "https://other.example.com");
    vi.stubEnv("SENTRY_SETUP_CODE", codeFor(host));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...token, user })),
    );
    await bootstrapAuthentication({ force: true, url: host });
    expect(getAccountRow(target)).toMatchObject({
      token: token.access_token,
      user_id: user?.id ?? null,
      is_active: 1,
    });
    expect(getAccountRow(other)).toMatchObject({
      token: "other-token",
      user_id: "other-user",
    });
  },
);

test.each([
  Response.json({ error: "invalid_grant" }, { status: 400 }),
  Response.json({ ...token, access_token: "" }),
])(
  "preserves an existing login when forced exchange fails",
  async (response) => {
    setAuthToken("existing-token", undefined, undefined, { host });
    vi.stubEnv("SENTRY_SETUP_CODE", codeFor(host));
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetch);
    await expect(bootstrapAuthentication({ force: true })).rejects.toThrow();
    expect(getAuthConfig()?.token).toBe("existing-token");
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("requires explicit consent before replacing stored authentication", async () => {
  setAuthToken("existing-token");
  vi.stubEnv("SENTRY_SETUP_CODE", codeFor(host));
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(bootstrapAuthentication()).rejects.toThrow(/--force/);
  expect(fetch).not.toHaveBeenCalled();
});

test("uses explicit proxy headers for a new server while preserving the old login on failure", async () => {
  setAuthToken("old-server-token", undefined, undefined, {
    host: "https://sentry.io",
  });
  vi.stubEnv("SENTRY_HOST", "https://sentry.io");
  captureEnvTokenHost();
  vi.stubEnv("SENTRY_CUSTOM_HEADERS", "X-IAP-Token: proxy-secret");
  vi.stubEnv("SENTRY_SETUP_CODE", codeFor(host));
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ error: "invalid_grant" }, { status: 400 }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    bootstrapAuthentication({ force: true, url: host }),
  ).rejects.toThrow(/Setup-code/);
  expect(fetch.mock.calls[0]![1].headers.get("X-IAP-Token")).toBe(
    "proxy-secret",
  );
  expect(getAuthConfig()?.token).toBe("old-server-token");
});

test("trusts the boot-time installer URL while rejecting post-boot HTTP URL changes", async () => {
  const local = "http://localhost:8000";
  vi.stubEnv("SENTRY_SETUP_CODE", codeFor(local));
  captureEnvTokenHost();
  vi.stubEnv("SENTRY_URL", local);
  const fetch = vi.fn().mockResolvedValue(Response.json(token));
  vi.stubGlobal("fetch", fetch);
  await expect(bootstrapAuthentication()).rejects.toThrow(/explicit --url/);
  await expect(bootstrapAuthentication({ url: host })).rejects.toThrow(
    /different Sentry instance/,
  );
  expect(fetch).not.toHaveBeenCalled();
  resetEnvTokenHostForTesting();
  captureEnvTokenHost();
  await bootstrapAuthentication();
  expect(fetch).toHaveBeenCalledTimes(1);
});
