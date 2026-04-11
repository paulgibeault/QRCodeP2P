# P2P Addon Integration Guide

The `p2p-addon` provides a drop-in, zero-server multiplayer connection interface for your HTML games. It handles the WebRTC negotiation, QR generation/scanning, and provides a simple event-driven API.

## Installation

1. Copy the following files into your game's directory:
   - `p2p-core.js`
   - `p2p-ui.js`
   - `p2p-addon.js`
   - `p2p-addon.css`

2. Import and initialize the addon in your game's script (must be a module):

```html
<script type="module">
    import P2PAddon from './p2p-addon.js';
    
    const multiplayer = new P2PAddon();
    
    // Initialize loads the external dependencies (qrcode, html5-qrcode) and injects the CSS overlay
    await multiplayer.init();
</script>
```

## API Specification

### `showUI()`
Opens the multiplayer connection modal. Bind this to a "Multiplayer" button in your game.
```javascript
document.getElementById('my-multiplayer-btn').addEventListener('click', () => {
    multiplayer.showUI();
});
```

### `hideUI()`
Closes the multiplayer connection modal.

### `destroy()`
Fully tears down all P2P resources: closes all `RTCPeerConnection` instances, the `BroadcastChannel`,
window event listeners, any active QR scanner, and removes the injected modal DOM. Call this when the
player leaves the lobby or the round ends, then call `init()` again to reinitialize for a new session.
```javascript
// e.g., when the game round ends
multiplayer.destroy();
// Later, to start a fresh session:
await multiplayer.init();
```

### `send(data)`
Sends data to the connected peer over the WebRTC data channel. Automatically stringifies JSON objects.
```javascript
multiplayer.send("Hello World!");
multiplayer.send({ player: 1, action: "jump", x: 100, y: 200 });
```

### Events

The addon extends `EventTarget`, allowing you to listen using standard `addEventListener`.

#### Event: `status`
Fired when the connection state changes. `event.detail` is an object `{ peerId, status }`.
```javascript
multiplayer.addEventListener('status', (event) => {
    const { peerId, status } = event.detail;
    console.log(`Peer ${peerId} is now: ${status}`);
    // status values: "connected", "disconnected", "failed", "checking", ...
});
```

#### Event: `data`
Fired when incoming JSON data is successfully parsed.
```javascript
multiplayer.addEventListener('data', (event) => {
    const payload = event.detail; // Automatically parsed JSON object
    console.log("Player moved to:", payload.x, payload.y);
});
```

#### Event: `message`
Fired for ALL incoming and outgoing messages (raw text). Useful for chat logs.
```javascript
multiplayer.addEventListener('message', (event) => {
    const isIncoming = event.detail.incoming;
    const rawText = event.detail.text;
    console.log(isIncoming ? "Peer said:" : "I said:", rawText);
});
```
