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
        this.peerConnection = null;
        this.dataChannel = null;
        this.candidates = [];
    }

    init() {
        if(this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.close();
        }
        
        this.peerConnection = new RTCPeerConnection(STUN_SERVERS);
        
        this.peerConnection.oniceconnectionstatechange = () => {
            this.dispatchEvent(new CustomEvent('status', { detail: this.peerConnection.iceConnectionState }));
        };

        // NEW: ICE Candidate Tracking
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                // Parse candidate string to find type (host, srflx, relay)
                const cstr = event.candidate.candidate;
                let typeMatch = cstr.match(/typ (\w+)/);
                let candType = typeMatch ? typeMatch[1] : 'unknown';
                
                let outStr = `[${candType.toUpperCase()}] ${event.candidate.address}:${event.candidate.port}`;
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'ice', msg: outStr }
                }));
            } else {
                this.dispatchEvent(new CustomEvent('diagnostic', {
                    detail: { type: 'sys', msg: 'ICE Gathering Complete.' }
                }));
            }
        };

        this.peerConnection.ondatachannel = (event) => {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: 'Data channel inbound from remote.' }}));
            this.setupDataChannel(event.channel);
        };
    }

    setupDataChannel(channel) {
        this.dataChannel = channel;
        this.dataChannel.onopen = () => {
            this.dispatchEvent(new CustomEvent('chatState', { detail: true }));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'success', msg: 'Data channel OPEN!' }}));
        };
        this.dataChannel.onclose = () => {
            this.dispatchEvent(new CustomEvent('chatState', { detail: false }));
        };
        this.dataChannel.onmessage = (event) => {
            this.dispatchEvent(new CustomEvent('message', { detail: { text: event.data, incoming: true }}));
        };
    }

    send(message) {
        if(this.dataChannel && this.dataChannel.readyState === 'open') {
            this.dataChannel.send(message);
            this.dispatchEvent(new CustomEvent('message', { detail: { text: message, incoming: false }}));
        } else {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: 'Cannot send, channel not open.' }}));
        }
    }

    async createOffer() {
        this.init();
        this.setupDataChannel(this.peerConnection.createDataChannel('data'));
        
        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);
            await this.waitForIceGathering();
            
            return JSON.stringify(this.peerConnection.localDescription);
        } catch (e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Offer creation failed: ${e.message}` }}));
            throw e;
        }
    }

    async createAnswer(offerPayload) {
        this.init();
        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offerPayload));
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);
            await this.waitForIceGathering();
            
            return JSON.stringify(this.peerConnection.localDescription);
        } catch(e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Answer creation failed: ${e.message}` }}));
            throw e;
        }
    }

    async acceptAnswer(answerPayload) {
        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answerPayload));
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'sys', msg: `Answer accepted` }}));
        } catch(e) {
            this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'error', msg: `Accepting answer failed: ${e.message}` }}));
        }
    }

    async waitForIceGathering() {
        return new Promise((resolve) => {
            if (this.peerConnection.iceGatheringState === 'complete') {
                resolve();
            } else {
                let timeout;
                const checkState = () => {
                    if (this.peerConnection.iceGatheringState === 'complete') {
                        this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                        clearTimeout(timeout);
                        resolve();
                    }
                };
                this.peerConnection.addEventListener('icegatheringstatechange', checkState);
                
                // 10 second timeout
                timeout = setTimeout(() => {
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'warn', msg: 'ICE Gathering Timeout (10s) reached. Proceeding with collected candidates.' }}));
                    resolve();
                }, 10000);
            }
        });
    }
}
