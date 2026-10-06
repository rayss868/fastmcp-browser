# Remote Bridge Architecture

**Status:** Draft / Proposal
**Date:** 2026-10-05
**Scope:** Allow the MCP server ↔ extension WebSocket bridge to be reachable from another machine, so an AI client on machine B drives a browser running on machine A with no code changes to the extension in the simplest variant.

---

## 1. Why

Today every hop is hardwired to loopback:

```
AI client ──stdio──► server (MCP + WS bridge) ──127.0.0.1:9229──► extension
              (hop 1: stdio)                    (hop 2: loopback, same machine)
```

Users want remote scenarios: an AI client on a VPS or another laptop driving the *real, logged-in* browser profile on a home workstation. The current code cannot do that without changes, because:

- `server/src/bridge.ts:246` binds the WebSocket server to `127.0.0.1` (loopback only).
- `extension/src/background.js:384` connects to `ws://127.0.0.1:${PORT}` (fixed).
- The bridge identity / token handshake (`bridge.ts`, `session.js`) is designed for loopback trust.

## 2. Goals / non-goals

### Goals
- Let an AI client on machine B drive a browser on machine A.
- Keep zero config for the default local case (no regressions in the current loopback UX, extension tests, or benchmark).
- Preserve multi-instance: several browser profiles can still connect.
- Security is a first-class concern: no open-by-default port, token is mandatory when remote.

### Non-goals (for now)
- Headless / browser launching. The extension still automates browsers that are already running.
- Native WebRTC or other P2P. Tunnels and bridges cover the requirement.
- Changing the MCP transport (still stdio on the client side).

## 3. Topology options

We evaluate three ways to make the bridge reachable remotely.

### Option A — SSH/network tunnel, zero code change (recommended)
Run the MCP server next to the browser (machine A). On machine B, create a forward:

```
# On B:
ssh -L 9229:127.0.0.1:9229 user@machine-A
```

B's `127.0.0.1:9229` tunnels to A's bridge. The extension and server need **no code change**; only the client's MCP config points at B's own loopback. Good when B can reach A via SSH.

### Option B — Bind + configurable endpoint in the extension (code change, in-repo)
Make the server bind anywhere and let the extension learn its bridge endpoint:

1. `server/src/bridge.ts` — accept a bind host via env (`FASTMCP_HOST`, default `127.0.0.1`).
2. `extension/src/background.js` — read bridge URL from `browser.storage.local` (`bridgeUrl`), fall back to `ws://127.0.0.1:9229`.
3. `manifest` — add a `connect-src` directive (see §5) so the extension may reach non-loopback WSS endpoints.
4. Token policy — when the bridge binds beyond loopback, refuse the default token: require `FASTMCP_TOKEN` (else start in loopback-only mode). Never ship the dev default over a non-loopback bind.

Pairs naturally with a TLS reverse proxy (Caddy/traefik) that terminates WSS and passes through to `127.0.0.1:9229` — keeps the browser extension talking to a public WSS endpoint without exposing a raw port.

### Option C — Outbound tunnel (ngrok / Cloudflare Tunnel / Tailscale)
Run a tunnel agent on A that exposes `127.0.0.1:9229` publicly (or into a private mesh). The extension must reach the public endpoint, so Option B's configurable endpoint is still required on the extension side. Cloudflare / Tailscale also give auth in front of the socket. Best when A has no inbound connectivity.

### Decision
- Default local behavior stays loopback-only (**no behavior change**).
- Implement Option B as the in-repo change (small, testable).
- Document Options A and C as operational recipes in the same doc.

## 4. Changes to existing code (Option B)

### `server/src/bridge.ts`
- Env `FASTMCP_HOST` (default `127.0.0.1`) passed into `createBridge(port, token, host)`.
- `new WebSocketServer({ host, port })` at line `246`.
- Loopback guard: when `host` is not loopback:
  - require `FASTMCP_TOKEN` explicitly set (non-default), else refuse to start;
  - warn about the absence of TLS and recommend a proxy.
- Peer bootstrap (`createBridge` -> `becomePeer`) still uses `127.0.0.1` for the host-socket — acceptable because peers on the same machine should still find each other via loopback.

### `extension/src/background.js`
- Add `bridgeUrl()` helper reading `browser.storage.local` key `bridgeUrl` first, then `fastmcpEndpoint` from storage, then `'ws://127.0.0.1:9229'`.
- Keep the existing manual-token override (`fastmcpToken` storage key + manifest `fastmcpToken`), so a public endpoint + real token both travel together.
- Add a small endpoint picker in `status.html` (optional) to set `bridgeUrl` in storage — this stays out of the automation hot path.

### `extension/manifest.*.json`
- Add `content_security_policy.extension_pages` with `connect-src 'self' ws://127.0.0.1:* https: wss:` (or narrower) so the service worker can open the configured remote socket.

### Tests
- `server`: unit test that `createBridge` refuses a non-loopback bind without an explicit token; parse env mapping.
- `extension`: test `bridgeUrl()` resolver precedence (storage > manifest default), and that fallback stays `ws://127.0.0.1:9229`.

## 5. Security notes

- The bridge currently trusts whoever knows the shared token. On a non-loopback bind that is the entire attack surface: **do not use the default token**.
- Do not expose port 9229 directly to the Internet without TLS + auth. Wrap in WSS via a reverse proxy (Caddy/traefik) or use a tunnel that provides mTLS (Tailscale) or URL-scoped auth.
- Review the peer-join handshake for remote abuse (an open peer can relay local commands). The bridge must keep the loopback/peer semantics distinct from remote connections; mark remote sockets and route accordingly.
- Changes to CSP may affect Firefox vs Chromium manifest — keep both test green.

## 6. Operations recipes

### SSH forward (recommended for LAN / trusted host)
```bash
# machine B (the AI client / MCP host):
ssh -N -L 9229:127.0.0.1:9229 user@machine-A
# server on A: FASTMCP_HOST kept loopback; B just sees its own 127.0.0.1:9229
```

### Cloudflare Tunnel (no inbound needed on A)
```bash
# machine A:
cloudflared tunnel --url http://127.0.0.1:9229
# expose the `wss://<public>.trycloudflare.com` endpoint
# set bridgeUrl in the extension; FASTMCP_TOKEN must be set on the server
```

### Tailscale (private mesh, mTLS)
```bash
# tailscale up on both machines; expose A's 9229 inside the tailnet
# extension bridgeUrl = ws://<A-tailnet-ip>:9229 ; server binds 0.0.0.0 with an explicit token
```

### Direct bind behind TLS proxy (enterprise)
```text
Caddy:  reverse_proxy wss://fastmcp.example.com → 127.0.0.1:9229
server: FASTMCP_HOST=127.0.0.1 FASTMCP_TOKEN=<strong>   (proxy is the only external entry)
extension bridgeUrl = wss://fastmcp.example.com
```

## 7. Limitations we keep (on purpose)
- `browser_upload` (`server/src/tools.ts`) reads `paths` on the machine running the **server**. In a remote setup the paths must exist on machine A (the browser/server host), not on B. Unchanged behavior, must be documented.
- Network observation buffers live per tab in the browser; remote latency affects round-trip but not correctness.
- Larger snapshots (visual mode, screenshot) pay increased latency over a tunnel; none of them break.

## 8. Rollout
1. [ ] `docs/remote-bridge.md` written (this document).
2. [ ] Fork + PR (see Instructions, part 2): Option B code in-repo.
3. [ ] Keep both test suites green: `npm test` in `server/`, `node --test tests/*.test.mjs` in `extension/`.
4. [ ] Once merged upstream (or in the fork), add operational recipes to README.