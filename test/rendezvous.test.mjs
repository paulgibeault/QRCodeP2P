// Rendezvous tests (v1.9): key schedule, carriers, and the flagship lifecycle
// e2e — two "devices" (isolated browser contexts) pair once, then reconnect
// through an untrusted dead-drop with NO human involvement: after a hard
// channel kill, and again after a full browser restart.
// Run with: node --test rendezvous.test.mjs   (from the test/ directory)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { mqttCodec } from '../rendezvous-carriers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PORT = 8133;        // static files
const DROP_PORT = 8134;   // in-test dead-drop pubsub
const BASE = `http://localhost:${PORT}`;

let server, dropServer, browser, ctxA, ctxB;

// ---------------------------------------------------------------------------
// In-test dead-drop: the untrusted rendezvous carrier backend. Deliberately
// dumb — append-only per topic, full history on subscribe — because the
// protocol must tolerate replays and stale blobs anyway.
const dropTopics = new Map();
function startDropServer() {
    dropServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        const u = new URL(req.url, 'http://x');
        const topic = u.searchParams.get('t') || '';
        if (req.method === 'POST' && u.pathname === '/pub') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                if (!dropTopics.has(topic)) dropTopics.set(topic, []);
                dropTopics.get(topic).push(body);
                res.end('ok');
            });
        } else if (u.pathname === '/sub') {
            const arr = dropTopics.get(topic) || [];
            const since = parseInt(u.searchParams.get('since') || '0', 10);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ msgs: arr.slice(since), next: arr.length }));
        } else {
            res.end('');
        }
    });
    dropServer.listen(DROP_PORT);
}

// Page-side polling carrier speaking to the drop server. Injected into both
// contexts so RendezvousManager can be handed `() => new HttpTestCarrier()`.
const HTTP_CARRIER = `
    window.HttpTestCarrier = class {
        constructor() { this.base = 'http://localhost:${DROP_PORT}'; this.subs = new Map(); this.timer = null; }
        async connect() { if (!this.timer) this.timer = setInterval(() => this._poll(), 120); }
        async _poll() {
            for (const [topic, st] of this.subs) {
                try {
                    const r = await fetch(this.base + '/sub?t=' + topic + '&since=' + st.next);
                    const j = await r.json();
                    st.next = j.next;
                    j.msgs.forEach(m => st.cbs.forEach(cb => { try { cb(m); } catch (e) {} }));
                } catch (e) {}
            }
        }
        async publish(topic, payload) { await fetch(this.base + '/pub?t=' + topic, { method: 'POST', body: payload }); }
        subscribe(topic, cb) {
            if (!this.subs.has(topic)) this.subs.set(topic, { next: 0, cbs: new Set() });
            const st = this.subs.get(topic);
            st.cbs.add(cb);
            return () => st.cbs.delete(cb);
        }
        close() { clearInterval(this.timer); this.timer = null; this.subs.clear(); }
    };
`;

const FORCE_LOCAL_ICE = `
    const OrigRTC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends OrigRTC {
        constructor(cfg = {}) { super({ ...cfg, iceServers: [] }); }
    };
    window.RTCPeerConnection.generateCertificate = OrigRTC.generateCertificate.bind(OrigRTC);
`;

before(async () => {
    server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', REPO_ROOT], { stdio: 'ignore' });
    startDropServer();
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch (_) {}
        await new Promise(r => setTimeout(r, 100));
    }
    browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
    });
    // Two contexts = two devices: separate IndexedDB, certificates, storage.
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    for (const ctx of [ctxA, ctxB]) await ctx.addInitScript(FORCE_LOCAL_ICE + HTTP_CARRIER);
});

after(async () => {
    await browser?.close();
    server?.kill();
    dropServer?.close();
});

async function harnessPage(ctx, label) {
    const page = await ctx.newPage();
    page.on('pageerror', err => console.error(`  [${label} pageerror]`, err.message));
    await page.goto(`${BASE}/test/harness.html`);
    await page.waitForFunction('window.__ready === true');
    return page;
}

async function connectPair(host, joiner) {
    const packedOffer = await host.evaluate(async () => {
        window.pm = new PeerManager({ iceMode: 'local' });
        window.__messages = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        return await ConnectionUtils.encodePayload(await pm.createOffer());
    });
    const packedAnswer = await joiner.evaluate(async (packed) => {
        window.pm = new PeerManager({ iceMode: 'local' });
        window.__messages = [];
        pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        const offerPayload = await ConnectionUtils.decodePayload(packed);
        return await ConnectionUtils.encodePayload(await pm.createAnswer(offerPayload));
    }, packedOffer);
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

const RDV_SETUP = `
    window.__rdvEvents = [];
    window.rdv = new RendezvousManager(pm, {
        carrierFactory: () => new HttpTestCarrier(),
        listenerDelayMs: 100,
        callerDelayMs: 250,
        episodeTimeoutMs: 60000,
        retryScheduleMs: [0, 400, 900, 2000]
    });
    for (const t of ['pair-established', 'reconnecting', 'reconnected', 'recovered-inband', 'gave-up', 'pair-request']) {
        rdv.addEventListener(t, e => __rdvEvents.push({ t, ...(e.detail || {}) }));
    }
`;

async function readPairRecord(page, label) {
    return page.evaluate(async (key) => {
        const db = await new Promise((res, rej) => {
            const r = indexedDB.open('qrp2p-rendezvous', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('pairs');
            r.onsuccess = () => res(r.result);
            r.onerror = () => rej(r.error);
        });
        const rec = await new Promise((res, rej) => {
            const q = db.transaction('pairs').objectStore('pairs').get(key);
            q.onsuccess = () => res(q.result);
            q.onerror = () => rej(q.error);
        });
        db.close();
        return rec ? { role: rec.role, epoch: rec.epoch, enabled: rec.enabled, hasBase: !!rec.base } : null;
    }, label);
}

// ---------------------------------------------------------------------------

test('crypto: key schedule symmetry, sealed-blob authentication, ratchet', async () => {
    const page = await harnessPage(ctxA, 'crypto');
    const r = await page.evaluate(async () => {
        const RC = RendezvousCrypto;
        const out = {};
        const a = RC.randBytes(32), b = RC.randBytes(32);

        // Order-independent derivation: both sides get the same keys.
        const base1 = await RC.derivePairBase(a, b);
        const base2 = await RC.derivePairBase(b, a);
        const tk1 = await RC.deriveTopicKey(base1), tk2 = await RC.deriveTopicKey(base2);
        out.topicSym = (await RC.topicForDay(tk1, '2026-07-06')) === (await RC.topicForDay(tk2, '2026-07-06'));
        out.topicShape = /^[0-9a-f]{32}$/.test(await RC.topicForDay(tk1, '2026-07-06'));
        out.topicRotates = (await RC.topicForDay(tk1, '2026-07-06')) !== (await RC.topicForDay(tk1, '2026-07-07'));

        // A different pair lands on different topics.
        const other = await RC.derivePairBase(RC.randBytes(32), RC.randBytes(32));
        out.topicUnlinkable = (await RC.topicForDay(await RC.deriveTopicKey(other), '2026-07-06'))
            !== (await RC.topicForDay(tk1, '2026-07-06'));

        // Seal/open: roundtrip, and every mismatch is silence (null).
        const k1 = await RC.deriveAeadKey(base1), k2 = await RC.deriveAeadKey(base2);
        const blob = await RC.seal(k1, 'payload-x', 'o', 7);
        out.roundtrip = (await RC.open(k2, blob, 'o', 7)) === 'payload-x';
        out.wrongDirection = (await RC.open(k2, blob, 'a', 7)) === null;
        out.wrongEpoch = (await RC.open(k2, blob, 'o', 8)) === null;
        out.wrongKey = (await RC.open(await RC.deriveAeadKey(other), blob, 'o', 7)) === null;
        const tampered = blob.slice(0, -2) + (blob.endsWith('AA') ? 'BB' : 'AA');
        out.tampered = (await RC.open(k2, tampered, 'o', 7)) === null;
        out.garbage = (await RC.open(k2, '!!not-base64!!', 'o', 7)) === null;

        // Ratchet: same transcript → same next keys; old blobs unreadable.
        const th = await RC.transcriptHash('AA:BB', 'CC:DD');
        const thSym = await RC.transcriptHash('CC:DD', 'AA:BB');
        out.transcriptSym = th.join(',') === thSym.join(',');
        const next1 = await RC.ratchet(base1, th), next2 = await RC.ratchet(base2, thSym);
        out.ratchetSym = (await RC.topicForDay(await RC.deriveTopicKey(next1), '2026-07-06'))
            === (await RC.topicForDay(await RC.deriveTopicKey(next2), '2026-07-06'));
        out.ratchetRotates = (await RC.topicForDay(await RC.deriveTopicKey(next1), '2026-07-06'))
            !== (await RC.topicForDay(tk1, '2026-07-06'));
        out.oldBlobDead = (await RC.open(await RC.deriveAeadKey(next1), blob, 'o', 7)) === null;
        return out;
    });
    for (const [k, v] of Object.entries(r)) assert.equal(v, true, `crypto property: ${k}`);
    console.log('  ✓ key schedule symmetric, sealing airtight, ratchet retires old keys');
    await page.close();
});

// ---------------------------------------------------------------------------

test('mqtt codec: framing roundtrips, split packets reassemble', () => {
    // CONNECT shape
    const connect = mqttCodec.connect('client-1');
    assert.equal(connect[0], 0x10, 'CONNECT packet type');

    // PUBLISH → parse
    const parser = mqttCodec.makeParser();
    const pub = mqttCodec.publish('qrp2p/r/v1/abc', 'sealed-blob-123');
    const pkts = parser(pub);
    assert.equal(pkts.length, 1);
    assert.equal(pkts[0].type, 'publish');
    assert.equal(pkts[0].topic, 'qrp2p/r/v1/abc');
    assert.equal(pkts[0].payload, 'sealed-blob-123');

    // Two packets in one chunk + one split across chunks
    const pub2 = mqttCodec.publish('t/x', 'one');
    const pub3 = mqttCodec.publish('t/y', 'two');
    const merged = new Uint8Array(pub2.length + pub3.length);
    merged.set(pub2, 0); merged.set(pub3, pub2.length);
    const firstHalf = merged.subarray(0, pub2.length + 3);
    const secondHalf = merged.subarray(pub2.length + 3);
    const p2 = parser(firstHalf);
    assert.equal(p2.length, 1, 'complete packet parsed, partial buffered');
    const p3 = parser(secondHalf);
    assert.equal(p3.length, 1, 'split packet reassembled');
    assert.equal(p3[0].payload, 'two');

    // CONNACK / SUBACK recognition
    const p4 = mqttCodec.makeParser()(Uint8Array.from([0x20, 2, 0, 0]));
    assert.equal(p4[0].type, 'connack');
    assert.equal(p4[0].ok, true);
    console.log('  ✓ MQTT 3.1.1 framing encodes, parses, and reassembles');
});

// ---------------------------------------------------------------------------

test('loopback carrier: pub/sub crosses pages in one context', async () => {
    const p1 = await harnessPage(ctxA, 'loop1');
    const p2 = await harnessPage(ctxA, 'loop2');
    await p2.evaluate(async () => {
        window.__got = [];
        window.c = new LoopbackCarrier('loop-test');
        await c.connect();
        c.subscribe('topic-1', m => __got.push(m));
    });
    await p1.evaluate(async () => {
        const c = new LoopbackCarrier('loop-test');
        await c.connect();
        await c.publish('topic-1', 'hello-across-pages');
    });
    await p2.waitForFunction(`__got.includes('hello-across-pages')`, null, { timeout: 5000 });
    console.log('  ✓ loopback carrier delivers across pages');
    await p1.close(); await p2.close();
});

// ---------------------------------------------------------------------------

test('LIFECYCLE: pair once → hard-kill auto-reconnects → browser restart auto-reconnects', async () => {
    // ---- phase 1: manual ceremony + pairing --------------------------------
    let A = await harnessPage(ctxA, 'devA');
    let B = await harnessPage(ctxB, 'devB');
    await connectPair(A, B);

    for (const page of [A, B]) await page.evaluate(RDV_SETUP);
    await A.evaluate(() => rdv.enablePair(Array.from(pm.peers.keys())[0], 'peer-B'));
    await B.evaluate(() => rdv.enablePair(Array.from(pm.peers.keys())[0], 'peer-A'));
    for (const page of [A, B]) {
        await page.waitForFunction(`__rdvEvents.some(e => e.t === 'pair-established')`, null, { timeout: 10000 });
    }
    const roleA = (await readPairRecord(A, 'peer-B')).role;
    const roleB = (await readPairRecord(B, 'peer-A')).role;
    assert.ok(['caller', 'listener'].includes(roleA));
    assert.notEqual(roleA, roleB, 'roles must be complementary');
    console.log(`  ✓ paired (A=${roleA}, B=${roleB})`);

    await A.evaluate(() => pm.send('before-from-A'));
    await B.waitForFunction(`__messages.includes('before-from-A')`, null, { timeout: 5000 });
    await B.evaluate(() => pm.send('before-from-B'));
    await A.waitForFunction(`__messages.includes('before-from-B')`, null, { timeout: 5000 });

    // ---- phase 2: hard kill → zero-tap reconnect ---------------------------
    await A.evaluate(() => Array.from(pm.peers.values())[0].dataChannel.close());
    for (const [page, label] of [[A, 'A'], [B, 'B']]) {
        await page.waitForFunction(`__rdvEvents.some(e => e.t === 'reconnected')`, null, { timeout: 30000 });
        await page.waitForFunction(
            `Array.from(pm.peers.values()).some(p => p.status === 'connected')`,
            null, { timeout: 15000 }
        );
        console.log(`  ✓ ${label}: dead link reconnected through the dead-drop`);
    }

    await A.evaluate(() => pm.send('after-from-A'));
    await B.waitForFunction(`__messages.includes('after-from-A')`, null, { timeout: 5000 });
    await B.evaluate(() => pm.send('after-from-B'));
    await A.waitForFunction(`__messages.includes('after-from-B')`, null, { timeout: 5000 });

    // Exactly-once across the death: session resumed, nothing duplicated.
    for (const [page, label] of [[A, 'A'], [B, 'B']]) {
        const dupes = await page.evaluate(() =>
            __messages.filter((m, i) => __messages.indexOf(m) !== i));
        assert.deepEqual(dupes, [], `${label}: no duplicate deliveries across reconnect`);
    }
    console.log('  ✓ messages flow after reconnect, exactly once');

    // Ratchet advanced on both sides.
    assert.equal((await readPairRecord(A, 'peer-B')).epoch, 1, 'A ratcheted to epoch 1');
    assert.equal((await readPairRecord(B, 'peer-A')).epoch, 1, 'B ratcheted to epoch 1');
    console.log('  ✓ both sides ratcheted (epoch 0 → 1)');

    // ---- phase 3: full browser restart → zero-tap reconnect ----------------
    await A.close(); await B.close();
    A = await harnessPage(ctxA, 'devA2');
    B = await harnessPage(ctxB, 'devB2');
    for (const page of [A, B]) {
        await page.evaluate(async () => {
            window.pm = new PeerManager({ iceMode: 'local' });
            window.__messages = [];
            pm.addEventListener('message', e => { if (e.detail.incoming) __messages.push(e.detail.text); });
        });
        await page.evaluate(RDV_SETUP);
        await page.evaluate(() => rdv.resumeAll());
    }
    for (const [page, label] of [[A, 'A'], [B, 'B']]) {
        await page.waitForFunction(`__rdvEvents.some(e => e.t === 'reconnected')`, null, { timeout: 30000 });
        await page.waitForFunction(
            `Array.from(pm.peers.values()).some(p => p.status === 'connected')`,
            null, { timeout: 15000 }
        );
        console.log(`  ✓ ${label}: reconnected after full restart via resumeAll()`);
    }
    await A.evaluate(() => pm.send('post-restart-from-A'));
    await B.waitForFunction(`__messages.includes('post-restart-from-A')`, null, { timeout: 5000 });
    await B.evaluate(() => pm.send('post-restart-from-B'));
    await A.waitForFunction(`__messages.includes('post-restart-from-B')`, null, { timeout: 5000 });
    console.log('  ✓ post-restart messages flow both ways');

    // Second ratchet: epoch 1 → 2.
    assert.equal((await readPairRecord(A, 'peer-B')).epoch, 2, 'A ratcheted to epoch 2');
    assert.equal((await readPairRecord(B, 'peer-A')).epoch, 2, 'B ratcheted to epoch 2');
    console.log('  ✓ second reconnect ratcheted again (epoch 1 → 2)');

    await A.close(); await B.close();
});

// ---------------------------------------------------------------------------

test('security: a stranger with the topic cannot inject; disabled pairs stay silent', async () => {
    const page = await harnessPage(ctxA, 'sec');
    const r = await page.evaluate(async () => {
        const RC = RendezvousCrypto;
        const out = {};
        // Attacker knows the topic (watched the relay) but lacks the pair key:
        // their forged blob must open to null for the honest listener.
        const honest = await RC.deriveAeadKey(await RC.derivePairBase(RC.randBytes(32), RC.randBytes(32)));
        const attacker = await RC.deriveAeadKey(await RC.derivePairBase(RC.randBytes(32), RC.randBytes(32)));
        const forged = await RC.seal(attacker, JSON.stringify({ peerId: 'x', sessionDesc: { type: 'offer', sdp: 'v=0' } }), 'o', 1);
        out.forgedRejected = (await RC.open(honest, forged, 'o', 1)) === null;

        // Replay of a legitimate old-epoch blob fails once the epoch advanced.
        const old = await RC.seal(honest, 'old-offer', 'o', 1);
        out.oldEpochRejected = (await RC.open(honest, old, 'o', 2)) === null;
        return out;
    });
    assert.equal(r.forgedRejected, true, 'forged blobs are silence');
    assert.equal(r.oldEpochRejected, true, 'stale-epoch blobs are silence');
    console.log('  ✓ forgery and replay both die at the AEAD boundary');
    await page.close();
});
