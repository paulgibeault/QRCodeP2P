const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
    ]
};

// ==========================================
// UTILS: Compression & QR
// ==========================================
export class ConnectionUtils {
    static async compressData(dataStr) {
        const stream = new Blob([dataStr], {type: 'application/json'}).stream().pipeThrough(new CompressionStream('deflate-raw'));
        const blob = await new Response(stream).blob();
        const buffer = await blob.arrayBuffer();
        
        // Robust Uint8Array to base64 conversion that avoids call stack limits
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const b64 = btoa(binary);
        
        // Convert standard base64 to base64url (URL-Safe)
        return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    static async decompressData(b64Str) {
        try {
            // Convert URL-safe base64url back to standard base64
            let standardB64 = b64Str.replace(/-/g, '+').replace(/_/g, '/');
            while (standardB64.length % 4) {
                standardB64 += '=';
            }
            const bytes = Uint8Array.from(atob(standardB64), c => c.charCodeAt(0));
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            const blob = await new Response(stream).blob();
            return await blob.text();
        } catch (e) {
            throw new Error(`Decompression failed: ${e.message}`);
        }
    }

    /**
     * Strips bulky/unnecessary lines from an SDP string to reduce QR code size.
     * Specifically filters out TCP candidates and optionally mDNS (.local) and IPv6 based on options.
     */
    static minifySDP(sdpStr, options = {}) {
        const allowLocal = options.allowLocalCandidates !== false;
        const allowIPv6 = options.allowIPv6Candidates !== false;
        const lines = sdpStr.split('\r\n');
        const minified = lines.filter(line => {
            if (line.startsWith('a=candidate:')) {
                // Drop TCP candidates (UDP is preferred for WebRTC data)
                if (line.includes(' tcp ')) return false;
                
                // Drop mDNS candidates if not allowed
                if (!allowLocal && line.includes('.local')) return false;
                
                const parts = line.split(' ');
                // Drop IPv6 candidates if not allowed (address is part 4, 0-indexed)
                if (!allowIPv6 && parts.length > 4 && parts[4].includes(':')) return false;
                
                return true;
            }
            return true;
        });
        return minified.join('\r\n');
    }

    /**
     * Validates that a signaling payload has the expected structure before
     * passing it to WebRTC internals. Throws a descriptive Error on failure.
     * @param {*} data - The deserialized payload object.
     * @param {string[]} [requiredFields=['peerId','sessionDesc']] - Fields that must be present.
     * @returns {object} The validated data object (pass-through).
     */
    static validatePayload(data, requiredFields = ['peerId', 'sessionDesc']) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Invalid payload: expected a plain object');
        }
        for (const field of requiredFields) {
            if (!(field in data)) {
                throw new Error(`Invalid payload: missing required field "${field}"`);
            }
        }
        if (data.sessionDesc && (typeof data.sessionDesc.type !== 'string' || typeof data.sessionDesc.sdp !== 'string')) {
            throw new Error('Invalid payload: sessionDesc must have string fields "type" and "sdp"');
        }
        return data;
    }
}

// ==========================================
// CORE: WebRTC Manager
// ==========================================
export class PeerManager extends EventTarget {
    constructor(options = {}) {
        super();
        this.peers = new Map();
        this.isHost = false;
        this.myId = this.generateId();
        
        // Configuration options
        this.options = {
            allowLocalCandidates: options.allowLocalCandidates !== false,
            allowIPv6Candidates: options.allowIPv6Candidates !== false,
            connectionTimeoutMs: options.connectionTimeoutMs || 300000 // 5 minutes default
        };
    }

    generateId() {
        return Math.random().toString(36).substring(2, 9);
    }

    initPeer(peerId, type) {
        if(this.peers.has(peerId)) {
            const existing = this.peers.get(peerId);
            existing.connection.onicecandidate = null;
            existing.connection.close();
            this.peers.delete(peerId);
        }
        
        const peerConnection = new RTCPeerConnection(STUN_SERVERS);
        const peerData = {
            connection: peerConnection,
            dataChannel: null,
            status: 'new',
            type: type
        };
        this.peers.set(peerId, peerData);
        
        peerConnection.oniceconnectionstatechange = () => {
            peerData.status = peerConnection.iceConnectionState;
            if (peerConnection.iceConnectionState === 'failed') {
                peerConnection.close();
                this.peers.delete(peerId);
            }
            this.dispatchEvent(new CustomEvent('status', { detail: { peerId, status: peerData.status } }));
        };

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                const cstr = event.candidate.candidate;
                let typeMatch = cstr.match(/typ (\w+)/);
                let candType = typeMatch ? typeMatch[1] : 'unknown';
                let outStr = `[${candType.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`;
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'ice', msg: `[Peer ${peerId}] ${outStr}` }
                }));
            } else {
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'sys', msg: `ICE Gathering Complete for ${peerId}.` }
                }));
            }
        };

        peerConnection.ondatachannel = (event) => {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Data channel inbound from ${peerId}.` }}));
            this.setupDataChannel(peerId, event.channel);
        };

        return peerData;
    }

    setupDataChannel(peerId, channel) {
        const peerData = this.peers.get(peerId);
        if(!peerData) return;
        
        peerData.dataChannel = channel;
        peerData.dataChannel.onopen = () => {
            this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: true } }));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'success', msg: `Data channel OPEN with ${peerId}!` }}));
        };
        peerData.dataChannel.onclose = () => {
            this.dispatchEvent(new CustomEvent('chatState', { detail: { peerId, ready: false } }));
            this.peers.delete(peerId);
        };
        peerData.dataChannel.onmessage = (event) => {
            let data = event.data;
            let parsed = null;
            
            try {
                parsed = JSON.parse(data);
            } catch(e) {
                parsed = { text: data, from: peerId }; // legacy string fallback
            }

            // Host relays messages
            if (this.isHost && parsed.from !== this.myId) {
                this.broadcast(data, peerId);
            }

            // Destructure only the expected fields to avoid merging arbitrary keys
            const { text, from } = parsed;
            this.dispatchEvent(new CustomEvent('message', { 
                detail: { text, from, incoming: true, peerId } 
            }));
        };
    }

    broadcast(message, excludePeerId = null) {
        let sent = false;
        const msgStr = typeof message === 'string' ? message : JSON.stringify(message);

        this.peers.forEach((peerData, pId) => {
            if (pId !== excludePeerId && peerData.dataChannel && peerData.dataChannel.readyState === 'open') {
                peerData.dataChannel.send(msgStr);
                sent = true;
            }
        });
        
        return sent;
    }

    send(text) {
        const payload = { text, from: this.myId };
        const sent = this.broadcast(payload);
        
        if (sent) {
            this.dispatchEvent(new CustomEvent('message', { detail: { text, from: this.myId, incoming: false }}));
        } else {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: 'Cannot send, no channels open.' }}));
        }
    }

    /**
     * Closes all peer connections and data channels, then clears the peers Map.
     * After destroy(), this instance should not be reused.
     */
    destroy() {
        this.peers.forEach((peerData) => {
            try { peerData.dataChannel?.close(); } catch(_) {}
            try { peerData.connection.close(); } catch(_) {}
        });
        this.peers.clear();
    }

    async createOffer() {
        this.isHost = true;
        const peerId = this.generateId();
        const peerData = this.initPeer(peerId, 'client');
        this.setupDataChannel(peerId, peerData.connection.createDataChannel('data'));
        
        try {
            const offer = await peerData.connection.createOffer();
            await peerData.connection.setLocalDescription(offer);
            await this.waitForIceGathering(peerId);
            
            setTimeout(() => {
                if (peerData.status !== 'connected') {
                    peerData.connection.close();
                    this.peers.delete(peerId);
                    this.dispatchEvent(new CustomEvent('diagnostic', {
                        detail: { type: 'warn', msg: `Connection attempt to ${peerId} timed out.` }
                    }));
                }
            }, this.options.connectionTimeoutMs);
            
            const minifiedSDP = ConnectionUtils.minifySDP(peerData.connection.localDescription.sdp, this.options);
            
            return JSON.stringify({
                peerId: peerId,
                sessionDesc: {
                    type: peerData.connection.localDescription.type,
                    sdp: minifiedSDP
                }
            });
        } catch (e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Offer creation failed: ${e.message}` }}));
            throw e;
        }
    }

    async createAnswer(offerPayload) {
        this.isHost = false;
        const hostPeerId = offerPayload.peerId; 
        const peerData = this.initPeer(hostPeerId, 'host');
        
        try {
            await peerData.connection.setRemoteDescription(new RTCSessionDescription(offerPayload.sessionDesc));
            const answer = await peerData.connection.createAnswer();
            await peerData.connection.setLocalDescription(answer);
            await this.waitForIceGathering(hostPeerId);
            
            const minifiedSDP = ConnectionUtils.minifySDP(peerData.connection.localDescription.sdp, this.options);
            
            return JSON.stringify({
                peerId: hostPeerId,
                sessionDesc: {
                    type: peerData.connection.localDescription.type,
                    sdp: minifiedSDP
                }
            });
        } catch(e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Answer creation failed: ${e.message}` }}));
            throw e;
        }
    }

    async acceptAnswer(answerPayload) {
        const peerId = answerPayload.peerId;
        const peerData = this.peers.get(peerId);
        
        if (!peerData) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Peer ${peerId} not found to accept answer.` }}));
            return;
        }

        if (peerData.connection.signalingState !== 'have-local-offer') {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Answer already processed for ${peerId}` }}));
            return;
        }

        try {
            await peerData.connection.setRemoteDescription(new RTCSessionDescription(answerPayload.sessionDesc));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Answer accepted from ${peerId}` }}));
        } catch(e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Accepting answer failed: ${e.message}` }}));
        }
    }

    async waitForIceGathering(peerId) {
        const peerData = this.peers.get(peerId);
        if (!peerData) return;

        return new Promise((resolve) => {
            if (peerData.connection.iceGatheringState === 'complete') {
                resolve();
            } else {
                let timeout;
                const checkState = () => {
                    if (peerData.connection.iceGatheringState === 'complete') {
                        peerData.connection.removeEventListener('icegatheringstatechange', checkState);
                        clearTimeout(timeout);
                        resolve();
                    }
                };
                peerData.connection.addEventListener('icegatheringstatechange', checkState);
                
                // 10 second timeout
                timeout = setTimeout(() => {
                    peerData.connection.removeEventListener('icegatheringstatechange', checkState);
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'warn', msg: `ICE Gathering Timeout for ${peerId}. Proceeding.` }}));
                    resolve();
                }, 10000);
            }
        });
    }
}
