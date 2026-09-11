// ==UserScript==
// @name         Enhanced Sesame Arrival Tab
// @namespace    https://trans-logistics.amazon.com/yms
// @version      9.1
// @description  Enhances the Sesame Arrivals page by showing license plate (LPN), driver name, and phone next to each VRID. Fully automatic — captures RTT auth token silently, auto-retries on 401, refreshes token every 45 min. Works for any site.
// @author       lingxuan
// @match        https://trans-logistics.amazon.com/yms/sesameGateConsole*
// @match        https://track.relay.amazon.dev/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @connect      track.relay.amazon.dev
// @updateURL    https://raw.githubusercontent.com/WalreinLu/Enhanced-Sesame-Arrival-Tab/main/Enhanced_Sesame_Arrival_Tab.user.js
// @downloadURL  https://raw.githubusercontent.com/WalreinLu/Enhanced-Sesame-Arrival-Tab/main/Enhanced_Sesame_Arrival_Tab.user.js
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    const isRTT = location.hostname === 'track.relay.amazon.dev';
    const isSesame = location.hostname === 'trans-logistics.amazon.com';

    // ════════════════════════════════════════════════════════════════
    // RTT PAGE — intercept XHR/fetch to capture auth token
    // ════════════════════════════════════════════════════════════════
    if (isRTT) {
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
            if (name.toLowerCase() === 'authorization' && value && value.length > 20) {
                try { GM_setValue('rtt_auth_token', JSON.stringify({ token: value, ts: Date.now() })); } catch(e) {}
            }
            return origSetHeader.apply(this, arguments);
        };

        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            try {
                if (init && init.headers) {
                    let authVal = null;
                    if (init.headers instanceof Headers) { authVal = init.headers.get('authorization'); }
                    else if (typeof init.headers === 'object' && !Array.isArray(init.headers)) {
                        for (const [k, v] of Object.entries(init.headers)) { if (k.toLowerCase() === 'authorization') { authVal = v; break; } }
                    } else if (Array.isArray(init.headers)) {
                        for (const [k, v] of init.headers) { if (k.toLowerCase() === 'authorization') { authVal = v; break; } }
                    }
                    if (authVal && authVal.length > 20) {
                        try { GM_setValue('rtt_auth_token', JSON.stringify({ token: authVal, ts: Date.now() })); } catch(e) {}
                    }
                }
            } catch(e) {}
            return origFetch.apply(this, arguments);
        };

        // Auto-close token capture popup
        if (window.name === 'lpn_token_popup') {
            let checks = 0;
            const iv = setInterval(() => {
                checks++;
                const s = GM_getValue('rtt_auth_token', null);
                if (s) { try { const d = JSON.parse(s); if (Date.now() - d.ts < 10000) { clearInterval(iv); setTimeout(() => window.close(), 500); return; } } catch(e) {} }
                if (checks >= 30) { clearInterval(iv); setTimeout(() => window.close(), 500); }
            }, 1000);
        }
        return;
    }

    // ════════════════════════════════════════════════════════════════
    // SESAME PAGE
    // ════════════════════════════════════════════════════════════════
    if (!isSesame) return;

    function onReady(fn) { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn); }

    onReady(function () {
        const API_BASE = 'https://track.relay.amazon.dev/api/v2/transport-views/';
        const POLL_INTERVAL = 3000;
        const PROCESSED_ATTR = 'data-lpn-processed';
        const TOKEN_MAX_AGE = 3600000;
        const TOKEN_REFRESH_MS = 45 * 60 * 1000;

        // Clear stale results
        try { for (const k of GM_listValues()) { if (k.startsWith('lpn_result_')) GM_deleteValue(k); } } catch(e) {}

        // ── Styles ─────────────────────────────────────────────────
        document.head.appendChild(Object.assign(document.createElement('style'), { textContent: `
            .lpn-container { display:inline-flex; flex-direction:row; align-items:center; margin-left:6px; vertical-align:middle; gap:4px; flex-wrap:wrap; }
            .lpn-row { display:inline-flex; align-items:center; gap:2px; }
            .lpn-badge { display:inline-block; padding:2px 8px; border-radius:4px; font-size:12px; font-weight:600; font-family:'Amazon Ember',Arial,sans-serif; cursor:default; white-space:nowrap; }
            .lpn-badge--loaded { background:#e6f4ea; color:#1a7f37; border:1px solid #a3d9b1; }
            .lpn-badge--loading { background:#f0f0f0; color:#888; border:1px solid #ddd; animation:lpn-pulse 1.2s ease-in-out infinite; }
            .lpn-badge--error { background:#fef0f0; color:#c44; border:1px solid #e8b0b0; font-size:11px; }
            .lpn-badge--no-data { background:#f5f5f5; color:#999; border:1px solid #e0e0e0; font-style:italic; }
            .lpn-badge--auth { background:#fff8e6; color:#b8860b; border:1px solid #e8d590; font-size:11px; }
            .lpn-badge--driver { background:#e8f0fe; color:#1a56db; border:1px solid #b0cdf7; font-size:11px; font-weight:500; }
            .lpn-copy-btn { display:inline-block; padding:1px 5px; border-radius:3px; font-size:11px; cursor:pointer; background:#e6f4ea; color:#1a7f37; border:1px solid #a3d9b1; transition:all 0.2s; }
            .lpn-copy-btn:hover { background:#c8ebd1; }
            .lpn-copy-btn--copied { background:#1a7f37; color:#fff; border-color:#1a7f37; }
            .lpn-phone-btn { display:inline-block; padding:1px 5px; border-radius:3px; font-size:11px; cursor:pointer; background:#e8f0fe; color:#1a56db; border:1px solid #b0cdf7; transition:all 0.2s; }
            .lpn-phone-btn:hover { background:#cddcfa; }
            .lpn-phone-popup { position:fixed; z-index:99999; background:#fff; border:1px solid #ccc; border-radius:8px; padding:16px 20px; box-shadow:0 4px 20px rgba(0,0,0,0.15); font-family:'Amazon Ember',Arial,sans-serif; min-width:220px; }
            .lpn-phone-popup h4 { margin:0 0 8px 0; font-size:14px; color:#333; }
            .lpn-phone-popup p { margin:4px 0; font-size:13px; color:#555; }
            .lpn-phone-popup .phone-number { font-size:16px; font-weight:600; color:#1a56db; }
            .lpn-phone-popup .close-btn { position:absolute; top:8px; right:12px; cursor:pointer; font-size:18px; color:#999; border:none; background:none; }
            .lpn-phone-popup .close-btn:hover { color:#333; }
            @keyframes lpn-pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        `}));

        const lpnCache = {};
        let tokenRefreshInProgress = false;
        let pendingRetries = [];

        // ── Token management ───────────────────────────────────────

        function getToken() {
            const s = GM_getValue('rtt_auth_token', null);
            if (!s) return null;
            try { const { token, ts } = JSON.parse(s); return (token && Date.now() - ts < TOKEN_MAX_AGE) ? token : null; } catch(e) { return null; }
        }

        function isTokenExpiringSoon() {
            const s = GM_getValue('rtt_auth_token', null);
            if (!s) return true;
            try { return (Date.now() - JSON.parse(s).ts) > TOKEN_REFRESH_MS; } catch(e) { return true; }
        }

        function refreshToken() {
            return new Promise((resolve) => {
                if (tokenRefreshInProgress) {
                    const iv = setInterval(() => { if (!tokenRefreshInProgress) { clearInterval(iv); resolve(getToken()); } }, 500);
                    return;
                }
                tokenRefreshInProgress = true;
                console.log('[LPN] 🔄 Auto-capturing auth token...');
                const lid = GM_addValueChangeListener('rtt_auth_token', function (k, o, n, remote) {
                    if (!remote) return;
                    try { GM_removeValueChangeListener(lid); } catch(e) {}
                    clearTimeout(tid);
                    tokenRefreshInProgress = false;
                    console.log('[LPN] 🔑 Token captured!');
                    resolve(getToken());
                    retryPendingVrids();
                });
                const tid = setTimeout(() => {
                    try { GM_removeValueChangeListener(lid); } catch(e) {}
                    tokenRefreshInProgress = false;
                    resolve(null);
                }, 30000);
                const popup = window.open('https://track.relay.amazon.dev/', 'lpn_token_popup', 'width=400,height=300,left=-2000,top=-2000,menubar=no,toolbar=no,status=no');
                if (!popup) { try { GM_removeValueChangeListener(lid); } catch(e) {} clearTimeout(tid); tokenRefreshInProgress = false; resolve(null); }
            });
        }

        if (typeof GM_removeValueChangeListener === 'undefined') var GM_removeValueChangeListener = function(){};

        // Background refresh every 5 min check
        setInterval(() => { if (isTokenExpiringSoon()) refreshToken(); }, 5 * 60 * 1000);

        // ── API calls ──────────────────────────────────────────────

        function apiCall(url, token) {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method: 'GET', url, anonymous: false,
                    headers: { 'Accept': 'application/json', 'Authorization': token },
                    onload(resp) {
                        if (resp.status === 401 || resp.status === 403) { GM_deleteValue('rtt_auth_token'); reject(new Error('auth_expired')); return; }
                        if (resp.status !== 200) { reject(new Error(`HTTP ${resp.status}`)); return; }
                        try { resolve(JSON.parse(resp.responseText)); } catch(e) { reject(new Error('Parse error')); }
                    },
                    onerror: () => reject(new Error('Network error')),
                    ontimeout: () => reject(new Error('Timeout')),
                    timeout: 10000,
                });
            });
        }

        // ── Fetch VRID data (LPN + driver ID) ──────────────────────

        async function fetchVridData(vrid) {
            if (lpnCache[vrid]) return lpnCache[vrid];

            let token = getToken();
            if (!token) token = await refreshToken();
            if (!token) throw new Error('popup_blocked');

            let data;
            try {
                data = await apiCall(`${API_BASE}NA:VR:${vrid}?view=detail`, token);
            } catch (e) {
                if (e.message === 'auth_expired') {
                    const newToken = await refreshToken();
                    if (newToken) data = await apiCall(`${API_BASE}NA:VR:${vrid}?view=detail`, newToken);
                    else throw new Error('auth_failed');
                } else throw e;
            }

            const result = { lpn: null, driverId: null, driverName: null, phone: null };

            // Extract LPN
            if (data.tractorDetail && data.tractorDetail.length > 0) {
                for (const t of data.tractorDetail) {
                    if (t.licensePlate && t.licensePlate.registrationId) { result.lpn = t.licensePlate.registrationId; break; }
                    if (t.assetId) { result.lpn = t.assetId; break; }
                }
            }

            // Extract driver ID
            if (data.drivers && data.drivers.length > 0) {
                result.driverId = data.drivers[0]; // e.g. "NA:DRIVER:amzn1.relay.d.v1.T-..."
            } else if (data.assignedDrivers && data.assignedDrivers.length > 0) {
                const d = data.assignedDrivers[0];
                if (d.assetType === 'DRIVER' && d.assetId) {
                    result.driverId = `NA:DRIVER:${d.assetId}`;
                }
            }

            // Fetch driver details if we have a driver ID
            if (result.driverId) {
                try {
                    const tok = getToken();
                    if (tok) {
                        const driverData = await apiCall(
                            `${API_BASE}${result.driverId}?relatedTripId=NA:VR:${vrid}&view=detail`, tok
                        );
                        if (driverData.firstName || driverData.lastName) {
                            result.driverName = [driverData.firstName, driverData.lastName].filter(Boolean).join(' ');
                        }
                        if (driverData.phoneNumber) result.phone = driverData.phoneNumber;
                    }
                } catch (e) {
                    console.log(`[LPN] Driver fetch failed for ${vrid}:`, e.message);
                }
            }

            if (!result.lpn) throw new Error('no_lpn');
            lpnCache[vrid] = result;
            return result;
        }

        // ── Retry pending VRIDs ────────────────────────────────────

        function retryPendingVrids() {
            if (!pendingRetries.length) return;
            const toRetry = [...pendingRetries]; pendingRetries = [];
            for (const { vrid, el } of toRetry) processVridWithElement(vrid, el);
        }

        // ── UI helpers ─────────────────────────────────────────────

        function createBadge(text, type) {
            return Object.assign(document.createElement('span'), { className: `lpn-badge lpn-badge--${type}`, textContent: text });
        }

        function showPhonePopup(name, phone, anchorEl) {
            // Remove existing popup
            const old = document.querySelector('.lpn-phone-popup');
            if (old) old.remove();

            const popup = document.createElement('div');
            popup.className = 'lpn-phone-popup';

            const rect = anchorEl.getBoundingClientRect();
            popup.style.top = (rect.bottom + 8) + 'px';
            popup.style.left = rect.left + 'px';

            popup.innerHTML = `
                <button class="close-btn">&times;</button>
                <h4>👤 ${name || 'Driver'}</h4>
                <p class="phone-number">📞 ${phone}</p>
            `;

            popup.querySelector('.close-btn').addEventListener('click', () => popup.remove());
            document.addEventListener('click', function handler(e) {
                if (!popup.contains(e.target) && e.target !== anchorEl) {
                    popup.remove();
                    document.removeEventListener('click', handler);
                }
            });

            document.body.appendChild(popup);
        }

        function createResultContainer(result) {
            const container = document.createElement('span');
            container.className = 'lpn-container';

            // Row 1: LPN + copy button
            const row1 = document.createElement('span');
            row1.className = 'lpn-row';

            const lpnBadge = createBadge(`🚛 ${result.lpn}`, 'loaded');
            row1.appendChild(lpnBadge);

            const copyBtn = document.createElement('span');
            copyBtn.className = 'lpn-copy-btn';
            copyBtn.textContent = '📋';
            copyBtn.title = `Copy ${result.lpn}`;
            copyBtn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                navigator.clipboard.writeText(result.lpn).then(() => {
                    copyBtn.textContent = '✅';
                    copyBtn.classList.add('lpn-copy-btn--copied');
                    setTimeout(() => { copyBtn.textContent = '📋'; copyBtn.classList.remove('lpn-copy-btn--copied'); }, 1500);
                });
            });
            row1.appendChild(copyBtn);
            container.appendChild(row1);

            // Row 2: Driver name + phone icon (if available)
            if (result.driverName) {
                const row2 = document.createElement('span');
                row2.className = 'lpn-row';

                const driverBadge = createBadge(`👤 ${result.driverName}`, 'driver');
                row2.appendChild(driverBadge);

                if (result.phone) {
                    const phoneBtn = document.createElement('span');
                    phoneBtn.className = 'lpn-phone-btn';
                    phoneBtn.textContent = '📞';
                    phoneBtn.title = 'Show phone number';
                    phoneBtn.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        showPhonePopup(result.driverName, result.phone, phoneBtn);
                    });
                    row2.appendChild(phoneBtn);
                }

                container.appendChild(row2);
            }

            return container;
        }

        // ── Process VRID ───────────────────────────────────────────

        async function processVridWithElement(vrid, badgeEl) {
            try {
                const result = await fetchVridData(vrid);
                badgeEl.replaceWith(createResultContainer(result));
            } catch (err) {
                if (err.message === 'no_lpn') {
                    badgeEl.replaceWith(createBadge('— No plate yet', 'no-data'));
                } else if (err.message === 'popup_blocked') {
                    const b = createBadge('⚠ Allow popups →', 'error');
                    b.style.cursor = 'pointer';
                    b.addEventListener('click', () => window.open('https://track.relay.amazon.dev/', '_blank'));
                    badgeEl.replaceWith(b);
                } else if (err.message === 'auth_expired' || err.message === 'auth_failed') {
                    const b = createBadge('🔄 Authenticating...', 'auth');
                    badgeEl.replaceWith(b);
                    pendingRetries.push({ vrid, el: b });
                } else {
                    badgeEl.replaceWith(createBadge(`⚠ ${err.message}`, 'error'));
                }
            }
        }

        function processVridElement(el) {
            el.setAttribute(PROCESSED_ATTR, 'true');
            const m = el.textContent.trim().match(/VRID\s+([A-Z0-9]+)/i);
            if (!m || m[1].length < 5) return;
            const badge = createBadge('🔄 Loading...', 'loading');
            el.parentNode.insertBefore(badge, el.nextSibling);
            processVridWithElement(m[1], badge);
        }

        // ── Scan ───────────────────────────────────────────────────

        function scanForVrids() {
            for (const link of document.querySelectorAll('a')) {
                if (link.getAttribute(PROCESSED_ATTR)) continue;
                if (/VRID\s+[A-Z0-9]{5,}/i.test(link.textContent.trim())) processVridElement(link);
            }
        }

        let scanTimeout = null;
        const observer = new MutationObserver(() => { if (scanTimeout) clearTimeout(scanTimeout); scanTimeout = setTimeout(scanForVrids, 500); });
        observer.observe(document.body, { childList: true, subtree: true });
        setInterval(scanForVrids, POLL_INTERVAL);
        setTimeout(scanForVrids, 1500);

        // Initial token check
        if (!getToken()) refreshToken();
        else if (isTokenExpiringSoon()) refreshToken();

        console.log('[Enhanced Sesame Arrival Tab v9.0] ✓ Loaded');
    });
})();
