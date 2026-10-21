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
  const auth = await authorizeRead(request, env);
  if (!auth.ok) return json({ ok: false, message: auth.message }, auth.status);

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
    const newId = String(payload?.id || "").trim() || `tab_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
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

async function authorizeRead(request, env) {
  const access = await checkAccess(request, env, { resourcePath: "/" });
  if (access.ok) {
    return { ok: true, source: access.result?.role || "access" };
  }

  const token = request.headers.get("x-clipboard-action-token") || "";
  const payload = await verifyActionToken(env, token);
  if (payload?.purpose === "clipboard:write" || payload?.purpose === "clipboard:read") {
    return { ok: true, source: "action-token" };
  }

  return { ok: false, status: 401, message: "访问授权已过期，请刷新页面重新验证。" };
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
<script>
(function() {
  try {
    var t = localStorage.getItem("cf_clipboard_theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", t);
  } catch(e) {}
})();
</script>
<style>
:root, [data-theme="light"] {
  --bg: #f8fafc;
  --bg-pattern: radial-gradient(rgba(15, 23, 42, 0.05) 1px, transparent 1px);
  --panel: #ffffff;
  --panel-hover: #f1f5f9;
  --ink: #0f172a;
  --ink-secondary: #334155;
  --muted: #64748b;
  --subtle: #94a3b8;
  --line: #e2e8f0;
  --line-strong: #cbd5e1;
  --accent: #0f172a;
  --accent-hover: #1e293b;
  --accent-active: #334155;
  --accent-light: rgba(15, 23, 42, 0.06);
  --accent-border: rgba(15, 23, 42, 0.15);
  --danger: #ef4444;
  --danger-hover: #dc2626;
  --danger-light: rgba(239, 68, 68, 0.08);
  --danger-border: rgba(239, 68, 68, 0.25);
  --warning: #f59e0b;
  --warning-light: rgba(245, 158, 11, 0.08);
  --warning-border: rgba(245, 158, 11, 0.25);
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
  --shadow-card: 0 20px 40px -15px rgba(0, 0, 0, 0.06), 0 0 0 1px var(--line);
  --kbd-bg: rgba(0, 0, 0, 0.06);
  --kbd-text: #0f172a;
  --kbd-border: rgba(0, 0, 0, 0.12);
  --scroll-thumb: #cbd5e1;
}

[data-theme="dark"] {
  --bg: #09090b;
  --bg-pattern: none;
  --panel: #141417;
  --panel-hover: #18181b;
  --ink: #ffffff;
  --ink-secondary: #f4f4f5;
  --muted: #a1a1aa;
  --subtle: #71717a;
  --line: #27272a;
  --line-strong: #3f3f46;
  --accent: #ffffff;
  --accent-hover: #e4e4e7;
  --accent-active: #d4d4d8;
  --accent-light: rgba(255, 255, 255, 0.08);
  --accent-border: rgba(255, 255, 255, 0.2);
  --danger: #ef4444;
  --danger-hover: #dc2626;
  --danger-light: rgba(239, 68, 68, 0.08);
  --danger-border: rgba(239, 68, 68, 0.25);
  --warning: #f59e0b;
  --warning-light: rgba(245, 158, 11, 0.08);
  --warning-border: rgba(245, 158, 11, 0.25);
  --shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
  --shadow-card: 0 20px 40px -15px rgba(0, 0, 0, 0.7), 0 0 0 1px var(--line);
  --kbd-bg: rgba(255, 255, 255, 0.12);
  --kbd-text: #ffffff;
  --kbd-border: rgba(255, 255, 255, 0.2);
  --scroll-thumb: #27272a;
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
  padding: 6px 2px;
}

.topbar-main {
  display: flex;
  align-items: center;
  gap: 14px;
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
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-sm);
  cursor: pointer;
  padding: 0;
  transition: all 0.2s ease;
}

.brand-icon:hover {
  color: var(--ink);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}

.brand-title {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--ink);
}

.brand-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent-light);
  border: 1px solid var(--line);
  color: var(--muted);
  letter-spacing: 0.04em;
}

.topbar-meta-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pill-token {
  height: 32px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 0 10px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  box-shadow: var(--shadow-sm);
  transition: all 0.2s ease;
}

.pill-token svg {
  color: var(--subtle);
  flex-shrink: 0;
}

.pill-token.expired {
  border-color: var(--danger-border);
  background: var(--danger-light);
  color: var(--danger);
}
.pill-token.expired svg {
  color: var(--danger);
}

.theme-btn {
  width: 32px;
  height: 32px;
  border: 1px solid var(--line);
  border-radius: 8px;
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
  width: 5px;
  height: 5px;
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
  width: 17px;
  height: 17px;
  border-radius: 4px;
  color: var(--subtle);
  transition: all 0.15s ease;
  margin-left: 3px;
  padding: 0;
  cursor: pointer;
}

.tab-close:hover {
  background: var(--danger-light);
  color: var(--danger);
}

.tab-close svg {
  pointer-events: none;
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
  min-height: calc(100vh - 240px);
}

.skeleton-loader {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 24px 26px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  background: var(--panel);
  border-radius: var(--radius-lg);
  z-index: 5;
  transition: opacity 0.2s ease;
  pointer-events: none;
}

.skeleton-shimmer {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}

.skeleton-line {
  height: 14px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--line) 25%, var(--line-strong) 50%, var(--line) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite ease-in-out;
  opacity: 0.6;
}

[data-theme="dark"] .skeleton-line {
  background: linear-gradient(90deg, #182235 25%, #2a3952 50%, #182235 75%);
  background-size: 200% 100%;
  opacity: 0.85;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.skeleton-tip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: var(--subtle);
  font-size: 13px;
  font-weight: 500;
  padding-bottom: 8px;
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
  transition: opacity 0.18s ease;
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

.toolbar-minimal {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  border-top: 1px solid var(--line);
  background: var(--panel);
  padding: 8px 16px;
  user-select: none;
}

.meta-updated {
  font-size: 12px;
  color: var(--subtle);
  font-variant-numeric: tabular-nums;
}

.status-group {
  display: inline-flex;
  align-items: center;
  gap: 10px;
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
  background: #10b981;
  box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
}
[data-theme="dark"] .status-indicator.ready .status-dot {
  background: #ffffff;
  box-shadow: 0 0 6px rgba(255, 255, 255, 0.4);
}

.status-indicator.dirty .status-dot {
  background: var(--warning);
  box-shadow: 0 0 8px var(--warning-light);
  animation: pulse-dot 1.5s infinite ease-in-out;
}
[data-theme="dark"] .status-indicator.dirty .status-dot {
  background: #ffffff;
  box-shadow: 0 0 8px rgba(255, 255, 255, 0.5);
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
[data-theme="dark"] .btn-secondary {
  border-color: var(--line);
  background: #18181b;
  color: #d4d4d8;
}
[data-theme="dark"] .btn-secondary:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: #27272a;
  color: #ffffff;
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

.btn-save {
  border-color: var(--line);
  background: var(--panel);
  color: var(--muted);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.btn-save:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--panel-hover);
  color: var(--ink);
}
[data-theme="dark"] .btn-save {
  border-color: var(--line);
  background: #18181b;
  color: #a1a1aa;
}
[data-theme="dark"] .btn-save:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: #27272a;
  color: #ffffff;
}

/* 有未保存改动时亮起 */
.btn-save.is-dirty {
  background: #0f172a !important;
  color: #ffffff !important;
  border-color: #0f172a !important;
  box-shadow: 0 0 16px rgba(15, 23, 42, 0.25);
  animation: save-glow 2.5s infinite ease-in-out;
}
.btn-save.is-dirty:hover:not(:disabled) {
  background: #1e293b !important;
  box-shadow: 0 0 22px rgba(15, 23, 42, 0.35);
}
.btn-save.is-dirty:active:not(:disabled) {
  background: #334155 !important;
}

[data-theme="dark"] .btn-save.is-dirty {
  background: #ffffff !important;
  color: #09090b !important;
  border-color: #ffffff !important;
  box-shadow: 0 0 16px rgba(255, 255, 255, 0.25);
}
[data-theme="dark"] .btn-save.is-dirty:hover:not(:disabled) {
  background: #e4e4e7 !important;
  box-shadow: 0 0 22px rgba(255, 255, 255, 0.35);
}
[data-theme="dark"] .btn-save.is-dirty:active:not(:disabled) {
  background: #d4d4d8 !important;
}

@keyframes save-glow {
  0%, 100% { box-shadow: 0 0 12px rgba(0, 0, 0, 0.15); }
  50% { box-shadow: 0 0 22px rgba(0, 0, 0, 0.25); }
}

[data-theme="dark"] @keyframes save-glow {
  0%, 100% { box-shadow: 0 0 12px rgba(255, 255, 255, 0.2); }
  50% { box-shadow: 0 0 22px rgba(255, 255, 255, 0.35); }
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
  box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.08);
  background: var(--panel);
  color: var(--ink);
  border: 1px solid var(--line-strong);
  animation: toast-in 0.22s cubic-bezier(0.16, 1, 0.3, 1);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

[data-theme="dark"] .toast {
  background: #141417;
  color: #f8fafc;
  border-color: var(--line);
}

.toast.success { border-left: 3px solid #0f172a; }
[data-theme="dark"] .toast.success { border-left: 3px solid #ffffff; }
.toast.error { border-left: 3px solid var(--danger); }
.toast.info { border-left: 3px solid #0ea5e9; }

/* Custom Confirm Modal */
.modal-backdrop {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  padding: 16px;
}

.modal-backdrop.is-open {
  opacity: 1;
  pointer-events: auto;
}

.modal-card {
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.45);
  width: 100%;
  max-width: 380px;
  padding: 22px 24px;
  transform: scale(0.92) translateY(8px);
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.modal-backdrop.is-open .modal-card {
  transform: scale(1) translateY(0);
}

.modal-header {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  margin-bottom: 20px;
}

.modal-icon-badge {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.modal-icon-badge.danger {
  background: var(--danger-light);
  color: var(--danger);
  border: 1px solid var(--danger-border);
}

.modal-title-wrap {
  flex: 1;
}

.modal-title {
  margin: 0 0 6px 0;
  font-size: 15.5px;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.3;
}

.modal-desc {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  line-height: 1.55;
  word-break: break-word;
}

.modal-target-highlight {
  color: var(--ink);
  font-weight: 600;
  padding: 1px 5px;
  background: var(--line);
  border-radius: 4px;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.modal-actions .btn {
  padding: 0 16px;
  font-size: 13px;
  height: 35px;
  border-radius: 8px;
}

.btn-modal-danger {
  border-color: transparent;
  background: var(--danger);
  color: #ffffff;
  box-shadow: 0 2px 8px -1px rgba(225, 29, 72, 0.4);
}
.btn-modal-danger:hover:not(:disabled) {
  background: var(--danger-hover);
  box-shadow: 0 4px 12px -1px rgba(225, 29, 72, 0.55);
}
.btn-modal-danger:active:not(:disabled) {
  transform: scale(0.97);
}

@media (max-width: 680px) {
  .shell { width: calc(100% - 20px); padding: 10px 0 20px 0; }
  .topbar {
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    padding: 8px 0;
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--bg);
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }
  .topbar-main {
    justify-content: space-between;
    width: 100%;
  }
  .topbar-actions {
    display: grid;
    grid-template-columns: 1fr 1fr 1.35fr;
    gap: 6px;
    width: 100%;
  }
  .topbar-actions .btn {
    height: 36px;
    justify-content: center;
    padding: 0 8px;
    font-size: 13px;
  }
  .tab-bar { padding: 6px 8px 0 8px; }
  .tab-title { max-width: 90px; }
  .toolbar-minimal {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 8px 12px;
  }
  textarea { min-height: calc(100vh - 250px); padding: 14px; }
}

.spin-anim {
  animation: spin 0.8s linear infinite;
}
</style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="topbar-main">
        <div class="brand">
          <button id="themeToggle" class="brand-icon" type="button" title="切换深色/浅色模式" aria-label="Toggle theme"></button>
          <span class="brand-title">Clipboard</span>
          <span class="brand-badge">${escapeHtml(authRole)}</span>
        </div>
        <div class="topbar-meta-right">
          <div class="pill-token" id="tokenPill" title="有效操作剩余时间">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 14 10"></polyline></svg>
            <span id="tokenTimer">${Math.round(actionTokenSeconds / 60)}:00</span>
          </div>
          <button id="refreshButton" class="theme-btn" type="button" title="刷新当前便签数据" aria-label="刷新当前便签">
            <svg class="btn-icon" id="refreshIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          </button>
        </div>
      </div>
      <div class="topbar-actions">
        <button id="copyButton" class="btn btn-secondary" type="button" title="复制当前便签全部内容">
          <svg class="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          <span class="btn-label">复制</span>
        </button>
        <button id="clearButton" class="btn btn-danger" type="button" title="清空内容">
          <svg class="btn-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          <span class="btn-label">清空</span>
        </button>
        <button id="saveButton" class="btn btn-save" type="button" title="保存剪贴板 (Ctrl+S)">
          <svg class="btn-icon" id="saveIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>
          <svg class="btn-icon spinner" id="saveSpinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:none;"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
          <span class="btn-label">保存</span>
        </button>
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
      <div class="textarea-wrapper" id="textareaWrapper">
        <div id="skeletonLoader" class="skeleton-loader" style="display: none;">
          <div class="skeleton-shimmer">
            <div class="skeleton-line" style="width: 72%;"></div>
            <div class="skeleton-line" style="width: 88%;"></div>
            <div class="skeleton-line" style="width: 55%;"></div>
            <div class="skeleton-line" style="width: 82%;"></div>
            <div class="skeleton-line" style="width: 65%;"></div>
            <div class="skeleton-line" style="width: 40%;"></div>
          </div>
          <div class="skeleton-tip">
            <svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
            <span>正在加载便签内容...</span>
          </div>
        </div>
        <textarea id="clipboard" spellcheck="false" placeholder="在此输入或粘贴文本...">${escapeHtml(content)}</textarea>
      </div>
      <div class="toolbar-minimal">
        <div class="status-group">
          <div id="statusIndicator" class="status-indicator ready">
            <span class="status-dot"></span>
            <span id="statusText">准备就绪</span>
          </div>
          <div class="stats-divider"></div>
          <div id="textStats" class="text-stats">0 字符 · 0 词 · 1 行</div>
        </div>
        <div class="meta-updated">
          <span id="metaUpdatedWrap" style="cursor: pointer;" title="点击立即刷新当前便签">更新于 <span id="updatedAt">${escapeHtml(updatedText)}</span></span>
        </div>
      </div>
    </section>
  </main>
  <div id="confirmModal" class="modal-backdrop" style="display: none;">
    <div class="modal-card">
      <div class="modal-header">
        <div class="modal-icon-badge danger">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18"></path>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </div>
        <div class="modal-title-wrap">
          <h3 class="modal-title" id="confirmModalTitle">删除便签</h3>
          <div class="modal-desc" id="confirmModalDesc">确认删除便签吗？</div>
        </div>
      </div>
      <div class="modal-actions">
        <button id="confirmCancelBtn" class="btn btn-secondary" type="button">取消</button>
        <button id="confirmOkBtn" class="btn btn-modal-danger" type="button">
          <span id="confirmOkLabel">确认删除</span>
        </button>
      </div>
    </div>
  </div>
  <div id="toastContainer" class="toast-container"></div>

<script>
const actionToken = ${JSON.stringify(actionToken)};
const actionTokenSeconds = ${actionTokenSeconds};
let tabs = ${JSON.stringify(tabs)};
let currentTabId = ${JSON.stringify(activeTabId)};
let previousTabId = null;

const textarea = document.getElementById("clipboard");
const skeletonLoader = document.getElementById("skeletonLoader");
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const textStats = document.getElementById("textStats");
const updatedAtEl = document.getElementById("updatedAt");
const metaUpdatedWrap = document.getElementById("metaUpdatedWrap");
const tokenTimerEl = document.getElementById("tokenTimer");
const tokenPill = document.getElementById("tokenPill");
const refreshButton = document.getElementById("refreshButton");
const refreshIcon = document.getElementById("refreshIcon");
const saveButton = document.getElementById("saveButton");
const saveIcon = document.getElementById("saveIcon");
const saveSpinner = document.getElementById("saveSpinner");
const clearButton = document.getElementById("clearButton");
const copyButton = document.getElementById("copyButton");
const themeToggle = document.getElementById("themeToggle");
const toastContainer = document.getElementById("toastContainer");
const tabsScroll = document.getElementById("tabsScroll");
const addTabBtn = document.getElementById("addTabBtn");
const confirmModal = document.getElementById("confirmModal");
const confirmModalTitle = document.getElementById("confirmModalTitle");
const confirmModalDesc = document.getElementById("confirmModalDesc");
const confirmCancelBtn = document.getElementById("confirmCancelBtn");
const confirmOkBtn = document.getElementById("confirmOkBtn");
const confirmOkLabel = document.getElementById("confirmOkLabel");

let lastSavedContent = textarea.value;
let isDirty = false;
let clearTimer = null;

// In-memory cache for all opened tabs
const tabsCache = {};
tabsCache[currentTabId] = {
  content: textarea.value,
  lastSavedContent: textarea.value,
  updatedText: updatedAtEl.textContent,
  updatedAt: ${Number(updatedAt || 0)},
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
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>';
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

// Client HTML escape helper
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Custom confirm dialog
function showConfirmDialog({ title, desc, highlightText, okText = "确认删除" }) {
  return new Promise((resolve) => {
    confirmModalTitle.textContent = title;
    confirmModalDesc.innerHTML = "";
    
    const descText = document.createTextNode(desc + (highlightText ? " " : "？"));
    confirmModalDesc.appendChild(descText);
    
    if (highlightText) {
      const tag = document.createElement("span");
      tag.className = "modal-target-highlight";
      tag.textContent = "「" + highlightText + "」";
      confirmModalDesc.appendChild(tag);
      confirmModalDesc.appendChild(document.createTextNode("？"));
    }
    
    const note = document.createElement("div");
    note.style.cssText = "color:var(--subtle);font-size:12px;margin-top:6px;";
    note.textContent = "删除后内容将无法恢复。";
    confirmModalDesc.appendChild(note);

    confirmOkLabel.textContent = okText;

    confirmModal.style.display = "flex";
    void confirmModal.offsetWidth;
    confirmModal.classList.add("is-open");

    function cleanup() {
      confirmModal.classList.remove("is-open");
      setTimeout(() => {
        confirmModal.style.display = "none";
      }, 200);
      confirmOkBtn.removeEventListener("click", onOk);
      confirmCancelBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeyDown);
      confirmModal.removeEventListener("click", onBackdropClick);
    }

    function onOk() {
      cleanup();
      resolve(true);
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onOk();
      }
    }

    function onBackdropClick(e) {
      if (e.target === confirmModal) {
        onCancel();
      }
    }

    confirmOkBtn.addEventListener("click", onOk);
    confirmCancelBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeyDown);
    confirmModal.addEventListener("click", onBackdropClick);
  });
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
      closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
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

  previousTabId = currentTabId;
  currentTabId = targetId;

  if (tabsCache[targetId]) {
    const cached = tabsCache[targetId];
    textarea.value = cached.content;
    lastSavedContent = cached.lastSavedContent;
    updatedAtEl.textContent = cached.updatedText;
    updateStatsAndDirty();
    renderTabs();
    checkRemoteUpdate();
    return;
  }

  setStatus("加载中...", "saving");
  if (skeletonLoader) skeletonLoader.style.display = "flex";
  textarea.style.opacity = "0.15";
  const switchingTo = targetId;

  try {
    const data = await getJson("/api/tab?id=" + encodeURIComponent(targetId));

    tabsCache[targetId] = {
      content: data.content || "",
      lastSavedContent: data.content || "",
      updatedText: data.updatedText || "尚未保存",
      updatedAt: Number(data.updatedAt || 0),
      isDirty: false,
    };

    if (currentTabId === switchingTo) {
      textarea.value = data.content || "";
      lastSavedContent = data.content || "";
      updatedAtEl.textContent = data.updatedText || "尚未保存";
      updateStatsAndDirty();
      renderTabs();
    }
  } catch (err) {
    if (currentTabId === switchingTo) {
      showToast("切换失败: " + err.message, "error");
    }
  } finally {
    if (currentTabId === switchingTo) {
      if (skeletonLoader) skeletonLoader.style.display = "none";
      textarea.style.opacity = "1";
    }
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
// Add tab (Optimistic instant response)
addTabBtn.addEventListener("click", async () => {
  const newTabId = "tab_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
  const defaultName = "便签 " + (tabs.length + 1);
  const newTab = { id: newTabId, title: defaultName };

  if (tabsCache[currentTabId]) {
    tabsCache[currentTabId].content = textarea.value;
    tabsCache[currentTabId].isDirty = (textarea.value !== tabsCache[currentTabId].lastSavedContent);
  }

  tabs.push(newTab);
  tabsCache[newTabId] = {
    content: "",
    lastSavedContent: "",
    updatedText: "尚未保存",
    isDirty: false,
  };

  previousTabId = currentTabId;
  currentTabId = newTabId;
  textarea.value = "";
  lastSavedContent = "";
  updatedAtEl.textContent = "尚未保存";

  updateStatsAndDirty();
  renderTabs();
  tabsScroll.scrollLeft = tabsScroll.scrollWidth;
  textarea.focus();
  showToast("已新建「" + newTab.title + "」", "success");

  try {
    const result = await postJson("/api/tabs", { action: "create", id: newTabId, title: defaultName });
    if (result.tabs) {
      tabs = result.tabs;
      renderTabs();
    }
  } catch (err) {
    tabs = tabs.filter(t => t.id !== newTabId);
    delete tabsCache[newTabId];
    if (currentTabId === newTabId) {
      currentTabId = tabs[0]?.id || "main";
      if (tabsCache[currentTabId]) {
        textarea.value = tabsCache[currentTabId].content;
        lastSavedContent = tabsCache[currentTabId].lastSavedContent;
        updatedAtEl.textContent = tabsCache[currentTabId].updatedText;
      }
      updateStatsAndDirty();
    }
    renderTabs();
    showToast("新建便签同步失败: " + err.message, "error");
  }
});

// Delete tab (Custom confirmation modal + Optimistic instant delete)
async function deleteTab(tabId, title) {
  const confirmed = await showConfirmDialog({
    title: "删除便签",
    desc: "确认删除便签",
    highlightText: title,
    okText: "确认删除",
  });
  if (!confirmed) return;

  const prevTabs = [...tabs];
  const deletedCache = tabsCache[tabId];
  const closingIndex = tabs.findIndex(t => t.id === tabId);

  delete tabsCache[tabId];
  const remainingTabs = tabs.filter(t => t.id !== tabId);
  tabs = remainingTabs;

  if (currentTabId === tabId) {
    // 智能选择下一个激活的便签：
    // 1. 优先切换回之前查看的便签（例如从“待解决清单”切到此便签后删除，自动返回“待解决清单”）
    // 2. 若之前查看的便签不存在，则按主流标签页规则就近激活相邻便签
    let nextTab = remainingTabs.find(t => t.id === previousTabId);
    if (!nextTab && remainingTabs.length > 0) {
      const nextIndex = Math.min(closingIndex, remainingTabs.length - 1);
      nextTab = remainingTabs[Math.max(0, nextIndex)];
    }
    if (nextTab) {
      await switchTab(nextTab.id);
    }
  } else {
    if (previousTabId === tabId) previousTabId = null;
    renderTabs();
  }
  showToast("已删除便签「" + title + "」", "info");

  try {
    const result = await postJson("/api/tabs", { action: "delete", id: tabId });
    if (result.tabs) {
      tabs = result.tabs;
      renderTabs();
    }
  } catch (err) {
    tabs = prevTabs;
    if (deletedCache) tabsCache[tabId] = deletedCache;
    renderTabs();
    showToast("删除便签同步失败: " + err.message, "error");
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
  saveButton.classList.toggle("is-dirty", isDirty);

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

async function getJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "x-clipboard-action-token": actionToken,
    },
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message || "请求失败");
  return result;
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
  if (!isDirty) {
    showToast("当前便签内容已是最新", "info");
    return;
  }
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
      tabsCache[currentTabId].updatedAt = Number(result.updatedAt || 0);
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

// Prefetch background tabs for instantaneous switching
async function prefetchTabs() {
  for (const tab of tabs) {
    if (!tabsCache[tab.id]) {
      try {
        const data = await getJson("/api/tab?id=" + encodeURIComponent(tab.id));
        if (data.ok && !tabsCache[tab.id]) {
          tabsCache[tab.id] = {
            content: data.content || "",
            lastSavedContent: data.content || "",
            updatedText: data.updatedText || "尚未保存",
            updatedAt: Number(data.updatedAt || 0),
            isDirty: false,
          };
        }
      } catch (_) {}
    }
  }
}
setTimeout(prefetchTabs, 400);

// Refresh current tab content (Manual or Auto)
let isRefreshing = false;
async function refreshCurrentTab(isManual = true) {
  if (isRefreshing) return;

  // 如果手动刷新且当前便签有未保存修改，提示确认
  if (isManual && isDirty) {
    const currentTitle = tabs.find(t => t.id === currentTabId)?.title || "当前便签";
    const confirmed = await showConfirmDialog({
      title: "刷新便签",
      desc: "当前便签有未保存的修改，刷新将丢失本地草稿并拉取云端最新内容，确认刷新",
      highlightText: currentTitle,
      okText: "放弃修改并刷新",
    });
    if (!confirmed) return;
  }

  isRefreshing = true;
  if (refreshIcon) refreshIcon.classList.add("spin-anim");
  if (refreshButton) refreshButton.disabled = true;

  try {
    const data = await getJson("/api/tab?id=" + encodeURIComponent(currentTabId));
    const newContent = data.content || "";
    const newUpdatedText = data.updatedText || "尚未保存";
    const newUpdatedAt = Number(data.updatedAt || 0);

    const contentChanged = (textarea.value !== newContent);
    textarea.value = newContent;
    lastSavedContent = newContent;
    updatedAtEl.textContent = newUpdatedText;

    if (tabsCache[currentTabId]) {
      tabsCache[currentTabId].content = newContent;
      tabsCache[currentTabId].lastSavedContent = newContent;
      tabsCache[currentTabId].updatedText = newUpdatedText;
      tabsCache[currentTabId].updatedAt = newUpdatedAt;
      tabsCache[currentTabId].isDirty = false;
    }

    updateStatsAndDirty();
    renderTabs();

    if (isManual) {
      if (contentChanged) {
        showToast("已同步云端最新内容", "success");
      } else {
        showToast("当前便签内容已是最新", "info");
      }
    } else {
      if (contentChanged) {
        showToast("已自动同步来自其他设备的更新", "success");
      }
    }
  } catch (err) {
    if (isManual) {
      showToast("刷新失败: " + err.message, "error");
    }
  } finally {
    isRefreshing = false;
    if (refreshIcon) refreshIcon.classList.remove("spin-anim");
    if (refreshButton) refreshButton.disabled = false;
  }
}

if (refreshButton) {
  refreshButton.addEventListener("click", () => refreshCurrentTab(true));
}
if (metaUpdatedWrap) {
  metaUpdatedWrap.addEventListener("click", () => refreshCurrentTab(true));
}

// 跨设备体验优化：切回标签页或窗口获得焦点时，若无本地草稿未保存，智能检查云端是否有更新
let lastSyncCheckTime = 0;
async function checkRemoteUpdate() {
  const now = Date.now();
  if (now - lastSyncCheckTime < 3000) return; // 3 秒节流保护
  lastSyncCheckTime = now;

  if (isDirty) return; // 本地正在编辑草稿时不自动静默覆盖

  try {
    const data = await getJson("/api/tab?id=" + encodeURIComponent(currentTabId));
    const cached = tabsCache[currentTabId];
    const serverUpdatedAt = Number(data.updatedAt || 0);
    const localUpdatedAt = cached ? (cached.updatedAt || 0) : 0;

    if ((serverUpdatedAt > localUpdatedAt || data.content !== textarea.value) && !isDirty) {
      const prevContent = textarea.value;
      textarea.value = data.content || "";
      lastSavedContent = data.content || "";
      updatedAtEl.textContent = data.updatedText || "尚未保存";

      if (tabsCache[currentTabId]) {
        tabsCache[currentTabId].content = data.content || "";
        tabsCache[currentTabId].lastSavedContent = data.content || "";
        tabsCache[currentTabId].updatedText = data.updatedText || "尚未保存";
        tabsCache[currentTabId].updatedAt = serverUpdatedAt;
        tabsCache[currentTabId].isDirty = false;
      }

      updateStatsAndDirty();
      renderTabs();

      if (prevContent !== data.content) {
        showToast("已自动同步来自其他设备的更新", "success");
      }
    }
  } catch (_) {}
}

window.addEventListener("focus", checkRemoteUpdate);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    checkRemoteUpdate();
  }
});

// 闲置自动检测：每隔 30 秒若页面处于激活状态且无未保存草稿，静默轮询一次
setInterval(() => {
  if (document.visibilityState === "visible" && !isDirty) {
    checkRemoteUpdate();
  }
}, 30000);

// 支持快捷键 Alt+R 或 Ctrl+Shift+R 局部刷新便签
window.addEventListener("keydown", (e) => {
  if ((e.altKey && e.key.toLowerCase() === "r") || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "r")) {
    e.preventDefault();
    refreshCurrentTab(true);
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
