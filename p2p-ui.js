import { ConnectionUtils } from './p2p-core.js';

export class P2PUIManager {
    constructor(peerNode) {
        this.peerNode = peerNode;
        this.html5QrcodeScanner = null;
        this.rawSDPPayload = "";
        this.currentScanSuccessCallback = null;
        
        this.createUI();
        this.bindEvents();
    }

    show() {
        this.ui.overlay.style.display = 'flex';
    }

    hide() {
        this.ui.overlay.style.display = 'none';
        this.cleanupUI();
    }

    createUI() {
        const template = `
        <div id="p2p-modal-overlay" class="p2p-modal-overlay" style="display:none;">
            <div class="p2p-modal">
                <header class="p2p-header">
                    <h2>Multiplayer Connection <span style="font-size: 0.5em; color: #888; vertical-align: middle; font-weight: normal; margin-left: 10px;">v1.2.0</span></h2>
                    <button id="p2p-btn-close" class="p2p-btn-danger" style="border:none; border-radius:4px; padding:4px 8px; cursor:pointer;">X</button>
                </header>
                <div id="p2p-status-badge" class="p2p-status-disconnected">DISCONNECTED</div>
                
                <div class="p2p-panels">
                    <div class="p2p-panel">
                        <h3 style="margin-top:0">1. Host Session</h3>
                        <button id="p2p-btn-host" class="p2p-btn p2p-btn-primary">Host (Create Offer)</button>
                        <button id="p2p-btn-scan-ans" class="p2p-btn p2p-btn-secondary" style="display:none;">Scan Answer</button>
                    </div>
                    <div class="p2p-panel">
                        <h3 style="margin-top:0">2. Join Session</h3>
                        <button id="p2p-btn-join" class="p2p-btn p2p-btn-primary">Join (Scan Offer)</button>
                    </div>
                </div>

                <div class="p2p-panel" style="margin-bottom: 15px;">
                    <div id="p2p-qr-container" style="display:none; text-align:center;">
                        <p id="p2p-qr-instructions"></p>
                        <div id="p2p-qr-canvas"></div>
                        <br>
                        <button id="p2p-btn-copy-sdp" class="p2p-btn p2p-text-btn" style="width:auto;">Copy Raw Data</button>
                    </div>
                    
                    <div id="p2p-scanner-container" style="display:none;">
                        <div id="p2p-reader"></div>
                        <div class="p2p-paste-section">
                            <input type="text" id="p2p-paste-input" placeholder="Paste raw data...">
                            <button id="p2p-btn-submit-paste" class="p2p-btn p2p-btn-secondary" style="margin-bottom:0; width:auto;">Submit</button>
                        </div>
                        <button id="p2p-btn-cancel-scan" class="p2p-btn p2p-btn-danger" style="margin-top:10px;">Cancel Scan</button>
                    </div>
                    
                    <div id="p2p-qr-placeholder" class="p2p-qr-placeholder">
                        Select Host or Join to begin.
                    </div>
                </div>

                <div class="p2p-panel">
                    <h3 style="margin-top:0; font-size:14px;">Diagnostics</h3>
                    <div id="p2p-diagnostics-out" class="p2p-diagnostics-box" role="log" aria-live="polite">
                        <div class="p2p-diag-info">[SYSTEM] Engine initialized.</div>
                    </div>
                </div>
            </div>
        </div>
        `;
        
        const wrapper = document.createElement('div');
        wrapper.innerHTML = template.trim();
        document.body.appendChild(wrapper.firstChild);
        
        this.ui = {
            overlay: document.getElementById('p2p-modal-overlay'),
            btnClose: document.getElementById('p2p-btn-close'),
            btnHost: document.getElementById('p2p-btn-host'),
            btnJoin: document.getElementById('p2p-btn-join'),
            btnScanAns: document.getElementById('p2p-btn-scan-ans'),
            statusBadge: document.getElementById('p2p-status-badge'),
            qrContainer: document.getElementById('p2p-qr-container'),
            qrInstructions: document.getElementById('p2p-qr-instructions'),
            qrCanvas: document.getElementById('p2p-qr-canvas'),
            btnCopySdp: document.getElementById('p2p-btn-copy-sdp'),
            scannerContainer: document.getElementById('p2p-scanner-container'),
            btnCancelScan: document.getElementById('p2p-btn-cancel-scan'),
            pasteInput: document.getElementById('p2p-paste-input'),
            btnSubmitPaste: document.getElementById('p2p-btn-submit-paste'),
            qrPlaceholder: document.getElementById('p2p-qr-placeholder'),
            diagnosticsOut: document.getElementById('p2p-diagnostics-out')
        };
    }

    logDiag(type, msg) {
        const div = document.createElement('div');
        div.className = `p2p-diag-${type}`;
        div.textContent = `[${new Date().toLocaleTimeString().split(' ')[0]}] ${msg}`;
        this.ui.diagnosticsOut.appendChild(div);
        this.ui.diagnosticsOut.scrollTop = this.ui.diagnosticsOut.scrollHeight;
    }

    bindEvents() {
        this.ui.btnClose.addEventListener('click', () => this.hide());
        
        this.peerNode.addEventListener('diagnostic', (e) => this.logDiag(e.detail.type, e.detail.msg));
        
        this.peerNode.addEventListener('status', (e) => {
            const status = e.detail;
            this.ui.statusBadge.textContent = status.toUpperCase();
            this.ui.statusBadge.className = '';
            if (status === 'connected') {
                this.ui.statusBadge.classList.add('p2p-status-connected');
                this.cleanupUI();
                // Auto hide modal after brief delay when connected?
                setTimeout(() => this.hide(), 1500);
            }
            else if (status === 'disconnected') this.ui.statusBadge.classList.add('p2p-status-disconnected');
            else this.ui.statusBadge.classList.add('p2p-status-connecting');
        });

        this.ui.btnHost.addEventListener('click', async () => {
            this.logDiag('info', '--- HOST SEQUENCE ---');
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            this.ui.btnScanAns.style.display = 'block';
            
            try {
                const offerData = await this.peerNode.createOffer();
                this.displayQRCode(offerData, "Step 1: Have JOINER scan this.");
            } catch (e) {
                this.logDiag('error', 'Critical failure generating Host Offer.');
            }
        });

        this.ui.btnJoin.addEventListener('click', () => {
            this.logDiag('info', '--- JOIN SEQUENCE ---');
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            
            this.startScanner(async (offerData) => {
                this.logDiag('info', 'Ingested Offer. Computing Answer SDP...');
                try {
                    const answerData = await this.peerNode.createAnswer(offerData);
                    this.displayQRCode(answerData, "Step 2: Have HOST scan this.");
                } catch (e) {
                    this.logDiag('error', 'Critical failure computing Joiner Answer.');
                }
            });
        });

        this.ui.btnScanAns.addEventListener('click', () => {
            this.logDiag('info', 'Opening scanner for Answer.');
            this.startScanner(async (answerData) => {
                this.logDiag('info', 'Applying Answer remotely...');
                await this.peerNode.acceptAnswer(answerData);
            });
        });

        this.ui.btnCancelScan.addEventListener('click', () => {
            this.cleanupUI();
            this.ui.btnHost.style.display = 'block';
            this.ui.btnJoin.style.display = 'block';
            this.ui.btnScanAns.style.display = 'none';
            if(this.peerNode.peerConnection) this.peerNode.peerConnection.close();
        });

        this.ui.btnCopySdp.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.rawSDPPayload);
                alert("Payload copied to clipboard.");
            } catch(e) {
                this.logDiag('error', "Clipboard access denied. This requires HTTPS.");
            }
        });

        this.ui.btnSubmitPaste.addEventListener('click', async () => {
            if (!this.currentScanSuccessCallback) return;
            const text = this.ui.pasteInput.value.trim();
            if (!text) return;
            try {
                this.logDiag('info', 'Attempting to unpack pasted string...');
                const decompressed = await ConnectionUtils.decompressData(text);
                this.currentScanSuccessCallback(JSON.parse(decompressed));
                this.ui.pasteInput.value = '';
                if(this.html5QrcodeScanner) try { this.html5QrcodeScanner.clear(); } catch(e){}
                this.ui.scannerContainer.style.display = 'none';
            } catch (e) {
                this.logDiag('error', `Paste parsing failed: ${e.message}`);
            }
        });
    }

    async displayQRCode(dataStr, instructions) {
        this.ui.scannerContainer.style.display = 'none';
        if(this.ui.qrPlaceholder) this.ui.qrPlaceholder.style.display = 'none';
        this.ui.qrContainer.style.display = 'block';
        this.ui.qrInstructions.textContent = instructions;
        
        this.logDiag('info', 'Compressing SDP payload...');
        this.rawSDPPayload = await ConnectionUtils.compressData(dataStr);
        this.logDiag('success', `Payload compressed to ${this.rawSDPPayload.length} chars`);
        
        try {
            this.ui.qrCanvas.innerHTML = '';
            new QRCode(this.ui.qrCanvas, {
                text: this.rawSDPPayload,
                width: 300,
                height: 300,
                correctLevel: QRCode.CorrectLevel.L
            });
        } catch(e) {
            this.logDiag('error', `QR Canvas err: ${e.message}`);
        }
    }

    startScanner(onSuccess) {
        this.ui.qrContainer.style.display = 'none';
        if(this.ui.qrPlaceholder) this.ui.qrPlaceholder.style.display = 'none';
        this.ui.scannerContainer.style.display = 'block';
        this.currentScanSuccessCallback = onSuccess;
        
        if (this.html5QrcodeScanner) {
            try { this.html5QrcodeScanner.clear(); } catch(e){}
        }
        
        this.html5QrcodeScanner = new Html5QrcodeScanner("p2p-reader", { fps: 10 }, false);
        
        let failureCount = 0;
        
        this.html5QrcodeScanner.render(async (decodedText, decodedResult) => {
            try { this.html5QrcodeScanner.clear(); } catch(e){}
            this.ui.scannerContainer.style.display = 'none';
            this.logDiag('success', 'QR Code parameters identified! Extracting payload...');
            
            try {
                const decompressed = await ConnectionUtils.decompressData(decodedText);
                const data = JSON.parse(decompressed);
                onSuccess(data);
            } catch (e) {
                this.logDiag('error', `Failed Data Decompression: ${e.message}`);
                alert("Failed to decode connection data. Check diagnostics panel.");
                this.cleanupUI();
                this.startScanner(onSuccess);
            }
        }, (err) => {
            if(err && !err.includes("NotFoundException")) {
                failureCount++;
                if(failureCount % 5 === 0) {
                    this.logDiag('warn', `Scanner active, parsing frame... (Failed decoding x${failureCount})`);
                }
            }
        });
    }

    cleanupUI() {
        this.ui.qrContainer.style.display = 'none';
        this.ui.scannerContainer.style.display = 'none';
        if(this.ui.qrPlaceholder && this.ui.statusBadge.textContent !== 'CONNECTED') {
            this.ui.qrPlaceholder.style.display = 'block';
        }
        if(this.html5QrcodeScanner) { try { this.html5QrcodeScanner.clear(); } catch(e){} }
    }
}
