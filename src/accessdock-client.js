export async function checkAccess(request, env, options = {}) {
  const baseUrl = String(env.ACCESSDOCK_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    return failure("Missing ACCESSDOCK_BASE_URL", 500, "missing_accessdock_base_url");
  }

  const url = new URL(request.url);
  if (options.resourcePath) {
    url.pathname = options.resourcePath;
    url.search = "";
  }

  const checkUrl = `${baseUrl}/api/check?return=${encodeURIComponent(url.toString())}`;
  const checkRequest = new Request(checkUrl, {
    method: "GET",
    headers: {
      cookie: request.headers.get("cookie") || "",
    },
  });

  let response;
  try {
    response =
      env.ACCESSDOCK && typeof env.ACCESSDOCK.fetch === "function"
        ? await env.ACCESSDOCK.fetch(checkRequest)
        : await fetch(checkRequest);
  } catch (error) {
    console.error("AccessDock request failed:", error);
    return failure("AccessDock request failed", 502, "accessdock_request_failed");
  }

  let result;
  try {
    // AccessDock returns 401 with a JSON loginUrl for protected requests.
    result = await response.json();
  } catch (error) {
    console.error("Invalid AccessDock response:", response.status, error);
    return failure("Invalid AccessDock response", 502, "invalid_accessdock_response");
  }

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

function failure(message, status, reason) {
  return {
    ok: false,
    response: new Response(message, { status }),
    result: { allowed: false, reason },
  };
}
