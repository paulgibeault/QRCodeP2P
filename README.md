# QR-Code P2P Connect

Establish a WebRTC connection with no signaling server! This project demonstrates how to connect two devices directly via WebRTC using QR codes to exchange the necessary SDP Offer and Answer.

[![Test the Application](https://img.shields.io/badge/Test_the_Application-blue?style=for-the-badge&logo=github)](https://paulgibeault.github.io/QRCodeP2P/)

## Features

- **100% Serverless**: No signaling backend required. The connection is established purely by scanning physical QR codes or copying and pasting the raw connection strings.
- **Cross-Device**: Works seamlessly between laptops, phones, and tablets.
- **Real-Time Data Channel**: Once connected, you can use the Test Bed Console to send real-time chat messages directly from device to device.

## How it Works

Because WebRTC requires devices to explicitly agree on connection parameters before opening a peer-to-peer connection, we use an out-of-band signaling method constraint:
1. **The Host** generates an "Offer" and displays it as a QR code.
2. **The Joiner** scans the offer, generates an "Answer", and displays it as a QR code.
3. **The Host** scans the answer to finalize the connection.

Everything happens securely and locally after the initial exchange.

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
python3 -m http.server 8000
```
Then navigate to `http://localhost:8000` in your browser.
