import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

function createMockDb() {
  const store = new Map();
  store.set("tab_1", { content: "便签1内容", updated_at: 1700000000 });
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("FROM clipboard_items WHERE id = ?")) {
                const row = store.get(args[0]);
                return row || null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO clipboard_items")) {
                store.set(args[0], { content: args[1], updated_at: args[2] });
              }
              return { success: true };
            },
          };
        },
      };
    },
  };
}

function createEnv(overrides = {}) {
  return {
    ACCESSDOCK_BASE_URL: "https://auth.example.com",
    ACTION_TOKEN_SECRET: "test-secret-key-12345",
    CLIPBOARD_DB: createMockDb(),
    ACCESSDOCK: {
      async fetch() {
        // Simulates unauthenticated or expired cookie check returning 401 redirect
        return Response.json(
          { allowed: false, protected: true, loginUrl: "https://auth.example.com/login", reason: "login_required" },
          { status: 401 },
        );
      },
    },
    ...overrides,
  };
}

test("GET /api/tab returns 401 JSON (not 302 redirect) when unauthorized", async () => {
  const env = createEnv();
  const res = await worker.fetch(new Request("https://ps.example.com/api/tab?id=tab_1"), env);

  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.match(json.message, /授权/);
});

test("GET /api/tab succeeds with x-clipboard-action-token even when AccessDock cookie check fails", async () => {
  const env = createEnv();

  // First fetch home page with AccessDock allowed to get actionToken
  const homeEnv = createEnv({
    ACCESSDOCK: {
      async fetch() {
        return Response.json({ allowed: true, protected: true, role: "admin" });
      },
    },
  });
  const homeRes = await worker.fetch(new Request("https://ps.example.com/"), homeEnv);
  assert.equal(homeRes.status, 200);
  const html = await homeRes.text();
  const tokenMatch = html.match(/const actionToken = "([^"]+)";/);
  assert.ok(tokenMatch, "actionToken should be present in page HTML");
  const actionToken = tokenMatch[1];

  // Now simulate mobile tab switch where AccessDock session cookie fails
  const tabRes = await worker.fetch(
    new Request("https://ps.example.com/api/tab?id=tab_1", {
      headers: { "x-clipboard-action-token": actionToken },
    }),
    env,
  );

  assert.equal(tabRes.status, 200);
  const data = await tabRes.json();
  assert.equal(data.ok, true);
  assert.equal(data.id, "tab_1");
  assert.equal(data.content, "便签1内容");
});
