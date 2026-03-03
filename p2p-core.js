const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        // for reliability, we normally would add a turn server here
        // { urls: 'turn:YOUR_TURN_SERVER', username: 'u', credential: 'c' }
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
        return btoa(String.fromCharCode(...new Uint8Array(buffer)));
    }

    static async decompressData(b64Str) {
        try {
            const bytes = Uint8Array.from(atob(b64Str), c => c.charCodeAt(0));
            const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
            const blob = await new Response(stream).blob();
            return await blob.text();
        } catch (e) {
            throw new Error(`Decompression failed: ${e.message}`);
        }
    }
}

// ==========================================
// CORE: WebRTC Manager
// ==========================================
export class PeerManager extends EventTarget {
    constructor() {
        super();
        this.peers = new Map();
        this.isHost = false;
        this.myId = this.generateId();
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

            this.dispatchEvent(new CustomEvent('message', { 
                detail: Object.assign({}, parsed, { incoming: true, peerId }) 
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

    async createOffer() {
        this.isHost = true;
        const peerId = this.generateId();
        const peerData = this.initPeer(peerId, 'client');
        this.setupDataChannel(peerId, peerData.connection.createDataChannel('data'));
        
        try {
            const offer = await peerData.connection.createOffer();
            await peerData.connection.setLocalDescription(offer);
            await this.waitForIceGathering(peerId);
            
            return JSON.stringify({
                peerId: peerId,
                sessionDesc: peerData.connection.localDescription
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
            
            return JSON.stringify({
                peerId: hostPeerId,
                sessionDesc: peerData.connection.localDescription
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
