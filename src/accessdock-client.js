export async function checkAccess(request, env, options = {}) {
  const baseUrl = String(env.ACCESSDOCK_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    return {
      ok: false,
      response: new Response("Missing ACCESSDOCK_BASE_URL", { status: 500 }),
      result: { allowed: false, reason: "missing_accessdock_base_url" },
    };
  }

  const url = new URL(request.url);
  if (options.resourcePath) {
    url.pathname = options.resourcePath;
    url.search = "";
  }

  const checkUrl = `${baseUrl}/api/check?return=${encodeURIComponent(url.toString())}`;
  const response = await fetch(checkUrl, {
    headers: {
      cookie: request.headers.get("cookie") || "",
    },
  });

  const result = await response.json();
  if (result.allowed) {
    return { ok: true, result };
  }

  if (result.loginUrl) {
    return {
      ok: false,
      response: Response.redirect(result.loginUrl, 302),
      result,
    };
  }

  return {
    ok: false,
    response: new Response("Forbidden", { status: 403 }),
    result,
  };
}
