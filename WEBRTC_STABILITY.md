# WebRTC stability rollout

This branch improves client-side recovery behavior while preserving the existing UI and room features.

## Client-side reliability changes

- TURN credential requests have an 8-second timeout, accept either an ICE-server array or an `{ "iceServers": [...] }` response, validate URL schemes, and avoid retaining potentially expired dynamic credentials after a failed refresh.
- Peer connections keep direct and relay candidates available (`iceTransportPolicy: "all"`); browsers can prefer direct P2P and fall back to TURN when a relay candidate is available.
- ICE recovery uses exponential backoff.
- Browser online/offline and tab visibility changes trigger a recovery pass; suspended Web Audio contexts are resumed when possible.
- Remote audio track mute/unmute/end events are reflected in member status, and remote audio nodes are cleaned up when a peer is removed.

## Free TURN relay: Metered Open Relay

The project uses a same-origin Cloudflare Worker endpoint at `GET /api/turn-credentials`. The Worker fetches the ICE server list from Metered Open Relay and returns it to the browser. The Metered API key is stored as a Worker Secret, not in `index.html`.

Metered currently advertises **20 GB of free TURN relay traffic per month** for Open Relay. This is a limited free allowance, not unlimited bandwidth. If the allowance is exhausted, relay service may stop or require a paid plan. Direct P2P can still work without TURN, but some NAT/firewall combinations will fail. Confirm the current free-tier terms in the Metered dashboard before relying on it.

Official references:
- [Open Relay overview and free allowance](https://www.metered.ca/tools/openrelay/)
- [TURN Server REST API](https://www.metered.ca/docs/turn-rest-api/)
- [TURN Server Quickstart](https://www.metered.ca/docs/turn-server-service/quickstart/)

### 1. Create a free Metered account and TURN credential

1. Open [Metered Open Relay](https://www.metered.ca/tools/openrelay/) and choose the free signup option.
2. If the signup flow asks for a payment card or paid subscription, stop there; do not enter payment details. Confirm the free plan is available to your account first.
3. In the Metered dashboard, open **TURN Server → Credentials** and create a credential.
4. On that credential's row, choose **Get credential → Show API Key** and copy its credential-scoped API key.
5. In **Developers**, copy your Metered app domain. It must look like `yourappname.metered.live`.
6. Keep the API key private. Although Metered documents this credential-scoped key as safe for browser use, this project proxies it through the Worker so it is not embedded in the public page.

A newly created TURN credential may take up to 2 minutes to propagate. If the first relay allocation fails, wait briefly and retry.

### 2. Configure Cloudflare Worker Secrets

The existing Cloudflare Worker remains the same-origin backend and static-site host. It does not use Cloudflare Realtime TURN and does not require Cloudflare Realtime billing.

Configure these two Worker Secrets for the `cjxd` Worker:

- `METERED_APP_DOMAIN`: your exact Metered hostname, for example `yourappname.metered.live` (hostname only; no `https://` and no trailing slash).
- `METERED_TURN_API_KEY`: the API key shown for the TURN credential in Metered.

Using Wrangler from the repository root:

```bash
npx wrangler secret put METERED_APP_DOMAIN
npx wrangler secret put METERED_TURN_API_KEY
```

Enter each value when prompted. Alternatively, add them as encrypted Secrets in the Cloudflare Worker settings. Do not add them as plain-text variables and never commit them to GitHub, `.dev.vars`, browser storage, or chat.

### 3. Deploy

The `wrangler.jsonc` file configures the Worker and the existing root `index.html` as Workers Static Assets. After configuring the two secrets, deploy only after confirming that this Worker configuration matches the currently active `cjxd` deployment:

```bash
npx wrangler deploy
```

If the current production Worker is managed from a different Cloudflare project or has different build settings, do not overwrite it blindly. Confirm the active deployment's name and build settings first.

### 4. Protect the public credential endpoint

The endpoint rejects cross-site browser requests and does not cache credentials. Origin checks alone do not prevent scripts or non-browser clients from calling a public endpoint. Add a Cloudflare WAF rate-limit rule for the exact path `/api/turn-credentials`, keyed by client IP. A conservative starting policy is 30 requests per minute per IP; tune it against real room-join traffic.

Monitor Metered usage in its dashboard. The free relay allowance is shared by all users of this app, so a public room can consume it quickly. If Metered offers a quota or credential-disable control on the selected free plan, set a limit and alert. Revoke/rotate the credential if its API key is exposed.

### 5. Verify the endpoint and relay

After deploy and secret configuration, open:

```
https://YOUR-WORKER-DOMAIN/api/turn-credentials
```

A successful response contains an `iceServers` array with credentialed `turn:` or `turns:` URLs. Treat the returned username/password as temporary authentication material; do not post the response publicly.

Then open the app on two devices using different networks, join the same room, and speak in both directions. In Chrome/Edge, open `chrome://webrtc-internals` before joining. Confirm:
- ICE gathers relay candidates (`typ relay`).
- When direct P2P is unavailable, the selected candidate pair uses a relay candidate.
- The remote audio inbound `bytesReceived` counter increases.
- Both users can hear each other after switching between Wi-Fi and cellular networks.

A TURN relay is a fallback, not a guarantee that every carrier path will work. Test from mainland China and each target carrier. Metered's global routing may have different latency or reachability depending on the user's network.

## Security and cost notes

- The Worker accepts only a Metered `*.metered.live` hostname to avoid becoming an arbitrary URL proxy.
- The Metered API key stays in Worker Secrets. Only ICE server credentials are returned to browsers.
- The free Open Relay allowance is currently advertised as 20 GB/month; it is not unlimited and terms can change.
- If the free quota is exhausted, users may fall back to direct P2P, but peers behind restrictive NAT/firewalls may not connect.
- Do not claim production stability until the relay candidate and two-way audio tests pass across the target networks.

## Rollout and acceptance checklist

- [ ] Create Metered free account and confirm the free Open Relay allowance is available without entering payment details.
- [ ] Create a TURN credential and wait for propagation.
- [ ] Configure `METERED_APP_DOMAIN` and `METERED_TURN_API_KEY` as Cloudflare Worker Secrets.
- [ ] Deploy to a staging Worker first.
- [ ] Verify the credential endpoint returns a valid TURN server.
- [ ] Verify join/leave, room discovery, chat, mute/deafen, per-peer volume, mic device switching, and avatars.
- [ ] Test Wi-Fi to cellular switching while in a room.
- [ ] Test two or more carriers and at least one restrictive network.
- [ ] Confirm a TURN relay candidate is gathered and selected when direct connectivity fails.
- [ ] Confirm reconnect does not create duplicate member cards or duplicate audio playback.
- [ ] Monitor monthly relay usage and keep the project within the free allowance.
- [ ] Only then merge and promote the Worker deployment.
