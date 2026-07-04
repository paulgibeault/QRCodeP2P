// End-to-end tests: real Chrome, real RTCPeerConnections, packed payloads.
// Run with: node --test e2e.test.mjs   (from the test/ directory)
//
// Uses the locally installed Google Chrome (channel: 'chrome') so no browser
// download is needed. A python http.server serves the repo root because
// ES modules and WebRTC both require an http(s) origin.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8123;
const BASE = `http://localhost:${PORT}`;

let server, browser, context;

// Stubs so index.html skips its CDN fetches (QR rendering isn't under test)
const UI_STUBS = `
    window.QRCode = function () {};
    window.QRCode.CorrectLevel = { L: 1, M: 0, Q: 3, H: 2 };
    window.Html5Qrcode = class {
        constructor() { this.isScanning = false; }
        async start() { throw new Error('no camera in tests'); }
        async stop() {}
        clear() {}
        async scanFile() { throw new Error('no files in tests'); }
    };
`;

// Force empty iceServers everywhere so tests never touch external STUN and
// never stall on unreachable networks. Host candidates are enough on loopback.
const FORCE_LOCAL_ICE = `
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
`;

before(async () => {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', REPO_ROOT], {
        stdio: 'ignore'
    });
    // Wait for the server to accept connections
    for (let i = 0; i < 50; i++) {
        try {
            const res = await fetch(`${BASE}/index.html`);
            if (res.ok) break;
        } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
    }

    browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        args: [
            // Expose raw local IPs in candidates instead of mDNS .local names —
            // mDNS resolution is flaky in headless; the codec's mDNS path is
            // covered by unit tests.
            '--disable-features=WebRtcHideLocalIpsWithMdns'
        ]
    });
    context = await browser.newContext();
    await context.addInitScript(UI_STUBS + FORCE_LOCAL_ICE);
});

after(async () => {
    await browser?.close();
    server?.kill();
});

async function newHarnessPage() {
    const page = await context.newPage();
    page.on('pageerror', err => console.error('  [pageerror]', err.message));
    await page.goto(`${BASE}/test/harness.html`);
    await page.waitForFunction('window.__ready === true');
    return page;
}

// ---------------------------------------------------------------------------

test('core: packed offer/answer handshake connects two real peers', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();

    // HOST: create offer, encode to packed string
    const packedOffer = await host.evaluate(async () => {
        window.pm = new PeerManager({ iceMode: 'local' });
        window.__messages = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        const offerJson = await pm.createOffer();
        return await ConnectionUtils.encodePayload(offerJson);
    });

    assert.match(packedOffer, /^1\.[A-Za-z0-9_-]+$/, 'offer must use the packed format');
    assert.ok(packedOffer.length < 300, `packed offer is ${packedOffer.length} chars — should be < 300`);
    console.log(`  packed offer: ${packedOffer.length} chars`);

    // JOINER: decode (rebuilds SDP from template!), answer, encode back
    const packedAnswer = await joiner.evaluate(async (packed) => {
        window.pm = new PeerManager({ iceMode: 'local' });
        window.__messages = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        const offerPayload = await ConnectionUtils.decodePayload(packed);
        const answerJson = await pm.createAnswer(offerPayload);
        return await ConnectionUtils.encodePayload(answerJson);
    }, packedOffer);

    assert.match(packedAnswer, /^1\.[A-Za-z0-9_-]+$/, 'answer must use the packed format');
    console.log(`  packed answer: ${packedAnswer.length} chars`);

    // HOST: decode the reconstructed answer and apply it
    await host.evaluate(async (packed) => {
        const answerPayload = await ConnectionUtils.decodePayload(packed);
        await pm.acceptAnswer(answerPayload);
    }, packedAnswer);

    // Both data channels must open
    await host.waitForFunction(
        `Array.from(pm.peers.values()).some(p => p.dataChannel && p.dataChannel.readyState === 'open')`,
        null, { timeout: 15000 }
    );
    await joiner.waitForFunction(
        `Array.from(pm.peers.values()).some(p => p.dataChannel && p.dataChannel.readyState === 'open')`,
        null, { timeout: 15000 }
    );

    // Message round-trip both directions
    await host.evaluate(() => pm.send('hello from host'));
    await joiner.waitForFunction(`__messages.includes('hello from host')`, null, { timeout: 5000 });
    await joiner.evaluate(() => pm.send('hello from joiner'));
    await host.waitForFunction(`__messages.includes('hello from joiner')`, null, { timeout: 5000 });

    console.log('  ✓ datachannel open, messages delivered both ways');
    await host.close();
    await joiner.close();
});

// ---------------------------------------------------------------------------

// REGRESSION (field test 2026-07-04): the host's ICE agent answers
// connectivity checks BEFORE it has received the answer, so the joiner's ICE
// reaches 'connected' mid-ceremony. v1.5.0 reported that as fully connected,
// hid the answer QR, and stranded the host. App-level 'connected' must mean
// the data channel is open; pre-answer ICE-connected must surface as
// 'finalizing'.
test('joiner must not report connected before host applies the answer', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();

    const packedOffer = await host.evaluate(async () => {
        window.pm = new PeerManager({ iceMode: 'local' });
        return await ConnectionUtils.encodePayload(await pm.createOffer());
    });

    const packedAnswer = await joiner.evaluate(async (packed) => {
        window.pm = new PeerManager({ iceMode: 'local' });
        window.__statuses = [];
        pm.addEventListener('status', e => __statuses.push(e.detail.status));
        const offerPayload = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await pm.createAnswer(offerPayload));
    }, packedOffer);

    // Host does NOT apply the answer yet — the kitchen-table window.
    // The joiner's ICE should still connect (host answers checks pre-answer),
    // which must surface as 'finalizing', never 'connected'.
    await joiner.waitForFunction(`__statuses.includes('finalizing')`, null, { timeout: 15000 });
    const leaked = await joiner.evaluate(() => __statuses.includes('connected'));
    assert.equal(leaked, false, "joiner must NOT report 'connected' while the host lacks the answer");
    console.log('  ✓ joiner correctly reports finalizing (not connected) pre-answer');

    // Now complete the ceremony — both sides must reach real connected.
    await host.evaluate(async (packed) => {
        await pm.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);
    await joiner.waitForFunction(`__statuses.includes('connected')`, null, { timeout: 15000 });
    await host.waitForFunction(
        `Array.from(pm.peers.values()).some(p => p.status === 'connected')`,
        null, { timeout: 15000 }
    );
    console.log('  ✓ both sides reach real connected once the answer is applied');

    await host.close();
    await joiner.close();
});

// ---------------------------------------------------------------------------

test('backward compat: legacy deflate payloads still decode', async () => {
    const page = await newHarnessPage();
    const result = await page.evaluate(async () => {
        const pm = new PeerManager({ iceMode: 'local' });
        const offerJson = await pm.createOffer();
        // Encode the OLD way (deflate + base64url), decode through the new path
        const legacy = await ConnectionUtils.compressData(offerJson);
        const decoded = await ConnectionUtils.decodePayload(legacy);
        const original = JSON.parse(offerJson);
        return {
            peerIdMatches: decoded.peerId === original.peerId,
            sdpMatches: decoded.sessionDesc.sdp === original.sessionDesc.sdp,
            legacyLen: legacy.length,
            packedLen: (await ConnectionUtils.encodePayload(offerJson)).length
        };
    });
    assert.ok(result.peerIdMatches, 'legacy decode must preserve peerId');
    assert.ok(result.sdpMatches, 'legacy decode must preserve the SDP exactly');
    console.log(`  legacy payload: ${result.legacyLen} chars vs packed: ${result.packedLen} chars`);
    await page.close();
});

// ---------------------------------------------------------------------------

test('full UI: link-tennis relay connects host and joiner across three tabs', async () => {
    // TAB H — the host's game tab
    const tabH = await context.newPage();
    tabH.on('pageerror', err => console.error('  [H pageerror]', err.message));
    await tabH.goto(`${BASE}/index.html`);
    await tabH.waitForFunction('!!window.__mp');
    await tabH.evaluate(() => {
        __mp.peerNode.options.iceMode = 'local';
        window.__received = [];
        __mp.addEventListener('message', e => { if (e.detail.incoming) __received.push(e.detail.text); });
    });
    await tabH.click('#btn-multiplayer');
    await tabH.click('#p2p-btn-host');
    await tabH.waitForFunction(`__mp.ui.rawSDPPayload.length > 0`, null, { timeout: 15000 });
    const packedOffer = await tabH.evaluate(() => __mp.ui.rawSDPPayload);
    console.log(`  offer via UI: ${packedOffer.length} chars`);

    // TAB J — joiner taps the invite link (simulates the chat-thread hop)
    const tabJ = await context.newPage();
    tabJ.on('pageerror', err => console.error('  [J pageerror]', err.message));
    await tabJ.goto(`${BASE}/index.html#p2p-offer=${packedOffer}`);
    await tabJ.waitForFunction('!!window.__mp && __mp.ui.rawSDPPayload.length > 0', null, { timeout: 15000 });
    const packedAnswer = await tabJ.evaluate(() => __mp.ui.rawSDPPayload);
    console.log(`  answer via UI: ${packedAnswer.length} chars`);

    // NOTE: because tab J is in the same browser profile, its automatic
    // BroadcastChannel forward may already connect H and J here ("auto-connect
    // bonus"). The relay tab below must still report success either way —
    // acceptAnswer tolerates an already-processed answer.

    // TAB R — the host taps the joiner's reply link, opening a relay tab
    const tabR = await context.newPage();
    tabR.on('pageerror', err => console.error('  [R pageerror]', err.message));
    await tabR.goto(`${BASE}/index.html#p2p-answer=${packedAnswer}`);

    // Relay must confirm delivery via the ack (unless H already connected via
    // the auto-forward, in which case H still acks — 'Delivered' either way).
    await tabR.waitForFunction(
        `document.getElementById('p2p-qr-instructions') &&
         /Delivered|Answer received/.test(document.getElementById('p2p-qr-instructions').textContent)`,
        null, { timeout: 10000 }
    );
    console.log('  ✓ relay tab reports answer delivered');

    // Host must reach connected state and the UI must reflect it
    await tabH.waitForFunction(
        `Array.from(__mp.peerNode.peers.values()).some(p => p.status === 'connected')`,
        null, { timeout: 15000 }
    );
    await tabJ.waitForFunction(
        `Array.from(__mp.peerNode.peers.values()).some(p => p.status === 'connected')`,
        null, { timeout: 15000 }
    );

    // Full data path through the addon API
    await tabJ.evaluate(() => __mp.send('gg from joiner'));
    await tabH.waitForFunction(`__received.includes('gg from joiner')`, null, { timeout: 5000 });

    console.log('  ✓ host and joiner connected through link tennis, message delivered');
    await tabH.close(); await tabJ.close(); await tabR.close();
});
