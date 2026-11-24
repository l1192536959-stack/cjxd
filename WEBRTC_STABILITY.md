# WebRTC stability rollout

This branch improves client-side recovery behavior while preserving the existing UI and room features.

## What changed in index.html

- TURN credential requests have an 8-second timeout, accept either an ICE-server array or an `{ "iceServers": [...] }` response, validate URL schemes, and avoid retaining potentially expired dynamic credentials after a failed refresh.
- Peer connections explicitly keep both direct and relay candidates available (`iceTransportPolicy: "all"`); the browser can prefer direct P2P and fall back to TURN when a relay candidate is available.
- ICE recovery now uses exponential backoff instead of permanently stopping after three retries.
- Browser online/offline and tab visibility changes trigger a recovery pass; a suspended Web Audio context is resumed when possible.
- Remote audio track mute/unmute/end events are reflected in the member status, and remote audio nodes are cleaned up when a peer is removed.

## Production TURN service: Cloudflare Realtime TURN

The project now includes a Cloudflare Worker endpoint at `GET /api/turn-credentials`. The existing page defaults to this same-origin endpoint; no visitor needs to enter a TURN URL or API key. The endpoint requests fresh credentials from Cloudflare and returns only short-lived ICE credentials.

### 1. Create the Cloudflare TURN key

1. Open the Cloudflare Dashboard and select the account that owns the `cjxd` Worker.
2. Open **Realtime → TURN Server** and create a TURN server/key.
3. Save the returned **TURN Token ID** and **TURN API Token/secret** securely. The secret is shown only during creation; do not paste it into GitHub, this chat, or the browser UI.
4. Cloudflare's managed TURN service supports UDP, TCP, and TLS. Its global anycast service does not use Cloudflare's China Network, so test carefully from mainland China and every target carrier.
5. TURN traffic is billed by outbound data (currently documented at USD $0.05/real-time GB unless used with Realtime SFU). Monitor usage and set account billing alerts.

### 2. Add the two Worker Secrets

From the repository root, deploy the Worker using Wrangler after logging into the correct Cloudflare account:

```bash
npx wrangler secret put REALTIME_TURN_TOKEN_ID
npx wrangler secret put REALTIME_TURN_TOKEN_SECRET
```

Enter the corresponding values when prompted. These are Worker Secrets, not ordinary `vars`. Never commit a `.dev.vars` file or secret values.

The Worker uses a 12-hour credential TTL, filters the browser-incompatible port 53 URLs, validates that Cloudflare returned a credentialed TURN server, and responds with `Cache-Control: no-store`. The provider key is never returned to the browser.

### 3. Deploy

The new `wrangler.jsonc` configures the existing root `index.html` as Workers Static Assets and sends `/api/*` through `worker.js`. After adding both secrets:

```bash
npx wrangler deploy
```

If the current production Worker is managed from a different Cloudflare project or has a different Worker name, do not overwrite it blindly. First confirm the active deployment's name/build settings and reconcile them with this `wrangler.jsonc`.

### 4. Protect the public credential endpoint

The endpoint rejects cross-site browser requests and does not cache credentials. Because this is a public voice application, also create a Cloudflare **WAF → Rate limiting rule** for the exact path `/api/turn-credentials`, keyed by client IP. A conservative starting policy is 30 requests per minute per IP with a short block period; tune it against real room-join traffic. Origin checks alone are not a substitute for rate limiting.

### 5. Verify the endpoint and relay

After deploy, open:

```
https://YOUR-WORKER-DOMAIN/api/turn-credentials
```

A successful response contains an `iceServers` array with `turn.cloudflare.com` URLs plus a username and credential. Treat that response as temporary secret material; do not post it publicly.

Then open the app in two devices on different networks, join the same room, and speak in both directions. In Chrome/Edge, open `chrome://webrtc-internals` before joining. Confirm:
- ICE gathers relay candidates (`typ relay`).
- When direct P2P is unavailable, the selected candidate pair uses a relay candidate.
- The remote audio inbound `bytesReceived` counter increases.
- Both users can hear each other after changing Wi-Fi/cellular networks.

Cloudflare TURN is a relay fallback, not a guarantee that every carrier path will work. In particular, verify the experience from mainland China and restrictive enterprise/campus networks before treating the rollout as complete.

## Security note

Do not put the long-lived TURN API token in `index.html`, query parameters, localStorage, GitHub, or a public issue. Only the short-lived username/credential pair is sent to each browser, and those credentials expire after 12 hours.
 
## Rollout and acceptance checklist

- [ ] Deploy this branch to a staging Worker first.
- [ ] Verify join/leave, room discovery, chat, mute/deafen, per-peer volume, mic device switching, and avatars.
- [ ] Test Wi-Fi to cellular switching while in a room.
- [ ] Test two or more carriers and at least one restrictive network.
- [ ] Confirm a TURN relay candidate is gathered and selected when direct connectivity fails.
- [ ] Confirm reconnect does not create duplicate member cards or duplicate audio playback.
- [ ] Only then merge and promote the Worker deployment.
