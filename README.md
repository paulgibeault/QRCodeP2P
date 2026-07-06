# QR-Code P2P Connect

Establish a WebRTC connection with no signaling server! This project demonstrates how to connect two devices directly via WebRTC using QR codes to exchange the necessary SDP Offer and Answer.

[![Test the Application](https://img.shields.io/badge/Test_the_Application-blue?style=for-the-badge&logo=github)](https://paulgibeault.github.io/QRCodeP2P/)

## Features

- **100% Serverless**: No signaling backend required. The connection is established purely by scanning physical QR codes or copying and pasting the raw connection strings.
- **Cross-Device**: Works seamlessly between laptops, phones, and tablets.
- **Real-Time Data Channel**: Once connected, you can use the Test Bed Console to send real-time chat messages directly from device to device.

## How it Works (v1.5.0 — Packed Payloads & Link Tennis)

Because WebRTC requires devices to explicitly agree on connection parameters before opening a peer-to-peer connection, the two artifacts (offer and answer) must each make one hop between the devices. v1.5.0 makes each hop tiny and frictionless:

### Binary template packing (`sdp-codec.js`)
Instead of compressing SDP text, we transmit only its real entropy — ICE credentials, DTLS fingerprint, and candidates — as a ~**112-153 character** string (was ~600+), and rebuild the full SDP from a template on the receiving side. QR codes are now small enough to scan instantly, and links survive SMS/iMessage intact. Legacy v1.4 payloads still decode.

### Leg 1 — Offer: Host → Joiner
1. **The Host** clicks **Host**; the packed offer is generated.
2. On mobile, the native **Share Sheet** sends an invite URL (iMessage, WhatsApp, etc.). On desktop, a QR code is displayed instead.
3. The joiner taps the link / scans the QR; the page **auto-ingests the offer**.

### Leg 2 — Answer: Joiner → Host ("link tennis")
4. The joiner's page generates the answer and offers **"Send reply link"** — the answer travels back through the *same chat thread* the invite came from.
5. The host taps the reply link. It opens a small **relay tab** that forwards the answer to the original game tab (BroadcastChannel / localStorage / opener), waits for the game tab's ack, and shows "✅ Delivered — close this tab".
6. Universal fallbacks, in order of reach: the host **scans the joiner's answer QR**, decodes a **texted screenshot** of it (📁 Decode from image), or pastes the raw string.

```
HOST TAB                        JOINER DEVICE
  |── invite link (offer) ──────────>|  tap → auto-ingest → answer ready
  |<───── reply link (answer) ───────|  sent back through the same chat
  | (relay tab → BroadcastChannel →  |
  |  game tab applies answer + acks) |
  ════════ CONNECTION ESTABLISHED ════════
```

### Connection modes
- **Anywhere** (default): uses public STUN — no data or signaling ever transits it; it only reflects your public IP. Required for Safari joiners that never grant camera access (Safari withholds ICE candidates without device permission).
- **Same Wi-Fi only**: zero external servers of any kind. Works LAN-only; on Safari this mode needs the QR flow (its camera grant unlocks host candidates).

### Automatic reconnection (v1.9)
Devices that pair once can opt in to **zero-touch reconnection**: if the connection dies completely (both networks changed, browser killed), they find each other again through public dead-drop relays — everything published is end-to-end AEAD-sealed with keys born on the original QR-ceremonied channel, topics are unlinkable daily HMACs, epochs kill replays, and the keys ratchet on every successful reconnect. A reconnected session **resumes** (sequence numbers, queued messages) rather than restarting. Full spec: [PROTOCOL.md](PROTOCOL.md).

### Resilience (v1.7)
A quick app switch or a notification no longer kills the session. Links ride out trouble in an `interrupted` state instead of dying: heartbeats detect a stalled peer, a wake probe re-checks the link the instant the tab returns, ICE restarts renegotiate **in-band over the data channel** (no new QR needed), and messages sent during a blip are queued and replayed with exactly-once delivery. Only after a generous grace window (default 5 min) does a link give up. See the v1.7.0 section of [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md).

A stage tracker in the connection modal shows exactly which leg of the exchange succeeded or died, and **📋 Copy transcript** exports the diagnostics for remote debugging.

Everything happens securely and locally after the initial exchange. See [IMPLEMENTATION_NOTES.md](IMPLEMENTATION_NOTES.md) for the wire format, the cross-browser test matrix, and known limits.

## Running the tests

```bash
cd test
npm install                              # Playwright library (uses your installed Chrome)
npx playwright install firefox webkit    # for the cross-engine matrix
npm test                                 # codec unit tests + 2-page/3-tab e2e + resilience suite
node --test cross-engine.test.mjs        # chrome/firefox/webkit matrix
```

## Integration into Single-Page Games

To include this package in your existing single-page HTML games without copying the files directly into your repository, you can serve the files through a CDN or link an external dependency.

### Method 1: Using jsDelivr CDN (GitHub Release)
You can directly import the addon module into your game's HTML file using a CDN link pointing to your repository:

```html
<script type="module">
    // Re-point the URL to your specific release tag (e.g., @v1.3.0) for stability
    import P2PAddon from 'https://cdn.jsdelivr.net/gh/paulgibeault/QRCodeP2P@main/p2p-addon.js';
    
    const mp = new P2PAddon();
    mp.init().then(() => {
        console.log("P2P Multiplayer Ready!");
        // mp.showUI() to open the connection menu
    });
</script>
```

### Method 2: Local Static Server
If you are developing locally, you can serve the `QRCodeP2P` directory on a local port (e.g. 8000) and import it into other projects:

```html
<script type="module">
    import P2PAddon from 'http://localhost:8000/p2p-addon.js';
    
    const mp = new P2PAddon();
    mp.init();
</script>
```
*(Note: Ensure your local server allows CORS if running your game on a separate port).*

## Running Locally

To run this project locally, simply clone the repository and serve the files over HTTP (WebRTC often requires a secure origin like `localhost` or `https`).

```bash
git clone https://github.com/paulgibeault/QRCodeP2P.git
cd QRCodeP2P
./go
```
Then navigate to `http://localhost:8000` in your browser.
