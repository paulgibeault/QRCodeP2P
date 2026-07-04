# POC Implementation Notes — v1.5.0 "Tiny Payloads & Link Tennis"

Working log for the serverless-signaling overhaul. Newest decisions at the bottom of each section.

## Goals (from design discussion 2026-07-04)

1. **Binary template packing** — stop shipping SDP text; ship only the entropy
   (ufrag, pwd, DTLS fingerprint, candidates) and rebuild the SDP from a template
   on the receiving side. Target: ≤ ~170 char payloads.
2. **Link tennis** — the answer travels back through the same chat thread the
   offer went out on. A tapped `#p2p-answer=` link opens a fresh tab that
   *relays* the answer to the original host tab via BroadcastChannel/localStorage,
   then confirms with an ack.
3. **Scan from image** — `Html5Qrcode.scanFile()` so a remote joiner can
   screenshot their answer QR and text it back; host decodes the screenshot.
4. **Two-mode ICE policy** — `local` (no ICE servers, pure LAN, zero external
   touch) vs `anywhere` (public STUN, still no signaling server).
5. **Reproducible tests** — Node unit tests for the codec; Playwright e2e with
   two real browser pages doing the full packed offer/answer dance.

## Architecture decisions

### Wire format (sdp-codec.js)

A packed payload is `"1." + base64url(bytes)`. The `.` cannot appear in the
legacy deflate-base64url format, so detection is unambiguous and legacy
payloads still decode (backward compat kept in `ConnectionUtils.decodePayload`).

Binary layout (big-endian):

```
byte 0        (version << 4) | flags        flags bit0: 0=offer 1=answer
byte 1..      peerId          1 len byte + ASCII bytes
              mid             1 len byte + ASCII bytes   (usually "0", packed
                              because the answer's mid MUST match the offer's)
              ice-ufrag       1 len byte + ASCII bytes
              ice-pwd         1 len byte + ASCII bytes
              fingerprint     1 len byte + raw bytes; hash algo inferred from
                              length (32=sha-256, 48=sha-384, 64=sha-512)
              candidate count 1 byte
              per candidate:
                meta byte     bits 0-1 addr kind: 0=ipv4 1=ipv6 2=mdns 3=raw
                              bits 2-3 cand type: 0=host 1=srflx 2=prflx 3=relay
                addr          ipv4: 4 bytes | ipv6: 16 bytes |
                              mdns: 16 bytes (the UUID of "uuid.local") |
                              raw: 1 len byte + ASCII (fallback for anything odd)
                port          2 bytes
```

Typical offer: 1 + 8 + 2 + ~6 + ~25 + 33 + 1 + 3×(1+4+2) ≈ **97 bytes ≈ 130
base64url chars** — QR version 5-6 at ECC M, scans instantly.

Everything else in the SDP is boilerplate reconstructed from a template:
`v=/o=/s=/t=`, BUNDLE group, `m=application 9 UDP/DTLS/SCTP webrtc-datachannel`,
`a=sctp-port:5000`, `a=max-message-size:262144`, `a=setup:actpass` (offer) /
`a=setup:active` (answer). Candidate lines are rebuilt with synthesized
foundation (index), component 1, udp, and RFC-formula priorities; srflx/relay
get `raddr 0.0.0.0 rport 0` (browsers accept the zero rel-addr).

**Known simplifications (documented, acceptable for POC):**
- `a=max-message-size` is hardcoded to 262144. Fine for game/chat payloads;
  file-transfer should chunk under 256 KB anyway.
- Assumes datachannel-only sessions with one m-line (true for this whole app).
- mDNS candidates must look like `<uuid>.local` (all shipping browsers do
  this); anything else falls back to the raw-string candidate kind.

### Why the round trip can't be eliminated
DTLS fingerprints must flow both directions and `RTCCertificate` is
generate-only in browsers (no key import), so no shared-seed trick can let the
host predict the answer. Minimum ceremony = one artifact each way. All work
goes into making each leg small (packing) and frictionless (link tennis /
QR / image / paste).

### Link tennis (p2p-ui.js)
- Offer leg unchanged: host shares `#p2p-offer=<packed>` URL via share sheet.
- Joiner's page auto-ingests, builds answer, and the primary CTA is now
  **"Send reply link"** — shares `#p2p-answer=<packed>` back through the same
  chat thread. QR remains as the collapsible secondary path.
- Host taps the reply link → opens a NEW tab (same origin) → that tab detects
  it has no pending peer for the answer → becomes a **relay**: posts the answer
  over BroadcastChannel + localStorage + window.opener, and shows
  "delivering…". The host tab applies the answer and posts back
  `{type:'answer-ack'}`; the relay tab flips to "✓ delivered, close this tab".
- Failure mode: host's default browser ≠ browser running the game →
  BroadcastChannel can't cross browsers. Covered by QR scan / image / paste
  fallbacks. (PWA installation is the long-term fix, noted as follow-on.)

### ICE modes (p2p-core.js)
`options.iceMode`: `'anywhere'` (default; public STUN — no data or signaling
transits STUN, it only reflects your public IP) or `'local'` (empty iceServers;
zero external network touch; same-LAN only). Surfaced in Advanced Settings.
mDNS note: browsers hide host IPs behind `<uuid>.local` names unless the page
holds a device-capture permission; the QR-scan flow grants camera anyway, which
un-hides real LAN IPs — helpful on networks that block mDNS multicast.

## Status log

- [x] Design agreed (see conversation) — four sub-problems: payload size,
      return leg, app re-entry, NAT.
- [x] `sdp-codec.js` written — pack/unpack + template reconstruction.
- [x] `ConnectionUtils.encodePayload/decodePayload` — packed-first with legacy
      deflate fallback on decode.
- [x] Core: `iceMode` option wired into `initPeer`.
- [x] UI: call sites swapped to encode/decode; link-tennis relay + ack;
      scan-from-image; ICE-mode toggle; stage tracker + copy transcript.
- [x] Node unit tests for codec round-trips (Chrome/Firefox-shaped SDPs,
      ipv4/ipv6/mdns/srflx candidates).
- [x] Playwright e2e: two pages, full packed offer→answer→connected→message
      round-trip over a real RTCPeerConnection pair. Also asserts payload size.
- [x] Playwright e2e: link-tennis relay across two tabs (BroadcastChannel + ack).

## Test results (2026-07-04, macOS, Chrome 138 / Playwright Firefox 151 / Playwright WebKit)

Full suite: **16 tests — 14 pass, 2 skipped** (documented environment limits).
Run from `test/`: `npm install`, `npx playwright install firefox webkit` (Chrome
uses the locally installed browser), then `npm test` and
`node --test cross-engine.test.mjs`.

### Payload sizes (the headline)

| Payload                    | Legacy deflate | Packed (new) |
| -------------------------- | -------------- | ------------ |
| Chrome offer (1 candidate) | 599 chars      | **112 chars**|
| Firefox answer             | —              | 153 chars    |
| Worst case in matrix       | —              | 153 chars    |

112-153 chars → QR version 5-7 at ECC **M** (bumped from L since we can afford
it now) → scans instantly at arm's length. URL length ~200 chars → survives
iMessage/SMS intact.

### What was proven end-to-end (automated, real browsers)

- Template-reconstructed SDP is accepted by `setRemoteDescription` in
  **Chrome, Firefox, and WebKit**, both as offer and as answer.
- chrome↔chrome (local mode, no STUN): connected in ~300ms, messages both ways.
- chrome host ↔ firefox joiner (local mode): connected in ~285ms.
- chrome host ↔ webkit joiner and webkit host ↔ chrome joiner (STUN mode):
  connected (webkit-host direction takes ~10s — WebKit sits out the full ICE
  gathering timeout before completing; acceptable, could tighten later).
- **Link tennis works**: three tabs (host / joiner-via-invite-link /
  relay-via-reply-link) — relay tab delivered the answer over BroadcastChannel,
  host acked, data channel opened, message delivered through the addon API.
- Legacy deflate payloads still decode (backward compat with v1.4 QRs/links).

### Real-world findings the tests surfaced (the valuable part)

1. **Safari/WebKit gathers ZERO ICE candidates with no STUN and no camera
   permission.** This is Safari's privacy model: host candidates require
   device access. Consequences:
   - 'local' mode (zero external servers) **cannot work on Safari via pure
     link tennis** (no camera ever granted). The QR-scan flow is immune — the
     camera grant it needs is exactly what unlocks host candidates.
   - Default mode therefore stays 'anywhere' (STUN). The core now emits a
     loud diagnostic when zero candidates are gathered instead of failing
     silently (`_warnIfNoCandidates`).
2. **Safari↔Safari over link tennis on the same LAN is srflx↔srflx**, which
   needs NAT hairpinning on the router — works on some routers, not others.
   Mitigations for later: prompt for a one-time camera grant on Safari
   ("improve connection"), or steer Safari↔Safari users to the QR flow.
3. **Firefox-as-offerer cannot complete ICE against any peer on the same
   machine** — reproduced with vanilla RTCPeerConnection (zero project code),
   headless AND headful, with and without STUN, while Firefox-as-answerer
   works fine. Filed as a same-machine artifact; needs two physical devices
   to verify Firefox hosting (not a blocker: Chrome-host ↔ Firefox-joiner is
   proven, and the codec handles Firefox SDP in unit tests).
4. WebKit zeroes out `raddr`/`rport` on its own srflx candidates — the same
   trick the codec uses for reconstruction, so that design choice is
   browser-endorsed.

### Files touched in this POC

| File | Change |
| ---- | ------ |
| `sdp-codec.js` | **new** — binary pack/unpack + SDP template reconstruction |
| `p2p-core.js` | `encodePayload`/`decodePayload` (packed-first, legacy fallback), `iceMode` option, zero-candidate warning |
| `p2p-ui.js` | all call sites on the new codec; host-side link-tennis relay + ack; scan-from-image (`Html5Qrcode.scanFile`); ICE-mode selector; stage tracker; copy-transcript; QR ECC L→M; v1.5.0 |
| `p2p-addon.css` | stage-chip styles |
| `index.html` | v1.5.0, exposes `window.__mp` for tests |
| `test/` | **new** — codec unit tests, 2-page + 3-tab e2e, cross-engine matrix |

### Next steps (not in this POC)

- Real-device kitchen-table test: iPhone Safari joiner ↔ Mac Chrome host via
  link tennis, using the stage tracker + copy-transcript to capture any
  failures. This is the moment the whole rig was built for.
- Safari camera-grant "improve connection" option (unlocks host candidates
  for LAN play without STUN).
- Persistent `RTCCertificate` (IndexedDB) → ~60-char reconnect payloads for
  previously-paired devices.
- Audio-chirp return leg (pure WebAudio FSK, ~140 bytes in 2-4s) — the
  delight feature, now trivial payload-wise.
- PWA manifest (+ Android `share_target`) for the app re-entry story.
- Lift into the arcade launcher as the `Arcade.peer` backbone
  (launcher owns the connection; games multiplex via postMessage).
