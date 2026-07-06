// Resilience tests (v1.7): interruption tolerance, heartbeat, in-band ICE
// restart, and the seq/ack/outbox reliability layer.
// Run with: node --test resilience.test.mjs   (from the test/ directory)
//
// Two kinds of coverage:
//   - REAL e2e: two Chrome pages, real RTCPeerConnections, real renegotiation
//     over the data channel (restartIce round-trip, glare, replay-on-ack).
//   - State-machine units: synthetic peer entries driven through the manager's
//     internal handlers with millisecond timers, because ICE 'disconnected'
//     cannot be forced deterministically from JS.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8127; // distinct from e2e.test.mjs — node --test runs files in parallel
const BASE = `http://localhost:${PORT}`;

let server, browser, context;

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

// Full manual ceremony between two harness pages; leaves `window.pm`,
// `window.__messages`, `window.__statuses` defined on both.
async function connectPair(host, joiner, pmOptions = {}) {
    const packedOffer = await host.evaluate(async (opts) => {
        window.pm = new PeerManager(Object.assign({ iceMode: 'local' }, opts));
        window.__messages = [];
        window.__statuses = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        pm.addEventListener('status', e => __statuses.push(e.detail.status));
        return await ConnectionUtils.encodePayload(await pm.createOffer());
    }, pmOptions);

    const packedAnswer = await joiner.evaluate(async ({ packed, opts }) => {
        window.pm = new PeerManager(Object.assign({ iceMode: 'local' }, opts));
        window.__messages = [];
        window.__statuses = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        pm.addEventListener('status', e => __statuses.push(e.detail.status));
        const offerPayload = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await pm.createAnswer(offerPayload));
    }, { packed: packedOffer, opts: pmOptions });

    await host.evaluate(async (packed) => {
        await pm.acceptAnswer(await ConnectionUtils.decodePayload(packed));
    }, packedAnswer);

    for (const page of [host, joiner]) {
        await page.waitForFunction(
            `Array.from(pm.peers.values()).some(p => p.status === 'connected')`,
            null, { timeout: 15000 }
        );
    }
}

// ---------------------------------------------------------------------------

test('control frames (ping/ack) never surface as app messages; heartbeat proves liveness', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();
    await connectPair(host, joiner, { heartbeatIntervalMs: 200 });

    // Exchange one app message each way so acks flow too.
    await host.evaluate(() => pm.send('app says hi'));
    await joiner.waitForFunction(`__messages.includes('app says hi')`, null, { timeout: 5000 });

    // Let several heartbeat ticks pass.
    await new Promise(r => setTimeout(r, 1200));

    for (const [page, label] of [[host, 'host'], [joiner, 'joiner']]) {
        const leaked = await page.evaluate(() =>
            __messages.filter(t => typeof t !== 'string' || t.includes('__p2pc')).length);
        assert.equal(leaked, 0, `${label}: control frames must never reach the app`);

        const alive = await page.evaluate(() => {
            const p = Array.from(pm.peers.values())[0];
            return Date.now() - p.lastAliveAt;
        });
        assert.ok(alive < 1000, `${label}: heartbeat must keep lastAliveAt fresh (was ${alive}ms stale)`);

        const status = await page.evaluate(() => Array.from(pm.peers.values())[0].status);
        assert.equal(status, 'connected', `${label}: steady-state must stay connected`);
    }
    console.log('  ✓ heartbeats flow invisibly, liveness stays fresh');

    await host.close(); await joiner.close();
});

// ---------------------------------------------------------------------------

test('acks prune the outbox; duplicate seqs are delivered exactly once', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();
    await connectPair(host, joiner);

    await host.evaluate(() => { pm.send('one'); pm.send('two'); pm.send('three'); });
    await joiner.waitForFunction(`__messages.length >= 3`, null, { timeout: 5000 });

    const received = await joiner.evaluate(() => __messages.slice());
    assert.deepEqual(received, ['one', 'two', 'three'], 'messages arrive in order');

    // Acks must have pruned the host's outbox.
    await host.waitForFunction(
        `Array.from(pm.peers.values())[0].outbox.length === 0`,
        null, { timeout: 5000 }
    );
    console.log('  ✓ outbox drained by acks');

    // Replay a duplicate of seq 1 straight into the joiner's message path —
    // exactly what a post-recovery resync replay can produce.
    const dupResult = await joiner.evaluate(() => {
        const peerId = Array.from(pm.peers.keys())[0];
        const before = __messages.length;
        pm._onChannelMessage(peerId, JSON.stringify({ text: 'one', from: 'whoever', seq: 1 }));
        return { before, after: __messages.length };
    });
    assert.equal(dupResult.after, dupResult.before, 'duplicate seq must be dropped');
    console.log('  ✓ duplicate suppressed by seq dedup');

    // Legacy frame without seq (pre-v1.7 peer) must still deliver.
    const legacy = await joiner.evaluate(() => {
        const peerId = Array.from(pm.peers.keys())[0];
        pm._onChannelMessage(peerId, JSON.stringify({ text: 'old-build', from: 'whoever' }));
        return __messages.includes('old-build');
    });
    assert.ok(legacy, 'seq-less legacy messages still deliver');
    console.log('  ✓ legacy (seq-less) frames still deliver');

    await host.close(); await joiner.close();
});

// ---------------------------------------------------------------------------

test('REAL in-band ICE restart: restartIce() heals over the data channel, messages still flow', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();
    await connectPair(host, joiner);

    // Trigger a genuine ICE restart on the host side. The fresh offer must
    // travel as a control frame over the data channel, the joiner must answer
    // in-band, and the pair must return to a stable, connected state.
    await host.evaluate(() => {
        const p = Array.from(pm.peers.values())[0];
        p.connection.restartIce();
    });

    await host.waitForFunction(`
        (() => {
            const p = Array.from(pm.peers.values())[0];
            return p.connection.signalingState === 'stable'
                && ['connected','completed'].includes(p.connection.iceConnectionState)
                && p.status === 'connected';
        })()
    `, null, { timeout: 15000 });
    await joiner.waitForFunction(`
        (() => {
            const p = Array.from(pm.peers.values())[0];
            return p.connection.signalingState === 'stable'
                && ['connected','completed'].includes(p.connection.iceConnectionState);
        })()
    `, null, { timeout: 15000 });
    console.log('  ✓ renegotiation completed in-band');

    // The link must still carry app traffic, both directions.
    await host.evaluate(() => pm.send('post-restart from host'));
    await joiner.waitForFunction(`__messages.includes('post-restart from host')`, null, { timeout: 5000 });
    await joiner.evaluate(() => pm.send('post-restart from joiner'));
    await host.waitForFunction(`__messages.includes('post-restart from joiner')`, null, { timeout: 5000 });
    console.log('  ✓ messages flow after ICE restart');

    // The app must never have been told the link dropped.
    for (const [page, label] of [[host, 'host'], [joiner, 'joiner']]) {
        const bad = await page.evaluate(() => __statuses.filter(s => s === 'disconnected' || s === 'failed'));
        assert.deepEqual(bad, [], `${label}: restart must not surface disconnected/failed`);
    }
    console.log('  ✓ no disconnected/failed status leaked during restart');

    await host.close(); await joiner.close();
});

// ---------------------------------------------------------------------------

test('REAL glare: simultaneous restartIce() on both sides settles via perfect negotiation', async () => {
    const host = await newHarnessPage();
    const joiner = await newHarnessPage();
    await connectPair(host, joiner);

    await Promise.all([
        host.evaluate(() => Array.from(pm.peers.values())[0].connection.restartIce()),
        joiner.evaluate(() => Array.from(pm.peers.values())[0].connection.restartIce())
    ]);

    for (const [page, label] of [[host, 'host'], [joiner, 'joiner']]) {
        await page.waitForFunction(`
            (() => {
                const p = Array.from(pm.peers.values())[0];
                return p.connection.signalingState === 'stable'
                    && ['connected','completed'].includes(p.connection.iceConnectionState);
            })()
        `, null, { timeout: 20000 });
        console.log(`  ✓ ${label} stable after glare`);
    }

    await host.evaluate(() => pm.send('after glare'));
    await joiner.waitForFunction(`__messages.includes('after glare')`, null, { timeout: 5000 });
    console.log('  ✓ messages flow after simultaneous restarts');

    await host.close(); await joiner.close();
});

// ---------------------------------------------------------------------------

test('interruption state machine: grace window, recovery cancels teardown, expiry tears down', async () => {
    const page = await newHarnessPage();

    const result = await page.evaluate(async () => {
        const out = {};
        const mkFakeChannel = () => ({ readyState: 'open', sent: [], send(m) { this.sent.push(m); }, close() {} });

        // --- expiry path -------------------------------------------------
        {
            const pm2 = new PeerManager({ iceMode: 'local', interruptedGraceMs: 150 });
            const statuses = [];
            pm2.addEventListener('status', e => statuses.push(e.detail.status));
            const pd = pm2.initPeer('peerA', 'client');
            pd.canRenegotiate = true; // established session
            pd.status = 'connected';
            pd.dataChannel = mkFakeChannel();

            pm2._onLinkTrouble('peerA', 'disconnected');
            out.expiryInterrupted = statuses.includes('interrupted');
            out.stillHeldDuringGrace = pm2.peers.has('peerA');
            await new Promise(r => setTimeout(r, 400));
            out.goneAfterGrace = !pm2.peers.has('peerA');
            out.terminalStatus = statuses[statuses.length - 1];
            pm2.destroy();
        }

        // --- recovery path -------------------------------------------------
        {
            const pm3 = new PeerManager({ iceMode: 'local', interruptedGraceMs: 150 });
            const statuses = [];
            pm3.addEventListener('status', e => statuses.push(e.detail.status));
            const pd = pm3.initPeer('peerB', 'client');
            pd.canRenegotiate = true;
            pd.status = 'connected';
            pd.dataChannel = mkFakeChannel();

            pm3._onLinkTrouble('peerB', 'disconnected');
            // Any inbound frame proves recovery — like the first pong after a wake.
            pm3._onChannelMessage('peerB', JSON.stringify({ __p2pc: 'pong', t: 1 }));
            out.recoveredStatus = pm3.peers.get('peerB') && pm3.peers.get('peerB').status;
            await new Promise(r => setTimeout(r, 400));
            out.survivedGrace = pm3.peers.has('peerB');
            out.noTerminal = !statuses.includes('disconnected');
            pm3.destroy();
        }

        // --- mid-ceremony failure keeps fail-fast --------------------------
        {
            const pm4 = new PeerManager({ iceMode: 'local' });
            const statuses = [];
            pm4.addEventListener('status', e => statuses.push(e.detail.status));
            const pd = pm4.initPeer('peerC', 'client'); // canRenegotiate stays false
            pd.status = 'checking';
            pm4._onLinkTrouble('peerC', 'failed');
            out.ceremonyFailFast = !pm4.peers.has('peerC') && statuses.includes('failed');
            pm4.destroy();
        }

        return out;
    });

    assert.ok(result.expiryInterrupted, "trouble on an established link surfaces 'interrupted'");
    assert.ok(result.stillHeldDuringGrace, 'peer must be HELD during the grace window');
    assert.ok(result.goneAfterGrace, 'peer torn down after grace expiry');
    assert.equal(result.terminalStatus, 'disconnected', "terminal status is 'disconnected'");
    assert.equal(result.recoveredStatus, 'connected', 'inbound frame flips interrupted back to connected');
    assert.ok(result.survivedGrace, 'recovered peer must outlive the old grace timer');
    assert.ok(result.noTerminal, 'recovered peer never reports disconnected');
    assert.ok(result.ceremonyFailFast, 'mid-ceremony ICE failure still fails fast');
    console.log('  ✓ interrupted → recovered and interrupted → expired both behave');

    await page.close();
});

// ---------------------------------------------------------------------------

test('outbox queues while interrupted and replays after resync', async () => {
    const page = await newHarnessPage();

    const result = await page.evaluate(() => {
        const out = {};
        const pm5 = new PeerManager({ iceMode: 'local' });
        const pd = pm5.initPeer('peerQ', 'client');
        pd.canRenegotiate = true;
        pd.status = 'interrupted';
        pd.dataChannel = { readyState: 'closed', send() { throw new Error('closed'); }, close() {} };

        // Queue while the channel is down.
        out.q1 = pm5._sendAppTo('peerQ', { text: 'queued-1', from: pm5.myId });
        out.q2 = pm5._sendAppTo('peerQ', { text: 'queued-2', from: pm5.myId });
        out.queuedCount = pd.outbox.length;

        // Link comes back: swap in an open channel and process the peer's
        // resync (they had seen nothing: have=0). Both queued frames must ship.
        const sent = [];
        pd.dataChannel = { readyState: 'open', send(m) { sent.push(JSON.parse(m)); }, close() {} };
        pd.status = 'connected';
        pm5._handleControl('peerQ', { __p2pc: 'resync', have: 0 });
        out.replayed = sent.filter(m => !m.__p2pc).map(m => m.text);

        // Peer acks everything → outbox empties.
        pm5._handleControl('peerQ', { __p2pc: 'ack', upTo: 2 });
        out.afterAck = pd.outbox.length;

        // A dead link (not interrupted, channel closed) must REFUSE sends.
        pd.status = 'disconnected';
        pd.dataChannel = { readyState: 'closed', send() { throw new Error('closed'); }, close() {} };
        out.deadRefused = !pm5._sendAppTo('peerQ', { text: 'nope', from: pm5.myId });

        pm5.destroy();
        return out;
    });

    assert.ok(result.q1 && result.q2, 'sends during interruption are accepted (queued)');
    assert.equal(result.queuedCount, 2, 'both messages sit in the outbox');
    assert.deepEqual(result.replayed, ['queued-1', 'queued-2'], 'resync replays queued messages in order');
    assert.equal(result.afterAck, 0, 'ack prunes the outbox');
    assert.ok(result.deadRefused, 'sends on a dead link are refused, not silently dropped');
    console.log('  ✓ queue → resync replay → ack prune all behave');

    await page.close();
});

// ---------------------------------------------------------------------------

test('wake probe marks a silent peer interrupted; a pong cancels it', async () => {
    const page = await newHarnessPage();

    const result = await page.evaluate(async () => {
        const out = {};
        // Silent peer: ping goes out on wake, nothing comes back.
        {
            const pmW = new PeerManager({ iceMode: 'local', wakeProbeTimeoutMs: 100, interruptedGraceMs: 60000 });
            const pd = pmW.initPeer('peerW', 'client');
            pd.canRenegotiate = true;
            pd.status = 'connected';
            pd.lastAliveAt = Date.now() - 60000;
            const sent = [];
            pd.dataChannel = { readyState: 'open', send(m) { sent.push(JSON.parse(m)); }, close() {} };

            pmW._onWake();
            out.pinged = sent.some(m => m.__p2pc === 'ping');
            await new Promise(r => setTimeout(r, 250));
            out.markedInterrupted = pmW.peers.get('peerW').status === 'interrupted';
            pmW.destroy();
        }
        // Responsive peer: pong arrives before the probe deadline.
        {
            const pmW2 = new PeerManager({ iceMode: 'local', wakeProbeTimeoutMs: 100, interruptedGraceMs: 60000 });
            const pd = pmW2.initPeer('peerV', 'client');
            pd.canRenegotiate = true;
            pd.status = 'connected';
            pd.lastAliveAt = Date.now() - 60000;
            pd.dataChannel = { readyState: 'open', send() {}, close() {} };

            pmW2._onWake();
            pmW2._onChannelMessage('peerV', JSON.stringify({ __p2pc: 'pong', t: 1 }));
            await new Promise(r => setTimeout(r, 250));
            out.stayedConnected = pmW2.peers.get('peerV').status === 'connected';
            pmW2.destroy();
        }
        return out;
    });

    assert.ok(result.pinged, 'wake sends an immediate ping');
    assert.ok(result.markedInterrupted, 'no answer within the probe window → interrupted');
    assert.ok(result.stayedConnected, 'a pong before the deadline keeps the link connected');
    console.log('  ✓ wake probe behaves for both silent and responsive peers');

    await page.close();
});
