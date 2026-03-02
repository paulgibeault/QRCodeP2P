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

## Running Locally

To run this project locally, simply clone the repository and serve the files over HTTP (WebRTC often requires a secure origin like `localhost` or `https`).

```bash
git clone https://github.com/paulgibeault/QRCodeP2P.git
cd QRCodeP2P
python3 -m http.server 8000
```
Then navigate to `http://localhost:8000` in your browser.
