# Reconnect Rendezvous — design document

> **STATUS: IMPLEMENTED in v1.9** — see `PROTOCOL.md` §7 for the normative
> spec and `rendezvous.js` / `rendezvous-crypto.js` / `rendezvous-carriers.js`
> for the implementation. Deviations from this design, chosen during
> implementation: (1) the dependency-free carrier is minimal **MQTT 3.1.1
> over WSS** — Nostr needs secp256k1 signing (a vendored dependency) and
> remains a future carrier; (2) caller/listener roles derive from the
> **pairing randoms** (lower hex = caller), not deviceIds, keeping the
> transport app-agnostic; (3) pair labels are **local to each side**
> (correlation is by link); (4) the caller uses a **shadow connection** so
> the v1.7 in-band repair keeps first claim on the link, and adoption
> (`PeerManager.adoptConnection`) resumes the session from the live entry
> or the terminal-death stash. The rest of this document matches what
> shipped.

v1.7's resilience layer heals every disruption that leaves the data channel
recoverable: suspends, blips, single-ended network changes. What it cannot
heal is a **fully dead channel** (both ends changed networks, SCTP torn down,
browser killed the tab) — the in-band signaling path died with it, and today
the only recovery is a fresh manual QR/link ceremony.

This doc designs the escape hatch: an **opt-in, per-pair, end-to-end-encrypted
rendezvous** that lets two devices that already paired manually once find each
other again and re-run signaling automatically — without this project growing
a server, an account system, or a plaintext byte on any third-party wire.

## Philosophy constraints (unchanged from v1)

1. No infrastructure we operate. Carriers must be free, public, redundant,
   and swappable (Nostr relays are the primary candidate: plain WSS, ephemeral
   events, many independent operators; public MQTT-over-WSS brokers are the
   fallback carrier behind the same interface).
2. The manual ceremony remains the ONLY way to establish trust. The
   rendezvous can never introduce a stranger — it can only re-introduce a
   pair that holds a secret born during a face-to-face (QR/link) pairing.
3. Games never see any of this. The SDK vocabulary stays
   `idle | connecting | connected | interrupted`.

## Threat model

| Adversary | Capability | Must NOT be able to |
|---|---|---|
| Relay operator | sees all published events, IPs, timing | read/forge signaling, identify the pair, track it across days |
| Network observer | sees WSS connections to relays | learn more than "this IP spoke to a public relay" |
| Other relay users | can publish to any topic | impersonate a peer, MITM a reconnect, replay old offers |
| A malicious *game* (iframe) | full SDK access | trigger, observe, or influence rendezvous at all |
| Device thief with localStorage dump | pair secrets | silently impersonate forever (bounded by ratchet + revocation) |

## Cryptographic design

**Root of trust — pairing.** While the first (manually-ceremonied, DTLS-
protected) data channel is open, each side sends 32 random bytes
(`crypto.getRandomValues`). Both derive:

```
pairSecret_0 = HKDF-SHA256(ikm = sortedConcat(randA, randB),
                           info = "qrp2p/rendezvous/v1", salt = zeros)
```

The DTLS channel's authenticity is anchored in the QR ceremony (the SDP
fingerprints rode the QR/link), so `pairSecret_0` inherits the face-to-face
trust. From `pairSecret_n` derive independent subkeys:

- `topicKey_n`  — HMAC key for rendezvous topic derivation
- `aeadKey_n`   — AES-256-GCM key for signaling payloads

**Unlinkable topics.** The rendezvous topic for a UTC day window `d` is
`HMAC(topicKey_n, "topic" || d)` truncated to 16 bytes, hex. Relays see a
random-looking topic that rotates daily and is computable only by the pair.
No deviceId, name, or stable identifier ever leaves the devices.

**Sealed signaling.** Every published event is
`AES-GCM(aeadKey_n, nonce=random96, aad = epoch || direction)` over a packed
payload (`SDPCodec.pack` output — the same ≤200-char blobs as the QR). GCM
gives confidentiality + integrity; **decrypt-then-parse**: anything that fails
authentication is dropped before any parsing touches it, so relay-injected
garbage has zero code-path surface.

**Replay & ordering.** Each pair persists a strictly-increasing `epoch`
(uint64). A reconnect attempt uses `epoch = max(stored)+1` in the AAD;
responders reject epochs ≤ the highest they've completed. Old ciphertexts are
therefore dead on arrival, even same-day.

**Ratchet (post-compromise recovery + forward secrecy).** On every successful
reconnect: `pairSecret_{n+1} = HKDF(pairSecret_n, info = "ratchet" ||
transcriptHash)` where `transcriptHash` covers both DTLS fingerprints of the
NEW connection. A copied localStorage snapshot goes stale at the pair's next
successful reconnect; recorded relay traffic never decrypts to future keys.

**MITM impossibility argument.** The offer/answer SDPs — including the DTLS
fingerprints of the new connection — travel only inside the AEAD. An attacker
without `pairSecret_n` cannot read or substitute fingerprints, so the DTLS
handshake that results is pinned end-to-end to the pair. A relay can only
delay or drop (DoS), which degrades to today's status quo: manual re-pair.

## Protocol sketch

Deterministic roles: the device with the lexicographically smaller
`deviceId` (exchanged during pairing, stored locally, never published) is the
**caller**; the other **listens**. Both MAY listen; only the caller publishes
first.

```
1. Trigger: a link died terminally (v1.7 grace expired / channel closed)
   AND the pair has rendezvous enabled. Also on launcher startup if a
   "resume session?" flag was persisted before the tab died.
2. Caller: connect to K relays (default 3), SUBSCRIBE topic(d),
   PUBLISH seal{ type:'offer', packedSDP, epoch }.
   Exponential backoff: 0s, 5s, 30s, then every 5 min, give up after 1 h.
3. Listener: on seal{'offer'} that authenticates and has a fresh epoch:
   build answer on a NEW RTCPeerConnection, PUBLISH seal{ type:'answer',
   packedSDP, epoch }.
4. Both: on connection, PeerManager.adoptConnection(peerId, newPc) swaps the
   RTCPeerConnection under the EXISTING peer entry — outbox, seq counters and
   session state survive, so the v1.7 resync/replay machinery makes the
   handover seamless to games. Then ratchet, persist epoch, disconnect from
   relays.
```

Relay I/O is isolated in a `RendezvousCarrier` interface (connect/publish/
subscribe/close) so Nostr vs MQTT vs anything else is a plug-in choice and
tests can inject a loopback carrier.

## Product / UX safeguards

- **Opt-in, per pair.** At first pairing the launcher asks: "Reconnect with
  ⟨name⟩ automatically if the connection breaks? Uses public relays; message
  content never leaves your devices unencrypted." Stored per known peer;
  revocable from the Known Peers panel (revocation deletes the pair secret).
- **No idle presence.** Devices connect to relays only while actively
  repairing (or during the startup resume check) — no standing "I'm online"
  beacon, which keeps both the privacy footprint and relay load minimal.
- **Visible state.** While the rendezvous runs, the SDK/UI status is the
  existing 'interrupted' ("Reconnecting…"); on give-up it becomes 'idle' with
  the normal manual re-pair path.

## Storage

`pairSecret_n` imported as non-extractable `CryptoKey`s (HKDF/HMAC/AES) in
IndexedDB, alongside `{ epoch, deviceId, enabledFlag }`. Raw bytes are never
kept in localStorage. Everything is deleted by known-peer removal.

## Implementation plan (when picked up)

1. `rendezvous-crypto.js` — HKDF/topic/seal/ratchet, unit-tested with WebCrypto
   test vectors (including cross-page interop of derived topics/keys).
2. `PeerManager.adoptConnection()` — connection swap under a live peer entry,
   e2e-tested with two real pages (kill pc, adopt a fresh pair, assert replay).
3. `rendezvous-carrier-nostr.js` + loopback carrier for tests.
4. `rendezvous.js` — the state machine above; e2e test with the loopback
   carrier; manual field test over ≥2 public relays.
5. Launcher UI: opt-in prompt, Known Peers toggle + revoke, resume-on-launch.

## Explicit non-goals

- Group (>2) rendezvous — pairs only; the host re-runs pairs per client.
- Presence/discovery of never-paired devices.
- Push-style wake of a closed app (needs a push service — out of scope).
