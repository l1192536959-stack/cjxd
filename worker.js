/**
 * cjxd Cloudflare Worker
 * Serves the existing static app through Workers Assets and issues short-lived
 * Cloudflare Realtime TURN credentials. Long-lived secrets stay in Worker Secrets.
 */
const TURN_TTL_SECONDS = 12 * 60 * 60; // 12 hours; Cloudflare maximum is 48 hours
const TURN_API_BASE = "https://rtc.live.cloudflare.com/v1/turn/keys";

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

  // Reject cross-site browser fetches. Same-origin requests are allowed.
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
  const input = Array.isArray(payload?.iceServers) ? payload.iceServers : [];
  const output = [];

  for (const server of input) {
    if (!server || !server.urls) continue;
    const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
      .filter((value) => typeof value === "string")
      .filter((value) => !/:53(?:\?|$)/.test(value));

    if (!urls.length) continue;
    const item = { urls };
    if (typeof server.username === "string") item.username = server.username;
    if (typeof server.credential === "string") item.credential = server.credential;
    if (server.credentialType === "password") item.credentialType = "password";
    output.push(item);
  }

  // Require an actual TURN URL and short-lived credentials, not just STUN.
  const hasTurn = output.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((value) => /^(turn|turns):/i.test(value));
  });
  const credentialedTurn = output.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    return urls.some((value) => /^(turn|turns):/i.test(value))
      && Boolean(server.username)
      && Boolean(server.credential);
  });

  if (!hasTurn || !credentialedTurn) {
    throw new Error("Cloudflare did not return valid TURN credentials");
  }
  return output;
}

async function issueTurnCredentials(env) {
  const keyId = env.REALTIME_TURN_TOKEN_ID;
  const keySecret = env.REALTIME_TURN_TOKEN_SECRET;
  if (!keyId || !keySecret) {
    return json({ error: "TURN_NOT_CONFIGURED", message: "语音中继服务尚未完成配置" }, 503);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const upstream = await fetch(
      `${TURN_API_BASE}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${keySecret}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: controller.signal,
      },
    );

    if (!upstream.ok) {
      // Do not expose provider response bodies or secret-related details.
      console.error("Cloudflare TURN credential request failed:", upstream.status);
      return json({ error: "TURN_PROVIDER_ERROR", message: "暂时无法获取语音中继凭证，请稍后重试" }, 502);
    }

    const payload = await upstream.json();
    const iceServers = filterIceServers(payload);
    return json({
      iceServers,
      expiresInSeconds: TURN_TTL_SECONDS,
      provider: "cloudflare-realtime-turn",
    });
  } catch (error) {
    console.error("TURN credential generation failed:", error?.name || "Error");
    return json({ error: "TURN_UNAVAILABLE", message: "语音中继服务暂时不可用" }, 502);
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

    // Workers Static Assets binding serves the existing index.html and other assets.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not Found", { status: 404 });
  },
};
