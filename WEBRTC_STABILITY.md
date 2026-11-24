# WebRTC stability rollout

This branch improves client-side recovery behavior while preserving the existing UI and room features.

## What changed in index.html

- TURN credential requests have an 8-second timeout, accept either an ICE-server array or an `{ "iceServers": [...] }` response, validate URL schemes, and avoid retaining potentially expired dynamic credentials after a failed refresh.
- Peer connections explicitly keep both direct and relay candidates available (`iceTransportPolicy: "all"`); the browser can prefer direct P2P and fall back to TURN when a relay candidate is available.
- ICE recovery now uses exponential backoff instead of permanently stopping after three retries.
- Browser online/offline and tab visibility changes trigger a recovery pass; a suspended Web Audio context is resumed when possible.
- Remote audio track mute/unmute/end events are reflected in the member status, and remote audio nodes are cleaned up when a peer is removed.

## Important: client changes alone cannot guarantee cross-carrier voice

The current repository contains only `index.html`. It has no TURN relay server or server-side credential endpoint. The current default configuration contains public STUN servers, but no production TURN relay. STUN helps peers discover public network mappings; it does not relay media. Users behind symmetric NAT, carrier-grade NAT, or restrictive firewalls may still connect to the room but fail to exchange audio.

For reliable service across mobile carriers and regions, deploy a production TURN service and make it available to every user:

1. Provision a managed TURN provider or a Coturn server with adequate bandwidth and regional capacity.
2. Enable TURN over UDP and TCP, plus TURN/TLS over TCP (commonly 5349 or 443 where supported). Open the configured relay UDP port range in the firewall/security group.
3. Put the provider API key or Coturn shared secret in a server-side secret store (for Cloudflare Workers, use Worker Secrets). Do not put a long-lived provider API key in `index.html`, a query string, or browser localStorage.
4. Expose a same-origin HTTPS endpoint that returns short-lived ICE credentials in this format:

```json
[
  {
    "urls": [
      "turn:turn.example.com:3478?transport=udp",
      "turn:turn.example.com:3478?transport=tcp",
      "turns:turn.example.com:5349?transport=tcp"
    ],
    "username": "short-lived-username",
    "credential": "short-lived-password"
  }
]
```

5. Configure the TURN API URL in the advanced network settings for each client during the pilot. For production, set a site-wide default endpoint in the application so users do not need to configure it manually. The endpoint must allow CORS from the site origin and return fresh credentials with `Cache-Control: no-store`.
6. Test with two devices on different carriers (for example, one Wi-Fi and one 4G/5G). In Chrome/Edge, open `chrome://webrtc-internals` before joining. Confirm the selected candidate pair is `relay` when direct P2P is blocked, and confirm inbound audio `bytesReceived` increases.

## Security note

The existing advanced setting accepts a TURN API URL in the browser. If that URL embeds a long-lived API key, every visitor can inspect and copy it. Use a server-side Worker endpoint with secrets and short-lived TURN credentials instead. Do not commit provider keys or TURN passwords to this repository.

## Rollout and acceptance checklist

- [ ] Deploy this branch to a staging Worker first.
- [ ] Verify join/leave, room discovery, chat, mute/deafen, per-peer volume, mic device switching, and avatars.
- [ ] Test Wi-Fi to cellular switching while in a room.
- [ ] Test two or more carriers and at least one restrictive network.
- [ ] Confirm a TURN relay candidate is gathered and selected when direct connectivity fails.
- [ ] Confirm reconnect does not create duplicate member cards or duplicate audio playback.
- [ ] Only then merge and promote the Worker deployment.
