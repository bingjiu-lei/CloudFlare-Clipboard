import { checkAccess } from "./accessdock-client.js";

const CLIPBOARD_ID = "main";
const TABS_META_ID = "_tabs_meta";
const DEFAULT_TABS = [{ id: "main", title: "默认便签" }];
const DEFAULT_ACTION_TOKEN_SECONDS = 30 * 60;
const MAX_CONTENT_LENGTH = 1024 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return handleHome(request, env);
    }

    if (request.method === "GET" && url.pathname === "/api/tab") {
      return handleGetTab(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/save") {
      return handleSave(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/clear") {
      return handleClear(request, env);
    }

    if (request.method === "POST" && url.pathname === "/api/tabs") {
      return handleTabsAction(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

async function handleHome(request, env) {
  const access = await checkAccess(request, env);
  if (!access.ok) return access.response;

  const tabs = await getTabsMeta(env);
  const activeTabId = tabs[0]?.id || CLIPBOARD_ID;
  const item = await getClipboard(env, activeTabId);
  const actionToken = await createActionToken(env, {
    purpose: "clipboard:write",
    role: access.result?.role || "public",
  });

  return html(renderPage({
    tabs,
    activeTabId,
    content: item.content,
    updatedAt: item.updated_at,
    actionToken,
    authRole: access.result?.role || "public",
    actionTokenSeconds: getActionTokenSeconds(env),
  }));
}

async function handleGetTab(request, env) {
  const access = await checkAccess(request, env, { resourcePath: "/" });
  if (!access.ok) return access.response;

  const url = new URL(request.url);
  const id = url.searchParams.get("id") || CLIPBOARD_ID;
  const item = await getClipboard(env, id);
  return json({
    ok: true,
    id,
    content: item.content,
    updatedAt: item.updated_at,
    updatedText: item.updated_at ? formatTime(item.updated_at) : "尚未保存",
  });
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

  const id = String(payload?.id || CLIPBOARD_ID).trim() || CLIPBOARD_ID;
  const content = String(payload?.content ?? "");
  if (content.length > MAX_CONTENT_LENGTH) {
    return json({ ok: false, message: "Content is too large." }, 413);
  }

  const updatedAt = unix();
  await saveClipboard(env, content, updatedAt, id);
  return json({ ok: true, id, updatedAt, updatedText: formatTime(updatedAt), auth: auth.source });
}

async function handleClear(request, env) {
  const auth = await authorizeWrite(request, env);
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  let payload = {};
  try {
    payload = await request.json();
  } catch {}

  const id = String(payload?.id || CLIPBOARD_ID).trim() || CLIPBOARD_ID;
  const updatedAt = unix();
  await saveClipboard(env, "", updatedAt, id);
  return json({ ok: true, id, updatedAt, updatedText: formatTime(updatedAt), auth: auth.source });
}

async function handleTabsAction(request, env) {
  const auth = await authorizeWrite(request, env);
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON body." }, 400);
  }

  const action = payload?.action;
  let tabs = await getTabsMeta(env);

  if (action === "create") {
    const title = String(payload?.title || `便签 ${tabs.length + 1}`).trim().slice(0, 30) || `便签 ${tabs.length + 1}`;
    const newId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    tabs.push({ id: newId, title });
    await saveTabsMeta(env, tabs);
    return json({ ok: true, tab: { id: newId, title }, tabs });
  }

  if (action === "rename") {
    const id = String(payload?.id || "");
    const title = String(payload?.title || "").trim().slice(0, 30);
    if (!id || !title) return json({ ok: false, message: "Invalid id or title" }, 400);
    tabs = tabs.map(t => (t.id === id ? { ...t, title } : t));
    await saveTabsMeta(env, tabs);
    return json({ ok: true, tabs });
  }

  if (action === "delete") {
    const id = String(payload?.id || "");
    if (!id || id === CLIPBOARD_ID) {
      return json({ ok: false, message: "无法删除默认主便签" }, 400);
    }
    tabs = tabs.filter(t => t.id !== id);
    if (tabs.length === 0) tabs = DEFAULT_TABS;
    await saveTabsMeta(env, tabs);
    await deleteClipboard(env, id);
    return json({ ok: true, tabs });
  }

  return json({ ok: false, message: "Unknown action" }, 400);
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

async function getTabsMeta(env) {
  try {
    const row = await env.CLIPBOARD_DB.prepare(
      "SELECT content FROM clipboard_items WHERE id = ?",
    ).bind(TABS_META_ID).first();

    if (!row?.content) return DEFAULT_TABS;
    const parsed = JSON.parse(row.content);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {}
  return DEFAULT_TABS;
}

async function saveTabsMeta(env, tabs) {
  const content = JSON.stringify(tabs);
  const updatedAt = unix();
  await env.CLIPBOARD_DB.prepare(
    "INSERT INTO clipboard_items(id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
  ).bind(TABS_META_ID, content, updatedAt).run();
}

async function getClipboard(env, id = CLIPBOARD_ID) {
  const row = await env.CLIPBOARD_DB.prepare(
    "SELECT content, updated_at FROM clipboard_items WHERE id = ?",
  ).bind(id).first();

  return {
    content: row?.content || "",
    updated_at: Number(row?.updated_at || 0),
  };
}

async function saveClipboard(env, content, updatedAt, id = CLIPBOARD_ID) {
  await env.CLIPBOARD_DB.prepare(
    "INSERT INTO clipboard_items(id, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at",
  ).bind(id, content, updatedAt).run();
}

async function deleteClipboard(env, id) {
  await env.CLIPBOARD_DB.prepare(
    "DELETE FROM clipboard_items WHERE id = ?",
  ).bind(id).run();
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

function renderPage({ tabs, activeTabId, content, updatedAt, actionToken, authRole, actionTokenSeconds }) {
  const updatedText = updatedAt ? formatTime(updatedAt) : "尚未保存";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clipboard</title>
<style>
:root {
  --bg: #f8fafc;
  --bg-pattern: radial-gradient(rgba(15, 23, 42, 0.06) 1px, transparent 1px);
  --panel: #ffffff;
  --panel-hover: #f1f5f9;
  --ink: #0f172a;
  --ink-secondary: #334155;
  --muted: #64748b;
  --subtle: #94a3b8;
  --line: #e2e8f0;
  --line-strong: #cbd5e1;
  --accent: #059669;
  --accent-hover: #047857;
  --accent-active: #065f46;
  --accent-light: #ecfdf5;
  --accent-border: #a7f3d0;
  --danger: #e11d48;
  --danger-hover: #be123c;
  --danger-light: #fff1f2;
  --danger-border: #fecdd3;
  --warning: #d97706;
  --warning-light: #fffbeb;
  --warning-border: #fde68a;
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-card: 0 4px 6px -1px rgba(0, 0, 0, 0.04), 0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 0 0 1px var(--line);
  --kbd-bg: rgba(255, 255, 255, 0.22);
  --kbd-text: #ffffff;
  --kbd-border: rgba(255, 255, 255, 0.35);
  --scroll-thumb: #cbd5e1;
}

[data-theme="dark"] {
  --bg: #090d16;
  --bg-pattern: radial-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px);
  --panel: #131b2e;
  --panel-hover: #1e293b;
  --ink: #f8fafc;
  --ink-secondary: #cbd5e1;
  --muted: #94a3b8;
  --subtle: #64748b;
  --line: #222f46;
  --line-strong: #334360;
  --accent: #10b981;
  --accent-hover: #059669;
  --accent-active: #047857;
  --accent-light: rgba(16, 185, 129, 0.12);
  --accent-border: rgba(16, 185, 129, 0.3);
  --danger: #f43f5e;
  --danger-hover: #e11d48;
  --danger-light: rgba(244, 63, 94, 0.12);
  --danger-border: rgba(244, 63, 94, 0.3);
  --warning: #f59e0b;
  --warning-light: rgba(245, 158, 11, 0.12);
  --warning-border: rgba(245, 158, 11, 0.3);
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
  --shadow-card: 0 4px 6px -1px rgba(0, 0, 0, 0.2), 0 20px 25px -5px rgba(0, 0, 0, 0.4), 0 0 0 1px var(--line);
  --kbd-bg: rgba(0, 0, 0, 0.25);
  --kbd-text: #ffffff;
  --kbd-border: rgba(255, 255, 255, 0.2);
  --scroll-thumb: #334360;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100vh;
  background-color: var(--bg);
  background-image: var(--bg-pattern);
  background-size: 20px 20px;
  color: var(--ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  transition: background-color 0.25s ease, color 0.25s ease;
}

.shell {
  width: min(1180px, calc(100% - 32px));
  min-height: 100vh;
  margin: 0 auto;
  padding: 20px 0 28px 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.topbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 4px 2px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  user-select: none;
}

.brand-icon {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-sm);
}

.brand-title {
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.pill {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--panel);
  padding: 0 12px;
  font-size: 12px;
  color: var(--muted);
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
}

.pill svg {
  color: var(--subtle);
  flex-shrink: 0;
}

.pill.expired {
  border-color: var(--danger-border);
  background: var(--danger-light);
  color: var(--danger);
}
.pill.expired svg {
  color: var(--danger);
}

.theme-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--line);
  border-radius: 50%;
  background: var(--panel);
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
  padding: 0;
}

.theme-btn:hover {
  color: var(--ink);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.workspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border-radius: 14px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
  transition: background-color 0.25s ease, box-shadow 0.25s ease;
}

/* Tabs System */
.tab-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
  padding: 8px 12px 0 12px;
  overflow: hidden;
  user-select: none;
}

.tabs-scroll {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  scrollbar-width: none;
  flex: 1;
  padding-bottom: 0;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}

.tab-item {
  height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border-radius: 8px 8px 0 0;
  border: 1px solid transparent;
  border-bottom: none;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  transition: all 0.15s ease;
  white-space: nowrap;
  flex-shrink: 0;
}

.tab-item:hover {
  color: var(--ink);
  background: rgba(0, 0, 0, 0.03);
}

[data-theme="dark"] .tab-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.tab-item.active {
  background: var(--panel);
  color: var(--ink);
  font-weight: 600;
  border-color: var(--line);
  position: relative;
  margin-bottom: -1px;
  padding-bottom: 1px;
  z-index: 1;
  box-shadow: 0 -2px 6px rgba(0, 0, 0, 0.02);
}

.tab-dirty-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warning);
  display: inline-block;
  flex-shrink: 0;
}

.tab-title {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-title-input {
  max-width: 130px;
  height: 20px;
  padding: 0 4px;
  border: 1px solid var(--accent);
  border-radius: 4px;
  background: var(--panel);
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  outline: none;
}

.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  color: var(--subtle);
  font-size: 14px;
  line-height: 1;
  transition: all 0.12s ease;
  margin-left: 2px;
}

.tab-close:hover {
  background: var(--danger-light);
  color: var(--danger);
}

.add-tab-btn {
  height: 27px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  border: 1px dashed var(--line-strong);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  margin-bottom: 3px;
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.add-tab-btn:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-light);
}

.textarea-wrapper {
  flex: 1;
  position: relative;
  display: flex;
}

textarea {
  flex: 1;
  width: 100%;
  min-height: calc(100vh - 240px);
  resize: vertical;
  border: 0;
  outline: 0;
  background: transparent;
  color: var(--ink);
  padding: 22px 24px;
  font: 14.5px/1.65 ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace;
  letter-spacing: 0.015em;
  tab-size: 2;
  scrollbar-width: thin;
  scrollbar-color: var(--scroll-thumb) transparent;
}

textarea::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
textarea::-webkit-scrollbar-track {
  background: transparent;
}
textarea::-webkit-scrollbar-thumb {
  background: var(--scroll-thumb);
  border-radius: 4px;
}
textarea::-webkit-scrollbar-thumb:hover {
  background: var(--subtle);
}

textarea::placeholder {
  color: var(--subtle);
  opacity: 0.8;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 10px 16px;
  flex-wrap: wrap;
  user-select: none;
}

.status-group {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  font-size: 12.5px;
  color: var(--muted);
}

.status-indicator {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-weight: 500;
  transition: color 0.2s ease;
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  transition: background 0.25s ease, box-shadow 0.25s ease;
}

.status-indicator.ready .status-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-light);
}

.status-indicator.dirty .status-dot {
  background: var(--warning);
  box-shadow: 0 0 0 3px var(--warning-light);
  animation: pulse-dot 2s infinite ease-in-out;
}

.status-indicator.saving .status-dot {
  background: #0284c7;
  box-shadow: 0 0 0 3px rgba(2, 132, 199, 0.15);
  animation: pulse-dot 1s infinite ease-in-out;
}

.status-indicator.error .status-dot {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-light);
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.85); }
}

.stats-divider {
  width: 1px;
  height: 14px;
  background: var(--line);
}

.text-stats {
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn {
  height: 34px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 0 13px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.16s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--shadow-sm);
  outline: none;
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none !important;
}

.btn-secondary {
  border-color: var(--line);
  background: var(--panel);
  color: var(--ink-secondary);
}
.btn-secondary:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--panel-hover);
  color: var(--ink);
}

.btn-danger {
  border-color: var(--line);
  background: var(--panel);
  color: var(--danger);
}
.btn-danger:hover:not(:disabled) {
  border-color: var(--danger-border);
  background: var(--danger-light);
}

.btn-danger-confirm {
  border-color: var(--danger) !important;
  background: var(--danger) !important;
  color: #ffffff !important;
  animation: shake 0.3s ease;
}

@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-2px); }
  75% { transform: translateX(2px); }
}

.btn-primary {
  background: var(--accent);
  color: #ffffff;
  border-color: transparent;
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-hover);
  box-shadow: 0 3px 8px -1px rgba(5, 150, 105, 0.35);
}
.btn-primary:active:not(:disabled) {
  background: var(--accent-active);
}

.spinner {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Toast Notifications */
.toast-container {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  z-index: 9999;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  min-width: 180px;
  max-width: 90vw;
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.18), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
  background: #0f172a;
  color: #f8fafc;
  border: 1px solid rgba(255, 255, 255, 0.12);
  animation: toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

[data-theme="dark"] .toast {
  background: #1e293b;
  color: #f8fafc;
  border-color: rgba(255, 255, 255, 0.18);
}

.toast.success { border-left: 3px solid var(--accent); }
.toast.error { border-left: 3px solid var(--danger); }
.toast.info { border-left: 3px solid #0ea5e9; }

@keyframes toast-in {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@media (max-width: 680px) {
  .shell { width: calc(100% - 20px); padding: 14px 0 20px 0; }
  .topbar { flex-direction: column; align-items: flex-start; gap: 10px; }
  .meta { justify-content: flex-start; width: 100%; }
  .tab-bar { padding: 6px 8px 0 8px; }
  .tab-title { max-width: 90px; }
  .toolbar { flex-direction: column; align-items: stretch; gap: 10px; }
  .status-group { justify-content: space-between; }
  .actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; }
  .btn { justify-content: center; padding: 0 8px; }
  textarea { min-height: calc(100vh - 270px); padding: 16px; }
}
</style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path>
            <rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect>
          </svg>
        </span>
        <span class="brand-title">Clipboard</span>
      </div>
      <div class="meta">
        <div class="pill">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          <span>验证：${escapeHtml(authRole)}</span>
        </div>
        <div class="pill">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          <span>更新：<span id="updatedAt">${escapeHtml(updatedText)}</span></span>
        </div>
        <div class="pill" id="tokenPill" title="有效操作剩余时间">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 10"></polyline></svg>
          <span>令牌：<span id="tokenTimer">${Math.round(actionTokenSeconds / 60)}:00</span></span>
        </div>
        <button id="themeToggle" class="theme-btn" type="button" title="切换深色/浅色模式" aria-label="Toggle theme"></button>
      </div>
    </header>

    <section class="workspace">
      <div class="tab-bar">
        <div class="tabs-scroll" id="tabsScroll"></div>
        <button id="addTabBtn" class="add-tab-btn" type="button" title="新建便签">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          <span>新建</span>
        </button>
      </div>
      <div class="textarea-wrapper">
        <textarea id="clipboard" spellcheck="false" placeholder="在此输入或粘贴文本...">${escapeHtml(content)}</textarea>
      </div>
      <div class="toolbar">
        <div class="status-group">
          <div id="statusIndicator" class="status-indicator ready">
            <span class="status-dot"></span>
            <span id="statusText">准备就绪</span>
          </div>
          <div class="stats-divider"></div>
          <div id="textStats" class="text-stats">0 字符 · 0 词 · 1 行</div>
        </div>
        <div class="actions">
          <button id="copyButton" class="btn btn-secondary" type="button" title="复制当前便签全部内容">
            <svg class="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            <span class="btn-label">复制</span>
          </button>
          <button id="clearButton" class="btn btn-danger" type="button" title="清空内容">
            <svg class="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            <span class="btn-label">清空</span>
          </button>
          <button id="saveButton" class="btn btn-primary" type="button" title="保存剪贴板 (Ctrl+S)">
            <svg class="btn-icon" id="saveIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
            <svg class="btn-icon spinner" id="saveSpinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
            <span class="btn-label">保存</span>
          </button>
        </div>
      </div>
    </section>
  </main>
  <div id="toastContainer" class="toast-container"></div>

<script>
const actionToken = ${JSON.stringify(actionToken)};
const actionTokenSeconds = ${actionTokenSeconds};
let tabs = ${JSON.stringify(tabs)};
let currentTabId = ${JSON.stringify(activeTabId)};

const textarea = document.getElementById("clipboard");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const textStats = document.getElementById("textStats");
const updatedAtEl = document.getElementById("updatedAt");
const tokenTimerEl = document.getElementById("tokenTimer");
const tokenPill = document.getElementById("tokenPill");
const saveButton = document.getElementById("saveButton");
const saveIcon = document.getElementById("saveIcon");
const saveSpinner = document.getElementById("saveSpinner");
const clearButton = document.getElementById("clearButton");
const copyButton = document.getElementById("copyButton");
const themeToggle = document.getElementById("themeToggle");
const toastContainer = document.getElementById("toastContainer");
const tabsScroll = document.getElementById("tabsScroll");
const addTabBtn = document.getElementById("addTabBtn");

let lastSavedContent = textarea.value;
let isDirty = false;
let clearTimer = null;

// In-memory cache for all opened tabs
const tabsCache = {};
tabsCache[currentTabId] = {
  content: textarea.value,
  lastSavedContent: textarea.value,
  updatedText: updatedAtEl.textContent,
  isDirty: false,
};

// Theme handling
const THEME_KEY = "cf_clipboard_theme";
function getTheme() {
  return localStorage.getItem(THEME_KEY) || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
function setTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
  themeToggle.innerHTML = theme === "dark"
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
}
setTheme(getTheme());
themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  setTheme(current === "dark" ? "light" : "dark");
});

// Toast system
function showToast(message, type = "info", duration = 2800) {
  const toast = document.createElement("div");
  toast.className = "toast " + type;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(8px) scale(0.96)";
    setTimeout(() => toast.remove(), 220);
  }, duration);
}

// Status handling
function setStatus(text, type = "ready") {
  statusText.textContent = text;
  statusIndicator.className = "status-indicator " + type;
}

// Render tabs UI
function renderTabs() {
  tabsScroll.innerHTML = "";
  tabs.forEach(tab => {
    const tabEl = document.createElement("div");
    tabEl.className = "tab-item" + (tab.id === currentTabId ? " active" : "");
    tabEl.dataset.id = tab.id;
    tabEl.title = tab.title + " (双击可重命名)";

    const cached = tabsCache[tab.id];
    const isTabDirty = cached ? cached.isDirty : false;
    if (isTabDirty) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty-dot";
      dot.title = "有未保存修改";
      tabEl.appendChild(dot);
    }

    const titleSpan = document.createElement("span");
    titleSpan.className = "tab-title";
    titleSpan.textContent = tab.title;
    tabEl.appendChild(titleSpan);

    tabEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startRenameTab(tab.id, titleSpan);
    });

    if (tab.id !== "main" || tabs.length > 1) {
      const closeBtn = document.createElement("span");
      closeBtn.className = "tab-close";
      closeBtn.innerHTML = "&times;";
      closeBtn.title = "删除便签";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteTab(tab.id, tab.title);
      });
      tabEl.appendChild(closeBtn);
    }

    tabEl.addEventListener("click", () => {
      if (tab.id !== currentTabId) {
        switchTab(tab.id);
      }
    });

    tabsScroll.appendChild(tabEl);
  });
}
renderTabs();

// Switch tab smoothly
async function switchTab(targetId) {
  if (targetId === currentTabId) return;

  if (tabsCache[currentTabId]) {
    tabsCache[currentTabId].content = textarea.value;
    tabsCache[currentTabId].isDirty = (textarea.value !== tabsCache[currentTabId].lastSavedContent);
  }

  currentTabId = targetId;

  if (tabsCache[targetId]) {
    const cached = tabsCache[targetId];
    textarea.value = cached.content;
    lastSavedContent = cached.lastSavedContent;
    updatedAtEl.textContent = cached.updatedText;
    updateStatsAndDirty();
    renderTabs();
    return;
  }

  setStatus("加载中...", "saving");
  try {
    const res = await fetch("/api/tab?id=" + encodeURIComponent(targetId));
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || "加载失败");

    textarea.value = data.content || "";
    lastSavedContent = data.content || "";
    updatedAtEl.textContent = data.updatedText || "尚未保存";

    tabsCache[targetId] = {
      content: data.content || "",
      lastSavedContent: data.content || "",
      updatedText: data.updatedText || "尚未保存",
      isDirty: false,
    };

    updateStatsAndDirty();
    renderTabs();
  } catch (err) {
    showToast("切换失败: " + err.message, "error");
  }
}

// Rename tab inline
function startRenameTab(tabId, titleSpan) {
  const currentTitle = titleSpan.textContent;
  const input = document.createElement("input");
  input.className = "tab-title-input";
  input.value = currentTitle;
  titleSpan.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  async function finishRename() {
    if (finished) return;
    finished = true;
    const newTitle = input.value.trim() || currentTitle;
    if (newTitle !== currentTitle) {
      tabs = tabs.map(t => (t.id === tabId ? { ...t, title: newTitle } : t));
      renderTabs();
      try {
        await postJson("/api/tabs", { action: "rename", id: tabId, title: newTitle });
        showToast("便签已重命名", "success");
      } catch (err) {
        showToast("重命名同步失败: " + err.message, "error");
      }
    } else {
      renderTabs();
    }
  }

  input.addEventListener("blur", finishRename);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      input.blur();
    } else if (e.key === "Escape") {
      input.value = currentTitle;
      input.blur();
    }
  });
}

// Add tab
addTabBtn.addEventListener("click", async () => {
  addTabBtn.disabled = true;
  try {
    const defaultName = "便签 " + (tabs.length + 1);
    const result = await postJson("/api/tabs", { action: "create", title: defaultName });
    tabs = result.tabs;
    const newTab = result.tab;

    if (tabsCache[currentTabId]) {
      tabsCache[currentTabId].content = textarea.value;
      tabsCache[currentTabId].isDirty = (textarea.value !== tabsCache[currentTabId].lastSavedContent);
    }

    tabsCache[newTab.id] = {
      content: "",
      lastSavedContent: "",
      updatedText: "尚未保存",
      isDirty: false,
    };

    currentTabId = newTab.id;
    textarea.value = "";
    lastSavedContent = "";
    updatedAtEl.textContent = "尚未保存";

    updateStatsAndDirty();
    renderTabs();
    textarea.focus();
    showToast("已创建「" + newTab.title + "」", "success");
  } catch (err) {
    showToast("新建便签失败: " + err.message, "error");
  } finally {
    addTabBtn.disabled = false;
  }
});

// Delete tab
async function deleteTab(tabId, title) {
  if (!confirm("确认删除便签「" + title + "」？删除后内容将无法恢复。")) return;

  try {
    const result = await postJson("/api/tabs", { action: "delete", id: tabId });
    delete tabsCache[tabId];
    tabs = result.tabs;

    if (currentTabId === tabId) {
      const nextTab = tabs[0];
      await switchTab(nextTab.id);
    } else {
      renderTabs();
    }
    showToast("已删除便签", "info");
  } catch (err) {
    showToast("删除便签失败: " + err.message, "error");
  }
}

// Live stats & dirty check
function updateStatsAndDirty() {
  const val = textarea.value;
  const chars = val.length;
  const words = val.trim() ? (val.trim().match(/[\\u4e00-\\u9fa5]|[a-zA-Z0-9_-]+/g) || []).length : 0;
  const lines = val ? val.split("\\n").length : 1;
  textStats.textContent = chars + " 字符 · " + words + " 词 · " + lines + " 行";

  const prevDirty = tabsCache[currentTabId] ? tabsCache[currentTabId].isDirty : false;
  isDirty = (val !== lastSavedContent);

  if (tabsCache[currentTabId]) {
    tabsCache[currentTabId].content = val;
    tabsCache[currentTabId].isDirty = isDirty;
  }

  if (isDirty) {
    setStatus("未保存更改", "dirty");
  } else {
    setStatus("已保存", "ready");
  }

  if (prevDirty !== isDirty) {
    renderTabs();
  }
}
updateStatsAndDirty();
textarea.addEventListener("input", updateStatsAndDirty);

// Tab indentation support
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const val = textarea.value;
    textarea.value = val.substring(0, start) + "  " + val.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    updateStatsAndDirty();
  }
});

// Window beforeunload check across all tabs
window.addEventListener("beforeunload", (e) => {
  const hasDirty = Object.values(tabsCache).some(t => t.isDirty) || isDirty;
  if (hasDirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function setBusy(isBusy) {
  saveButton.disabled = isBusy;
  clearButton.disabled = isBusy;
  saveIcon.style.display = isBusy ? "none" : "";
  saveSpinner.style.display = isBusy ? "" : "none";
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

// Save action
async function handleSaveAction() {
  if (saveButton.disabled) return;
  setBusy(true);
  setStatus("正在保存...", "saving");
  try {
    const result = await postJson("/api/save", { id: currentTabId, content: textarea.value });
    updatedAtEl.textContent = result.updatedText;
    lastSavedContent = textarea.value;

    if (tabsCache[currentTabId]) {
      tabsCache[currentTabId].content = textarea.value;
      tabsCache[currentTabId].lastSavedContent = textarea.value;
      tabsCache[currentTabId].updatedText = result.updatedText;
      tabsCache[currentTabId].isDirty = false;
    }

    updateStatsAndDirty();
    renderTabs();
    setStatus("已保存", "ready");
    showToast("保存成功", "success");
  } catch (error) {
    setStatus(error.message, "error");
    showToast("保存失败: " + error.message, "error", 4000);
  } finally {
    setBusy(false);
  }
}
saveButton.addEventListener("click", handleSaveAction);

// Global Ctrl+S / Cmd+S shortcut
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    handleSaveAction();
  }
});

// Copy all action
copyButton.addEventListener("click", async () => {
  if (!textarea.value) {
    showToast("当前没有内容可复制", "info");
    return;
  }
  try {
    await navigator.clipboard.writeText(textarea.value);
    showToast("已复制全部内容到剪贴板", "success");
    const label = copyButton.querySelector(".btn-label");
    const prevText = label.textContent;
    label.textContent = "已复制";
    setTimeout(() => { label.textContent = prevText; }, 1600);
  } catch (err) {
    showToast("复制失败，请手动选择复制", "error");
  }
});

// Safe Clear action (Mode B: local textarea clear, persist on save)
function resetClearButton() {
  clearButton.classList.remove("btn-danger-confirm");
  clearButton.querySelector(".btn-label").textContent = "清空";
  clearTimer = null;
}

clearButton.addEventListener("click", () => {
  if (!textarea.value) {
    showToast("当前输入框已是空的", "info");
    return;
  }
  if (!clearTimer) {
    clearButton.classList.add("btn-danger-confirm");
    clearButton.querySelector(".btn-label").textContent = "确定清空？";
    clearTimer = setTimeout(resetClearButton, 3000);
    return;
  }
  clearTimeout(clearTimer);
  resetClearButton();

  textarea.value = "";
  if (tabsCache[currentTabId]) {
    tabsCache[currentTabId].content = "";
    tabsCache[currentTabId].isDirty = ("" !== tabsCache[currentTabId].lastSavedContent);
  }
  updateStatsAndDirty();
  renderTabs();
  textarea.focus();
  showToast("输入框已清空，按保存或 Ctrl+S 写入云端", "info");
});

document.addEventListener("click", (e) => {
  if (clearTimer && !clearButton.contains(e.target)) {
    clearTimeout(clearTimer);
    resetClearButton();
  }
});

// Token countdown timer
let remainingSeconds = actionTokenSeconds;
function updateCountdown() {
  if (remainingSeconds <= 0) {
    tokenTimerEl.textContent = "已过期";
    tokenPill.classList.add("expired");
    showToast("页面令牌已过期，请刷新页面以继续操作", "error", 8000);
    return;
  }
  const mins = Math.floor(remainingSeconds / 60);
  const secs = remainingSeconds % 60;
  tokenTimerEl.textContent = mins + ":" + (secs < 10 ? "0" : "") + secs;
  if (remainingSeconds === 120) {
    showToast("页面令牌将在 2 分钟后过期，建议及时保存", "info", 5000);
  }
  remainingSeconds--;
  setTimeout(updateCountdown, 1000);
}
updateCountdown();
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
