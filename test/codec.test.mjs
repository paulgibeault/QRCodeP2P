// Node unit tests for sdp-codec.js — run with: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SDPCodec } from '../sdp-codec.js';

const FINGERPRINT = 'A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90:A1:B2:C3:D4:E5:F6:07:18:29:3A:4B:5C:6D:7E:8F:90';

// Chrome-shaped datachannel offer with host/srflx/mdns/ipv6/tcp candidates
const CHROME_OFFER_SDP = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:2999745851 1 udp 2113937151 192.168.1.42 56789 typ host generation 0 network-cost 999',
    'a=candidate:1510613869 1 udp 1677729535 203.0.113.5 60000 typ srflx raddr 192.168.1.42 rport 56789 generation 0',
    'a=candidate:842163049 1 udp 1677732095 2001:db8::1 60001 typ srflx raddr :: rport 0',
    'a=candidate:3334445556 1 udp 2113939711 a1b2c3d4-e5f6-7890-abcd-ef1234567890.local 56790 typ host',
    'a=candidate:99988877 1 tcp 1518280447 192.168.1.42 9 typ host tcptype active',
    'a=ice-ufrag:oVXe',
    'a=ice-pwd:ByKUuUpJd8gJKF10YsTTuXqz',
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${FINGERPRINT}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ''
].join('\r\n');

// Firefox-shaped answer (fingerprint at session level, LF line endings)
const FIREFOX_ANSWER_SDP = [
    'v=0',
    'o=mozilla...THIS_IS_SDPARTA-99.0 8324656071236848 0 IN IP4 0.0.0.0',
    's=-',
    't=0 0',
    `a=fingerprint:sha-256 ${FINGERPRINT}`,
    'a=group:BUNDLE 0',
    'a=ice-options:trickle',
    'a=msid-semantic:WMS *',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=candidate:0 1 UDP 2122252543 10.0.0.7 51234 typ host',
    'a=sendrecv',
    'a=ice-pwd:e5b4bbcccb54d3b7cf132bf3ddc0f781',
    'a=ice-ufrag:8b31e9b4',
    'a=mid:0',
    'a=setup:active',
    'a=sctp-port:5000',
    'a=max-message-size:1073741823',
    ''
].join('\n');

const offerPayload = { peerId: 'abc1234', sessionDesc: { type: 'offer', sdp: CHROME_OFFER_SDP } };

test('pack produces a compact versioned string', () => {
    const packed = SDPCodec.pack(offerPayload);
    assert.match(packed, /^1\.[A-Za-z0-9_-]+$/);
    assert.ok(packed.length < 250, `packed length ${packed.length} should be < 250`);
    assert.ok(SDPCodec.isPacked(packed));
    console.log(`  offer packed size: ${packed.length} chars (raw SDP payload was ${CHROME_OFFER_SDP.length} chars)`);
});

test('unpack reconstructs a valid offer SDP', () => {
    const packed = SDPCodec.pack(offerPayload);
    const out = SDPCodec.unpack(packed);

    assert.equal(out.peerId, 'abc1234');
    assert.equal(out.sessionDesc.type, 'offer');
    const sdp = out.sessionDesc.sdp;

    assert.ok(sdp.includes('a=ice-ufrag:oVXe'));
    assert.ok(sdp.includes('a=ice-pwd:ByKUuUpJd8gJKF10YsTTuXqz'));
    assert.ok(sdp.includes(`a=fingerprint:sha-256 ${FINGERPRINT}`));
    assert.ok(sdp.includes('a=setup:actpass'), 'offer must be actpass');
    assert.ok(sdp.includes('a=mid:0'));
    assert.ok(sdp.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel'));

    // All four UDP candidates survive; TCP one is dropped
    assert.ok(sdp.includes(' 192.168.1.42 56789 typ host'));
    assert.ok(sdp.includes(' 203.0.113.5 60000 typ srflx raddr 0.0.0.0 rport 0'));
    assert.ok(sdp.includes(' 2001:db8:0:0:0:0:0:1 60001 typ srflx raddr :: rport 0'));
    assert.ok(sdp.includes(' a1b2c3d4-e5f6-7890-abcd-ef1234567890.local 56790 typ host'));
    assert.equal((sdp.match(/a=candidate:/g) || []).length, 4, 'tcp candidate must be dropped');
});

test('pack/unpack round-trip is stable', () => {
    const packed1 = SDPCodec.pack(offerPayload);
    const unpacked = SDPCodec.unpack(packed1);
    const packed2 = SDPCodec.pack(unpacked);
    assert.equal(packed1, packed2, 'repacking an unpacked payload must be byte-identical');
});

test('firefox-shaped answer packs and reconstructs with setup:active', () => {
    const payload = { peerId: 'xyz9876', sessionDesc: { type: 'answer', sdp: FIREFOX_ANSWER_SDP } };
    const packed = SDPCodec.pack(payload);
    const out = SDPCodec.unpack(packed);

    assert.equal(out.sessionDesc.type, 'answer');
    assert.ok(out.sessionDesc.sdp.includes('a=setup:active'), 'answer must be active');
    assert.ok(out.sessionDesc.sdp.includes('a=ice-ufrag:8b31e9b4'));
    assert.ok(out.sessionDesc.sdp.includes(' 10.0.0.7 51234 typ host'));
    console.log(`  answer packed size: ${packed.length} chars`);
});

test('isPacked rejects legacy deflate payloads', () => {
    assert.equal(SDPCodec.isPacked('eJxLTEouyczPUwCAAA'), false); // no dot
    assert.equal(SDPCodec.isPacked('not!valid'), false);
});

test('unpack rejects garbage and truncation', () => {
    assert.throws(() => SDPCodec.unpack('2.AAAA'), /version/);
    assert.throws(() => SDPCodec.unpack('nope'), /not a packed payload/);
    const packed = SDPCodec.pack(offerPayload);
    const truncated = packed.slice(0, Math.floor(packed.length / 2));
    assert.throws(() => SDPCodec.unpack(truncated));
});

test('sdp without ice credentials refuses to pack', () => {
    assert.throws(
        () => SDPCodec.pack({ peerId: 'x', sessionDesc: { type: 'offer', sdp: 'v=0\r\ns=-\r\n' } }),
        /missing ice-ufrag/
    );
});
