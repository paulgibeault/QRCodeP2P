import { ConnectionUtils } from './p2p-core.js';

export class P2PUIManager {
    constructor(peerNode) {
        this.peerNode = peerNode;
        this.html5QrcodeScanner = null;
        this.rawSDPPayload = "";
        this.currentScanSuccessCallback = null;
        
        this.createUI();
        this.bindEvents();
        this._setupInterTabComms();
        this._checkURLFragment();
    }

    // ==========================================
    // INTER-TAB COMMUNICATION
    // Three channels are tried in parallel to maximise cross-browser reach:
    //   1. BroadcastChannel  → works within the same browser profile (Chrome→Chrome, Firefox→Firefox)
    //   2. localStorage      → works within the same origin + browser profile (fallback to BC)
    //   3. window.opener     → works when the joiner tab was opened by the host tab (Share API same browser)
    // For cross-browser scenarios (iOS Share → Safari while game is in Chrome), these channels all
    // fail gracefully. In that case the joiner ALWAYS displays an answer QR that the host scans — 
    // this is the universal fallback that works 100% of the time.
    // ==========================================

    _setupInterTabComms() {
        // --- Channel 1: BroadcastChannel ---
        this.bc = new BroadcastChannel('p2p-signaling');
        this.bc.onmessage = (e) => {
            if (e.data.type === 'answer') {
                this._tryApplyAnswer(e.data.payload, 'BroadcastChannel');
            }
        };

        // --- Channel 2: localStorage ---
        window.addEventListener('storage', (e) => {
            if (e.key === 'p2p-answer-forward' && e.newValue) {
                try {
                    const data = JSON.parse(e.newValue);
                    localStorage.removeItem('p2p-answer-forward');
                    this._tryApplyAnswer(data, 'localStorage');
                } catch(_) {}
            }
        });

        // --- Channel 3: window.postMessage (host receives answer from joiner tab it opened) ---
        window.addEventListener('message', (e) => {
            // Only accept messages from same origin
            if (e.origin !== window.location.origin) return;
            if (e.data && e.data.type === 'p2p-answer') {
                this._tryApplyAnswer(e.data.payload, 'window.postMessage');
            }
        });
    }

    _tryApplyAnswer(data, source) {
        if (this.peerNode.peers.has(data.peerId)) {
            this.logDiag('info', `Applying Answer from ${source}.`);
            this.peerNode.acceptAnswer(data);
        } else {
            this.logDiag('warn', `Answer received via ${source} but peer not found; ignoring.`);
        }
    }

    // ==========================================
    // URL FRAGMENT INGESTION
    // Called on page load. Detects if this tab was opened via a share link.
    // ==========================================

    _checkURLFragment() {
        const hash = window.location.hash;
        const offerMatch = hash.match(/[#&]p2p-offer=([^&]+)/);
        const answerMatch = hash.match(/[#&]p2p-answer=([^&]+)/);

        if (offerMatch || answerMatch) {
            this.show();
            const payload = offerMatch ? offerMatch[1] : answerMatch[1];
            const type = offerMatch ? 'offer' : 'answer';
            this._ingestURLPayload(payload, type);
            // Clean the fragment so refreshing doesn't re-trigger
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }

    async _ingestURLPayload(payload, type) {
        try {
            this.logDiag('info', `URL ${type} detected. Ingesting...`);
            const decompressed = await ConnectionUtils.decompressData(payload);
            const data = JSON.parse(decompressed);

            if (type === 'offer') {
                // -------------------------------------------------------
                // JOINER PATH: This tab was opened by the host's share link.
                //
                // Strategy for returning the answer:
                //   (A) Display answer as QR code — universal, always works.
                //       The host scans it directly. This is the PRIMARY path.
                //   (B) Simultaneously attempt all inter-tab channels so that
                //       if the same browser is running the host, the connection
                //       completes automatically without any scanning.
                // -------------------------------------------------------
                this.ui.btnHost.style.display = 'none';
                this.ui.btnJoin.style.display = 'none';

                this.logDiag('info', 'Computing Answer SDP...');
                const answerData = await this.peerNode.createAnswer(data);

                // Compress answer for QR display
                const compressed = await ConnectionUtils.compressData(answerData);
                this.rawSDPPayload = compressed;

                // PRIMARY path: show answer QR for host to scan
                this.displayQRCode(answerData,
                    "📱 Show this QR code to the HOST to scan, OR use the Share button below to send the answer link.");

                // BONUS path: try all inter-tab channels silently in parallel
                const answerObj = JSON.parse(answerData);
                this._attemptAutoReturn(answerObj, compressed);

            } else {
                // -------------------------------------------------------
                // HOST PATH: This tab received an answer via a share link.
                // (Rare — usually the answer comes via QR scan or auto-forward.)
                // -------------------------------------------------------
                this._tryApplyAnswer(data, 'URL fragment');
                this.ui.qrContainer.style.display = 'block';
                this.ui.qrInstructions.innerHTML =
                    '<strong>Answer received!</strong> Completing connection...';
            }
        } catch (e) {
            this.logDiag('error', `URL payload ingestion failed: ${e.message}`);
        }
    }

    /**
     * Tries to route the answer back to the host tab automatically using all
     * available inter-tab channels. Falls back gracefully — QR is always shown.
     */
    _attemptAutoReturn(answerObj, compressedAnswer) {
        // Channel 1: BroadcastChannel
        try {
            this.bc.postMessage({ type: 'answer', payload: answerObj });
            this.logDiag('info', 'Answer broadcast via BroadcastChannel.');
        } catch(_) {}

        // Channel 2: localStorage
        try {
            localStorage.setItem('p2p-answer-forward', JSON.stringify(answerObj));
            this.logDiag('info', 'Answer written to localStorage.');
        } catch(_) {}

        // Channel 3: window.opener (if this tab was opened by the host tab)
        try {
            if (window.opener && !window.opener.closed) {
                window.opener.postMessage(
                    { type: 'p2p-answer', payload: answerObj },
                    window.location.origin
                );
                this.logDiag('info', 'Answer sent to opener tab via postMessage.');
            }
        } catch(_) {}

        // Build a shareable answer URL as well (for the Share button on the joiner)
        const fragment = `#p2p-answer=${compressedAnswer}`;
        this._answerShareURL = window.location.href.split('#')[0] + fragment;
    }

    // ==========================================
    // SHARING
    // ==========================================

    async _shareOrCopy(payload, type, instructions) {
        const fragment = `#p2p-${type}=${payload}`;
        const shareURL = window.location.href.split('#')[0] + fragment;

        if (navigator.share) {
            try {
                await navigator.share({
                    title: `P2P ${type === 'offer' ? 'Game Invite' : 'Connection Answer'}`,
                    text: instructions,
                    url: shareURL,
                });
                this.logDiag('success', `Shared ${type} via native share sheet.`);
                return;
            } catch (e) {
                if (e.name !== 'AbortError') {
                    this.logDiag('warn', `Native share failed (${e.message}), falling back to clipboard.`);
                } else {
                    return; // User cancelled — don't fall through
                }
            }
        }

        // Fallback: copy URL to clipboard
        try {
            await navigator.clipboard.writeText(shareURL);
            this.logDiag('success', 'Share URL copied to clipboard!');
            this._showShareFeedback('Link copied! Send it to your opponent.');
        } catch (e) {
            this.logDiag('warn', 'Clipboard unavailable. Showing manual copy prompt.');
            prompt('Copy this link and send it to your opponent:', shareURL);
        }
    }

    _showShareFeedback(msg) {
        if (!this.ui.shareToast) return;
        this.ui.shareToast.textContent = msg;
        this.ui.shareToast.style.display = 'block';
        setTimeout(() => { this.ui.shareToast.style.display = 'none'; }, 3000);
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
                    <h2>Multiplayer Connection <span style="font-size: 0.5em; color: #888; vertical-align: middle; font-weight: normal; margin-left: 10px;">v1.4.0</span></h2>
                    <button id="p2p-btn-close" class="p2p-btn-danger" style="border:none; border-radius:4px; padding:4px 8px; cursor:pointer;">X</button>
                </header>
                <div id="p2p-status-badge" class="p2p-status-disconnected">DISCONNECTED</div>
                
                <div class="p2p-panels">
                    <div class="p2p-panel">
                        <h3 style="margin-top:0">1. Host Session</h3>
                        <button id="p2p-btn-host" class="p2p-btn p2p-btn-primary">Host (Create Offer)</button>
                        <button id="p2p-btn-add-player" class="p2p-btn p2p-btn-primary" style="display:none;">Add Another Player</button>
                        <button id="p2p-btn-scan-ans" class="p2p-btn p2p-btn-secondary" style="display:none;">📷 Scan Answer QR</button>
                    </div>
                    <div class="p2p-panel">
                        <h3 style="margin-top:0">2. Join Session</h3>
                        <button id="p2p-btn-join" class="p2p-btn p2p-btn-primary">Join (Scan Offer)</button>
                    </div>
                </div>

                <div class="p2p-panel" style="margin-bottom: 15px;">
                    <div id="p2p-qr-container" style="display:none; text-align:center;">
                        <p id="p2p-qr-instructions"></p>
                        <button id="p2p-btn-share-sdp" class="p2p-btn p2p-btn-primary" style="width:auto; padding: 10px 24px; font-size:15px;">📤 Share Link</button>
                        <div id="p2p-share-toast" style="display:none; margin-top:8px; color:#4ade80; font-size:13px;"></div>
                        <details style="margin-top:12px;">
                            <summary style="cursor:pointer; color:#888; font-size:12px;">Show QR code instead</summary>
                            <div id="p2p-qr-canvas" style="margin-top:8px;"></div>
                        </details>
                        <br>
                        <button id="p2p-btn-copy-sdp" class="p2p-btn p2p-text-btn" style="width:auto;">Copy Raw Data</button>
                    </div>
                    
                    <div id="p2p-scanner-container" style="display:none;">
                        <div id="p2p-reader"></div>
                        <div class="p2p-paste-section">
                            <input type="text" id="p2p-paste-input" placeholder="Paste raw data or answer link...">
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
            btnAddPlayer: document.getElementById('p2p-btn-add-player'),
            btnJoin: document.getElementById('p2p-btn-join'),
            btnScanAns: document.getElementById('p2p-btn-scan-ans'),
            statusBadge: document.getElementById('p2p-status-badge'),
            qrContainer: document.getElementById('p2p-qr-container'),
            qrInstructions: document.getElementById('p2p-qr-instructions'),
            qrCanvas: document.getElementById('p2p-qr-canvas'),
            btnShareSdp: document.getElementById('p2p-btn-share-sdp'),
            shareToast: document.getElementById('p2p-share-toast'),
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
            const { peerId, status } = e.detail;
            
            if (this.peerNode.isHost) {
                let connectedCount = 0;
                this.peerNode.peers.forEach(p => { if (p.status === 'connected') connectedCount++; });
                
                if (connectedCount > 0) {
                    this.ui.statusBadge.textContent = `HOSTING (${connectedCount} PEERS)`;
                    this.ui.statusBadge.className = 'p2p-status-connected';
                    this.cleanupUI();
                    
                    this.ui.btnHost.style.display = 'none';
                    this.ui.btnJoin.style.display = 'none';
                    this.ui.btnScanAns.style.display = 'none';
                    this.ui.btnAddPlayer.style.display = 'inline-block';
                } else if (status === 'disconnected') {
                    this.ui.statusBadge.textContent = 'DISCONNECTED';
                    this.ui.statusBadge.className = 'p2p-status-disconnected';
                } else {
                    this.ui.statusBadge.textContent = 'CONNECTING...';
                    this.ui.statusBadge.className = 'p2p-status-connecting';
                }
            } else {
                this.ui.statusBadge.textContent = status.toUpperCase();
                this.ui.statusBadge.className = '';
                if (status === 'connected') {
                    this.ui.statusBadge.classList.add('p2p-status-connected');
                    this.cleanupUI();
                    setTimeout(() => this.hide(), 1500);
                }
                else if (status === 'disconnected') this.ui.statusBadge.classList.add('p2p-status-disconnected');
                else this.ui.statusBadge.classList.add('p2p-status-connecting');
            }
        });

        // ---- HOST: create offer ----
        this.ui.btnHost.addEventListener('click', async () => {
            this.logDiag('info', '--- HOST SEQUENCE ---');
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            this.ui.btnScanAns.style.display = 'block';
            
            try {
                const offerData = await this.peerNode.createOffer();

                // Prefer Share API for offer delivery — resilient across devices
                if (navigator.share) {
                    const compressed = await ConnectionUtils.compressData(offerData);
                    this.rawSDPPayload = compressed;
                    const fragment = `#p2p-offer=${compressed}`;
                    const shareURL = window.location.href.split('#')[0] + fragment;

                    this.displayQRCode(offerData,
                        "📤 Share this invite link with the joiner. After they join, click \"Scan Answer QR\" to scan their screen.");

                    this.logDiag('info', 'Offer ready. Share link generated.');
                } else {
                    // No Share API (desktop) — show QR for joiner to scan
                    this.displayQRCode(offerData, "Step 1: Have JOINER scan this QR code.");
                }
            } catch (e) {
                this.logDiag('error', 'Critical failure generating Host Offer.');
            }
        });

        this.ui.btnAddPlayer.addEventListener('click', async () => {
            this.logDiag('info', '--- ADDING MULTIPLAYER ---');
            this.ui.btnAddPlayer.style.display = 'none';
            this.ui.btnScanAns.style.display = 'block';
            
            try {
                const offerData = await this.peerNode.createOffer();
                this.displayQRCode(offerData, "Step 1: Have NEW JOINER scan this QR code.");
            } catch (e) {
                this.logDiag('error', 'Critical failure generating Additional Offer.');
            }
        });

        // ---- HOST: scan joiner's answer QR ----
        this.ui.btnScanAns.addEventListener('click', () => {
            this.logDiag('info', 'Opening scanner for Answer QR...');
            this.startScanner(async (answerData) => {
                this.logDiag('info', 'Applying Answer...');
                await this.peerNode.acceptAnswer(answerData);
            });
        });

        // ---- JOINER: scan host's offer QR ----
        this.ui.btnJoin.addEventListener('click', () => {
            this.logDiag('info', '--- JOIN SEQUENCE ---');
            this.ui.btnHost.style.display = 'none';
            this.ui.btnJoin.style.display = 'none';
            
            this.startScanner(async (offerData) => {
                this.logDiag('info', 'Ingested Offer. Computing Answer SDP...');
                try {
                    const answerData = await this.peerNode.createAnswer(offerData);

                    // Show QR for host to scan — universal and reliable
                    this.displayQRCode(answerData,
                        "📱 Show this QR to the HOST to scan. Or use Share/Copy to send them the link.");

                    // Also attempt auto-forwarding via all inter-tab channels
                    const compressed = this.rawSDPPayload; // set by displayQRCode
                    const answerObj = JSON.parse(answerData);
                    this._attemptAutoReturn(answerObj, compressed);
                } catch (e) {
                    this.logDiag('error', 'Critical failure computing Joiner Answer.');
                }
            });
        });

        this.ui.btnCancelScan.addEventListener('click', () => {
            this.cleanupUI();
            
            if (this.peerNode.isHost && Array.from(this.peerNode.peers.values()).some(p => p.status === 'connected')) {
                this.ui.btnAddPlayer.style.display = 'inline-block';
                this.ui.btnScanAns.style.display = 'none';
            } else {
                this.ui.btnHost.style.display = 'inline-block';
                this.ui.btnJoin.style.display = 'inline-block';
                this.ui.btnScanAns.style.display = 'none';
                if (this.ui.btnAddPlayer) this.ui.btnAddPlayer.style.display = 'none';
            }
            
            // Close any pending connections
            this.peerNode.peers.forEach((p, id) => {
                if (p.status !== 'connected') {
                    p.connection.close();
                    this.peerNode.peers.delete(id);
                }
            });
        });

        // ---- Share / Copy buttons ----
        this.ui.btnShareSdp.addEventListener('click', async () => {
            const type = this.peerNode.isHost ? 'offer' : 'answer';
            const instructions = type === 'offer'
                ? 'Open this link to join my game! After joining, share your answer QR with me.'
                : 'Open this link to complete the connection.';
            await this._shareOrCopy(this.rawSDPPayload, type, instructions);
        });

        this.ui.btnCopySdp.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(this.rawSDPPayload);
                this._showShareFeedback('Raw data copied to clipboard.');
            } catch(e) {
                this.logDiag('error', "Clipboard access denied. This requires HTTPS.");
            }
        });

        // ---- Paste / manual entry ----
        this.ui.btnSubmitPaste.addEventListener('click', async () => {
            if (!this.currentScanSuccessCallback) return;
            let text = this.ui.pasteInput.value.trim();
            if (!text) return;
            
            // Extract payload if they pasted a full URL
            const offerMatch = text.match(/[#&]p2p-offer=([^&]+)/);
            const answerMatch = text.match(/[#&]p2p-answer=([^&]+)/);
            if (offerMatch) text = offerMatch[1];
            else if (answerMatch) text = answerMatch[1];
            
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
                width: 256,
                height: 256,
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
