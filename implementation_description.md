# P2P Architecture Refactor Plan

This document details the planned steps to improve the P2Q WebRTC app based on best practices.

## UI Diagnostics enhancements (`index.html` & `style.css`)
We will add a dedicated "Diagnostics Console" alongside or below the primary chat view. This section will actively track the lifecycle of the connection:
- Add visual indicators (badges) showing STUN and TURN availability.
- Track `Local Description` Gathering (`host`, `srflx`, `prflx`) tracking natively in the DOM.
- Decorate tracking slots showing retries/errors returned by `Html5QrcodeScanner.render`, reducing silent failure frustrations.

## Application Architecture changes (`app.js`)
We will rewrite the core logic from synchronous blocks directly bound to the DOM, to a class-based observer layer.
- `class P2PManager extends EventTarget`: Responsible for abstracting RTCPeerConnection, signaling triggers, buffer compression.
- Catch constraints within `setLocalDescription`, JSON parsing with localized Error triggers bound back to the new Diagnostic views instead of console output.
