import { checkAccess } from "./accessdock-client.js";

const CLIPBOARD_ID = "main";
const DEFAULT_ACTION_TOKEN_SECONDS = 30 * 60;
const MAX_CONTENT_LENGTH = 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return handleHome(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/save") {
      return handleSave(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/clear") {
      return handleClear(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleHome(request, env) {
  const access = await checkAccess(request, env);
  if (!access.ok) return access.response;

  const item = await getClipboard(env);
  const actionToken = await createActionToken(env, {
    purpose: "clipboard:write",
    role: access.result?.role || "public",
  });

  return html(renderPage({
    content: item.content,
    updatedAt: item.updated_at,
    actionToken,
    authRole: access.result?.role || "public",
    actionTokenSeconds: getActionTokenSeconds(env),
  }));
}

async function handleSave(request, env) {
  const auth = await authorizeWrite(request, env);
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON body." }, 400);
  }

  const content = String(payload?.content ?? "");
  if (content.length > MAX_CONTENT_LENGTH) {
    return json({ ok: false, message: "Content is too large." }, 413);
  }

  const updatedAt = unix();
  await saveClipboard(env, content, updatedAt);
  return json({ ok: true, updatedAt, updatedText: formatTime(updatedAt), auth: auth.source });
}

async function handleClear(request, env) {
  const auth = await authorizeWrite(request, env);
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  const updatedAt = unix();
  await saveClipboard(env, "", updatedAt);
  return json({ ok: true, updatedAt, updatedText: formatTime(updatedAt), auth: auth.source });
}

async function authorizeWrite(request, env) {
  const access = await checkAccess(request, env, { resourcePath: "/" });
  if (access.ok && (access.result?.role === "admin" || access.result?.role === "access")) {
    return { ok: true, source: access.result.role };
  }

  const token = request.headers.get("x-clipboard-action-token") || "";
  const payload = await verifyActionToken(env, token);
  if (payload?.purpose === "clipboard:write") {
    return { ok: true, source: "action-token" };
  }

  return { ok: false, status: 401, message: "Authorization expired. Refresh the page and verify again." };
}

async function getClipboard(env) {
  const row = await env.CLIPBOARD_DB.prepare(
    "SELECT content, updated_at FROM clipboard_items WHERE id = ?",
  ).bind(CLIPBOARD_ID).first();

  return {
    content: row?.content || "",
    updated_at: Number(row?.updated_at || 0),
  };
}

async function saveClipboard(env, content, updatedAt) {
  await env.CLIPBOARD_DB.prepare(
    "INSERT INTO clipboard_items(id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
  ).bind(CLIPBOARD_ID, content, updatedAt).run();
}

async function createActionToken(env, payload) {
  const maxAge = getActionTokenSeconds(env);
  const body = {
    ...payload,
    iat: unix(),
    exp: unix() + maxAge,
    nonce: crypto.randomUUID(),
  };
  const encoded = base64UrlEncode(JSON.stringify(body));
  const signature = await sign(encoded, env);
  return `${encoded}.${signature}`;
}

async function verifyActionToken(env, token) {
  if (!token || !token.includes(".")) return null;
  const [encoded, signature] = token.split(".");
  const expected = await sign(encoded, env);
  if (!timingSafeEqual(signature || "", expected)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encoded));
  } catch {
    return null;
  }

  if (!payload.exp || unix() > payload.exp) return null;
  return payload;
}

async function sign(value, env) {
  const secret = env.ACTION_TOKEN_SECRET;
  if (!secret) throw new Error("Missing ACTION_TOKEN_SECRET");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bufferToBase64Url(signature);
}

function getActionTokenSeconds(env) {
  const value = Number(env.ACTION_TOKEN_SECONDS || DEFAULT_ACTION_TOKEN_SECONDS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ACTION_TOKEN_SECONDS;
}

function renderPage({ content, updatedAt, actionToken, authRole, actionTokenSeconds }) {
  const updatedText = updatedAt ? formatTime(updatedAt) : "尚未保存";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CloudFlare Clipboard</title>
<style>
:root {
  --bg: #f4f6f2;
  --panel: #fffdf7;
  --ink: #16211a;
  --muted: #667062;
  --line: #d9dfd1;
  --accent: #1f7a4d;
  --accent-strong: #145734;
  --danger: #b42318;
  --shadow: 0 18px 60px rgba(30, 45, 35, .10);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  background:
    linear-gradient(180deg, rgba(255, 253, 247, .88), rgba(244, 246, 242, .96)),
    repeating-linear-gradient(90deg, rgba(22, 33, 26, .035) 0 1px, transparent 1px 36px);
  color: var(--ink);
  font-family: ui-sans-serif, "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
}
.shell {
  width: min(1120px, calc(100% - 32px));
  min-height: 100vh;
  margin: 0 auto;
  padding: 28px 0;
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 18px;
}
.topbar {
  display: flex;
  justify-content: space-between;
  align-items: end;
  gap: 18px;
}
.eyebrow {
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: .08em;
  text-transform: uppercase;
}
h1 {
  margin: 0;
  font-size: clamp(28px, 4vw, 48px);
  line-height: 1;
  letter-spacing: 0;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
  color: var(--muted);
  font-size: 13px;
}
.pill {
  min-height: 30px;
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: rgba(255, 253, 247, .82);
  padding: 0 11px;
}
.workspace {
  min-height: 0;
  display: grid;
  grid-template-rows: 1fr auto;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: var(--shadow);
  overflow: hidden;
}
textarea {
  width: 100%;
  min-height: 58vh;
  resize: vertical;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  padding: 24px;
  font: 16px/1.65 ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
}
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 14px;
  border-top: 1px solid var(--line);
  background: rgba(250, 251, 245, .92);
  padding: 14px;
}
.status {
  min-height: 32px;
  display: inline-flex;
  align-items: center;
  color: var(--muted);
  font-size: 13px;
}
.actions {
  display: flex;
  gap: 10px;
}
button {
  height: 38px;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 0 14px;
  font: inherit;
  font-weight: 800;
  cursor: pointer;
}
.primary {
  background: var(--accent);
  color: #fff;
}
.primary:hover { background: var(--accent-strong); }
.secondary {
  border-color: #efc8c3;
  background: #fff;
  color: var(--danger);
}
button:disabled {
  opacity: .55;
  cursor: not-allowed;
}
@media (max-width: 680px) {
  .topbar, .toolbar { align-items: stretch; flex-direction: column; }
  .meta { justify-content: flex-start; }
  .actions { width: 100%; }
  button { flex: 1; }
  textarea { min-height: 62vh; padding: 18px; }
}
</style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="eyebrow">CloudFlare Clipboard</div>
        <h1>私有剪贴板</h1>
      </div>
      <div class="meta">
        <span class="pill">验证：${escapeHtml(authRole)}</span>
        <span class="pill">更新：<span id="updatedAt">${escapeHtml(updatedText)}</span></span>
        <span class="pill">页面令牌：${Math.round(actionTokenSeconds / 60)} 分钟</span>
      </div>
    </header>
    <section class="workspace">
      <textarea id="clipboard" spellcheck="false" placeholder="把需要临时保存的文字放在这里。">${escapeHtml(content)}</textarea>
      <div class="toolbar">
        <div id="status" class="status">准备就绪</div>
        <div class="actions">
          <button id="clearButton" class="secondary" type="button">清空</button>
          <button id="saveButton" class="primary" type="button">保存</button>
        </div>
      </div>
    </section>
  </main>
<script>
const actionToken = ${JSON.stringify(actionToken)};
const textarea = document.getElementById("clipboard");
const statusEl = document.getElementById("status");
const updatedAtEl = document.getElementById("updatedAt");
const saveButton = document.getElementById("saveButton");
const clearButton = document.getElementById("clearButton");

function setBusy(isBusy) {
  saveButton.disabled = isBusy;
  clearButton.disabled = isBusy;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "var(--danger)" : "var(--muted)";
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-clipboard-action-token": actionToken,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || "请求失败");
  return result;
}

saveButton.addEventListener("click", async () => {
  setBusy(true);
  setStatus("正在保存...");
  try {
    const result = await postJson("/api/save", { content: textarea.value });
    updatedAtEl.textContent = result.updatedText;
    setStatus("已保存");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener("click", async () => {
  if (!confirm("确认清空剪贴板内容？")) return;
  setBusy(true);
  setStatus("正在清空...");
  try {
    const result = await postJson("/api/clear", {});
    textarea.value = "";
    updatedAtEl.textContent = result.updatedText;
    setStatus("已清空");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
});
</script>
</body>
</html>`;
}

function html(content, status = 200) {
  return new Response(content, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value) {
  return new Date(Number(value) * 1000).toLocaleString("zh-CN", { hour12: false });
}

function unix() {
  return Math.floor(Date.now() / 1000);
}

function bufferToBase64Url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlEncode(value) {
  return btoa(unescape(encodeURIComponent(value))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeURIComponent(escape(atob(padded)));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
