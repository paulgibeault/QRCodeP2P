// Cross-engine matrix: packs an offer in one browser ENGINE and answers it in
// another, ferrying the packed strings through Node — exactly what happens in
// the real world when the two artifacts travel via QR / chat link.
//
// This is the closest one-machine approximation of "iPhone Safari joiner,
// Mac Chrome host": separate browser processes, different WebRTC stacks.
//
// ENVIRONMENT FINDINGS BAKED INTO THIS MATRIX (2026-07-04, macOS):
//
// 1. WebKit gathers ZERO ICE candidates with no STUN and no camera permission
//    (Safari's privacy model: host candidates require device access). So all
//    WebKit pairs run in 'anywhere' (STUN) mode — which works. Real-world
//    consequence: Safari joiners need STUN mode or a camera grant; the core
//    now emits a diagnostic when zero candidates are gathered.
//
// 2. Firefox-as-OFFERER cannot complete ICE against ANY peer on the SAME
//    machine — verified with vanilla RTCPeerConnection (no project code), both
//    headless and headful, with and without STUN. Firefox-as-answerer works
//    fine. This is a same-machine/Firefox-stack artifact, not reachable by
//    our code; Firefox-host pairs are skipped and must be verified on two
//    physical devices.
//
// 3. WebKit<->WebKit with STUN is srflx<->srflx on the same machine, which
//    requires NAT hairpinning on the router — worked through some routers,
//    not others. Skipped as environment-dependent. Real-world equivalent
//    (two iPhones, link-tennis, no camera grants) shares this risk — the QR
//    flow's camera grant avoids it by unlocking host candidates.
//
// Run with: node --test cross-engine.test.mjs   (from the test/ directory)

import { test, before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8124;
const BASE = `http://localhost:${PORT}`;

let server;
const browsers = {};

before(async () => {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', REPO_ROOT], {
        stdio: 'ignore'
    });
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
    }

    browsers.chrome = await chromium.launch({
        channel: 'chrome', headless: true,
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
    });
    browsers.firefox = await firefox.launch({
        headless: true,
        firefoxUserPrefs: {
            'media.peerconnection.ice.obfuscate_host_addresses': false
        }
    });
    browsers.webkit = await webkit.launch({ headless: true });
});

after(async () => {
    for (const b of Object.values(browsers)) await b?.close();
    server?.kill();
});

async function harnessPage(browser, label) {
    const page = await browser.newPage();
    page.on('pageerror', err => console.error(`  [${label} pageerror]`, err.message));
    await page.goto(`${BASE}/test/harness.html`);
    await page.waitForFunction('window.__ready === true');
    return page;
}

async function runHandshake(hostBrowser, joinerBrowser, hostLabel, joinerLabel, iceMode) {
    const host = await harnessPage(hostBrowser, hostLabel);
    const joiner = await harnessPage(joinerBrowser, joinerLabel);
    const t0 = Date.now();

    const packedOffer = await host.evaluate(async (mode) => {
        window.pm = new PeerManager({ iceMode: mode });
        window.__messages = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        return await ConnectionUtils.encodePayload(await pm.createOffer());
    }, iceMode);

    const packedAnswer = await joiner.evaluate(async ([packed, mode]) => {
        window.pm = new PeerManager({ iceMode: mode });
        window.__messages = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        const offerPayload = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await pm.createAnswer(offerPayload));
    }, [packedOffer, iceMode]);

    await host.evaluate(async (packed) => {
        await pm.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);

    const OPEN = `Array.from(pm.peers.values()).some(p => p.dataChannel && p.dataChannel.readyState === 'open')`;
    await host.waitForFunction(OPEN, null, { timeout: 20000 });
    await joiner.waitForFunction(OPEN, null, { timeout: 20000 });

    await host.evaluate(() => pm.send('ping'));
    await joiner.waitForFunction(`__messages.includes('ping')`, null, { timeout: 5000 });
    await joiner.evaluate(() => pm.send('pong'));
    await host.waitForFunction(`__messages.includes('pong')`, null, { timeout: 5000 });

    const ms = Date.now() - t0;
    console.log(`  ✓ ${hostLabel} host ↔ ${joinerLabel} joiner (${iceMode}): connected + round-trip in ${ms}ms (offer ${packedOffer.length}c, answer ${packedAnswer.length}c)`);
    await host.close();
    await joiner.close();
}

// [host, joiner, iceMode] — see header comment for why each pair is chosen
const MATRIX = [
    ['chrome', 'chrome', 'local'],
    ['chrome', 'firefox', 'local'],
    ['chrome', 'webkit', 'anywhere'],  // webkit needs STUN (srflx-only without camera)
    ['webkit', 'chrome', 'anywhere']
];

for (const [h, j, mode] of MATRIX) {
    test(`cross-engine: ${h} host ↔ ${j} joiner [${mode}]`, async () => {
        await runHandshake(browsers[h], browsers[j], h, j, mode);
    });
}

test('cross-engine: firefox-as-host pairs — SKIPPED (same-machine Firefox ICE artifact; verify on two devices)', { skip: true }, () => {});
test('cross-engine: webkit ↔ webkit — SKIPPED (srflx↔srflx needs router hairpin; verify on two devices)', { skip: true }, () => {});
