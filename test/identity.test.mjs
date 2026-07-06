// Persistent-identity tests (v1.8): the device certificate survives across
// PeerManager instances (IndexedDB), its DTLS fingerprint is exposed per
// link, and opting out still works.
// Run with: node --test identity.test.mjs   (from the test/ directory)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8131; // distinct port — node --test runs files in parallel
const BASE = `http://localhost:${PORT}`;

let server, browser, context;

const FORCE_LOCAL_ICE = `
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
    // Statics are not inherited onto our wrapper by super() — copy the one we use.
    window.RTCPeerConnection.generateCertificate = OrigRTC.generateCertificate.bind(OrigRTC);
`;

const FP_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/; // sha-256 fingerprint shape

before(async () => {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', REPO_ROOT], {
        stdio: 'ignore'
    });
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
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
    });
    context = await browser.newContext();
    await context.addInitScript(FORCE_LOCAL_ICE);
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

async function offerFingerprint(page, pmOptions) {
    return await page.evaluate(async (opts) => {
        const pm = new PeerManager(Object.assign({ iceMode: 'local' }, opts));
        const offer = JSON.parse(await pm.createOffer());
        pm.destroy();
        return PeerManager.extractFingerprint(offer.sessionDesc.sdp);
    }, pmOptions);
}

// ---------------------------------------------------------------------------

test('persistent identity: fingerprint is stable across PeerManager instances and page loads', async () => {
    const page1 = await newHarnessPage();
    const fpA = await offerFingerprint(page1, {});
    const fpB = await offerFingerprint(page1, {});
    assert.match(fpA, FP_RE, `fingerprint has sha-256 shape (got ${fpA})`);
    assert.equal(fpA, fpB, 'two managers in the same profile present the same identity');
    await page1.close();

    // A brand-new page = a fresh JS world, same origin storage — the profile's
    // certificate must come back from IndexedDB.
    const page2 = await newHarnessPage();
    const fpC = await offerFingerprint(page2, {});
    assert.equal(fpA, fpC, 'identity survives a page reload via IndexedDB');
    console.log(`  ✓ stable fingerprint ${fpA.slice(0, 17)}… across managers and reloads`);
    await page2.close();
});

// ---------------------------------------------------------------------------

test('persistentIdentity:false opts out (ephemeral cert differs from the stored identity)', async () => {
    const page = await newHarnessPage();
    const persistent = await offerFingerprint(page, {});
    const ephemeral = await offerFingerprint(page, { persistentIdentity: false });
    assert.match(ephemeral, FP_RE, 'ephemeral fingerprint still has sha-256 shape');
    assert.notEqual(persistent, ephemeral, 'opting out must not reuse the stored certificate');
    console.log('  ✓ opt-out produces a distinct ephemeral identity');
    await page.close();
});

// ---------------------------------------------------------------------------

test('getPeerFingerprint exposes the remote identity on a connected link', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();

    const { packedOffer, hostFp } = await host.evaluate(async () => {
        window.pm = new PeerManager({ iceMode: 'local' });
        const offerJson = await pm.createOffer();
        return {
            packedOffer: await ConnectionUtils.encodePayload(offerJson),
            hostFp: PeerManager.extractFingerprint(JSON.parse(offerJson).sessionDesc.sdp)
        };
    });

    const { packedAnswer, joinerSeesHostFp } = await joiner.evaluate(async (packed) => {
        window.pm = new PeerManager({ iceMode: 'local' });
        const offerPayload = await ConnectionUtils.decodePayload(packed);
        const answerJson = await pm.createAnswer(offerPayload);
        return {
            packedAnswer: await ConnectionUtils.encodePayload(answerJson),
            joinerSeesHostFp: pm.getPeerFingerprint(offerPayload.peerId)
        };
    }, packedOffer);

    assert.equal(joinerSeesHostFp, hostFp,
        "joiner's view of the host identity must match the host's actual fingerprint");

    await host.evaluate(async (packed) => {
        await pm.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);
    for (const page of [host, joiner]) {
        await page.waitForFunction(
            `Array.from(pm.peers.values()).some(p => p.status === 'connected')`,
            null, { timeout: 15000 }
        );
    }

    const hostSeesJoinerFp = await host.evaluate(() =>
        pm.getPeerFingerprint(Array.from(pm.peers.keys())[0]));
    assert.match(hostSeesJoinerFp, FP_RE, 'host reads a well-formed remote fingerprint post-connect');
    console.log('  ✓ both sides can read the remote identity off the live link');

    await host.close();
    await joiner.close();
});
