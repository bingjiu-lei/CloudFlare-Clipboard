import assert from "node:assert/strict";
import test from "node:test";

import { checkAccess } from "../src/accessdock-client.js";

const protectedRequest = new Request("https://ps.example.com/");

test("uses the ACCESSDOCK service binding when configured", async () => {
  let bindingCalled = false;
  const env = {
    ACCESSDOCK_BASE_URL: "https://auth.example.com",
    ACCESSDOCK: {
      async fetch() {
        bindingCalled = true;
        return Response.json({ allowed: true, protected: true, role: "admin" });
      },
    },
  };

  const result = await checkAccess(protectedRequest, env);

  assert.equal(bindingCalled, true);
  assert.equal(result.ok, true);
  assert.equal(result.result.role, "admin");
});

test("falls back to public fetch when no service binding exists", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    Response.json({ allowed: true, protected: false });

  const result = await checkAccess(protectedRequest, {
    ACCESSDOCK_BASE_URL: "https://auth.example.com",
  });

  assert.equal(result.ok, true);
});

test("accepts AccessDock's 401 login response", async () => {
  const loginUrl =
    "https://auth.example.com/login?return=https%3A%2F%2Fps.example.com%2F";
  const env = {
    ACCESSDOCK_BASE_URL: "https://auth.example.com",
    ACCESSDOCK: {
      async fetch() {
        return Response.json(
          { allowed: false, protected: true, loginUrl, reason: "login_required" },
          { status: 401 },
        );
      },
    },
  };

  const result = await checkAccess(protectedRequest, env);

  assert.equal(result.ok, false);
  assert.equal(result.response.status, 302);
  assert.equal(result.response.headers.get("location"), loginUrl);
});
