const APP_VERSION = "v1.1.0 (Refactored)";

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
class ConnectionUtils {
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
class PeerManager extends EventTarget {
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
        this.setupDataChannel(this.peerConnection.createDataChannel('chat'));
        
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
                
                // 2.5 second timeout
                timeout = setTimeout(() => {
                    this.peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    this.dispatchEvent(new CustomEvent('diagnostic', { detail: { type: 'warn', msg: 'ICE Gathering Timeout (2.5s) reached. Proceeding with collected candidates.' }}));
                    resolve();
                }, 2500);
            }
        });
    }
}

// ==========================================
// UI / MAIN RUNNER
// ==========================================
const ui = {
    btnHost: document.getElementById('btn-host'),
    btnJoin: document.getElementById('btn-join'),
    btnScanAns: document.getElementById('btn-scan-answer'),
    qrContainer: document.getElementById('qr-container'),
    scannerContainer: document.getElementById('scanner-container'),
    qrPlaceholder: document.getElementById('qr-placeholder'),
    qrCanvas: document.getElementById('qr-canvas'),
    qrInstructions: document.getElementById('qr-instructions'),
    statusBadge: document.getElementById('connection-status'),
    messagesBox: document.getElementById('messages'),
    chatInput: document.getElementById('chat-input'),
    btnSend: document.getElementById('btn-send'),
    chatForm: document.getElementById('chat-form'),
    diagnosticsOut: document.getElementById('diagnostics-out'),
    iceServersDisplay: document.getElementById('ice-servers-display'),
    pasteInput: document.getElementById('paste-input'),
    btnSubmitPaste: document.getElementById('btn-submit-paste')
};

// Initialize Display
if (document.getElementById('app-version')) document.getElementById('app-version').textContent = APP_VERSION;
STUN_SERVERS.iceServers.forEach(server => {
    let li = document.createElement('li');
    li.textContent = server.urls;
    ui.iceServersDisplay.appendChild(li);
});

const peerNode = new PeerManager();
let html5QrcodeScanner;
let rawSDPPayload = "";
let currentScanSuccessCallback = null;

function htmlEscape(str) {
    return String(str).replace(/[&<>"'`=\/]/g, function (s) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#x2F;', '`': '&#x60;', '=': '&#x3D;' }[s];
    });
}

function CandTypeMapping(typeStr) {
    let typeMap = typeStr.toLowerCase();
    if(typeMap === 'host') return '<span class="badge badge-host">HOST</span>';
    if(typeMap === 'srflx') return '<span class="badge badge-srflx">SRFLX</span>';
    if(typeMap === 'relay') return '<span class="badge badge-turn">RELAY</span>';
    return `<span class="badge badge-host">${htmlEscape(typeStr.toUpperCase())}</span>`;
}

// Diagnostics Logging
function logDiag(type, msg) {
    const div = document.createElement('div');
    if(type === 'ice') {
        let span = document.createElement('span');
        span.className = 'diag-ice';
        // Parse the message to format the tags manually
        let typematch = msg.match(/\[(.*?)\]/);
        if (typematch) {
             let tag = CandTypeMapping(typematch[1]);
             span.innerHTML = tag + " " + htmlEscape(msg.replace(`[${typematch[1]}] `, ''));
        } else {
             span.textContent = msg;
        }
        div.appendChild(span);
    } else {
        div.className = `diag-${type}`;
        div.textContent = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
    }
    ui.diagnosticsOut.appendChild(div);
    ui.diagnosticsOut.scrollTop = ui.diagnosticsOut.scrollHeight;
}

// App Logic Logs
peerNode.addEventListener('diagnostic', (e) => logDiag(e.detail.type, e.detail.msg));
peerNode.addEventListener('status', (e) => {
    const status = e.detail;
    ui.statusBadge.textContent = status.toUpperCase();
    ui.statusBadge.className = '';
    if (status === 'connected') {
        ui.statusBadge.classList.add('status-connected');
        cleanupUI();
    }
    else if (status === 'disconnected') ui.statusBadge.classList.add('status-disconnected');
    else ui.statusBadge.classList.add('status-connecting');
});

// Chat Log
function logMessage(msg, type = 'system') {
    const div = document.createElement('div');
    if(type === 'system') div.style.color = '#888';
    if(type === 'me') div.style.color = '#4ade80';
    if(type === 'peer') div.style.color = '#60a5fa';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    ui.messagesBox.appendChild(div);
    ui.messagesBox.scrollTop = ui.messagesBox.scrollHeight;
}

peerNode.addEventListener('chatState', (e) => {
    ui.chatInput.disabled = !e.detail;
    ui.btnSend.disabled = !e.detail;
});
peerNode.addEventListener('message', (e) => {
    if (e.detail.incoming) logMessage(`Peer: ${e.detail.text}`, 'peer');
    else logMessage(`Me: ${e.detail.text}`, 'me');
});

ui.chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ui.chatInput.value.trim();
    if(text) {
        peerNode.send(text);
        ui.chatInput.value = '';
    }
});

// ==========================================
// SCANNER & QR ENGINE
// ==========================================
async function displayQRCode(dataStr, instructions) {
    ui.scannerContainer.style.display = 'none';
    if(ui.qrPlaceholder) ui.qrPlaceholder.style.display = 'none';
    ui.qrContainer.style.display = 'block';
    ui.qrInstructions.textContent = instructions;
    
    logDiag('info', 'Compressing SDP payload...');
    rawSDPPayload = await ConnectionUtils.compressData(dataStr);
    logDiag('success', `Payload compressed to ${rawSDPPayload.length} chars`);
    
    try {
        ui.qrCanvas.innerHTML = '';
        new QRCode(ui.qrCanvas, {
            text: rawSDPPayload,
            width: 300,
            height: 300,
            correctLevel: QRCode.CorrectLevel.L
        });
    } catch(e) {
        logDiag('error', `QR Canvas err: ${e.message}`);
    }
}

function startScanner(onSuccess) {
    ui.qrContainer.style.display = 'none';
    if(ui.qrPlaceholder) ui.qrPlaceholder.style.display = 'none';
    ui.scannerContainer.style.display = 'block';
    currentScanSuccessCallback = onSuccess;
    
    if (html5QrcodeScanner) {
        try { html5QrcodeScanner.clear(); } catch(e){}
    }
    
    html5QrcodeScanner = new Html5QrcodeScanner("reader", { fps: 10 }, false);
    
    let failureCount = 0;
    
    html5QrcodeScanner.render(async (decodedText, decodedResult) => {
        // Success Handler
        try { html5QrcodeScanner.clear(); } catch(e){}
        ui.scannerContainer.style.display = 'none';
        logDiag('success', 'QR Code parameters identified! Extracting payload...');
        
        try {
            const decompressed = await ConnectionUtils.decompressData(decodedText);
            const data = JSON.parse(decompressed);
            onSuccess(data);
        } catch (e) {
            logDiag('error', `Failed Data Decompression: ${e.message}`);
            alert("Failed to decode connection data. Check diagnostics panel.");
            // Restart scanner visually if failed
            cleanupUI();
            startScanner(onSuccess);
        }
    }, (err) => {
        // Error / Retry Handler (Avoid flooding log on empty frames)
        if(err && !err.includes("NotFoundException")) {
            failureCount++;
            if(failureCount % 5 === 0) {
                logDiag('warn', `Scanner active, parsing frame... (Failed decoding x${failureCount})`);
            }
        }
    });
}

function cleanupUI() {
    ui.qrContainer.style.display = 'none';
    ui.scannerContainer.style.display = 'none';
    if(ui.qrPlaceholder && ui.statusBadge.textContent !== 'CONNECTED') {
        ui.qrPlaceholder.style.display = 'block';
    }
    if(html5QrcodeScanner) { try { html5QrcodeScanner.clear(); } catch(e){} }
}

// ==========================================
// EVENT BINDINGS
// ==========================================
ui.btnHost.addEventListener('click', async () => {
    logMessage('Starting as HOST...');
    logDiag('info', '--- HOST SEQUENCE ---');
    ui.btnHost.style.display = 'none';
    ui.btnJoin.style.display = 'none';
    ui.btnScanAns.style.display = 'inline-block';
    
    try {
        const offerData = await peerNode.createOffer();
        displayQRCode(offerData, "Step 1: Have JOINER scan this.");
    } catch (e) {
        logDiag('error', 'Critical failure generating Host Offer.');
    }
});

ui.btnJoin.addEventListener('click', () => {
    logMessage('Starting as JOINER...');
    logDiag('info', '--- JOIN SEQUENCE ---');
    ui.btnHost.style.display = 'none';
    ui.btnJoin.style.display = 'none';
    
    startScanner(async (offerData) => {
        logDiag('info', 'Ingested Offer constraints. Computing Answer SDP...');
        try {
            const answerData = await peerNode.createAnswer(offerData);
            displayQRCode(answerData, "Step 2: Have HOST scan this.");
        } catch (e) {
            logDiag('error', 'Critical failure computing Joiner Answer.');
        }
    });
});

ui.btnScanAns.addEventListener('click', () => {
    logDiag('info', 'Opening scanner for Answer.');
    startScanner(async (answerData) => {
        logDiag('info', 'Applying Answer remotely...');
        await peerNode.acceptAnswer(answerData);
    });
});

// Misc Bindings
document.getElementById('btn-cancel-scan').addEventListener('click', () => {
    cleanupUI();
    ui.btnHost.style.display = 'block';
    ui.btnJoin.style.display = 'block';
    ui.btnScanAns.style.display = 'none';
    if(peerNode.peerConnection) peerNode.peerConnection.close();
});

document.getElementById('btn-clear-diag').addEventListener('click', () => {
    ui.diagnosticsOut.innerHTML = '';
    logDiag('info', 'Diagnostics Cleared.');
});

document.getElementById('btn-copy-sdp').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(rawSDPPayload);
        alert("Payload copied to clipboard.");
    } catch(e) {
        logDiag('error', "Clipboard access denied. This requires HTTPS.");
    }
});

ui.btnSubmitPaste.addEventListener('click', async () => {
    if (!currentScanSuccessCallback) return;
    const text = ui.pasteInput.value.trim();
    if (!text) return;
    try {
        logDiag('info', 'Attempting to unpack pasted string...');
        const decompressed = await ConnectionUtils.decompressData(text);
        currentScanSuccessCallback(JSON.parse(decompressed));
        ui.pasteInput.value = '';
        if(html5QrcodeScanner) try { html5QrcodeScanner.clear(); } catch(e){}
        ui.scannerContainer.style.display = 'none';
    } catch (e) {
        logDiag('error', `Paste parsing failed: ${e.message}`);
    }
});
