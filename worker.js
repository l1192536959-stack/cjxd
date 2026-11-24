/**
 * cjxd Cloudflare Worker
 * Serves the existing static app and proxies scoped
 * Metered Open Relay ICE credentials. Provider keys stay in Worker Secrets.
 */
const METERED_API_TIMEOUT_MS = 10000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, no-cache, must-revalidate, private",
      "pragma": "no-cache",
      "x-content-type-options": "nosniff",
      "referrer-policy": "same-origin",
      ...extraHeaders,
    },
  });
}

function isSameOriginRequest(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return false;
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite === "cross-site") return false;
  const referer = request.headers.get("Referer");
  if (!origin && referer) {
    try {
      if (new URL(referer).origin !== url.origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function filterIceServers(payload) {
  const input = Array.isArray(payload)
    ? payload
    : (Array.isArray(payload?.iceServers) ? payload.iceServers : []);
  const output = [];

  for (const server of input) {
    if (!server || !server.urls) continue;
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((value) => typeof value === "string")
      .filter((value) => /^(stun|stuns|turn|turns):/i.test(value))
      .filter((value) => !/:53(?:\\?|$)/.test(value));
    if (!urls.length) continue;

    const item = { urls };
    if (typeof server.username === "string") item.username = server.username;
    if (typeof server.credential === "string") item.credential = server.credential;
    if (server.credentialType === "password") item.credentialType = "password";
    output.push(item);
  }

  const credentialedTurn = output.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((value) => /^(turn|turns):/i.test(value))
      && Boolean(server.username)
      && Boolean(server.credential);
  });
  if (!credentialedTurn) {
    throw new Error("Metered did not return credentialed TURN servers");
  }
  return output;
}

async function issueTurnCredentials(env) {
  const appDomain = String(env.METERED_APP_DOMAIN || "").trim().toLowerCase();
  const apiKey = env.METERED_TURN_API_KEY;
  // Accept only the exact Metered app hostname; never allow arbitrary upstream URLs.
  if (!/^[a-z0-9-]+\\.metered\\.live$/.test(appDomain) || !apiKey) {
    return json({
      error: "TURN_NOT_CONFIGURED",
      message: "免费 TURN 服务尚未完成配置",
    }, 503);
  }

  const endpoint = new URL(`https://${appDomain}/api/v1/turn/credentials`);
  endpoint.searchParams.set("apiKey", apiKey);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), METERED_API_TIMEOUT_MS);
  try {
    const upstream = await fetch(endpoint.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!upstream.ok) {
      console.error("Metered TURN credential request failed:", upstream.status);
      return json({
        error: "TURN_PROVIDER_ERROR",
        message: "暂时无法获取免费语音中继凭证，请稍后重试",
      }, 502);
    }

    const payload = await upstream.json();
    const iceServers = filterIceServers(payload);
    return json({
      iceServers,
      provider: "metered-open-relay",
    });
  } catch (error) {
    console.error("Metered TURN credential request failed:", error?.name || "Error");
    return json({
      error: "TURN_UNAVAILABLE",
      message: "免费语音中继服务暂时不可用",
    }, 502);
  } finally {
    clearTimeout(timeout);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/turn-credentials") {
      if (request.method !== "GET") {
        return json({ error: "METHOD_NOT_ALLOWED" }, 405, { allow: "GET" });
      }
      if (!isSameOriginRequest(request, url)) {
        return json({ error: "ORIGIN_NOT_ALLOWED" }, 403);
      }
      return issueTurnCredentials(env);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
