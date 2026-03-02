const STUN_SERVERS = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
};

let peerConnection;
let dataChannel;
let html5QrcodeScanner;

// UI Elements
const btnHost = document.getElementById('btn-host');
const btnJoin = document.getElementById('btn-join');
const btnScanAnswer = document.getElementById('btn-scan-answer');
const qrContainer = document.getElementById('qr-container');
const scannerContainer = document.getElementById('scanner-container');
const qrCanvas = document.getElementById('qr-canvas');
const qrInstructions = document.getElementById('qr-instructions');
const messagesBox = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const btnSend = document.getElementById('btn-send');
const statusBadge = document.getElementById('connection-status');
const readerDiv = document.getElementById('reader');
const pasteInput = document.getElementById('paste-input');
const btnSubmitPaste = document.getElementById('btn-submit-paste');

let rawSDPPayload = ""; // used for copying
let currentScanSuccessCallback = null;

function logMessage(msg, type = 'system') {
    const div = document.createElement('div');
    if(type === 'system') div.style.color = '#888';
    if(type === 'me') div.style.color = '#4ade80';
    if(type === 'peer') div.style.color = '#60a5fa';
    div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    messagesBox.appendChild(div);
    messagesBox.scrollTop = messagesBox.scrollHeight;
}

function updateStatus(status) {
    statusBadge.textContent = status.toUpperCase();
    statusBadge.className = '';
    if (status === 'connected') statusBadge.classList.add('status-connected');
    else if (status === 'disconnected') statusBadge.classList.add('status-disconnected');
    else statusBadge.classList.add('status-connecting');
}

function initPeerConnection() {
    peerConnection = new RTCPeerConnection(STUN_SERVERS);
    
    peerConnection.oniceconnectionstatechange = () => {
        logMessage(`ICE Connection State: ${peerConnection.iceConnectionState}`);
        if(peerConnection.iceConnectionState === 'connected') {
            updateStatus('connected');
            cleanupUI();
            chatInput.disabled = false;
            btnSend.disabled = false;
        } else if (peerConnection.iceConnectionState === 'disconnected') {
            updateStatus('disconnected');
            chatInput.disabled = true;
            btnSend.disabled = true;
        }
    };

    peerConnection.ondatachannel = (event) => {
        logMessage('Data channel received from peer.');
        setupDataChannel(event.channel);
    };
}

function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.onopen = () => logMessage('Data channel opened!');
    dataChannel.onclose = () => logMessage('Data channel closed.');
    dataChannel.onmessage = (event) => logMessage(`Peer: ${event.data}`, 'peer');
}

async function waitForIceGathering() {
    return new Promise((resolve) => {
        if (peerConnection.iceGatheringState === 'complete') {
            resolve();
        } else {
            const checkState = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    peerConnection.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            };
            peerConnection.addEventListener('icegatheringstatechange', checkState);
        }
    });
}

function generateQRCode(data, instructions) {
    scannerContainer.style.display = 'none';
    qrContainer.style.display = 'block';
    qrInstructions.textContent = instructions;
    
    // Compress data to fit in QR code more easily
    const compressed = LZString.compressToEncodedURIComponent(data);
    rawSDPPayload = compressed;
    logMessage(`Generated Payload size: ${compressed.length} characters`);
    
    try {
        qrCanvas.innerHTML = '';
        new QRCode(qrCanvas, {
            text: compressed,
            width: 300,
            height: 300,
            correctLevel: QRCode.CorrectLevel.L
        });
        logMessage('QR code generated successfully.', 'system');
    } catch (e) {
        logMessage(`QR Error: ${e.message || e}`, 'system');
    }
}

function startScanner(onSuccess) {
    qrContainer.style.display = 'none';
    scannerContainer.style.display = 'block';
    currentScanSuccessCallback = onSuccess;
    
    if (html5QrcodeScanner) {
        try { html5QrcodeScanner.clear(); } catch(e){}
    }
    
    html5QrcodeScanner = new Html5QrcodeScanner(
      "reader",
      { fps: 10, qrbox: {width: 250, height: 250} },
      /* verbose= */ false);
      
    html5QrcodeScanner.render((decodedText, decodedResult) => {
        try { html5QrcodeScanner.clear(); } catch(e){}
        scannerContainer.style.display = 'none';
        
        try {
            const decompressed = LZString.decompressFromEncodedURIComponent(decodedText);
            const data = JSON.parse(decompressed);
            onSuccess(data);
        } catch (e) {
            logMessage(`Error reading QR code payload: ${e.message}`, 'system');
            alert("Failed to decode QR connection data. Please try again.");
        }
    }, (err) => {
        // ignore running errors
    });
}

function cleanupUI() {
    qrContainer.style.display = 'none';
    scannerContainer.style.display = 'none';
    if(html5QrcodeScanner) {
        try { html5QrcodeScanner.clear(); } catch(e){}
    }
}

// ========================
// HOST FLOW
// ========================
btnHost.addEventListener('click', async () => {
    logMessage('Starting as HOST...');
    updateStatus('connecting');
    initPeerConnection();
    
    // Host creates data channel
    setupDataChannel(peerConnection.createDataChannel('chat'));
    
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    
    logMessage('Gathering ICE candidates... please wait.');
    await waitForIceGathering();
    
    const offerPayload = JSON.stringify(peerConnection.localDescription);
    generateQRCode(offerPayload, "Step 1: Have the JOINER scan this QR code.");
    
    btnHost.style.display = 'none';
    btnJoin.style.display = 'none';
    btnScanAnswer.style.display = 'inline-block';
});

btnScanAnswer.addEventListener('click', () => {
    logMessage('Opening camera to scan Answer...');
    startScanner(async (answerData) => {
        logMessage('Answer received. Setting remote description...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answerData));
        logMessage('Connection should establish shortly...', 'system');
    });
});

// ========================
// JOIN FLOW
// ========================
btnJoin.addEventListener('click', () => {
    logMessage('Starting as JOINER. Waiting for Offer scan...');
    updateStatus('connecting');
    initPeerConnection();
    
    btnHost.style.display = 'none';
    btnJoin.style.display = 'none';
    
    startScanner(async (offerData) => {
        logMessage('Offer received. Creating Answer...');
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offerData));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        logMessage('Gathering ICE candidates... please wait.');
        await waitForIceGathering();
        
        const answerPayload = JSON.stringify(peerConnection.localDescription);
        generateQRCode(answerPayload, "Step 2: Have the HOST scan this QR code.");
    });
});

// ========================
// MISC Handlers
// ========================
document.getElementById('btn-cancel-scan').addEventListener('click', () => {
    cleanupUI();
    btnHost.style.display = 'block';
    btnJoin.style.display = 'block';
    btnScanAnswer.style.display = 'none';
    updateStatus('disconnected');
});

document.getElementById('btn-copy-sdp').addEventListener('click', () => {
    navigator.clipboard.writeText(rawSDPPayload).then(() => {
        alert("Payload copied to clipboard (useful if QR is too dense to scan)");
    });
});

btnSubmitPaste.addEventListener('click', () => {
    if (!currentScanSuccessCallback) return;
    const pastedText = pasteInput.value.trim();
    if (!pastedText) return;
    
    try {
        const decompressed = LZString.decompressFromEncodedURIComponent(pastedText);
        const data = JSON.parse(decompressed);
        
        if (html5QrcodeScanner) {
            try { html5QrcodeScanner.clear(); } catch(e){}
        }
        scannerContainer.style.display = 'none';
        pasteInput.value = '';
        
        currentScanSuccessCallback(data);
    } catch (e) {
        logMessage(`Error reading pasted payload: ${e.message}`, 'system');
        alert("Failed to decode pasted connection data. Please try again.");
    }
});

function sendMessage() {
    const text = chatInput.value.trim();
    if(text && dataChannel && dataChannel.readyState === 'open') {
        dataChannel.send(text);
        logMessage(`Me: ${text}`, 'me');
        chatInput.value = '';
    }
}

btnSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keypress', (e) => {
    if(e.key === 'Enter') sendMessage();
});
