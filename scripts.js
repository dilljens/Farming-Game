// Backend imports — local PostgREST adapter (same call surface as the
// Firebase SDK it replaces). See backend/AI_BACKEND.md. Point the game at
// another backend via localStorage 'fgBackendUrl' or window.FG_BACKEND_URL.
import { initializeApp } from './backend.js?v=20260907i';
import { getFirestore, collection, query, where, orderBy, limit, onSnapshot, doc, setDoc, deleteDoc, getDocs, getDoc } from './backend.js?v=20260907i';
import { getAuth, signInAnonymously, onAuthStateChanged } from './backend.js?v=20260907i';
import {
    asTimestamp,
    buildElapsedHistory,
    clampGameDuration,
    createGame,
    formatGameTime,
    gameElapsedMs,
    getTimeWindow,
    mergeHistoriesByPlayer,
    capHistoryPoints,
    MAX_HISTORY_POINTS,
    MIN_TIME_WINDOW_MS,
    normalizeGame,
    normalizeHistoryPoints
} from './game-time.js?v=20260907f';
import { RULE_KEYS, SCENARIOS, SCENARIO_KEYS, activeEcon, activeHarvest, applyScenario, boardMaxNetWorth, bulkMult, bulkNext, computeMarketPrice, marketBasis, normalizeEcon, normalizeHarvest, normalizeRules, normalizeTuning, scenarioName } from './pricing.js?v=20261004d';

// Backend selection lives in backend.js (localStorage 'fgBackendUrl' >
// window.FG_BACKEND_URL > http://localhost:3002). Firebase config
// retired with the Firestore cutover.
const backendConfig = {};

// Initialize backend client
const app = initializeApp(backendConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Wait for auth before doing any backend reads.
let resolveAuthReady;
const authReady = new Promise((resolve) => {
    resolveAuthReady = resolve;
});
onAuthStateChanged(auth, (user) => {
    if (user) resolveAuthReady(user);
});

// Local identity (UUID in localStorage) — no login, nothing to configure.
signInAnonymously(auth)
  .then(() => {
    console.log('Signed in with local identity', auth.currentUser?.uid);
  })
  .catch((error) => {
    console.error('Sign-in failed:', error);
  });

// --- Room lobby — mirrors imposterirl/src/lib/games.ts + src/app/lobby/[room_code]/page.tsx + RoomCodeDisplay.tsx ---
const STORAGE_KEY_ROOM_CODE = 'farmingGameRoomCode';
const roomCodeAtBoot = (() => {
    try { return localStorage.getItem(STORAGE_KEY_ROOM_CODE)?.toUpperCase() || null; }
    catch { return null; }
})();
let currentRoomCode = (() => {
    try {
        const params = new URLSearchParams(window.location.search);
        const fromUrl = params.get('room')?.toUpperCase().trim();
        if (fromUrl) return fromUrl;
        return localStorage.getItem(STORAGE_KEY_ROOM_CODE)?.toUpperCase() || null;
    } catch { return null; }
})();
let roomListenerUnsub = null;
let roomDocUnsub = null;
let roomQrVisible = false;
let currentRoomHostUid = null;
let isHost = false;

// Roomless trading rides on a shared system room ("global tavern").
// Lowercase on purpose: generated codes are A-Z only, so it can never
// collide with a real room, and the join box (which uppercases) can't open it.
const LOBBY_ROOM_CODE = 'lobby';
function tradeRoomCode() {
    return currentRoomCode || LOBBY_ROOM_CODE;
}

function getRoomJoinUrl(roomCode) {
    // GitHub Pages safe: https://dilljens.github.io/Farming-Game/?room=AB
    const basePath = window.location.pathname.replace(/index\.html$/, '');
    const base = basePath.endsWith('/') ? basePath : basePath + '/';
    return `${window.location.origin}${base}?room=${roomCode}`;
}

async function getRoomByCode(roomCode) {
    if (!roomCode) return null;
    const snap = await getDoc(doc(db, 'rooms', roomCode.toUpperCase()));
    return snap.exists() ? snap.data() : null;
}

// Exact copy of imposterirl/src/lib/games.ts:generateRoomCode — tries 2-char → 3-char → 4-char, A-Z, 50 attempts each
async function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const random = (len) => {
        let r = '';
        for (let i = 0; i < len; i++) r += chars.charAt(Math.floor(Math.random() * chars.length));
        return r;
    };
    for (const len of [2, 3, 4]) {
        const seen = new Set();
        for (let attempt = 0; attempt < 50; attempt++) {
            const code = random(len);
            if (seen.has(code)) continue;
            seen.add(code);
            const existing = await getRoomByCode(code);
            if (!existing) return code;
        }
    }
    return random(4);
}

async function createRoom(rules = {}) {
    const code = await generateRoomCode();
    try { await authReady; } catch {}
    const hostUid = auth.currentUser?.uid || null;
    const hostName = document.getElementById('editableUsername')?.innerText.trim() || 'Host';
    await setDoc(doc(db, 'rooms', code), {
        room_code: code,
        createdAt: new Date().toISOString(),
        last_activity_at: new Date().toISOString(),
        status: 'Lobby',
        hostUid,
        hostName,
        rules: normalizeRules(rules),
    });
    return code;
}

function roomErrorMessage(e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Firestore is retired: denials now come from PostgREST, so point at the
    // backend runbook instead of the Firebase console.
    if (e && (e.code === 'permission-denied' || /insufficient permissions/i.test(msg))) {
        return 'Room service blocked: the backend rejected this request. ' +
            'Check that the PostgREST service is up and backend/permissions.sql is applied, wait a minute, then retry.';
    }
    return msg;
}

function persistRoomCode(code) {
    currentRoomCode = code ? code.toUpperCase() : null;
    try {
        if (currentRoomCode) localStorage.setItem(STORAGE_KEY_ROOM_CODE, currentRoomCode);
        else localStorage.removeItem(STORAGE_KEY_ROOM_CODE);
    } catch {}
}

function updateRoomUi() {
    const display = document.getElementById('roomCodeDisplay');
    const big = document.getElementById('roomCodeBig');
    const qrBtn = document.getElementById('roomQrBtn');
    const input = document.getElementById('roomCodeInput');
    const leaveBtn = document.getElementById('leaveRoomBtn');
    const status = document.getElementById('roomStatus');
    const joinUrlEl = document.getElementById('roomJoinUrl');
    const qrCodeText = document.getElementById('roomQrCodeText');
    const hostBadge = document.getElementById('hostBadge');
    const hostControls = document.getElementById('hostControls');
    const roomSettingsBtn = document.getElementById('roomSettingsBtn');
    if (big) big.textContent = currentRoomCode || '--';
    if (display) display.classList.toggle('hidden', !currentRoomCode);
    if (qrBtn) qrBtn.classList.toggle('hidden', !currentRoomCode);
    if (leaveBtn) leaveBtn.classList.toggle('hidden', !currentRoomCode);
    if (input && currentRoomCode) input.value = currentRoomCode;
    if (status) {
        if (!currentRoomCode) status.textContent = 'No room — leaderboard is global. Create or join a 2-letter room.';
        else if (isHost) status.textContent = `In room ${currentRoomCode} — you are HOST — leaderboard is room-scoped`;
        else status.textContent = `In room ${currentRoomCode} — leaderboard is room-scoped`;
    }
    if (hostBadge) hostBadge.classList.toggle('hidden', !isHost || !currentRoomCode);
    if (hostControls) hostControls.classList.toggle('hidden', !isHost || !currentRoomCode);
    // Keep settings discoverable in a room even if host identity has not
    // finished syncing yet; click-time checks provide a useful explanation.
    if (roomSettingsBtn) {
        roomSettingsBtn.classList.toggle('hidden', !currentRoomCode);
        roomSettingsBtn.disabled = false;
        roomSettingsBtn.title = isHost ? 'Edit settings for everyone in this room' : 'Verify host status and edit room settings';
    }
    // Guests in a room get a visible way to become the host (take over / make the game theirs)
    const guestControls = document.getElementById('guestControls');
    if (guestControls) guestControls.classList.toggle('hidden', isHost || !currentRoomCode);
    if (qrCodeText) qrCodeText.textContent = currentRoomCode || '';
    if (joinUrlEl) joinUrlEl.textContent = currentRoomCode ? getRoomJoinUrl(currentRoomCode) : '';
    // QR wrap visibility is controlled by toggle, but hide when leaving
    if (!currentRoomCode && roomQrVisible) {
        roomQrVisible = false;
        const wrap = document.getElementById('roomQrWrap');
        if (wrap) { wrap.classList.add('hidden'); wrap.classList.remove('flex'); }
    }
    // also toggle global reset button host hint
    const resetBtn = document.getElementById('resetButton');
    if (resetBtn) {
        if (currentRoomCode && !isHost) resetBtn.title = 'Only host can reset the room';
        else if (currentRoomCode && isHost) resetBtn.title = 'Reset this room (host only)';
        else resetBtn.title = 'Reset game';
    }
}

async function updateRoomQr(roomCode) {
    const wrap = document.getElementById('roomQrWrap');
    const img = document.getElementById('roomQrImg');
    if (!roomCode || !wrap || !img) return;
    const url = getRoomJoinUrl(roomCode);
    const joinUrlEl = document.getElementById('roomJoinUrl');
    if (joinUrlEl) joinUrlEl.textContent = url;
    try {
        // Self-hosted generator (vendor/qrcode.js). Remote fallback kept in
        // case the vendored file ever fails to load.
        const makeQr = globalThis.qrcode;
        if (typeof makeQr === 'function') {
            const qr = makeQr(0, 'M');
            qr.addData(url);
            qr.make();
            img.src = qr.createDataURL(6, 4);
        } else {
            img.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(url)}`;
        }
    } catch (e) {
        console.error('QR gen failed', e);
        img.src = `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(url)}`;
    }
}

async function joinRoom(code) {
    const upper = code.toUpperCase().trim();
    if (!upper) throw new Error('Enter a room code');
    const room = await getRoomByCode(upper);
    if (!room) throw new Error('Room not found');
    const previousRoom = (() => { try { return localStorage.getItem(STORAGE_KEY_ROOM_CODE)?.toUpperCase() || null; } catch { return null; } })();
    persistRoomCode(upper);
    if (previousRoom !== upper) await resetForRoomStart();
    const url = getRoomJoinUrl(upper);
    try { history.replaceState({}, '', url); } catch {}
    updateRoomUi();
    await updateRoomQr(upper);
    // touch activity
    try { await setDoc(doc(db, 'rooms', upper), { last_activity_at: new Date().toISOString() }, { merge: true }); } catch {}
    restartRoomListener();
    return room;
}

async function leaveRoom() {
    const leavingCode = currentRoomCode;
    const leavingWasHost = isHost;
    // host handoff — mirror imposterirl useLobby DELETE handling
    if (leavingCode && leavingWasHost && auth.currentUser) {
        try {
            const snap = await getDocs(query(collection(db, 'leaderboard'), where('roomCode', '==', leavingCode)));
            const candidates = [];
            snap.forEach(d => {
                if (d.id !== auth.currentUser.uid) {
                    const data = d.data();
                    candidates.push({ id: d.id, updatedAt: data.updatedAt?.toMillis ? data.updatedAt.toMillis() : new Date(data.updatedAt||0).getTime(), createdAt: data.createdAt||0 });
                }
            });
            if (candidates.length > 0) {
                // Most recently active first — the stalest presence must not inherit the room.
                candidates.sort((a,b)=> (b.updatedAt||0)-(a.updatedAt||0));
                const next = candidates[0];
                await setDoc(doc(db, 'rooms', leavingCode), { hostUid: next.id, last_activity_at: new Date().toISOString() }, { merge: true });
            }
        } catch (e) { console.warn('host handoff failed', e); }
    }
    persistRoomCode(null);
    isHost = false;
    currentRoomHostUid = null;
    try {
        const clean = window.location.pathname.replace(/index\.html$/, '');
        const base = clean.endsWith('/') ? clean : clean + '/';
        history.replaceState({}, '', `${window.location.origin}${base}`);
    } catch {}
    updateRoomUi();
    const wrap = document.getElementById('roomQrWrap');
    if (wrap) { wrap.classList.add('hidden'); wrap.classList.remove('flex'); }
    roomQrVisible = false;
    restartRoomListener();
}

// Any player in a room can become the host: claims hostUid on the room doc.
// If someone else is host, this takes over (with their client updating via listener).
async function claimHost() {
    const status = document.getElementById('roomStatus');
    if (!currentRoomCode) { if (status) status.textContent = 'Join or create a room first.'; return; }
    try { await authReady; } catch {}
    const myUid = auth.currentUser?.uid;
    if (!myUid) { if (status) status.textContent = 'Still signing in — try again in a second.'; return; }
    if (isHost) { if (status) status.textContent = `You are already host of ${currentRoomCode}`; return; }
    const hostName = document.getElementById('editableUsername')?.innerText.trim() || 'Host';
    await setDoc(doc(db, 'rooms', currentRoomCode), {
        hostUid: myUid,
        hostName,
        last_activity_at: new Date().toISOString(),
    }, { merge: true });
    currentRoomHostUid = myUid;
    isHost = true;
    updateRoomUi();
    if (status) status.textContent = `You are now HOST of room ${currentRoomCode} — leaderboard is room-scoped`;
}

function startRoomDocListener() {
    if (roomDocUnsub) { try { roomDocUnsub(); } catch {} roomDocUnsub = null; }
    if (!currentRoomCode) { isHost = false; currentRoomHostUid = null; updateRoomUi(); return; }
    const ref = doc(db, 'rooms', currentRoomCode);
    roomDocUnsub = onSnapshot(ref, (snap)=>{
        if (!snap.exists()) { isHost = false; currentRoomHostUid = null; updateRoomUi(); return; }
        const data = snap.data();
        currentRoomHostUid = data.hostUid || null;
        const myUid = auth.currentUser?.uid || null;
        // claim host if room has none (like imposterirl first player is_host=true)
        if (!currentRoomHostUid && myUid && currentRoomCode) {
            setDoc(ref, { hostUid: myUid, hostName: document.getElementById('editableUsername')?.innerText.trim() || 'Host' }, { merge: true }).catch(()=>{});
            currentRoomHostUid = myUid;
        }
        isHost = !!myUid && myUid === currentRoomHostUid;
        updateRoomUi();
        // Market rules ride the room doc; host edits propagate to everyone.
        currentRoomRules = normalizeRules(data.rules);
        try { updateScenarioBadge(); } catch {}
        refreshPriceCells();
        // Number settings (econ/harvest) also ride the room doc: re-derive
        // interest, buy bounds, and roll payouts so guests follow the host.
        try { updateTotals(); } catch {}
        try { populateRollTable(); } catch {}
        // host reset signal — mirror imposterirl resetGameForNewRound via room doc
        const resetAt = data.lastHostResetAt;
        if (resetAt && !isHost) {
            try {
                const key = 'lastSeenHostResetAt_'+currentRoomCode;
                const seen = localStorage.getItem(key);
                if (seen !== resetAt) {
                    localStorage.setItem(key, resetAt);
                    // auto-reset local game for non-host players (like imposterirl players reset to Lobby)
                    performReset({ keepRoom: true });
                    const s = document.getElementById('roomStatus');
                    if (s) s.textContent = `Host reset room ${currentRoomCode}`;
                }
            } catch {}
        }
    }, (e)=> console.error('room doc listener', e));
}
function restartRoomListener() {
    if (roomListenerUnsub) { try { roomListenerUnsub(); } catch {} roomListenerUnsub = null; }
    if (tradeListenerUnsub) { try { tradeListenerUnsub(); } catch {} tradeListenerUnsub = null; }
    if (roomDocUnsub) { try { roomDocUnsub(); } catch {} roomDocUnsub = null; }
    if (authReady) authReady.then(() => { startFirestoreListener(); startTradeListener(); startRoomDocListener(); }).catch(()=>{});
    else { startRoomDocListener(); }
}

let purchaseMult = 1;
let gameClockTimer = null;

// Pay/gain modal state lives up here (not with the modal code below):
// updateActionButtonStates() reads payModeSelection during early page init,
// so these must be initialized before any init-time updateTotals() call.
let isGainMode = false;
let payModeSelection = { payType: 'total', perAcre: '100' };
let gainModeSelection = { payType: 'total', perAcre: '100' };

// Manual interest override: the Interest cell is tappable — typing a custom
// amount (card rulings, house rules) sticks until it is paid, then interest
// snaps back to the auto calculation (loan × host interest %).
let manualInterestOverride = null;

// Short on cash for a mandatory expense (per-acre pay, interest)? Borrow
// the full expense plus $1,000 extra: the loan lands as cash first (like
// the buy flow's shortfall) so the cash floor can't block the payment.
// Net effect: +$1,000 cash, +(expense + $1,000) loan. Blocked by the debt
// cap. One undoable action covering every leg.
// (Declared up top: updateActionButtonStates() reads it during early page
// init, before this section of the file executes — same TDZ crash as
// payModeSelection before it.)
const EXPENSE_LOAN_EXTRA = 1000;

let leaderboardSaveTimer = null;
let leaderboardSaveGeneration = 0;
let leaderboardWriteQueue = Promise.resolve();

function invalidatePendingLeaderboardSaves() {
        leaderboardSaveGeneration += 1;
        if (leaderboardSaveTimer) clearTimeout(leaderboardSaveTimer);
        leaderboardSaveTimer = null;
}

function scheduleLeaderboardSave(totalWorth) {
        if (leaderboardSaveTimer) clearTimeout(leaderboardSaveTimer);
        leaderboardSaveTimer = setTimeout(() => {
                leaderboardSaveTimer = null;
                sendDataToServer(totalWorth, leaderboardSaveGeneration);
        }, 500);
}

function calculateNet() {
    //console.log('Calculating net values...');
    const rows = document.querySelectorAll('#spreadsheet tr');

    rows.forEach((row, index) => {
        if (index === 0) return;
        if (row.classList.contains('highlight')) return;

        const netValueCell = row.querySelector('.net');
        if (!netValueCell) return;

        // Columns: 0 Assets, 1 Acres, 2 Qty, 3 Cost, 4 Net
        const acresCell = row.cells[1];
        const qtyCell = row.cells[2];
        const costCell = row.cells[3];
        const netCell = row.cells[4];

        if (!qtyCell || !costCell || !netCell) return;

        const qtyValueEl = qtyCell.querySelector('span.editable');
        const qtyRaw = (qtyValueEl ? qtyValueEl.textContent : qtyCell.innerText).replace(/,/g, '').trim();
        const qty = parseFloat(qtyRaw) || 0;
        // Cost cells show the live market quote for purchases, but holdings
        // are valued at their stable base price. Discounts/taxes change what
        // a new buy costs, never the player's net worth.
        const valuationCost = costCell.dataset.base !== undefined && costCell.dataset.base !== ''
            ? parseFloat(costCell.dataset.base)
            : parseFloat(((costCell.querySelector('.cost-price') || costCell).innerText || '').replace(/,/g, '').trim());
        const net = qty * (Number.isFinite(valuationCost) ? valuationCost : 0);

        netCell.textContent = numberWithCommasAndDecimals(net);

        const acresPerUnit = parseFloat(row.getAttribute('data-acres-per-unit') || '0') || 0;
        if (acresCell) {
            const assetType = row.cells[0].textContent.split(' ')[1]; // Get the asset type (Hay, Grain, etc.)
            const tractorQty = parseInt(document.querySelector('.qty-tractor').textContent) || 0;
            const harvesterQty = parseInt(document.querySelector('.qty-harvester').textContent) || 0;
            if (assetType === 'Tractor') {
                acresCell.textContent = "+" + (Math.min(tractorQty, 5) * 20) + "%";
            } else if (assetType === 'Harvester') {
                acresCell.textContent = "+" + (Math.min(harvesterQty, 5) * 20) + "%";
            } else if (assetType === 'Farm' || assetType === 'Ranch') {
                acresCell.textContent = numberWithCommasAndDecimals(qty * 10);
            } else if (acresPerUnit > 0) {
                let acresMultiplier = 1;
                acresCell.textContent = numberWithCommasAndDecimals(qty * acresPerUnit * acresMultiplier);
            } else {
                acresCell.textContent = '';
            }
        }
    });

    updateTotalAcres(); // Update total acres
    updateTotalWorth(true); // Update the total worth after net values are calculated (debounced save)
    if (typeof updateUpgradedRidgesDisplay === 'function') updateUpgradedRidgesDisplay();
}

function parseTransactionValue(rawValue) {
    if (rawValue === null || rawValue === undefined) return NaN;
    let s = String(rawValue).trim();
    if (!s) return NaN;

    // Normalize common input variants.
    s = s.replace(/[‐‑–—−－]/g, '-'); // dashes mobile keyboards produce (U+2010/2011/2013/2014/2212/FF0D)
    s = s.replace(/\$/g, '');
    s = s.replace(/\s+/g, '');

    // Support accounting parentheses: (1234) => -1234
    const parenMatch = s.match(/^\((.*)\)$/);
    if (parenMatch) s = '-' + parenMatch[1];

    s = s.replace(/,/g, '');

    // Support trailing sign: 1000- => -1000, 1000+ => 1000
    const trailingSign = s.match(/^(.*?)([+-])$/);
    if (trailingSign && trailingSign[1]) {
        s = (trailingSign[2] === '-' ? '-' : '') + trailingSign[1];
    }

    const n = Number(s);
    // Whole dollars only — the game has no cents, and displays round, so the
    // ledger must round too or totals and gating math silently disagree.
    return Number.isFinite(n) ? Math.round(n) : NaN;
}

function handleTransaction(inputId, transactionClass, totalClass) {
    const inputElement = document.getElementById(inputId);
    if (inputElement && inputElement.value.trim() !== '') {
        const newValue = parseTransactionValue(inputElement.value);
        if (!Number.isFinite(newValue)) {
            inputElement.value = '';
            sayStatus(`Couldn't read that as a number — try plain digits like 2000.`);
            return;
        }

        // Cash floor: reject negative cash entries that would go below $0
        if (transactionClass.includes('cash') && wouldGoNegativeCash(newValue)) {
            inputElement.value = '';
            showCashFloorWarning(newValue);
            return;
        }

        // Check loan limit for loan transactions
        if (transactionClass.includes('loan') && newValue > 0) {
            updateTotals();
            const currentLoanTotal = getCurrentLoanTotal();
            if (currentLoanTotal + newValue > debtCap()) {
                inputElement.value = '';
                sayStatus(`Debt cap $${debtCap().toLocaleString()} blocks +$${newValue.toLocaleString()} — current debt $${currentLoanTotal.toLocaleString()}. Pay down debt or ask the host to raise the cap.`);
                return;
            }
        }

        const table = document.getElementById('financialTable');
        // Check for an existing empty transaction cell
        let emptyCellFound = false;
        const transactionCells = document.querySelectorAll(`.${transactionClass}`);
        for (let cell of transactionCells) {
            if (cell.textContent.trim() === '') {
                // cell.textContent = inputElement.value; // Use the empty cell for the new transaction
                // Transaction cells are no longer editable
                emptyCellFound = true;
                break;
            }
        }

        // // If no empty cell was found, create a new row
        if (!emptyCellFound) {
            const newRow = table.insertRow(); // Insert below the input cells
            if (inputId === 'cashInput') {
                createTransactionCell(newRow, 'cash-transaction', '', false); // Empty, non-editable cell for alignment
                createTransactionCell(newRow, 'cash-total');
                createTransactionCell(newRow, 'loan-transaction', '', false); // Empty, non-editable cell for alignment
                createTransactionCell(newRow, 'loan-total');
            } else {
                createTransactionCell(newRow, 'cash-transaction', '', false); // Empty, non-editable cell for alignment
                createTransactionCell(newRow, 'cash-total');
                createTransactionCell(newRow, 'loan-transaction', '', false); // Empty, non-editable cell for alignment
                createTransactionCell(newRow, 'loan-total');
            }
        }

        shiftAndInsertTransaction(inputId,transactionClass);
        // Manual entries (typed or quick-button) are single-leg undo actions.
        pushUndoAction({
            label: `Manual ${transactionClass.includes('cash') ? 'cash' : 'loan'} entry $${newValue.toLocaleString()}`,
            cash: transactionClass.includes('cash') ? 1 : 0,
            loan: transactionClass.includes('loan') ? 1 : 0
        });
        // Calculate the new total
        updateTotals();
        saveQuantitiesToLocalStorage();
        
        // Remove excess rows beyond 10 transactions
        // Row 0 = headers, Row 1 = instructions, Row 2 = transaction headers, Row 3+ = transactions
        const maxRows = 13; // 3 header rows + 10 transaction rows
        while (table.rows.length > maxRows) {
            table.deleteRow(table.rows.length - 1);
        }
        
        // Clear the input field after the transaction is added
        inputElement.value = '';
    }
}

let cashWarnTimer = null;
function showCashFloorWarning(attemptedAmount) {
    let toast = document.getElementById('cashFloorToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'cashFloorToast';
        toast.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#dc2626;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:60;box-shadow:0 2px 8px rgba(0,0,0,.25);transition:opacity .3s;opacity:0;pointer-events:none;';
        document.body.appendChild(toast);
    }
    const needed = (attemptedAmount != null && Number.isFinite(attemptedAmount)) ? ` ($${Math.abs(attemptedAmount).toLocaleString()} needed)` : '';
    toast.textContent = `Not enough cash${needed} — balance can't go below $0`;
    toast.style.opacity = '1';
    clearTimeout(cashWarnTimer);
    cashWarnTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2200);
}

// Cash can never go below zero via spending. Epsilon absorbs float noise.
function wouldGoNegativeCash(numericValue) {
    return numericValue < 0 && (getCurrentCashTotal() + numericValue) < -0.005;
}

function addCashTransactionValue(amount) {
    if (!data.transactions) data.transactions = { cash: [], loan: [] };
    if (!Array.isArray(data.transactions.cash)) data.transactions.cash = [];
    if (!Array.isArray(data.transactions.loan)) data.transactions.loan = [];

    const numericValue = parseTransactionValue(amount);
    if (!Number.isFinite(numericValue)) return;

    // Cash floor: reject any spend that would take the balance below $0
    if (wouldGoNegativeCash(numericValue)) {
        showCashFloorWarning(numericValue);
        return;
    }

    data.transactions.cash.unshift(String(numericValue));
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    saveQuantitiesToLocalStorage();
}

function addLoanTransactionValue(amount) {
    if (!data.transactions) data.transactions = { cash: [], loan: [] };
    if (!Array.isArray(data.transactions.cash)) data.transactions.cash = [];
    if (!Array.isArray(data.transactions.loan)) data.transactions.loan = [];

    const numericValue = parseTransactionValue(amount);
    if (!Number.isFinite(numericValue)) return;

    // Check loan limit for positive loan amounts
    if (numericValue > 0) {
        updateTotals();
        const currentLoanTotal = getCurrentLoanTotal();
        if (currentLoanTotal + numericValue > debtCap()) {
            console.warn('Loan transaction would exceed the debt limit (cap $' + debtCap().toLocaleString() + '). Current debt: $' + currentLoanTotal.toLocaleString() + ', Additional loan: $' + numericValue.toLocaleString() + '.');
            return; // Silently fail for programmatic calls
        }
    }

    data.transactions.loan.unshift(String(numericValue));
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    saveQuantitiesToLocalStorage();
}

function undoToast(msg) {
    let toast = document.getElementById('undoToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'undoToast';
        toast.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;background:#1f2937;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;z-index:60;box-shadow:0 2px 8px rgba(0,0,0,.25);transition:opacity .3s;opacity:0;pointer-events:none;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(undoToast._t);
    undoToast._t = setTimeout(() => { toast.style.opacity = '0'; }, 2200);
}

function ensureActionLog() {
    if (!Array.isArray(data.actionLog)) data.actionLog = [];
    return data.actionLog;
}

// Record one undoable action. cash/loan are COUNTS of ledger lines the
// action added (derived from ledger lengths around the adds, so silently
// rejected adds — cash floor, debt cap — never create phantom undo legs).
// qty is {targetClass, delta}; ridge is {key, count} for ridge buys.
function pushUndoAction(action) {
    const cash = Math.max(0, Math.floor(Number(action.cash) || 0));
    const loan = Math.max(0, Math.floor(Number(action.loan) || 0));
    // A silently rejected add (cash floor, debt cap) leaves ledger lengths
    // unchanged — record nothing so undo never pops a no-op.
    if (cash === 0 && loan === 0 && !action.qty && !action.ridge) return;
    const log = ensureActionLog();
    log.push({
        t: Date.now(),
        label: String(action.label || 'action'),
        cash,
        loan,
        qty: action.qty || null,
        ridge: action.ridge || null
    });
    while (log.length > MAX_UNDO_ACTIONS) log.shift();
}

function ledgerLen(which) {
    try { return data.transactions?.[which]?.length || 0; } catch { return 0; }
}

// Qty deltas apply inversely on undo (not snapshot restore) so edits made
// between the action and its undo (steppers, hand-typing) are preserved.
function applyQtyDelta(targetClass, delta) {
    const cell = document.querySelector(`.${targetClass}`);
    if (!cell || !Number.isFinite(delta) || delta === 0) return;
    const cur = parseInt(cell.textContent || '0', 10) || 0;
    const floor = targetClass === 'qty-cows' ? ranchBonusFloor() : 0;
    cell.textContent = String(Math.max(floor, cur + delta));
}

// Single undo entry point — both Cash and Loan headers call this. Pops the
// most recent ACTION (not ledger line) and reverses every leg of it: ledger
// lines are removed head-first (the action's lines are at the head exactly
// when it is the most recent action, which pop guarantees), then ridge
// ownership (floor first), then qty.
function undoLastAction() {
    const log = ensureActionLog();
    if (log.length === 0) {
        undoToast('Nothing to undo');
        return;
    }
    const a = log.pop();
    try {
        if (data.transactions) {
            if (Array.isArray(data.transactions.cash)) data.transactions.cash.splice(0, a.cash);
            if (Array.isArray(data.transactions.loan)) data.transactions.loan.splice(0, a.loan);
        }
        // Ridge revert BEFORE the qty delta: the floor drops first so undoing
        // a ridge buy lands back at the pre-buy qty instead of sticking at
        // the (old, higher) bonus floor.
        if (a.ridge && a.ridge.key) {
            const counts = normalizeRidgeCounts(data.ranchRidgeSelections);
            counts[a.ridge.key] = Math.max(0, (counts[a.ridge.key] || 0) - (Math.floor(Number(a.ridge.count) || 0)));
            data.ranchRidgeSelections = counts;
            data.ranchRidgeBonus = getRanchRidgeBonusFromSelections(counts);
        }
        if (a.qty && a.qty.targetClass) applyQtyDelta(a.qty.targetClass, -(Number(a.qty.delta) || 0));
    } catch (err) {
        console.warn('undoLastAction failed to fully reverse', a, err);
    }
    updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    updateTotals();
    calculateNet();
    populateRollTable();
    updateUpgradedRidgesDisplay();
    saveQuantitiesToLocalStorage();
    undoToast(`Undid: ${a.label}`);
}

function shiftAndInsertTransaction(inputId, transactionClass) {
    // Get the value from the input
    const inputElement = document.getElementById(inputId);
    const numericValue = parseTransactionValue(inputElement.value);

    // Check that the value is not empty
    if (Number.isFinite(numericValue)) {
        // Determine which transaction type (cash or loan)
        const transactionType = transactionClass.includes('cash') ? 'cash' : 'loan';
        
        // Add new transaction to the beginning of the global data array
        data.transactions[transactionType].unshift(String(numericValue));
        
        // Select all the transaction cells for cash or loan
        const transactionCells = document.querySelectorAll(`.${transactionClass}`);
        
        // Update only the visible cells (first 10 from data)
        const visibleTransactions = data.transactions[transactionType].slice(0, 10);
        visibleTransactions.forEach((value, index) => {
            if (transactionCells[index]) {
                transactionCells[index].textContent = numberWithCommasAndDecimals(value);
            }
        });

        // Clear the input element
        inputElement.value = '';

        // After shifting values, recalculate the total
        updateTotals();

    }
}

function syncDOMToData() {
    // Sync visible transaction cells back to the data object
    const cashCells = document.querySelectorAll('.cash-transaction');
    const loanCells = document.querySelectorAll('.loan-transaction');
    
    // Ensure data.transactions exists
    if (!data.transactions) {
        data.transactions = { cash: [], loan: [] };
    }
    
    // Rebuild cash transactions from DOM cells, filtering out empty ones
    data.transactions.cash = [];
    cashCells.forEach((cell) => {
        const cellValue = cell.textContent.trim();
        if (cellValue !== '') {
            // Parse the formatted value back to a raw number string
            const numericValue = parseTransactionValue(cellValue);
            if (Number.isFinite(numericValue)) {
                data.transactions.cash.push(String(numericValue));
            }
        }
    });
    
    // Rebuild loan transactions from DOM cells, filtering out empty ones
    data.transactions.loan = [];
    loanCells.forEach((cell) => {
        const cellValue = cell.textContent.trim();
        if (cellValue !== '') {
            // Parse the formatted value back to a raw number string
            const numericValue = parseTransactionValue(cellValue);
            if (Number.isFinite(numericValue)) {
                data.transactions.loan.push(String(numericValue));
            }
        }
    });
    
    // Save to localStorage after syncing
    saveQuantitiesToLocalStorage();
}

function makeCellEditable(cell) {
    // Totals are derived values; never allow editing them.
    if (cell.classList.contains('cash-total') || cell.classList.contains('loan-total')) {
        cell.contentEditable = 'false';
        return;
    }

    cell.contentEditable = 'true';
    
    let originalValue = null;
    
    // Store original value when editing starts
    cell.addEventListener('focus', () => {
        originalValue = parseTransactionValue(cell.textContent);
    });
    
    // Event listener for input events - don't sync on every keystroke to avoid issues with partial input
    // cell.addEventListener('input', () => {
    //     syncDOMToData(); // Sync changes back to global data
    //     updateTotals();
    // });

    // Event listener for keydown events to handle the Enter key
    cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Prevent the default Enter key action
            cell.blur(); // Remove focus from the cell
        }
    });

    // Event listener for blur events to sync when editing is finished
    cell.addEventListener('blur', () => {
        const newValue = parseTransactionValue(cell.textContent);
        
        // Validate and preserve the sign from the original transaction
        if (Number.isFinite(originalValue) && Number.isFinite(newValue)) {
            const originalSign = Math.sign(originalValue);
            const newSign = Math.sign(newValue);
            
            if (originalSign !== 0 && newSign !== 0 && originalSign !== newSign) {
                // Sign changed - preserve the original sign but allow magnitude change
                const correctedValue = originalSign * Math.abs(newValue);
                cell.textContent = numberWithCommasAndDecimals(String(correctedValue));
                // alert('Transaction sign preserved. The sign cannot be changed for existing transactions.');
            }
        }
        
        syncDOMToData(); // Sync changes back to global data
        updateTotals(); // Recalculate the total when editing is finished
        // Reformat all transaction cells with proper number formatting
        updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
    });
}


// Call this function after creating a new transaction cell
function createTransactionCell(row, className, value = '', isEditable = false) {
    const cell = row.insertCell();
    cell.className = className;
    cell.textContent = value;
    if (isEditable) {
        makeCellEditable(cell);
    }
}

function getCurrentCashTotal() {
    if (data && data.transactions && Array.isArray(data.transactions.cash)) {
        return data.transactions.cash.reduce((sum, val) => sum + (parseTransactionValue(val) || 0), 0);
    }
    const cashTotalCell = document.querySelector('.cash-total');
    return cashTotalCell ? (parseTransactionValue(cashTotalCell.textContent) || 0) : 0;
}

function getCurrentLoanTotal() {
    if (data && data.transactions && Array.isArray(data.transactions.loan)) {
        return data.transactions.loan.reduce((sum, val) => sum + (parseTransactionValue(val) || 0), 0);
    }
    const loanTotalCell = document.querySelector('.loan-total');
    return loanTotalCell ? (parseTransactionValue(loanTotalCell.textContent) || 0) : 0;
}

// Debt ceiling, interest, and minimum down payment are host settings on the
// room doc (see roomEcon()); debtCap() is the live value, not a constant.
function getBuyBounds(totalCost) {
    const total = Number(totalCost) || 0;
    const cash = getCurrentCashTotal();
    const cap = debtCap();
    const debtRoom = Math.max(0, cap - getCurrentLoanTotal());
    const effective = cash + debtRoom;
    const downPct = roomEcon().downPct / 100;
    // Minimum down payment: max of host-set % of cost or amount needed to keep loan <= cap
    let min = Math.ceil(Math.max(total * downPct, Math.max(0, total - debtRoom)) / 100) * 100;
    min = Math.min(min, total);
    let max;
    let feasible;
    if (total <= 0) {
        max = 0;
        feasible = false;
    } else if (effective >= total) {
        // Cash + borrowing covers everything: any down payment works,
        // the shortfall is borrowed automatically at confirm.
        max = total;
        feasible = max >= min;
    } else {
        max = Math.max(0, Math.floor(Math.min(cash, total) / 100) * 100);
        feasible = max >= min;
    }
    return { min, max, feasible, cash, debtRoom, effective };
}

function getCurrentInterestValue() {
    const interestCell = document.querySelector('.interest');
    return interestCell ? (parseFloat(String(interestCell.textContent).replace(/,/g, '')) || 0) : 0;
}

function setButtonDisabled(button, disabled) {
    if (!button) return;
    button.disabled = !!disabled;
    button.classList.toggle('is-disabled', !!disabled);
    button.setAttribute('aria-disabled', disabled ? 'true' : 'false');
}

// Interest-row buttons never use the `disabled` attribute: a disabled button
// swallows taps with zero feedback ("grayed out when it shouldn't"). They
// look gray via the same class but stay tappable, and the tap either pays
// or says exactly why not in the room status line.
function setTappableBtn(button, blocked, reason) {
    if (!button) return;
    button.disabled = false;
    button.classList.toggle('is-disabled', !!blocked);
    button.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    if (reason) button.title = reason;
}
function sayStatus(msg) {
    const status = document.getElementById('roomStatus');
    if (status) status.textContent = msg;
}

function updateActionButtonStates() {
    const cashTotal = getCurrentCashTotal();

    // Pay Interest — when cash can't cover it, swap in the borrow button:
    // same expense plus $1,000 extra on the loan.
    const payInterestBtn = document.getElementById('payInterestBtn');
    const borrowInterestBtn = document.getElementById('borrowInterestBtn');
    if (payInterestBtn) {
        const interest = getCurrentInterestValue();
        const short = interest > 0 && cashTotal < interest;
        payInterestBtn.classList.toggle('hidden', short && !!borrowInterestBtn);
        const blocked = !(interest > 0) || cashTotal < interest;
        setTappableBtn(
            payInterestBtn,
            blocked,
            !(interest > 0)
                ? (manualInterestOverride != null
                    ? 'Custom $0 interest pinned — tap Pay Interest to clear it and resume auto.'
                    : 'No interest due right now.')
                : `Needs $${interest.toLocaleString()} — cash $${cashTotal.toLocaleString()} is short. Borrow covers it.`
        );
        if (borrowInterestBtn) {
            borrowInterestBtn.classList.toggle('hidden', !short);
            if (short) {
                const loan = interest + EXPENSE_LOAN_EXTRA;
                const capOk = getCurrentLoanTotal() + loan <= debtCap();
                borrowInterestBtn.textContent = `Borrow $${interest.toLocaleString()} + $1k`;
                const reason = capOk
                    ? `Pays $${interest.toLocaleString()} interest now; loan $${loan.toLocaleString()}, you keep $1,000 cash`
                    : `Debt cap $${debtCap().toLocaleString()} blocks the $${loan.toLocaleString()} loan — pay down debt or ask the host to raise the cap.`;
                setTappableBtn(borrowInterestBtn, !capOk, reason);
            }
        }
    }

    // Pay Per Acre
    const payPerAcreBtn = document.getElementById('payPerAcreBtn');
    if (payPerAcreBtn) {
        const totalAcres = getTotalAcres();
        const disabled = cashTotal <= 0 || totalAcres <= 0;
        setButtonDisabled(payPerAcreBtn, disabled);
    }

    // Short on cash — sits left of Pay Per Acre: borrows the current
    // pay-mode total plus $1,000 extra and pays it in one tap. When cash
    // covers, it just opens the pay modal instead.
    const shortOnCashBtn = document.getElementById('shortOnCashBtn');
    if (shortOnCashBtn) {
        const total = currentPayPerAcreTotal();
        if (!(total > 0)) {
            shortOnCashBtn.title = 'Pick a pay option first (open Pay Per Acre)';
            setButtonDisabled(shortOnCashBtn, true);
        } else if (cashTotal >= total) {
            shortOnCashBtn.title = `Cash covers the $${total.toLocaleString()} — opens Pay Per Acre`;
            setButtonDisabled(shortOnCashBtn, false);
        } else {
            const loan = total + EXPENSE_LOAN_EXTRA;
            const capOk = getCurrentLoanTotal() + loan <= debtCap();
            shortOnCashBtn.title = capOk
                ? `Borrows $${total.toLocaleString()} + $1,000 extra (loan $${loan.toLocaleString()}) and pays it — you keep $1,000 cash`
                : `Debt cap $${debtCap().toLocaleString()} blocks this loan`;
            setButtonDisabled(shortOnCashBtn, !capOk);
        }
    }

    // Gain Per Acre
    const gainPerAcreBtn = document.getElementById('gainPerAcreBtn');
    if (gainPerAcreBtn) {
        const totalAcres = getTotalAcres();
        const disabled = totalAcres <= 0;
        setButtonDisabled(gainPerAcreBtn, disabled);
    }

    // Pay Off Loan
    const payOffLoanBtn = document.getElementById('payOffLoanBtn');
    if (payOffLoanBtn) {
        const currentLoan = getCurrentLoanTotal();
        const disabled = cashTotal <= 0 || currentLoan <= 0;
        setButtonDisabled(payOffLoanBtn, disabled);
    }

    // Buy buttons: disabled unless the player can afford the true minimum
    // down payment (20% of cost, or more when near the $50k debt cap),
    // counting cash plus unused debt room. Gated on a SINGLE unit: the
    // modal is the gatekeeper for 2x (it downgrades when double is
    // unaffordable). Gating here on a stale 2x flag greyed buttons out
    // from under players who could afford one.
    document.querySelectorAll('button.buy-btn[data-asset]').forEach((btn) => {
        const row = btn.closest('tr');
        const costCell = row && row.cells ? row.cells[3] : null;
        const priceText = (costCell?.querySelector('.cost-price') || costCell)?.textContent || '';
        const unitCost = parseFloat(String(priceText).replace(/,/g, '')) || 0;
        const disabled = unitCost <= 0 || !getBuyBounds(unitCost).feasible;
        setButtonDisabled(btn, disabled);
    });
}

function updateTotals() {
    // Calculate totals from global data object, not localStorage
    // This ensures all entries contribute to the total, including newly added ones
    let cashTotal = 0;
    let loanTotal = 0;

    if (data && data.transactions) {
        // Sum all cash transactions from global data object
        cashTotal = data.transactions.cash.reduce((sum, val) => {
            return sum + (parseTransactionValue(val) || 0);
        }, 0);
        // Sum all loan transactions from global data object
        loanTotal = data.transactions.loan.reduce((sum, val) => {
            return sum + (parseTransactionValue(val) || 0);
        }, 0);
    }

    // Update the total cells
    const cashTotalCell = document.querySelector('.cash-total');
    if (cashTotalCell) {
        cashTotalCell.textContent = numberWithCommasAndDecimals(cashTotal);
    }

    const loanTotalCell = document.querySelector('.loan-total');
    if (loanTotalCell) {
        loanTotalCell.textContent = numberWithCommasAndDecimals(loanTotal);
    }

    // Update net cash, total worth, and interest after updating totals
    updateNetCash();
    updateTotalWorth(true);
    updateInterest();

    // Keep UI buttons in sync with affordability
    updateActionButtonStates();
}

function updateTotalAcres() {
    const rows = document.querySelectorAll('#spreadsheet tr');
    let totalAcres = 0;

    rows.forEach((row, index) => {
        if (index === 0) return;
        if (row.classList.contains('highlight')) return;

        const netCell = row.querySelector('.net');
        if (!netCell) return;

        const acresPerUnit = parseFloat(row.getAttribute('data-acres-per-unit') || '0') || 0;
        if (!(acresPerUnit > 0)) return;

        const qtyCell = row.cells[2];
        if (!qtyCell) return;
        const qtyValueEl = qtyCell.querySelector('span.editable');
        const qtyRaw = (qtyValueEl ? qtyValueEl.textContent : qtyCell.innerText).replace(/,/g, '').trim();
        const qty = parseFloat(qtyRaw) || 0;

        totalAcres += qty * acresPerUnit;
    });

    const totalAcresCell = document.querySelector('.total-acres');
    if (totalAcresCell) {
        totalAcresCell.textContent = numberWithCommasAndDecimals(totalAcres);
    }
}


function updateNetCash() {
    // Retrieve and parse the total cash and total loan values
    const cashTotalValue = parseFloat(document.querySelector('.cash-total').textContent.replace(/,/g, '') || 0);
    const loanTotalValue = parseFloat(document.querySelector('.loan-total').textContent.replace(/,/g, '') || 0);
    
    // Calculate net cash
    const netCash = cashTotalValue - loanTotalValue;

    // Update the net cash cell with formatted value
    const netCashCell = document.querySelector('.net-cash');
    if (netCashCell) {
        netCashCell.textContent = numberWithCommasAndDecimals(netCash);
    }
}


function updateInterest() {
    const interestCell = document.querySelector('.interest');
    if (!interestCell) return;
    // A typed-in amount wins until it is paid — never clobber mid-keystroke.
    if (manualInterestOverride != null) {
        if (document.activeElement !== interestCell) {
            interestCell.textContent = numberWithCommasAndDecimals(manualInterestOverride);
        }
        paintInterestCustom();
        return;
    }
    // Retrieve and parse the loan total value
    const loanTotalText = document.querySelector('.loan-total').textContent.replace(/,/g, '');
    // Convert to float and handle potential NaN if the text can't be converted
    const loanTotalValue = parseFloat(loanTotalText) || 0;

    // Calculate interest (host-set % of loan total), whole dollars — the game has no cents.
    const interestValue = Math.round(loanTotalValue * (roomEcon().interestPct / 100));

    // Update the interest cell with formatted value
    interestCell.textContent = numberWithCommasAndDecimals(interestValue);
    paintInterestCustom();
}

// A pinned custom amount gets an amber-tinted background + title so a $0
// never reads as a broken calc — it reads as what it is: your override,
// cleared by paying.
function paintInterestCustom() {
    const cell = document.querySelector('.interest');
    if (!cell) return;
    if (manualInterestOverride != null) {
        cell.style.background = '#fef3c7';
        cell.title = `Custom interest $${manualInterestOverride.toLocaleString()} — tap Pay Interest to settle, auto calc resumes`;
    } else {
        cell.style.background = '';
        cell.title = 'Tap to type a custom interest amount';
    }
}

// Tapping the Interest cell types a custom amount owed. It sticks (auto
// calc pauses) until Pay/Borrow Interest pays it, then auto resumes.
function wireManualInterestCell() {
    const cell = document.querySelector('.interest');
    if (!cell || cell.dataset.interestBound === '1') return;
    cell.dataset.interestBound = '1';
    cell.contentEditable = 'true';
    cell.title = 'Tap to type a custom interest amount';
    cell.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); cell.blur(); }
    });
    cell.addEventListener('input', () => {
        const v = parseFloat(String(cell.textContent).replace(/,/g, '')) || 0;
        manualInterestOverride = Math.max(0, Math.round(v));
        paintInterestCustom();
        updateActionButtonStates();
    });
    cell.addEventListener('blur', () => {
        const v = parseFloat(String(cell.textContent).replace(/,/g, '').trim());
        if (!Number.isFinite(v) || v < 0) {
            manualInterestOverride = null;
            updateInterest();
        } else {
            manualInterestOverride = Math.round(v);
            cell.textContent = numberWithCommasAndDecimals(manualInterestOverride);
        }
        updateActionButtonStates();
    });
}

function updateTotalWorth(sendData) {
    // Select all the net value cells
    const netValueCells = document.querySelectorAll('.net');
    let totalWorth = 0;

    // Sum all net value cell amounts
    netValueCells.forEach(cell => {
        totalWorth += parseFloat(cell.textContent.replace(/,/g, '')) || 0; // Remove any commas and parse to float
    });

    // Get the net cash value
    const netCashCell = document.querySelector('.net-cash');
    const netCashValue = netCashCell ? parseFloat(netCashCell.textContent.replace(/,/g, '')) || 0 : 0;

    // Add the net cash value to the total worth
    totalWorth += netCashValue;

    // Update the total worth cell
    const totalWorthCell = document.querySelector('.total-worth');
    if (totalWorthCell) totalWorthCell.textContent = numberWithCommasAndDecimals(totalWorth);
    // History is recorded on the debounced save (settled value), not here:
    // this runs mid-transaction (cash out before assets in), and those
    // transient states showed up as false dips/negatives on the chart.
    // Send the username and total worth to the server
    if (sendData) scheduleLeaderboardSave(totalWorth);
}

function sendDataToServer(totalWorth, generation = leaderboardSaveGeneration) {

    if (generation !== leaderboardSaveGeneration) return;

    const usernameCell = document.getElementById('editableUsername');
    const username = usernameCell.innerText.trim();

    // console.log('Sending data to server:', { username: username, networth: totalWorth });
    // Check if username is valid
    if (username === '' || username === 'Enter name') {
        console.log('Invalid username, not sending data');
        return;
    }

    // Ensure user is authenticated
    if (!auth.currentUser) {
        console.log('User not authenticated, skipping save');
        return;
    }

    // Wait for stored history to be read before writing: setDoc replaces the
    // whole doc, so saving before seeding would wipe existing history points.
    ensureHistorySeeded().then(() => {
        if (generation !== leaderboardSaveGeneration || historySeedFailed) {
            console.log('Skipping leaderboard save: net worth history state unknown (will retry)');
            return;
        }
        sendDataToServerAfterSeed(totalWorth, username, generation);
    }).catch((err) => console.error('History seed wait failed:', err));
}

function sendDataToServerAfterSeed(totalWorth, username, generation) {
    if (generation !== leaderboardSaveGeneration || !auth.currentUser) return;

    const hayQty = parseInt(document.querySelector('.qty-hay')?.textContent || '0', 10) || 0;
    const grainQty = parseInt(document.querySelector('.qty-grain')?.textContent || '0', 10) || 0;
    const fruitQty = parseInt(document.querySelector('.qty-fruit')?.textContent || '0', 10) || 0;
    const farmCowsQty = parseInt(document.querySelector('.qty-farm')?.textContent || '0', 10) || 0;
    const ranchCowsQty = parseInt(document.querySelector('.qty-cows')?.textContent || '0', 10) || 0;
    const cowsQty = farmCowsQty + ranchCowsQty;
    const harvesterQty = parseInt(document.querySelector('.qty-harvester')?.textContent || '0', 10) || 0;
    const tractorQty = parseInt(document.querySelector('.qty-tractor')?.textContent || '0', 10) || 0;

    const loanTotalCell = document.querySelector('.loan-total');
    const debt = loanTotalCell ? (parseFloat(loanTotalCell.textContent.replace(/,/g, '')) || 0) : 0;

    const cash = getCurrentCashTotal();

    recordHistoryPoint(totalWorth);

    const payload = {
        username: username,
        networth: totalWorth,
        debt: debt,
        cash: cash,
        hay: hayQty,
        grain: grainQty,
        fruit: fruitQty,
        cows: cowsQty,
        farm: farmCowsQty,
        harvester: harvesterQty,
        tractor: tractorQty,
        history: Array.isArray(myHistoryCache) ? myHistoryCache : [],
        gameId: data.game.id,
        gameCreatedAt: data.game.createdAt,
        gameDurationMs: data.game.durationMs,
        roomCode: currentRoomCode || null,
        updatedAt: new Date()
    };

    // Serialize whole-document writes so an older save cannot finish after a
    // newer one. Reset increments the generation and makes queued old writes
    // no-ops before they can restore the previous game state.
    const userDocRef = doc(db, 'leaderboard', auth.currentUser.uid);
    leaderboardWriteQueue = leaderboardWriteQueue
        .then(() => {
            if (generation !== leaderboardSaveGeneration) return;
            return setDoc(userDocRef, payload);
        })
        .then(() => {
            if (generation === leaderboardSaveGeneration) console.log('Data saved to Firestore');
        })
        .catch((error) => {
            console.error('Error saving to Firestore:', error);
        });

}

// --- Net worth history (feeds the leaderboard progress chart) ---
// Stored inside each player's leaderboard doc as history: [{t, v}, ...]
// MAX_HISTORY_POINTS is imported from game-time.js (shared with the cap helper).
const HISTORY_MIN_INTERVAL_MS = 0; // track every distinct networth change accurately (no time throttle)
let myHistoryCache = null;      // seeded from Firestore once auth is ready
let historySeedPromise = null;  // in-flight/complete seeding (retryable)
let historySeedFailed = false;  // true => don't write history (would wipe stored points)
let historySeedGeneration = 0;

function resetHistoryCacheForNewGame() {
    historySeedGeneration += 1;
    myHistoryCache = [];
    historySeedPromise = Promise.resolve();
    historySeedFailed = false;
}

function ensureHistorySeeded() {
    if (!historySeedPromise) {
        historySeedPromise = seedHistoryCache(historySeedGeneration);
    }
    return historySeedPromise;
}

async function seedHistoryCache(generation) {
    if (!auth.currentUser) return;
    try {
        const snap = await getDoc(doc(db, 'leaderboard', auth.currentUser.uid));
        if (generation !== historySeedGeneration) return;
        const storedData = snap.data() || {};
        const storedGameId = storedData.gameId;
        const storedCreatedAt = asTimestamp(storedData.gameCreatedAt);
        const hasGameMetadata = Boolean(storedGameId) || Number.isFinite(storedCreatedAt);
        const isDifferentGame = !hasGameMetadata
            || (storedGameId && data.game?.id && storedGameId !== data.game.id)
            || (Number.isFinite(storedCreatedAt) && storedCreatedAt !== data.game?.createdAt);
        const stored = isDifferentGame ? [] : storedData.history;
        const storedPoints = capHistoryPoints(normalizeHistoryPoints(stored));
        // Merge instead of clobber: a debounced save may have recorded a
        // point before this read returned.
        if (Array.isArray(myHistoryCache) && myHistoryCache.length > 0) {
            const storedTs = new Set(storedPoints.map(p => p.t));
            const localOnly = myHistoryCache.filter(p => !storedTs.has(p.t));
            myHistoryCache = capHistoryPoints(normalizeHistoryPoints(storedPoints.concat(localOnly)));
        } else {
            myHistoryCache = storedPoints;
        }
        historySeedFailed = false;
    } catch (err) {
        if (generation !== historySeedGeneration) return;
        console.error('Error loading net worth history:', err);
        // Unknown stored state: block history writes until a later retry
        // succeeds, otherwise the next save would wipe stored points.
        historySeedFailed = true;
        historySeedPromise = null; // allow retry on the next save attempt
    }
}

function recordHistoryPoint(totalWorth) {
    if (!Array.isArray(myHistoryCache)) myHistoryCache = [];
    let now = Date.now();
    const last = myHistoryCache[myHistoryCache.length - 1];
    // Ensure monotonic timestamp if two changes land in same ms
    if (last && now <= last.t) now = last.t + 1;
    if (last && last.v === totalWorth) return;                  // unchanged value — no new point
    myHistoryCache.push({ t: now, v: totalWorth });
    myHistoryCache = capHistoryPoints(myHistoryCache);
}

  
// Function to update the leaderboard table with fetched data
function updateLeaderboardTable(data) {
    const leaderboardTable = document.getElementById('leaderboard');
    const tbody = leaderboardTable.querySelector('tbody');

    // Clear existing rows in the table body
    tbody.innerHTML = '';

    // Create a new row for each entry in the fetched data
    data.forEach(entry => {
        const row = document.createElement('tr');

        const usernameCell = document.createElement('td');
        usernameCell.textContent = entry.username;
        usernameCell.className = 'text-center';

        const networthCell = document.createElement('td');
        networthCell.textContent = parseFloat(entry.networth ?? 0).toLocaleString('en-US'); // Format the number with commas
        networthCell.className = 'text-center';

        const debtCell = document.createElement('td');
        debtCell.textContent = parseFloat(entry.debt ?? 0).toLocaleString('en-US');
        debtCell.className = 'text-center';

        const cashCell = document.createElement('td');
        cashCell.textContent = parseFloat(entry.cash ?? 0).toLocaleString('en-US');
        cashCell.className = 'text-center';

        const hayCell = document.createElement('td');
        hayCell.textContent = (entry.hay ?? 0).toString();
        hayCell.className = 'text-center';

        const grainCell = document.createElement('td');
        grainCell.textContent = (entry.grain ?? 0).toString();
        grainCell.className = 'text-center';

        const fruitCell = document.createElement('td');
        fruitCell.textContent = (entry.fruit ?? 0).toString();
        fruitCell.className = 'text-center';

        const cowsCell = document.createElement('td');
        cowsCell.textContent = (entry.cows ?? 0).toString();
        cowsCell.className = 'text-center';

        // Append cells to the row
        row.appendChild(usernameCell);
        row.appendChild(networthCell);
        row.appendChild(cashCell);
        row.appendChild(debtCell);
        row.appendChild(hayCell);
        row.appendChild(grainCell);
        row.appendChild(fruitCell);
        row.appendChild(cowsCell);

        // Append the row to the table body
        tbody.appendChild(row);
    });
}

// --- Leaderboard progress chart (net worth over time, one line per player) ---

let progressChart = null;
let latestLeaderboardData = [];

// Distinct per-player colors: roster sorted by name => evenly spaced hues, so
// no two players in the same game land in the same color family. Same roster
// => same colors on every client (hashing names alone clustered greens).
function paletteColor(index, total) {
    const hue = total > 0 ? (index * 360) / total : 0;
    return `hsl(${hue.toFixed(1)}, 70%, 45%)`;
}

function buildChartDatasets(data) {
    // One line per player per room: docs are merged first so a second device
    // (or a fresh anonymous sign-in) can't draw a twin line that folds over
    // the original. All lines share one uncompressed clock — like a stock
    // chart — instead of per-player inactivity squashing that shifts lines
    // sideways relative to each other.
    const merged = mergeHistoriesByPlayer(data);
    if (merged.length === 0) return [];
    const start = Math.min(...merged.map((group) => group.gameCreatedAt));
    const ordered = [...merged].sort((a, b) =>
        String(a.username || '').localeCompare(String(b.username || ''), undefined, { sensitivity: 'base' }));
    return ordered.map((group, i) => {
        // Infinity buffer: true elapsed wall time, no gap compression.
        const elapsedHistory = buildElapsedHistory(group.history, start, Infinity);
        const color = paletteColor(i, ordered.length);
        return {
            label: group.username,
            data: elapsedHistory.map(point => ({ x: point.x, y: point.v })),
            borderColor: color,
            backgroundColor: color,
            tension: 0, // straight segments: smoothing overshoots below zero on sharp moves
            pointRadius: 0,
            borderWidth: 2,
            fill: false
        };
    });
}

function getChartWindowForDatasets(datasets) {
    return getTimeWindow((datasets || []).flatMap(dataset => dataset.data || []));
}

// Called on every leaderboard snapshot. Data is cached so the chart can be
// created lazily when the Chart view is first shown (a canvas created while
// hidden gets zeroed dimensions).
function updateProgressChart(data) {
    latestLeaderboardData = data;
    // Inline trade forms track who's online: refresh counterparties on every
    // snapshot (selection-preserving — refresh keeps the prior pick).
    try { refreshCustomBuySellers(); } catch {}
    try { refreshCustomSellBuyers(); } catch {}
    if (!progressChart || typeof Chart === 'undefined') return;
    const datasets = buildChartDatasets(data);
    progressChart.data.datasets = datasets;
    // Follow the live window unless the user has zoomed or panned; the Reset
    // button hands control back.
    const win = getChartWindowForDatasets(datasets);
    progressChart.$defaultWindow = win;
    const userZoomed = typeof progressChart.isZoomedOrPanned === 'function'
        ? progressChart.isZoomedOrPanned()
        : false;
    if (!userZoomed) {
        progressChart.options.scales.x.min = win.min;
        progressChart.options.scales.x.max = win.max;
    }
    progressChart.update('none');
}

// --- Market pricing: room-creator-selectable rules (rooms.rules JSONB) ---
// Prices derive from the polled leaderboard snapshot + local game clock, so
// every device computes identical prices with no server round trip. Owned
// holdings revalue at market: rewriting the Cost cells flows through net
// worth, the buy modal, and saves automatically. Player-to-player trades
// stay negotiated and are never adjusted.
let currentRoomRules = {};

// Host-tunable numbers ride the same room doc as the rule flags. Each group
// only applies when its checkbox is on (customecon/customharvest) —
// otherwise today's defaults, so unticked rooms play the standard game.
function roomEcon() {
    return activeEcon(currentRoomRules);
}
function roomHarvest() {
    return activeHarvest(currentRoomRules);
}
function debtCap() {
    return roomEcon().debtCap;
}

function marketBoard() {
    const rows = Array.isArray(latestLeaderboardData) ? latestLeaderboardData : [];
    if (currentRoomCode) return rows.filter((d) => (d.roomCode || '').toUpperCase() === currentRoomCode);
    return rows;
}

// Pause-aware room clock: the union of every board doc's history
// timestamps, so an hour-plus break with no room activity stops the game
// clock (and boom & bust) on every device at once.
function roomGameElapsed(now) {
    const g = (typeof data !== 'undefined' && data && data.game) || {};
    const times = [];
    for (const d of marketBoard()) {
        const h = Array.isArray(d.history) ? d.history : [];
        for (const p of h) times.push(p && p.t);
    }
    return gameElapsedMs(times, Number(g.createdAt), now);
}

function currentMarketCtx(asset) {
    const board = marketBoard();
    const players = board.length;
    const key = String(asset || '').toLowerCase();
    let total = 0;
    for (const d of board) total += Number(d[key] ?? 0) || 0;
    // Room crop totals feed the demand balancer, the seasons clock, and
    // the boom & bust walks (same snapshot on every client, so every
    // device prices identically). Per-capita earned basis: starting
    // inventory stripped, remainder divided by players — room size stops
    // accelerating the market.
    const rawTotals = {};
    for (const k of ['hay', 'grain', 'fruit']) {
        let t = 0;
        for (const d of board) t += Number(d[k] ?? 0) || 0;
        rawTotals[k] = t;
    }
    const cropTotals = marketBasis(rawTotals, players);
    // Market cost is a room-wide quote, never personalized by this device's
    // rank or local inventory. Use room-average ownership for Estate so every
    // client computes the same surcharge from the same leaderboard snapshot.
    const avgOwned = players > 0 ? total / players : 0;
    return {
        rules: normalizeRules(currentRoomRules),
        players,
        rank: undefined,
        avgOwned,
        myOwned: avgOwned,
        totals: cropTotals,
        roomCode: currentRoomCode || ''
    };
}

function marketNote(asset) {
    try {
        const { mult, notes } = computeMarketPrice(1, asset, currentMarketCtx(asset));
        if (!notes.length) return '';
        const m = mult.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        return ` Market ×${m} (${notes.join(' · ')})`;
    } catch { return ''; }
}

const MARKET_CELL_ASSETS = ['hay', 'grain', 'fruit', 'farm', 'harvester', 'tractor'];

function refreshPriceCells() {
    let changed = false;
    for (const asset of MARKET_CELL_ASSETS) {
        const btn = document.querySelector(`.buy-btn[data-asset="${asset}"]`);
        const costCell = btn?.closest('tr')?.cells?.[3];
        if (!costCell) continue;
        const priceEl = costCell.querySelector('.cost-price') || costCell;
        const noteEl = costCell.querySelector('.market-note');
        if (costCell.dataset.base === undefined || costCell.dataset.base === '') {
            costCell.dataset.base = (priceEl.innerText || '').replace(/,/g, '').trim();
        }
        const base = parseFloat(costCell.dataset.base) || 0;
        if (!(base > 0)) continue;
        const { price, mult, notes } = computeMarketPrice(base, asset, currentMarketCtx(asset));
        const text = price.toLocaleString('en-US');
        if (priceEl.innerText.trim() !== text) {
            priceEl.innerText = text;
            changed = true;
        }
        // Per-crop modifiers + source, visible right under the price.
        if (noteEl) {
            const note = notes.length
                ? `Market ×${mult.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} (${notes.join(' · ')})`
                : '';
            if (noteEl.textContent !== note) { noteEl.textContent = note; changed = true; }
        }
    }
    if (changed && typeof calculateNet === 'function') calculateNet();
}

function createProgressChart() {
    if (progressChart || typeof Chart === 'undefined') return;
    const canvas = document.getElementById('progressChart');
    if (!canvas) return;
    // chartjs-plugin-zoom (UMD) exposes itself as ChartZoom; register it so
    // wheel/pinch zoom and drag pan are available on the progress chart.
    if (typeof ChartZoom !== 'undefined') Chart.register(ChartZoom);
    const datasets = buildChartDatasets(latestLeaderboardData);
    const initialWindow = getChartWindowForDatasets(datasets);
    progressChart = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 } }
                },
                tooltip: {
                    callbacks: {
                        title: (items) => items.length
                            ? `Game time ${formatGameTime(items[0].parsed.x)}`
                            : ''
                    }
                },
                zoom: {
                    pan: { enabled: true, mode: 'x' },
                    zoom: {
                        wheel: { enabled: true },
                        pinch: { enabled: true },
                        mode: 'x'
                    },
                    limits: {
                        x: {
                            min: 'original',
                            max: 'original',
                            minRange: MIN_TIME_WINDOW_MS
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: initialWindow.min,
                    max: initialWindow.max,
                    title: { display: true, text: 'Game time since first change' },
                    ticks: {
                        maxTicksLimit: 6,
                        font: { size: 10 },
                        callback: (v) => formatGameTime(v)
                    },
                    grid: { display: false }
                },
                y: {
                    ticks: {
                        font: { size: 10 },
                        // Compact ($1M, $250k) so wide values don't squeeze
                        // the plot off narrow phone screens.
                        callback: (v) => {
                            const n = Number(v) || 0;
                            const a = Math.abs(n);
                            if (a >= 1000000) return `$${parseFloat((n / 1000000).toFixed(1))}M`;
                            if (a >= 1000) return `$${parseFloat((n / 1000).toFixed(1))}k`;
                            return `$${n}`;
                        }
                    }
                }
            }
        }
    });
    progressChart.$defaultWindow = initialWindow;
}

// Show exactly one of the two leaderboard views at a time.
function showLeaderboardView(view) {
    const tableWrap = document.getElementById('leaderboardTableWrap');
    const chartWrap = document.getElementById('leaderboardChartWrap');
    const tableBtn = document.getElementById('showTableBtn');
    const chartBtn = document.getElementById('showChartBtn');
    if (!tableWrap || !chartWrap || !tableBtn || !chartBtn) return;

    const isChart = view === 'chart';
    tableWrap.classList.toggle('hidden', isChart);
    chartWrap.classList.toggle('hidden', !isChart);
    tableBtn.classList.toggle('active', !isChart);
    chartBtn.classList.toggle('active', isChart);
    tableBtn.setAttribute('aria-pressed', String(!isChart));
    chartBtn.setAttribute('aria-pressed', String(isChart));

    if (isChart) {
        createProgressChart(); // lazy: first switch to Chart view
        if (progressChart) {
            progressChart.resize();
            progressChart.update('none');
        }
    }
}

document.getElementById('showTableBtn')?.addEventListener('click', () => showLeaderboardView('table'));
document.getElementById('showChartBtn')?.addEventListener('click', () => showLeaderboardView('chart'));

// --- Chart zoom controls (chartjs-plugin-zoom) ---
function withZoomableChart(fn) {
    if (progressChart && typeof progressChart.zoom === 'function') fn(progressChart);
}

function resetChartZoom() {
    if (!progressChart || typeof progressChart.resetZoom !== 'function') return;
    progressChart.resetZoom();
    // Resume following the live window after a manual reset.
    const win = progressChart.$defaultWindow;
    if (win) {
        progressChart.options.scales.x.min = win.min;
        progressChart.options.scales.x.max = win.max;
    }
    progressChart.update('none');
}

document.getElementById('zoomInBtn')?.addEventListener('click', () => withZoomableChart(c => c.zoom(1.25)));
document.getElementById('zoomOutBtn')?.addEventListener('click', () => withZoomableChart(c => c.zoom(0.8)));
document.getElementById('resetZoomBtn')?.addEventListener('click', resetChartZoom);

// --- Room wiring — mirrors imposterirl lobby create/join + QR ---
async function initRoomFromUrl() {
    updateRoomUi();
    if (!currentRoomCode) return;
    try {
        const room = await getRoomByCode(currentRoomCode);
        if (!room) {
            document.getElementById('roomStatus').textContent = `Room ${currentRoomCode} not found`;
            persistRoomCode(null);
            updateRoomUi();
            return;
        }
        // URL joins can race DOMContentLoaded/localStorage restoration; only
        // reset after the saved farm has loaded, and only on room transition.
        if (document.readyState === 'loading') {
            await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
        }
        if (roomCodeAtBoot !== currentRoomCode) await resetForRoomStart();
        persistRoomCode(currentRoomCode);
        await updateRoomQr(currentRoomCode);
        document.getElementById('roomStatus').textContent = `Joined room ${currentRoomCode}`;
    } catch (e) { console.error('initRoom', e); }
}

document.getElementById('createRoomBtn')?.addEventListener('click', async () => {
    // Room setup screen first — the room (with its rules) is made on confirm.
    openRoomSetup();
});

async function finishMakeRoom(rules) {
    const btn = document.getElementById('createRoomBtn');
    const status = document.getElementById('roomStatus');
    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Creating room…';
    try {
        const code = await createRoom(rules);
        persistRoomCode(code);
        currentRoomHostUid = auth.currentUser?.uid || null;
        isHost = !!currentRoomHostUid;
        await resetForRoomStart();
        try { history.replaceState({}, '', getRoomJoinUrl(code)); } catch {}
        updateRoomUi();
        await updateRoomQr(code);
        if (status) status.textContent = `Created room ${code} — share the code or QR`;
        restartRoomListener();
    } catch (e) {
        console.error(e);
        if (status) status.textContent = roomErrorMessage(e);
    } finally { if (btn) btn.disabled = false; }
}

// --- Room setup screen: scenario cards + rule checkboxes with descriptions
// + number sliders/boxes, all rendering from the pricing.js sources of truth.
// A preset fills the whole form; any hand edit flips the scenario to Custom.
const RULE_LABELS = {
    seasons: 'Seasons', rubberband: 'Rubber-band', estate: 'Estate',
    balance: 'Balance', events: 'Boom&Bust', customecon: 'Economy', customharvest: 'Harvest'
};
const RULE_DESCRIPTIONS = {
    seasons: 'Prices start normal and walk up and down as the room harvests: each crop runs its own cycle sized by player count, peaking at +25%.',
    rubberband: 'Individual leader/trailer prices are disabled so everyone sees the same room-wide costs.',
    estate: 'Adds a shared surcharge based on the room-average number of farms, harvesters, or tractors owned.',
    balance: 'The crop everyone piles into goes dear (up to 2×); ignored ones go cheap (down to half). Hay caps at $20k, fruit floors at $20k.',
    events: 'Each crop walks its own random path: every room harvest moves a crop ±$100, zero-sum across crops and capped. Over-held crops also drift down and under-held crops drift up ($100 tickets).',
    customecon: 'Enables your economy numbers below (unticked = $50k cap, 10% interest, 20% down).',
    customharvest: 'Enables your harvest numbers below (unticked = standard hay tiers and equipment bonus).'
};
let setupScenarioKey = 'standard';

// One slider per market rule, set at room creation. Strengths scale how
// hard seasons/balance bite (100% = classic); individual rank-based
// rubberband prices are neutral under shared-cost pricing; estate uses
// room-average ownership so every player gets the same quote;
// events sets the max walk swing %. Economy/Harvest have no row — their
// number groups below are the tuning.
const RULE_TUNING_SPECS = {
    seasons: { label: 'Effect strength', min: 0, max: 200, step: 10, def: 100, desc: 'How hard the harvest wave swings prices. 100% is classic; 0% holds everything at base.' },
    rubberband: { label: 'Leader tax / trailer aid', min: 0, max: 30, step: 1, def: 10, suffix: '%', desc: 'Kept for legacy room settings; individual price differences are disabled so all players see the same costs.' },
    estate: { label: 'Shared extra cost per unit', min: 0, max: 50, step: 5, def: 10, suffix: '%', desc: 'Adds the same surcharge to everyone using the room-average number of farms, harvesters, or tractors.' },
    balance: { label: 'Effect strength', min: 0, max: 200, step: 10, def: 100, desc: 'How hard the demand balancer pushes the popular crop up and the ignored ones down.' },
    events: { label: 'Max walk swing', min: 0, max: 50, step: 5, def: 50, suffix: '%', desc: 'Farthest a crop\u2019s walk may stray from base. Still zero-sum — one crop\u2019s boom is funded by the others\u2019 busts.' }
};

function tuningSlider(key) {
    return document.querySelector(`input[data-scope="setup"][data-tslider="${key}"]`);
}
function tuningInput(key) {
    return document.querySelector(`input[data-scope="setup"][data-tuning="${key}"]`);
}

function readSetupTuning() {
    const out = {};
    for (const key of Object.keys(RULE_TUNING_SPECS)) {
        const el = tuningInput(key);
        if (!el) continue;
        out[key] = el.value === '' ? 0 : Number(el.value);
    }
    return out;
}

function syncSetupTuning(rules) {
    const t = normalizeTuning(rules && rules.tuning);
    for (const key of Object.keys(RULE_TUNING_SPECS)) {
        const num = tuningInput(key);
        if (num) num.value = t[key];
        const slider = tuningSlider(key);
        if (slider) slider.value = t[key];
    }
    syncSetupTuningEnabled();
}

// A rule's slider only edits live while its box is ticked — unticked
// rules do nothing, same as the number groups below.
function syncSetupTuningEnabled() {
    document.querySelectorAll('input[data-setup-rule]').forEach((box) => {
        const on = !!box.checked;
        const num = tuningInput(box.dataset.setupRule);
        if (num) num.disabled = !on;
        const slider = tuningSlider(box.dataset.setupRule);
        if (slider) slider.disabled = !on;
    });
}

function bindSetupTuning() {
    document.querySelectorAll('input[data-scope="setup"][data-tslider]').forEach((slider) => {
        if (slider.dataset.tsliderBound) return;
        slider.dataset.tsliderBound = '1';
        const pair = tuningInput(slider.dataset.tslider);
        slider.addEventListener('input', () => { if (pair) pair.value = slider.value; });
        slider.addEventListener('change', () => { if (pair) pair.value = slider.value; markSetupCustom(); });
    });
    document.querySelectorAll('input[data-scope="setup"][data-tuning]').forEach((el) => {
        if (el.dataset.tuningBound) return;
        el.dataset.tuningBound = '1';
        el.addEventListener('input', () => {
            const s = tuningSlider(el.dataset.tuning);
            if (s && el.value !== '') s.value = el.value;
        });
        el.addEventListener('change', markSetupCustom);
    });
}

function setupScenarioRadio(key) {
    return document.querySelector(`input[name="setupScenario"][value="${key}"]`);
}

function renderSetupForm() {
    const sc = document.getElementById('setupScenarios');
    if (sc && !sc.dataset.rendered) {
        sc.innerHTML = '';
        for (const key of [...SCENARIO_KEYS, 'custom']) {
            const label = document.createElement('label');
            label.className = 'flex items-start gap-2 p-2 border border-gray-200 rounded-lg cursor-pointer hover:bg-gray-50 text-xs';
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'setupScenario';
            radio.value = key;
            radio.className = 'mt-0.5';
            const body = document.createElement('span');
            const name = document.createElement('span');
            name.className = 'block font-bold text-gray-800';
            name.textContent = key === 'custom' ? 'Custom' : SCENARIOS[key].label;
            const blurb = document.createElement('span');
            blurb.className = 'block text-gray-500';
            blurb.textContent = key === 'custom'
                ? 'Your own mix — selected automatically when you tweak anything.'
                : SCENARIOS[key].blurb;
            body.appendChild(name);
            body.appendChild(blurb);
            label.appendChild(radio);
            label.appendChild(body);
            label.addEventListener('click', () => {
                // Radio change fires after click; defer so checked state lands.
                setTimeout(() => {
                    const picked = document.querySelector('input[name="setupScenario"]:checked')?.value;
                    if (picked && picked !== 'custom') applySetupScenario(picked);
                    else setupScenarioKey = 'custom';
                }, 0);
            });
            sc.appendChild(label);
        }
        sc.dataset.rendered = '1';
    }
    const rc = document.getElementById('setupRules');
    if (rc && !rc.dataset.rendered) {
        rc.innerHTML = '';
        for (const key of RULE_KEYS) {
            const card = document.createElement('div');
            card.className = 'p-2 border border-gray-200 rounded-lg text-xs';
            const top = document.createElement('label');
            top.className = 'flex items-start gap-2 cursor-pointer';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.dataset.setupRule = key;
            box.className = 'mt-0.5';
            const body = document.createElement('span');
            const name = document.createElement('span');
            name.className = 'block font-bold text-gray-800';
            name.textContent = RULE_LABELS[key] || key;
            const desc = document.createElement('span');
            desc.className = 'block text-gray-500';
            desc.textContent = RULE_DESCRIPTIONS[key] || '';
            body.appendChild(name);
            body.appendChild(desc);
            top.appendChild(box);
            top.appendChild(body);
            card.appendChild(top);
            const tune = RULE_TUNING_SPECS[key];
            if (tune) {
                const trow = document.createElement('div');
                trow.className = 'mt-2 pl-6';
                const head = document.createElement('span');
                head.className = 'flex items-center gap-1 font-medium text-gray-700';
                const tname = document.createElement('span');
                tname.textContent = tune.suffix ? `${tune.label} (${tune.suffix})` : tune.label;
                const info = makeInfoButton(tune.label);
                const tip = document.createElement('span');
                tip.className = 'info-tip hidden';
                tip.textContent = tune.desc;
                wireInfoButton(info, tip);
                head.appendChild(tname);
                head.appendChild(info);
                trow.appendChild(head);
                trow.appendChild(tip);
                const srow = document.createElement('span');
                srow.className = 'flex items-center gap-2 mt-1';
                const slider = document.createElement('input');
                slider.type = 'range';
                slider.min = String(tune.min);
                slider.max = String(tune.max);
                slider.step = String(tune.step);
                slider.value = String(tune.def);
                slider.dataset.tslider = key;
                slider.dataset.scope = 'setup';
                slider.className = 'flex-1';
                slider.setAttribute('aria-label', tune.label);
                const num = document.createElement('input');
                num.type = 'number';
                num.min = String(tune.min);
                num.max = String(tune.max);
                num.step = String(tune.step);
                num.value = String(tune.def);
                num.dataset.tuning = key;
                num.dataset.scope = 'setup';
                num.className = 'w-20 border rounded px-1 py-0.5 text-xs';
                num.setAttribute('aria-label', `${tune.label} value`);
                srow.appendChild(slider);
                srow.appendChild(num);
                trow.appendChild(srow);
                card.appendChild(trow);
            }
            box.addEventListener('change', () => { markSetupCustom(); syncSetupTuningEnabled(); });
            rc.appendChild(card);
        }
        rc.dataset.rendered = '1';
    }
    bindSetupTuning();
    renderSettingRows('setupSettingsRows', 'setup');
    bindSettingsSliders('setup', async () => { markSetupCustom(); });
    document.querySelectorAll('input[data-scope="setup"][data-setting]').forEach((el) => {
        if (!el.dataset.setupBound) {
            el.dataset.setupBound = '1';
            el.addEventListener('change', () => { syncSetupSliderToBox(el); markSetupCustom(); });
            el.addEventListener('input', () => { syncSetupSliderToBox(el); });
        }
    });
}

function syncSetupSliderToBox(boxEl) {
    const slider = document.querySelector(`input[data-scope="setup"][data-slider="${boxEl.dataset.setting}"]`);
    if (slider && boxEl.value !== '') slider.value = boxEl.value;
}

function applySetupScenario(key) {
    if (!SCENARIOS[key]) return;
    setupScenarioKey = key;
    const r = applyScenario(key);
    const radio = setupScenarioRadio(key);
    if (radio) radio.checked = true;
    document.querySelectorAll('input[data-setup-rule]').forEach((box) => {
        box.checked = !!r[box.dataset.setupRule];
    });
    syncSettingsInputs('setup', r);
    syncSetupTuning(r);
}

function markSetupCustom() {
    setupScenarioKey = 'custom';
    const radio = setupScenarioRadio('custom');
    if (radio) radio.checked = true;
}

function readSetupRules() {
    const flags = {};
    document.querySelectorAll('input[data-setup-rule]').forEach((box) => {
        flags[box.dataset.setupRule] = !!box.checked;
    });
    const tuned = readSettingsInputs('setup');
    const rules = { ...flags, econ: tuned.econ, harvest: tuned.harvest, tuning: readSetupTuning() };
    if (setupScenarioKey !== 'custom') rules.scenario = setupScenarioKey;
    return normalizeRules(rules);
}

let roomSetupMode = 'create'; // 'create' (Make Room) or 'edit' (host retunes live)
function setRoomSetupChrome() {
    const edit = roomSetupMode === 'edit';
    const title = document.getElementById('roomSetupTitle');
    const sub = document.getElementById('roomSetupSub');
    const confirm = document.getElementById('confirmRoomSetup');
    if (title) title.textContent = edit ? 'Room Settings' : 'Make Room — game setup';
    if (sub) sub.textContent = edit
        ? 'Saving applies to everyone in the room immediately — prices, interest, and payouts re-derive on every device.'
        : "Pick a scenario or mix your own rules and numbers, then make the room. The badge in the Market row always shows what's active.";
    if (confirm) confirm.textContent = edit ? 'Save Settings' : 'Make Room';
}
function openRoomSetup() {
    roomSetupMode = 'create';
    renderSetupForm();
    applySetupScenario('standard');
    setRoomSetupChrome();
    document.getElementById('roomSetupModal')?.classList.remove('hidden');
}
// Host mid-game retune: prefill the same form from the live room rules and
// save back to the room doc — the room-doc listener pushes them to guests.
async function openRoomSettings() {
    const status = document.getElementById('roomStatus');
    if (!currentRoomCode) {
        if (status) status.textContent = 'Join or create a room before editing its settings.';
        return;
    }
    try {
        await authReady;
        const snap = await getDoc(doc(db, 'rooms', currentRoomCode));
        const hostUid = snap.exists() ? (snap.data().hostUid || null) : null;
        currentRoomHostUid = hostUid;
        isHost = !!auth.currentUser?.uid && auth.currentUser.uid === hostUid;
        updateRoomUi();
    } catch (e) {
        console.error('Unable to verify room host before settings edit', e);
        if (status) status.textContent = roomErrorMessage(e);
        return;
    }
    if (!isHost) {
        if (status) status.textContent = 'Only the room host can edit settings. Confirm the host badge or ask the host to transfer host status.';
        return;
    }
    roomSetupMode = 'edit';
    renderSetupForm();
    const r = normalizeRules(currentRoomRules);
    setupScenarioKey = (r.scenario && SCENARIOS[r.scenario]) ? r.scenario : 'custom';
    const radio = setupScenarioRadio(setupScenarioKey);
    if (radio) radio.checked = true;
    document.querySelectorAll('input[data-setup-rule]').forEach((box) => {
        box.checked = !!r[box.dataset.setupRule];
    });
    syncSettingsInputs('setup', r);
    syncSetupTuning(r);
    setRoomSetupChrome();
    document.getElementById('roomSetupModal')?.classList.remove('hidden');
}
async function saveRoomSettings(rules) {
    const status = document.getElementById('roomStatus');
    if (status) status.textContent = 'Saving settings…';
    try {
        await authReady;
        const snap = await getDoc(doc(db, 'rooms', currentRoomCode));
        if (!snap.exists() || snap.data().hostUid !== auth.currentUser?.uid) {
            isHost = false;
            updateRoomUi();
            if (status) status.textContent = 'Settings were not saved: this account is no longer the room host.';
            return;
        }
        await setDoc(doc(db, 'rooms', currentRoomCode), {
            rules: normalizeRules(rules),
            last_activity_at: new Date().toISOString(),
        }, { merge: true });
        currentRoomRules = normalizeRules(rules);
        updateScenarioBadge();
        refreshPriceCells();
        updateTotals();
        populateRollTable();
        if (status) status.textContent = `Room ${currentRoomCode} settings saved — everyone follows`;
    } catch (e) {
        console.error(e);
        if (status) status.textContent = roomErrorMessage(e);
    }
}
function hideRoomSetup() {
    document.getElementById('roomSetupModal')?.classList.add('hidden');
}

document.getElementById('cancelRoomSetup')?.addEventListener('click', hideRoomSetup);
document.getElementById('roomSetupModal')?.addEventListener('click', (e) => { if (e.target.id === 'roomSetupModal') hideRoomSetup(); });
document.getElementById('confirmRoomSetup')?.addEventListener('click', async () => {
    const rules = readSetupRules();
    hideRoomSetup();
    if (roomSetupMode === 'edit') {
        if (currentRoomCode && isHost) await saveRoomSettings(rules);
        else if (document.getElementById('roomStatus')) document.getElementById('roomStatus').textContent = 'Settings were not saved: host status is no longer active.';
    } else {
        await finishMakeRoom(rules);
    }
});
document.getElementById('roomSettingsBtn')?.addEventListener('click', () => openRoomSettings());

document.getElementById('joinRoomBtn')?.addEventListener('click', async () => {
    const input = document.getElementById('roomCodeInput');
    const status = document.getElementById('roomStatus');
    const raw = (input?.value || '').toUpperCase().trim();
    if (!raw) { if (status) status.textContent = 'Enter a room code'; return; }
    if (status) status.textContent = 'Joining…';
    try {
        await joinRoom(raw);
        if (status) status.textContent = `Joined room ${raw}`;
    } catch (e) {
        console.error(e);
        if (status) status.textContent = roomErrorMessage(e);
    }
});

document.getElementById('leaveRoomBtn')?.addEventListener('click', async () => {
    await leaveRoom();
    document.getElementById('roomStatus').textContent = 'Left room — back to global leaderboard';
});

document.getElementById('roomQrBtn')?.addEventListener('click', async () => {
    roomQrVisible = !roomQrVisible;
    const wrap = document.getElementById('roomQrWrap');
    const btn = document.getElementById('roomQrBtn');
    if (!currentRoomCode) return;
    if (roomQrVisible) {
        await updateRoomQr(currentRoomCode);
        if (wrap) { wrap.classList.remove('hidden'); wrap.classList.add('flex'); }
        if (btn) btn.textContent = 'HIDE QR';
    } else {
        if (wrap) { wrap.classList.add('hidden'); wrap.classList.remove('flex'); }
        if (btn) btn.textContent = '📱 JOIN QR';
    }
});

document.getElementById('roomCodeInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('joinRoomBtn')?.click(); }
});
document.getElementById('roomCodeInput')?.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0,4);
});

// boot room UI
initRoomFromUrl();

// Base price of an asset for trade-form defaults: the stable Cost-column
// base (dataset.base once priced, else the printed cell) — never the live
// market quote, never the old hardcoded 1000.
function assetBasePrice(asset) {
    const key = String(asset || '').toLowerCase();
    const costCell = document.querySelector(`.buy-btn[data-asset="${key}"]`)?.closest('tr')?.cells?.[3];
    const priceText = costCell?.querySelector('.cost-price')?.textContent ?? costCell?.textContent ?? '';
    const raw = (costCell?.dataset?.base ?? '').trim() !== '' ? costCell.dataset.base : priceText;
    const v = Math.round(parseFloat(String(raw).replace(/,/g, '')) || 0);
    return Math.max(0, v);
}
function resetTradePriceToBase(priceId, qtyId, asset) {
    const priceEl = document.getElementById(priceId);
    if (!priceEl) return;
    const qty = Math.max(1, parseInt(document.getElementById(qtyId)?.value || '1', 10) || 1);
    priceEl.value = String(assetBasePrice(asset) * qty);
}

// custom buy wiring (side-by-side buttons pop up the modal)
document.getElementById('customBuyBtn')?.addEventListener('click', showCustomBuyModal);
document.getElementById('cancelCustomBuy')?.addEventListener('click', hideCustomBuyModal);
document.getElementById('customBuyModal')?.addEventListener('click', (e) => { if (e.target.id === 'customBuyModal') hideCustomBuyModal(); });
document.getElementById('confirmCustomBuy')?.addEventListener('click', performCustomBuy);
document.getElementById('customBuyAsset')?.addEventListener('change', () => { refreshCustomBuySellers(); resetTradePriceToBase('customBuyPrice', 'customBuyQty', document.getElementById('customBuyAsset')?.value || 'Hay'); updateCustomBuyPreview(); });
document.getElementById('customBuyQty')?.addEventListener('input', updateCustomBuyPreview);
document.getElementById('customBuyPrice')?.addEventListener('input', updateCustomBuyPreview);
document.getElementById('customBuySeller')?.addEventListener('change', updateCustomBuyPreview);

// custom sell wiring (mirror of buy: seller initiates, buyer accepts)
document.getElementById('customSellBtn')?.addEventListener('click', showCustomSellModal);
document.getElementById('cancelCustomSell')?.addEventListener('click', hideCustomSellModal);
document.getElementById('customSellModal')?.addEventListener('click', (e) => { if (e.target.id === 'customSellModal') hideCustomSellModal(); });
document.getElementById('confirmCustomSell')?.addEventListener('click', performCustomSell);
document.getElementById('customSellAsset')?.addEventListener('change', () => { refreshCustomSellBuyers(); resetTradePriceToBase('customSellPrice', 'customSellQty', document.getElementById('customSellAsset')?.value || 'Hay'); updateCustomSellPreview(); });
document.getElementById('customSellQty')?.addEventListener('input', updateCustomSellPreview);
document.getElementById('customSellPrice')?.addEventListener('input', updateCustomSellPreview);
document.getElementById('customSellBuyer')?.addEventListener('change', updateCustomSellPreview);

// Trade dropdowns populate on load; snapshots keep them fresh after.
try { refreshCustomBuySellers(); } catch {}
try { refreshCustomSellBuyers(); } catch {}

// host controls — only host sees Reset Room (imposterirl: host controls game start/settings)
document.getElementById('hostResetRoomBtn')?.addEventListener('click', async () => { await resetRoomForHost(); });
document.getElementById('hostResetGameBtn')?.addEventListener('click', async () => { await performReset({ keepRoom: true }); });
// guests can take over hosting so there is always a way to become host + make/run the game
document.getElementById('becomeHostBtn')?.addEventListener('click', async () => { await claimHost(); });

// Market readout (read-only): all settings are fixed at room creation.
// The badge names the scenario; the text lists the active rules for
// hand-mixed (Custom) rooms. Everyone sees the same via the room doc.
function updateScenarioBadge() {
    const badge = document.getElementById('scenarioBadge');
    const on = RULE_KEYS.filter((k) => !!currentRoomRules[k]);
    const names = on.map((k) => RULE_LABELS[k] || k);
    if (badge) {
        badge.textContent = scenarioName(currentRoomRules);
        badge.title = names.length ? `Active rules: ${names.join(', ')}` : 'Standard game — no market rules on';
    }
    const rulesText = document.getElementById('activeRulesText');
    if (rulesText) rulesText.textContent = names.join(' • ');
}

// Number settings (economy + harvest tuning): slider + number-box rows
// rendered from one spec for the room setup screen (scope 'setup').
// Setup rows are shared by room creation and host mid-game settings edits.
const SETTING_SPECS = [
    { group: 'econ', key: 'debtCap', label: 'Max loan $', min: 0, max: 500000, step: 5000, def: 50000, desc: 'The biggest loan the bank will give you. Set to 0 for no loans at all (Debt-Free).' },
    { group: 'econ', key: 'interestPct', label: 'Interest %', min: 0, max: 100, step: 1, def: 10, desc: 'Yearly cut added to what you owe. Higher means borrowed money costs more over time.' },
    { group: 'econ', key: 'downPct', label: 'Min down %', min: 0, max: 100, step: 5, def: 20, desc: 'Cash you must pay up front on every buy — the rest is borrowed. 100 means cash only.' },
    { group: 'harvest', key: 'hayMidQty', label: 'Hay mid qty', min: 2, max: 20, step: 1, def: 5, desc: 'Hay you must own to reach the middle bonus tier on roll payouts.' },
    { group: 'harvest', key: 'hayMidMult', label: 'Hay mid ×', min: 1, max: 3, step: 0.5, def: 1.5, desc: 'Hay roll payout multiplier once you reach the middle tier.' },
    { group: 'harvest', key: 'hayHighQty', label: 'Hay high qty', min: 3, max: 30, step: 1, def: 10, desc: 'Hay you must own to reach the top bonus tier on roll payouts.' },
    { group: 'harvest', key: 'hayHighMult', label: 'Hay high ×', min: 1, max: 5, step: 0.5, def: 2, desc: 'Hay roll payout multiplier once you reach the top tier.' },
    { group: 'harvest', key: 'equipRate', label: 'Equip +%/unit', min: 0, max: 200, step: 5, def: 20, percent: true, desc: 'Extra crop on every roll for each tractor (hay) or harvester (grain) you own.' },
    { group: 'harvest', key: 'equipCap', label: 'Equip cap', min: 0, max: 10, step: 1, def: 5, desc: 'Most tractors/harvesters that count toward the bonus. The rest still count for net worth.' }
];
const HOST_SETTING_FIELDS = [
    ['econ', 'debtCap'], ['econ', 'interestPct'], ['econ', 'downPct'],
    ['harvest', 'hayMidQty'], ['harvest', 'hayMidMult'],
    ['harvest', 'hayHighQty'], ['harvest', 'hayHighMult'],
    ['harvest', 'equipRate'], ['harvest', 'equipCap']
];

// Tap-to-reveal explainer: the ⓘ button toggles its tip without
// triggering the surrounding label/row (mobile has no hover).
function wireInfoButton(btn, tip) {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        tip.classList.toggle('hidden');
    });
}

function makeInfoButton(about) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'info-btn';
    btn.textContent = 'i';
    btn.setAttribute('aria-label', `What does this do? ${about}`);
    return btn;
}

function renderSettingRows(containerId, scope) {
    const box = document.getElementById(containerId);
    if (!box || box.dataset.rendered === '1') return;
    box.innerHTML = '';
    let lastGroup = '';
    let grid = null;
    for (const spec of SETTING_SPECS) {
        if (spec.group !== lastGroup) {
            lastGroup = spec.group;
            const h = document.createElement('h5');
            h.className = 'mt-2 font-semibold text-gray-500';
            h.textContent = spec.group === 'econ' ? 'ECONOMY (needs Economy ☑)' : 'HARVEST (needs Harvest ☑)';
            box.appendChild(h);
            grid = document.createElement('div');
            grid.className = 'mt-1 grid grid-cols-1 gap-2';
            box.appendChild(grid);
        }
        const label = document.createElement('label');
        label.className = 'flex flex-col gap-1';
        const head = document.createElement('span');
        head.className = 'flex items-center gap-1 text-sm font-medium text-gray-700';
        const nameEl = document.createElement('span');
        nameEl.textContent = spec.label;
        const info = makeInfoButton(spec.label);
        const tip = document.createElement('span');
        tip.className = 'info-tip hidden text-xs';
        tip.textContent = spec.desc;
        wireInfoButton(info, tip);
        head.appendChild(nameEl);
        head.appendChild(info);
        label.appendChild(head);
        label.appendChild(tip);
        const row = document.createElement('span');
        row.className = 'flex items-center gap-2';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(spec.min);
        slider.max = String(spec.max);
        slider.step = String(spec.step);
        slider.value = String(spec.def);
        slider.dataset.slider = `${spec.group}.${spec.key}`;
        slider.dataset.scope = scope;
        slider.className = 'flex-1';
        slider.setAttribute('aria-label', spec.label);
        const num = document.createElement('input');
        num.type = 'number';
        num.min = String(spec.min);
        num.max = String(spec.max);
        num.step = String(spec.step);
        num.value = String(spec.def);
        num.dataset.setting = `${spec.group}.${spec.key}`;
        num.dataset.scope = scope;
        num.className = 'w-20 border rounded px-1 py-0.5 text-xs';
        num.setAttribute('aria-label', `${spec.label} value`);
        row.appendChild(slider);
        row.appendChild(num);
        label.appendChild(row);
        grid.appendChild(label);
    }
    box.dataset.rendered = '1';
}

function settingInput(scope, group, key) {
    return document.querySelector(`input[data-scope="${scope}"][data-setting="${group}.${key}"]`);
}
function settingSlider(scope, group, key) {
    return document.querySelector(`input[data-scope="${scope}"][data-slider="${group}.${key}"]`);
}
// Equipment rate stores a fraction (0.2) but shows as a friendly percent (20).
function shownSettingValue(group, key, stored) {
    return (group === 'harvest' && key === 'equipRate') ? Math.round(stored * 100) : stored;
}
function storedSettingValue(group, key, shown) {
    return (group === 'harvest' && key === 'equipRate') ? shown / 100 : shown;
}

function syncSettingsInputs(scope, rules = currentRoomRules) {
    // Show the stored draft (clamped). Host groups grey out while their
    // checkbox is off — unticked groups play standard values. The setup
    // draft always edits live (its checkboxes gate on confirm).
    const econ = normalizeEcon(rules.econ);
    const harvest = normalizeHarvest(rules.harvest);
    const groups = { econ, harvest };
    const enabled = scope === 'setup'
        ? { econ: true, harvest: true }
        : { econ: !!rules.customecon, harvest: !!rules.customharvest };
    for (const [group, key] of HOST_SETTING_FIELDS) {
        const shown = shownSettingValue(group, key, groups[group][key]);
        const num = settingInput(scope, group, key);
        if (num) { num.value = shown; num.disabled = !enabled[group]; }
        const slider = settingSlider(scope, group, key);
        if (slider) { slider.value = shown; slider.disabled = !enabled[group]; }
    }
}

function readSettingsInputs(scope) {
    const out = { econ: {}, harvest: {} };
    for (const [group, key] of HOST_SETTING_FIELDS) {
        const el = settingInput(scope, group, key);
        if (!el) continue;
        // Cleared input means 0 (typed 0 works too); normalizeRules clamps
        // each field into its valid range from there.
        const n = el.value === '' ? 0 : Number(el.value);
        out[group][key] = storedSettingValue(group, key, n);
    }
    return out;
}

// Slider drags preview in the box live; the room-doc save fires on release
// (change), same as typing a number and leaving the box.
function bindSettingsSliders(scope, onCommit) {
    document.querySelectorAll(`input[data-scope="${scope}"][data-slider]`).forEach((slider) => {
        if (slider.dataset.sliderBound) return;
        slider.dataset.sliderBound = '1';
        const pair = document.querySelector(`input[data-scope="${scope}"][data-setting="${slider.dataset.slider}"]`);
        slider.addEventListener('input', () => { if (pair) pair.value = slider.value; });
        slider.addEventListener('change', async () => {
            if (pair) pair.value = slider.value;
            await onCommit();
        });
    });
}

// Number settings live only in the room setup screen (scope 'setup') —
// there is no mid-game tuning. The shared renderer above serves it.

// --- Digital dice — hidden by default, for tables without physical dice ---
let diceHistory = [];
let diceRolling = false;
function setDiceDisplay(value) {
    const el = document.getElementById('diceDisplay');
    if (el) el.textContent = String(value);
}
function pushDiceHistory(text) {
    diceHistory.unshift(text);
    if (diceHistory.length > 20) diceHistory = diceHistory.slice(0, 20);
    const h = document.getElementById('diceHistory');
    if (h) h.textContent = diceHistory.join(' • ');
}
function rollDice() {
    if (diceRolling) return null;
    const roll = Math.floor(Math.random() * 6) + 1; // 1-6 only
    const el = document.getElementById('diceDisplay');
    if (!el) { pushDiceHistory(String(roll)); return roll; }
    // Tumble through faces before settling, so rolling the same number
    // twice in a row still reads as a fresh roll.
    diceRolling = true;
    const btn = document.getElementById('rollDiceBtn');
    if (btn) btn.disabled = true;
    let i = 0;
    const iv = setInterval(() => {
        i++;
        if (i >= 6) {
            clearInterval(iv);
            setDiceDisplay(`🎲 ${roll}`);
            pushDiceHistory(String(roll));
            try { navigator.vibrate && navigator.vibrate(10); } catch {}
            diceRolling = false;
            if (btn) btn.disabled = false;
        } else {
            setDiceDisplay(`🎲 ${Math.floor(Math.random() * 6) + 1}`);
        }
    }, 60);
    return roll;
}
function setDiceVisible(visible) {
    const comp = document.getElementById('diceComponent');
    const toggle = document.getElementById('toggleDiceBtn');
    if (comp) comp.classList.toggle('hidden', !visible);
    if (toggle) toggle.classList.toggle('hidden', visible);
}
document.getElementById('toggleDiceBtn')?.addEventListener('click', () => setDiceVisible(true));
document.getElementById('hideDiceBtn')?.addEventListener('click', () => setDiceVisible(false));
document.getElementById('rollDiceBtn')?.addEventListener('click', () => rollDice());
// haptics for thumb actions (dice/buy/qty/roll)
document.addEventListener('click', (e) => {
    if (e.target.closest('.buy-btn, .qty-btn, .roll-cell-button, #rollDiceBtn, #confirmBuy, #confirmCustomBuy, #confirmCustomSell, #payPerAcreBtn, #payInterestBtn, #gainPerAcreBtn, #payOffLoanBtn')) {
        try { navigator.vibrate && navigator.vibrate(10); } catch {}
    }
});

// --- Custom Buy — buy property from another player at custom price ---
function refreshCustomBuySellers() {
    const sel = document.getElementById('customBuySeller');
    if (!sel) return;
    const myUsername = document.getElementById('editableUsername')?.innerText.trim() || '';
    const prev = sel.value;
    sel.innerHTML = '';
    const others = (latestLeaderboardData || []).filter(p => (p.username || '').trim() !== myUsername && p.username !== 'Enter name');
    if (others.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = currentRoomCode ? 'No other players in this room yet' : 'No other players online yet';
        sel.appendChild(opt);
    } else {
        others.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p._id || p.username;
            // store uid in dataset for Firestore update, display name + qty preview
            opt.dataset.uid = p._id || '';
            opt.dataset.username = p.username;
            const assetName = document.getElementById('customBuyAsset')?.value || 'Hay';
            const qty = getSellerQty(p, assetName);
            opt.textContent = `${p.username} — ${assetName}: ${qty} (net $${(p.networth||0).toLocaleString()})`;
            sel.appendChild(opt);
        });
    }
    if (prev) {
        const hasPrev = [...sel.options].some(o => o.value === prev);
        if (hasPrev) sel.value = prev;
    }
    updateCustomBuyPreview();
}
function getAssetQtyKey(asset) {
    const map = { Hay: 'Hay', Grain: 'Grain', Fruit: 'Fruit', Farm: 'Farm', Cows: 'Cows', Harvester: 'Harvester', Tractor: 'Tractor' };
    return map[asset] || asset;
}
function getSellerQty(sellerData, asset) {
    if (!sellerData) return 0;
    const key = asset.toLowerCase();
    if (key === 'cows' || key === 'ranch cows') {
        // Prefer the split ranch field; fall back to combined cows for legacy docs
        if (sellerData.ranch != null) return Number(sellerData.ranch || 0);
        if (sellerData.farm != null) return Number(sellerData.cows || 0) - Number(sellerData.farm || 0);
        return Number(sellerData.cows || 0);
    }
    if (key === 'farm' || key === 'farm cows') {
        if (sellerData.farm != null) return Number(sellerData.farm || 0);
        return Number(sellerData.cows || 0); // legacy docs only stored combined cows
    }
    if (key === 'harvester') return Number(sellerData.harvester || 0);
    if (key === 'tractor') return Number(sellerData.tractor || 0);
    return Number(sellerData[key] ?? sellerData[key.toLowerCase()] ?? 0);
}
// My own board holdings (DOM-grained) — used to validate sell offers and accepts.
function myAssetQty(asset) {
    const classMap = { Hay:'qty-hay', Grain:'qty-grain', Fruit:'qty-fruit', Farm:'qty-farm', Cows:'qty-cows', Harvester:'qty-harvester', Tractor:'qty-tractor' };
    const cell = document.querySelector(`.${classMap[getAssetQtyKey(asset)] || 'qty-hay'}`);
    return parseInt(cell?.textContent || '0', 10) || 0;
}
// Who may click Accept: a party who didn't create the offer. Offers predate
// createdBy were buyer-created (Custom Buy), so the seller accepts those.
function canAcceptTrade(t, myUid) {
    if (!t || t.status !== 'pending' || !myUid) return false;
    if (t.buyerUid !== myUid && t.sellerUid !== myUid) return false;
    const creator = t.createdBy || t.buyerUid;
    return myUid !== creator;
}
function updateCustomBuyPreview() {
    const preview = document.getElementById('customBuyPreview');
    const hint = document.getElementById('customBuyHint');
    if (!preview) return;
    const sellerSel = document.getElementById('customBuySeller');
    const asset = document.getElementById('customBuyAsset')?.value || 'Hay';
    const qty = parseInt(document.getElementById('customBuyQty')?.value || '1', 10);
    const price = Math.round(parseFloat(String(document.getElementById('customBuyPrice')?.value || '0').replace(/,/g, '')) || 0);
    const opt = sellerSel?.selectedOptions?.[0];
    const sellerName = opt?.dataset?.username || opt?.textContent?.split(' —')[0] || 'seller';
    const sellerData = (latestLeaderboardData || []).find(p => (p._id && p._id === opt?.dataset?.uid) || p.username === sellerName);
    const sellerQty = getSellerQty(sellerData, asset);
    const myCash = getCurrentCashTotal();
    preview.innerHTML = `You: cash $${myCash.toLocaleString()} → $${(myCash - price).toLocaleString()} after pay<br>Seller ${sellerName}: ${asset} ${sellerQty} → ${sellerQty - qty} after sale<br>Price: $${price.toLocaleString()} for ${qty} × ${asset}`;
    let err = '';
    if (!sellerSel || !sellerSel.value) err = 'Pick a seller.';
    else if (!Number.isFinite(qty) || qty <= 0) err = 'Quantity must be ≥1.';
    else if (!Number.isFinite(price) || price < 0) err = 'Price must be ≥0.';
    else if (sellerQty < qty) err = `Seller only has ${sellerQty} ${asset}.`;
    else if (myCash < price) err = `You need $${price.toLocaleString()} cash (have $${myCash.toLocaleString()}).`;
    if (hint) { hint.textContent = err; hint.classList.toggle('hidden', !err); }
    const confirm = document.getElementById('confirmCustomBuy');
    if (confirm) confirm.disabled = !!err;
}
// Trade popups: side-by-side buttons open the buy/sell modals. Refresh
// the counterparty dropdowns on open (plus on every snapshot) so they
// track who's actually online. Selection-preserving via prev-restore.
function showCustomBuyModal() {
    refreshCustomBuySellers();
    resetTradePriceToBase('customBuyPrice', 'customBuyQty', document.getElementById('customBuyAsset')?.value || 'Hay');
    updateCustomBuyPreview();
    document.getElementById('customBuyModal')?.classList.remove('hidden');
}
function hideCustomBuyModal() {
    document.getElementById('customBuyModal')?.classList.add('hidden');
}
let tradeListenerUnsub = null;
let seenTradeIds = new Set();
// Consecutive failed buyer auto-applies per trade (in-memory only: a reload
// restarts the count, which is fine — the persisted applied-IDs stay primary).
const tradeApplyFails = {};
const MAX_BUYER_APPLY_FAILS = 5;
// Retry-chain timer: onSnapshot only re-renders on DATA change, so a counter
// incremented inside the render would stall at 1 and warnings/staleness would
// never resolve. While buyer applies keep failing, re-poll fresh (never act
// on a stale snapshot). Cleared on every (re)subscribe, so room switches and
// leaves can never leak or double-subscribe.
let tradeRetryTimer = null;
// Trades already applied locally survive reloads (otherwise a refresh would
// re-apply every historical accepted trade and duplicate qty/cash).
try {
    const stored = JSON.parse(localStorage.getItem('farmingGameAppliedTrades') || '[]');
    if (Array.isArray(stored)) stored.forEach(id => seenTradeIds.add(id));
} catch {}
// Accepted-offer confirmations dismissed from MY inbox only (local): the
// trade doc stays put so the counterparty's settlement poll still sees it.
const dismissedTrades = new Set();
try {
    const storedDismissed = JSON.parse(localStorage.getItem('farmingGameDismissedTrades') || '[]');
    if (Array.isArray(storedDismissed)) storedDismissed.forEach(id => { if (typeof id === 'string') dismissedTrades.add(id); });
} catch {}
function dismissTrade(tradeId) {
    if (!tradeId) return;
    dismissedTrades.add(tradeId);
    try {
        localStorage.setItem('farmingGameDismissedTrades', JSON.stringify([...dismissedTrades].slice(-200)));
    } catch {}
    startTradeListener(); // re-poll + re-render without the dismissed line
}
function markTradeApplied(tradeId) {
    seenTradeIds.add('applied-' + tradeId);
    try {
        const arr = [...seenTradeIds].filter(s => s.startsWith('applied-')).slice(-200);
        localStorage.setItem('farmingGameAppliedTrades', JSON.stringify(arr));
    } catch {}
}
// An offer belongs to the game that was running when it was created. Compare
// against MY OWN game clock (same device, always valid) — never against
// another device's timestamps. Offers predating my game (self-reset, host
// reset I followed) are refused, never applied.
function tradeInCurrentGame(t) {
    try {
        const created = new Date(t.createdAt || 0).getTime();
        if (!Number.isFinite(created) || !created) return true;
        const gameStart = Number(data?.game?.createdAt) || 0;
        if (!gameStart) return true;
        return created >= gameStart - 60 * 1000;
    } catch { return true; }
}
// Only auto-apply recently accepted trades, and never ones settled before the
// current game started (those belong to a previous board, e.g. fresh device
// with no applied-ID history). Persisted applied IDs are the primary guard.
function isRecentTrade(t, maxAgeMs = 24 * 60 * 60 * 1000) {
    const ts = new Date(t.updatedAt || t.createdAt || 0).getTime();
    if (!Number.isFinite(ts) || (Date.now() - ts) >= maxAgeMs) return false;
    try {
        const gameStart = Number(data?.game?.createdAt) || 0;
        if (gameStart && ts < gameStart - 60 * 1000) return false;
    } catch {}
    return true;
}

function applyLocalTrade(trade, role) {
    const qty = Number(trade.qty || 0);
    const price = Number(trade.price || 0);
    const asset = trade.asset || 'Hay';
    const qtyKey = getAssetQtyKey(asset);
    const classMap = { Hay:'qty-hay', Grain:'qty-grain', Fruit:'qty-fruit', Farm:'qty-farm', Cows:'qty-cows', Harvester:'qty-harvester', Tractor:'qty-tractor' };
    const targetClass = classMap[qtyKey] || 'qty-hay';
    const cell = document.querySelector(`.${targetClass}`);
    if (!cell) return false;
    const tradeCashBefore = ledgerLen('cash');
    let cur = parseInt(cell.textContent || '0', 10) || 0;
    if (role === 'buyer') {
        if (price !== 0 && wouldGoNegativeCash(-price)) return false;
        if (price !== 0) addCashTransactionValue(-price);
        cell.textContent = String(cur + qty);
    } else {
        // seller: bonus cows aren't sellable stock — only qty above the
        // ridge-bonus floor can go (farm cows and everything else: all of it).
        const floor = isRanchCowsAsset(asset) ? ranchBonusFloor() : 0;
        if (cur - floor < qty) return false;
        cell.textContent = String(cur - qty);
        if (price !== 0) addCashTransactionValue(price);
    }
    // Trades settle as one undoable action (cash leg + qty move together).
    pushUndoAction({
        label: `Trade: ${role === 'buyer' ? 'bought' : 'sold'} ${qty} ${asset} $${price.toLocaleString()}`,
        cash: ledgerLen('cash') - tradeCashBefore,
        loan: 0,
        qty: { targetClass, delta: role === 'buyer' ? qty : -qty }
    });
    calculateNet();
    populateRollTable();
    saveQuantitiesToLocalStorage();
    return true;
}

function renderTradeInbox(trades) {
    const box = document.getElementById('tradeInbox');
    if (!box) return;
    const myUid = auth.currentUser?.uid || '';
    // Actionable offers: I'm a party and I didn't create it. My own pending
    // offers wait on the other side (outgoing). Legacy offers were
    // buyer-created, so the seller still accepts those.
    const incoming = trades.filter(t => t.status === 'pending' && canAcceptTrade(t, myUid));
    const outgoing = trades.filter(t => t.status === 'pending' && (t.buyerUid === myUid || t.sellerUid === myUid) && !canAcceptTrade(t, myUid));
    const acceptedForMe = trades.filter(t => t.status === 'accepted' && (t.buyerUid === myUid || t.sellerUid === myUid) && !seenTradeIds.has('applied-'+t.id) && isRecentTrade(t));
    // apply accepted trades that I haven't applied locally yet (buyer side applies on accept, seller already applied on accept)
    // This handles buyer applying after seller accepts
    let failedApplies = 0;
    acceptedForMe.forEach(t => {
        if (t.buyerUid === myUid && !seenTradeIds.has('applied-'+t.id)) {
            // Offers from before my current game are never auto-applied.
            if (!tradeInCurrentGame(t)) return;
            // buyer applies now if not already
            const ok = applyLocalTrade(t, 'buyer');
            if (ok) { markTradeApplied(t.id); delete tradeApplyFails[t.id]; }
            else { tradeApplyFails[t.id] = (tradeApplyFails[t.id] || 0) + 1; failedApplies++; }
        } else if (t.sellerUid === myUid && !seenTradeIds.has('applied-'+t.id)) {
            // Seller side settles here when the BUYER accepted (sell offers):
            // the seller never clicked, so nothing applied yet. Buy offers
            // applied at accept-click time, making this a no-op safety net.
            if (!tradeInCurrentGame(t)) return;
            const ok = applyLocalTrade(t, 'seller');
            if (ok) { markTradeApplied(t.id); delete tradeApplyFails[t.id]; }
            else { tradeApplyFails[t.id] = (tradeApplyFails[t.id] || 0) + 1; failedApplies++; }
        }
    });
    // Forget fail counts for trades that are gone or settled.
    const liveIds = new Set(acceptedForMe.map(t => t.id));
    Object.keys(tradeApplyFails).forEach(id => { if (!liveIds.has(id)) delete tradeApplyFails[id]; });
    let html = '';
    if (incoming.length) {
        html += `<div class="font-bold mb-1">Incoming trade offers</div>`;
        incoming.forEach(t => {
            // Direction-aware line: buy offers want my goods, sell offers offer theirs.
            const line = t.buyerUid === myUid
                ? `${t.sellerName} offers ${t.qty} ${t.asset} for $${Number(t.price).toLocaleString()}`
                : `${t.buyerName} wants ${t.qty} ${t.asset} for $${Number(t.price).toLocaleString()}`;
            html += `<div class="flex items-center justify-between gap-2 py-1 border-b border-yellow-100">
                <span>${line} — you are ${t.buyerUid === myUid ? 'buyer' : 'seller'}</span>
                <span class="flex gap-1">
                  <button data-accept="${t.id}" class="px-2 py-1 bg-green-600 text-white rounded text-xs">Accept</button>
                  <button data-reject="${t.id}" class="px-2 py-1 bg-gray-300 rounded text-xs">Reject</button>
                </span>
            </div>`;
        });
    }
    if (outgoing.length) {
        html += `<div class="font-bold mt-2 mb-1">Outgoing — waiting for them</div>`;
        outgoing.forEach(t => {
            const line = t.sellerUid === myUid
                ? `${t.qty} ${t.asset} to ${t.buyerName} for $${Number(t.price).toLocaleString()} — pending`
                : `${t.qty} ${t.asset} from ${t.sellerName} for $${Number(t.price).toLocaleString()} — pending`;
            html += `<div class="py-1 border-b border-yellow-100 flex items-center justify-between gap-2"><span>${line}</span><button data-reject="${t.id}" class="px-1.5 py-0.5 text-gray-500 hover:text-gray-800 text-sm leading-none" title="Cancel this offer">×</button></div>`;
        });
    }
    const justAccepted = trades.filter(t => t.status === 'accepted' && (Date.now() - new Date(t.updatedAt||t.createdAt).getTime() < 15000) && (t.buyerUid===myUid || t.sellerUid===myUid) && !dismissedTrades.has(t.id));
    justAccepted.forEach(t => {
        const role = t.sellerUid===myUid ? 'sold' : 'bought';
        html += `<div class="text-xs text-green-700 mt-1 flex items-center justify-between gap-2"><span>✓ ${role} ${t.qty} ${t.asset} for $${Number(t.price).toLocaleString()} ${t.sellerUid===myUid?'to '+t.buyerName:'from '+t.sellerName}</span><button data-dismiss="${t.id}" class="px-1.5 py-0.5 text-gray-500 hover:text-gray-800 text-sm leading-none" title="Clear this confirmation">×</button></div>`;
    });
    // A stuck side used to retry silently forever. Keep retrying (cash or
    // stock may arrive), but say so out loud — role-aware either way.
    acceptedForMe
        .filter(t => (tradeApplyFails[t.id] || 0) >= MAX_BUYER_APPLY_FAILS)
        .forEach(t => {
            html += t.buyerUid === myUid
                ? `<div class="text-xs text-red-700 mt-1">⚠ Can't afford ${t.qty} ${t.asset} from ${t.sellerName} ($${Number(t.price).toLocaleString()}) — still accepted, applies when you have cash.</div>`
                : `<div class="text-xs text-red-700 mt-1">⚠ Short on ${t.asset} for ${t.buyerName} (need ${t.qty}) — still accepted, applies when you restock.</div>`;
        });
    if (!html) { box.classList.add('hidden'); box.innerHTML=''; }
    else {
        box.innerHTML = html;
        box.classList.remove('hidden');
    }
    box.querySelectorAll('[data-accept]').forEach(b=> b.addEventListener('click', ()=> acceptTrade(b.dataset.accept)));
    box.querySelectorAll('[data-reject]').forEach(b=> b.addEventListener('click', ()=> rejectTrade(b.dataset.reject)));
    box.querySelectorAll('[data-dismiss]').forEach(b=> b.addEventListener('click', ()=> dismissTrade(b.dataset.dismiss)));
    // Keep polling fresh while buyer applies fail: the snapshot layer only
    // re-renders on data change, so without this the fail counter (and the
    // warning below, and the 15s confirmation lines) would freeze after one
    // attempt. Fresh resubscribe each tick — never renders stale data.
    // Scheduled even for an empty inbox so the count can't stall there either.
    if (failedApplies > 0 && !tradeRetryTimer) {
        tradeRetryTimer = setTimeout(() => { tradeRetryTimer = null; startTradeListener(); }, 2600);
    }
}

async function acceptTrade(tradeId) {
    if (!tradeId) return;
    const ref = doc(db, 'rooms', tradeRoomCode(), 'trades', tradeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const t = { id: snap.id, ...snap.data() };
    const myUid = auth.currentUser?.uid;
    if (!canAcceptTrade(t, myUid)) return;
    // Refuse offers from before my current game (pending across a reset).
    if (!tradeInCurrentGame(t)) {
        const s = document.getElementById('roomStatus');
        if (s) s.textContent = `Offer ${t.qty} ${t.asset} is from a previous game — ask for a re-offer.`;
        return;
    }
    const iAmBuyer = t.buyerUid === myUid;
    if (iAmBuyer) {
        // Buyer accepting a sell offer: must afford it right now.
        if (Number(t.price || 0) !== 0 && wouldGoNegativeCash(-Number(t.price || 0))) {
            const s = document.getElementById('roomStatus');
            if (s) s.textContent = `You need $${Number(t.price || 0).toLocaleString()} cash to accept.`;
            return;
        }
    } else {
        // Seller accepting a buy offer: must hold the qty right now, not
        // counting ridge-bonus cows (they're earned property, never sellable).
        const available = isRanchCowsAsset(t.asset) ? sellableRanchCows() : myAssetQty(t.asset);
        if (available < Number(t.qty || 0)) {
            alert(`You only have ${available} sellable ${t.asset}, need ${t.qty}`);
            return;
        }
    }
    // Write FIRST, apply locally after. If the write fails nothing moved, so
    // retrying the accept can never deduct twice. (The local apply cannot fail
    // after the check above — same tick, no interleaving.)
    try {
        await setDoc(ref, { status: 'accepted', updatedAt: new Date().toISOString() }, { merge: true });
    } catch (e) {
        console.error('accept write failed', e);
        const s = document.getElementById('roomStatus');
        if (s) s.textContent = 'Accept failed: ' + roomErrorMessage(e);
        return;
    }
    // Apply my own side locally (seller removes qty/adds cash, buyer adds
    // qty/pays) — the counterparty settles via their poll listener.
    if (applyLocalTrade(t, iAmBuyer ? 'buyer' : 'seller')) markTradeApplied(t.id);
    try { navigator.vibrate && navigator.vibrate([10,30,10]); } catch {}
}
async function rejectTrade(tradeId) {
    if (!tradeId) return;
    const ref = doc(db, 'rooms', tradeRoomCode(), 'trades', tradeId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    const t = snap.data();
    if (t.status !== 'pending') return;
    // Only the buyer (cancel) or the seller (decline) can reject — not third parties
    const myUid = auth.currentUser?.uid;
    if (t.sellerUid !== myUid && t.buyerUid !== myUid) return;
    await setDoc(ref, { status: 'rejected', updatedAt: new Date().toISOString() }, { merge: true });
}
function startTradeListener() {
    if (tradeListenerUnsub) { try{tradeListenerUnsub();}catch{} tradeListenerUnsub=null; }
    if (tradeRetryTimer) { clearTimeout(tradeRetryTimer); tradeRetryTimer = null; }
    // Roomless players trade through the shared lobby room, so this always
    // listens — scoped to the current room, or the lobby when outside one.
    // The room filter is load-bearing: without it every room's offers land in
    // this inbox (and Accept would act on foreign trades).
    const tRoom = tradeRoomCode();
    const q = query(collection(db, 'rooms', tRoom, 'trades'), where('roomCode', '==', tRoom));
    tradeListenerUnsub = onSnapshot(q, (snap)=>{
        const trades = [];
        snap.forEach(d=> trades.push({ id:d.id, ...d.data()}));
        // sort recent first
        trades.sort((a,b)=> new Date(b.createdAt||0)-new Date(a.createdAt||0));
        renderTradeInbox(trades);
    }, (e)=> console.error('trade listener', e));
}

async function performCustomBuy() {
    const sellerSel = document.getElementById('customBuySeller');
    const asset = document.getElementById('customBuyAsset')?.value || 'Hay';
    const qty = parseInt(document.getElementById('customBuyQty')?.value || '1', 10);
    const price = Math.round(parseFloat(String(document.getElementById('customBuyPrice')?.value || '0').replace(/,/g, '')) || 0);
    const hint = document.getElementById('customBuyHint');
    const opt = sellerSel?.selectedOptions?.[0];
    const sellerUid = opt?.dataset?.uid || '';
    const sellerName = opt?.dataset?.username || '';
    // re-validate (preview state may be stale)
    updateCustomBuyPreview();
    if (document.getElementById('confirmCustomBuy')?.disabled) return;
    if (!sellerUid) { if (hint){hint.textContent='Seller not found (no UID).'; hint.classList.remove('hidden');} return; }
    if (sellerUid === auth.currentUser?.uid) { if (hint){hint.textContent='Cannot buy from yourself.'; hint.classList.remove('hidden');} return; }
    if (price !== 0 && wouldGoNegativeCash(-price)) { if (hint){hint.textContent='Not enough cash.'; hint.classList.remove('hidden');} return; }
    // Roomless trades go through the shared lobby room (created on demand).
    const tRoom = tradeRoomCode();
    if (!currentRoomCode) {
        try {
            await setDoc(doc(db, 'rooms', LOBBY_ROOM_CODE), {
                room_code: LOBBY_ROOM_CODE,
                createdAt: new Date().toISOString(),
                last_activity_at: new Date().toISOString(),
                status: 'Lobby',
            }, { merge: true });
        } catch {}
    }
    // create pending trade — seller must accept before property/money moves (accurate for both)
    const qtyKey = getAssetQtyKey(asset);
    try {
        const tradeId = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        await setDoc(doc(db, 'rooms', tRoom, 'trades', tradeId), {
            buyerUid: auth.currentUser.uid,
            buyerName: document.getElementById('editableUsername')?.innerText.trim() || 'buyer',
            sellerUid, sellerName, asset: qtyKey, qty, price,
            roomCode: tRoom,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            // Creator stamp: the counterparty accepts. Buy offers are
            // buyer-created (seller accepts); sell offers are seller-created.
            createdBy: auth.currentUser.uid
        });
        hideCustomBuyModal();
        const status = document.getElementById('roomStatus');
        if (status) status.textContent = `Offer sent to ${sellerName}: ${qty} ${asset} for $${price.toLocaleString()} — waiting for accept`;
    } catch (e) {
        console.error('trade create failed', e);
        if (hint){hint.textContent = 'Offer failed: ' + roomErrorMessage(e); hint.classList.remove('hidden');}
        return;
    }
}

// --- Custom Sell — offer your property to another player at a price you set ---
function refreshCustomSellBuyers() {
    const sel = document.getElementById('customSellBuyer');
    if (!sel) return;
    const myUsername = document.getElementById('editableUsername')?.innerText.trim() || '';
    const prev = sel.value;
    sel.innerHTML = '';
    const others = (latestLeaderboardData || []).filter(p => (p.username || '').trim() !== myUsername && p.username !== 'Enter name');
    if (others.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = currentRoomCode ? 'No other players in this room yet' : 'No other players online yet';
        sel.appendChild(opt);
    } else {
        others.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p._id || p.username;
            opt.dataset.uid = p._id || '';
            opt.dataset.username = p.username;
            opt.textContent = `${p.username} (net $${(p.networth||0).toLocaleString()})`;
            sel.appendChild(opt);
        });
    }
    if (prev) {
        const hasPrev = [...sel.options].some(o => o.value === prev);
        if (hasPrev) sel.value = prev;
    }
    updateCustomSellPreview();
}
function updateCustomSellPreview() {
    const preview = document.getElementById('customSellPreview');
    const hint = document.getElementById('customSellHint');
    if (!preview) return;
    const buyerSel = document.getElementById('customSellBuyer');
    const asset = document.getElementById('customSellAsset')?.value || 'Hay';
    const qty = parseInt(document.getElementById('customSellQty')?.value || '1', 10);
    const price = Math.round(parseFloat(String(document.getElementById('customSellPrice')?.value || '0').replace(/,/g, '')) || 0);
    const opt = buyerSel?.selectedOptions?.[0];
    const buyerName = opt?.dataset?.username || opt?.textContent?.split(' (')[0] || 'buyer';
    // Ranch cows: only qty above the ridge-bonus floor can be sold.
    const locked = isRanchCowsAsset(asset) ? ranchBonusFloor() : 0;
    const myQty = myAssetQty(asset);
    const sellable = Math.max(0, myQty - locked);
    preview.innerHTML = `You: ${asset} ${myQty} → ${myQty - qty} after sale` +
        (locked > 0 ? ` (${locked} ridge bonus locked)` : '') +
        `<br>${buyerName} pays $${price.toLocaleString()} for ${qty} × ${asset}`;
    let err = '';
    if (!buyerSel || !buyerSel.value) err = 'Pick a buyer.';
    else if (!Number.isFinite(qty) || qty <= 0) err = 'Quantity must be ≥1.';
    else if (!Number.isFinite(price) || price < 0) err = 'Price must be ≥0.';
    else if (sellable < qty) err = locked > 0
        ? `Only ${sellable} sellable (${locked} ridge bonus locked).`
        : `You only have ${myQty} ${asset}.`;
    if (hint) { hint.textContent = err; hint.classList.toggle('hidden', !err); }
    const confirm = document.getElementById('confirmCustomSell');
    if (confirm) confirm.disabled = !!err;
}
function showCustomSellModal() {
    refreshCustomSellBuyers();
    resetTradePriceToBase('customSellPrice', 'customSellQty', document.getElementById('customSellAsset')?.value || 'Hay');
    updateCustomSellPreview();
    document.getElementById('customSellModal')?.classList.remove('hidden');
}
function hideCustomSellModal() {
    document.getElementById('customSellModal')?.classList.add('hidden');
}
async function performCustomSell() {
    const buyerSel = document.getElementById('customSellBuyer');
    const asset = document.getElementById('customSellAsset')?.value || 'Hay';
    const qty = parseInt(document.getElementById('customSellQty')?.value || '1', 10);
    const price = Math.round(parseFloat(String(document.getElementById('customSellPrice')?.value || '0').replace(/,/g, '')) || 0);
    const hint = document.getElementById('customSellHint');
    const opt = buyerSel?.selectedOptions?.[0];
    const buyerUid = opt?.dataset?.uid || '';
    const buyerName = opt?.dataset?.username || '';
    // re-validate (preview state may be stale)
    updateCustomSellPreview();
    if (document.getElementById('confirmCustomSell')?.disabled) return;
    if (!buyerUid) { if (hint){hint.textContent='Buyer not found (no UID).'; hint.classList.remove('hidden');} return; }
    if (buyerUid === auth.currentUser?.uid) { if (hint){hint.textContent='Cannot sell to yourself.'; hint.classList.remove('hidden');} return; }
    const sellableNow = isRanchCowsAsset(asset) ? sellableRanchCows() : myAssetQty(asset);
    if (sellableNow < qty) { if (hint){hint.textContent=`Only ${sellableNow} sellable ${asset} (ridge bonus can't be sold).`; hint.classList.remove('hidden');} return; }
    // Roomless trades go through the shared lobby room (created on demand).
    const tRoom = tradeRoomCode();
    if (!currentRoomCode) {
        try {
            await setDoc(doc(db, 'rooms', LOBBY_ROOM_CODE), {
                room_code: LOBBY_ROOM_CODE,
                createdAt: new Date().toISOString(),
                last_activity_at: new Date().toISOString(),
                status: 'Lobby',
            }, { merge: true });
        } catch {}
    }
    // create pending trade — buyer must accept before property/money moves
    const qtyKey = getAssetQtyKey(asset);
    try {
        const tradeId = `${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
        await setDoc(doc(db, 'rooms', tRoom, 'trades', tradeId), {
            buyerUid, buyerName,
            sellerUid: auth.currentUser.uid,
            sellerName: document.getElementById('editableUsername')?.innerText.trim() || 'seller',
            asset: qtyKey, qty, price,
            roomCode: tRoom,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: auth.currentUser.uid
        });
        hideCustomSellModal();
        const status = document.getElementById('roomStatus');
        if (status) status.textContent = `Offer sent to ${buyerName}: ${qty} ${asset} for $${price.toLocaleString()} — waiting for accept`;
    } catch (e) {
        console.error('trade create failed', e);
        if (hint){hint.textContent = 'Offer failed: ' + roomErrorMessage(e); hint.classList.remove('hidden');}
        return;
    }
}

// Function to start Firestore real-time listener — room-scoped like imposterirl players by game_id
function startFirestoreListener() {
    if (roomListenerUnsub) { try { roomListenerUnsub(); } catch {} roomListenerUnsub = null; }
    // Room-scoped leaderboard: where(roomCode==current) then client-sort. Avoids composite index need.
    let q;
    if (currentRoomCode) {
        // Stable order (user_id is unique): without it PostgREST returns rows
        // in unspecified order, every poll looks "changed", and the table +
        // chart re-render continuously. Display order is client-sorted below.
        q = query(collection(db, 'leaderboard'), where('roomCode', '==', currentRoomCode), orderBy('user_id'));
    } else {
        q = query(collection(db, 'leaderboard'), orderBy('networth', 'desc'), limit(10));
    }
    roomListenerUnsub = onSnapshot(q, (querySnapshot) => {
        let leaderboardData = [];
        querySnapshot.forEach((docSnap) => {
            const d = docSnap.data();
            d._id = docSnap.id;
            leaderboardData.push(d);
        });
        if (currentRoomCode) {
            leaderboardData.sort((a, b) => (Number(b.networth) || 0) - (Number(a.networth) || 0));
            leaderboardData = leaderboardData.slice(0, 10);
        }
        updateLeaderboardTable(leaderboardData);
        updateProgressChart(leaderboardData);
        refreshPriceCells();
        // keep custom-buy seller list fresh
        if (typeof refreshCustomBuySellers === 'function') refreshCustomBuySellers();
    }, (error) => {
        console.error('Firestore listener error:', error);
    });
    return roomListenerUnsub;
}

// Start the Firestore listener and seed net-worth history once auth is ready
authReady
    .then(() => {
        ensureHistorySeeded();
        startFirestoreListener();
        startTradeListener();
        // Room-doc listener too: fresh loads (?room= link or restored room)
        // otherwise never learn host, rules, or host resets (restartRoomListener
        // only runs on create/join/leave clicks).
        startRoomDocListener();
        // The initial calculation can run before anonymous auth finishes. Try
        // the current state once more so a cold start is not silently lost.
        const username = document.getElementById('editableUsername')?.innerText.trim();
        const totalWorth = getCurrentTotalWorthFromDOM();
        if (username && username !== 'Enter name' && totalWorth !== null) {
            scheduleLeaderboardSave(totalWorth);
        }
    })
    .catch((err) => console.error('Auth wait failed:', err));


function getCurrentTotalWorthFromDOM() {
    const totalWorthCell = document.querySelector('.total-worth');
    if (!totalWorthCell) return null;
    return parseFloat(totalWorthCell.textContent.replace(/,/g, '')) || 0;
}

function commitUsernameEdit() {
    const usernameCell = document.getElementById('editableUsername');
    if (!usernameCell) return;

    const trimmed = usernameCell.innerText.trim();
    if (trimmed === '') {
        usernameCell.innerText = 'Enter name';
        saveQuantitiesToLocalStorage();
        return;
    }

    saveQuantitiesToLocalStorage();

    const totalWorth = getCurrentTotalWorthFromDOM();
    if (totalWorth !== null) scheduleLeaderboardSave(totalWorth);
}


function makeEditableCellsExitOnEnter() {
    const editableElements = document.querySelectorAll('td.editable, span.editable');

    editableElements.forEach((el) => {
        if (el.dataset && el.dataset.exitOnEnterBound === '1') return;
        if (el.dataset) el.dataset.exitOnEnterBound = '1';

        const commit = () => {
            // Qty / other editable cells
            calculateNet();
            populateRollTable();
            saveQuantitiesToLocalStorage();
        };

        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                el.blur();
                commit();
            }
        });

        // "Tap outside" / click away
        el.addEventListener('blur', commit);
    });
}

// This function should be called during initial setup and whenever new editable cells are added
makeEditableCellsExitOnEnter();
//console.log('log working')
function numberWithCommasAndDecimals(x) {
    // Whole dollars only — the game never deals in cents, so no ".00".
    // Name kept so the existing call sites don't change.
    const cleanInput = String(x).replace(/,/g, '');

    const numericValue = parseFloat(cleanInput);
    if (isNaN(numericValue)) {
        return '0';
    }

    return Math.round(numericValue).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Example usage:
//console.log(numberWithCommasAndDecimals('1107.1')); // Should log '1,107'

function populateRollTable() {
    // Define the base monetary values for each roll and item type.
    // Rolls are inverted on purpose: roll 1 pays best, roll 6 pays worst
    // (1<->6, 2<->5, 3<->4), so low dice are the exciting ones.
    const baseValues = {
      Hay: [3000, 2200, 1500, 1000, 600, 400],
      Grain: [7000, 5300, 3800, 2500, 1500, 800],
      Fruit: [17500, 13000, 9000, 6000, 3500, 2000],
      Cows: [7500, 5000, 3800, 2800, 2000, 1400]
    };
    
    // Get the quantities from the contenteditable cells
    // Assuming these cells have an id or a specific class to identify them
    const quantities = {
      Hay: parseInt(document.querySelector('.qty-hay').textContent) || 0,
      Grain: parseInt(document.querySelector('.qty-grain').textContent) || 0,
      Fruit: parseInt(document.querySelector('.qty-fruit').textContent) || 0,
      Cows: (parseInt(document.querySelector('.qty-farm').textContent) || 0) +
        (parseInt(document.querySelector('.qty-cows').textContent) || 0),
      Tractor: parseInt(document.querySelector('.qty-tractor').textContent) || 0,
      Harvester: parseInt(document.querySelector('.qty-harvester').textContent) || 0
    };
  
    // Get all rows in the roll table except the header row
    const rollRows = document.querySelectorAll('.roll-table tr:not(:first-child)');
  
    rollRows.forEach((row, index) => {
      const assetType = row.cells[0].textContent.split(' ')[0]; // Get the asset type (Hay, Grain, etc.) without suffix
      const quantity = quantities[assetType] || 0; // Get the quantity for this asset type

            // Hay tiers + equipment bonuses are host settings (room doc);
            // defaults reproduce today's game (5+ => 1.5x, 10+ => 2x, +20%/unit cap 5).
            const harvestRules = roomHarvest();
            let multiplier = 1;
            if (assetType === 'Hay') {
                if (quantity >= harvestRules.hayHighQty) multiplier = harvestRules.hayHighMult;
                else if (quantity >= harvestRules.hayMidQty) multiplier = harvestRules.hayMidMult;
                multiplier += Math.min(quantities.Tractor, harvestRules.equipCap) * harvestRules.equipRate;
            } else if (assetType === 'Grain') {
                multiplier += Math.min(quantities.Harvester, harvestRules.equipCap) * harvestRules.equipRate;
            }

            // Manual multiplier from tapping
            const state = parseInt(row.cells[0].getAttribute('data-state') || 0);
            let manualMultiplier = 1;
            if (state === 1) manualMultiplier = 0.5;
            else if (state === 2 && (assetType === 'Hay' || assetType === 'Grain')) manualMultiplier = 2;
  
      // Calculate and populate the cells for each roll
      baseValues[assetType].forEach((value, rollIndex) => {
                const profit = quantity * value * multiplier * manualMultiplier; // Calculate the profit
                const payoutCell = row.cells[rollIndex + 1];
                if (!payoutCell) return;

                // Make each payout cell contain a real button so it behaves like a button on mobile.
                let payoutButton = payoutCell.querySelector('button.roll-cell-button');
                if (!payoutButton) {
                        payoutCell.textContent = '';
                        payoutButton = document.createElement('button');
                        payoutButton.type = 'button';
                        payoutButton.className = 'roll-cell-button';
                        payoutCell.appendChild(payoutButton);
                }

                payoutButton.textContent = numberWithCommasAndDecimals(profit); // Populate the button with formatted profit
      });
    });
  }

  
  // Call this function to populate the roll table when the page loads or when quantities update
  populateRollTable();
  
  // Attach an input event listener to each editable quantity cell to update the roll table on change
  document.querySelectorAll('#spreadsheet .editable').forEach(cell => {
    cell.addEventListener('input', populateRollTable);
  });
  // Hand-typed ranch cows snap back to the ridge-bonus floor on blur
  // (clamping mid-keystroke would fight the edit, so wait for blur).
  document.querySelector('.qty-cows')?.addEventListener('blur', () => {
      clampRanchCowsToFloor();
  });

// Call this function to populate the roll table when the page loads or when quantities update
populateRollTable();

// Journal-based undo: every money+qty mutation pushes ONE action entry and
// undo reverses the whole action (all ledger legs + qty/ridge deltas), so a
// buy can never be half-undone into free assets or forgiven debt.
const MAX_UNDO_ACTIONS = 50;

function getBaseState() {
    return {
        game: createGame(),
        qty: {
            Hay: 1,
            Grain: 1,
            Fruit: 0,
            Farm: 0,
            Cows: 0,
            Harvester: 0,
            Tractor: 0
        },
        ranchRidgeBonus: 0,
        ranchRidgeSelections: {
            ahtanum: 0,
            rattlesnake: 0,
            cascades: 0,
            toppenish: 0
        },
        transactions: {
            cash: ['5000'],
            loan: ['5000']
        },
        // Journal-based undo: every money+qty mutation pushes ONE action;
        // undo reverses the whole action (all ledger legs + qty/ridge
        // deltas), never a single leg. Cleared on reset (fresh game).
        actionLog: [],
        username: ''
    };
}

let data = getBaseState();

function normalizeSavedState(savedData) {
    const baseState = getBaseState();
    const saved = savedData && typeof savedData === 'object' ? savedData : {};
    return {
        ...baseState,
        ...saved,
        game: normalizeGame(saved.game, baseState.game.createdAt),
        qty: { ...baseState.qty, ...(saved.qty || {}) },
        transactions: {
            cash: Array.isArray(saved.transactions?.cash)
                ? saved.transactions.cash
                : baseState.transactions.cash,
            loan: Array.isArray(saved.transactions?.loan)
                ? saved.transactions.loan
                : baseState.transactions.loan
        },
        // Undo journal survives reload (capped); drop malformed entries.
        actionLog: Array.isArray(saved.actionLog)
            ? saved.actionLog.filter(a => a && typeof a === 'object').slice(-MAX_UNDO_ACTIONS)
            : [],
        ranchRidgeSelections: normalizeRidgeCounts(saved.ranchRidgeSelections)
    };
}

function updateGameClockDisplay() {
    const display = document.getElementById('gameTimeDisplay');
    if (!display || !data?.game) return;
    const elapsed = roomGameElapsed(Date.now());
    const duration = clampGameDuration(data.game.durationMs);
    display.textContent = `Game time: ${formatGameTime(Math.min(elapsed, duration))} / ${formatGameTime(duration)}`;
    display.title = `Started ${new Date(data.game.createdAt).toLocaleString()}`;
    // Seasons move with the clock: cheap guarded recompute, DOM only on change.
    try { refreshPriceCells(); } catch {}
}

function startGameClock() {
    if (gameClockTimer) clearInterval(gameClockTimer);
    updateGameClockDisplay();
    gameClockTimer = setInterval(updateGameClockDisplay, 1000);
}

// Bonus cows granted per owned ridge. Ridges are repeat-buyable property,
// so ranchRidgeSelections maps key -> owned COUNT (see normalizeRidgeCounts).
const RIDGE_BONUS_BY_KEY = {
    ahtanum: 2,
    rattlesnake: 3,
    cascades: 4,
    toppenish: 5
};

function getRanchRidgeBonusFromSelections(selections) {
    if (!selections) return 0;
    return Object.keys(RIDGE_BONUS_BY_KEY).reduce((sum, key) => {
        const count = Math.max(0, Math.floor(Number(selections[key]) || 0));
        return sum + count * RIDGE_BONUS_BY_KEY[key];
    }, 0);
}

// Ridge bonus cows are earned property, not sellable stock: the ranch-cows
// cell (and every path that lowers it) may never drop below this floor.
// Bonus cows settle last — only qty above the floor can be sold or stepped
// away. `data` may still be seeding on first paint, so default to 0.
function ranchBonusFloor() {
    try {
        return Math.max(0, Math.floor(Number(data.ranchRidgeBonus) || 0));
    } catch { return 0; }
}

function ranchCowsQty() {
    return parseInt(document.querySelector('.qty-cows')?.textContent || '0', 10) || 0;
}

function sellableRanchCows() {
    return Math.max(0, ranchCowsQty() - ranchBonusFloor());
}

// Snap the ranch-cows cell back up to the floor (used after hand-edits and
// legacy loads that predate the floor). No-op when already above it.
function clampRanchCowsToFloor() {
    const cell = document.querySelector('.qty-cows');
    if (!cell) return;
    const floor = ranchBonusFloor();
    if ((parseInt(cell.textContent || '0', 10) || 0) < floor) {
        cell.textContent = String(floor);
        calculateNet();
        populateRollTable();
        saveQuantitiesToLocalStorage();
    }
}

function isRanchCowsAsset(asset) {
    return String(asset || '').toLowerCase() === 'cows';
}

// Ridges are multi-buy property: selections hold OWNED COUNTS, not flags.
// Legacy saves stored booleans (true = owned once) — coerced on load.
function normalizeRidgeCounts(saved) {
    const counts = {};
    Object.keys(RIDGE_BONUS_BY_KEY).forEach((key) => {
        const raw = saved?.[key];
        const n = typeof raw === 'boolean' ? (raw ? 1 : 0) : Math.floor(Number(raw) || 0);
        counts[key] = Math.max(0, n);
    });
    return counts;
}

function updateUpgradedRidgesDisplay() {
    const displayEl = document.getElementById('upgradedRidgesDisplay');
    const ranchCowsQty = parseInt(document.querySelector('.qty-cows')?.textContent || '0', 10) || 0;
    const ridgeBonus = data.ranchRidgeBonus || 0;
    const upgradedRidges = Math.max(0, ranchCowsQty - ridgeBonus);
    if (displayEl) displayEl.textContent = `Ridge Expansions: ${upgradedRidges}`;
    // Owned counts per ridge (ridges are repeat-buyable; the menu is
    // display-only, buying happens through the buy modal).
    document.querySelectorAll('[data-ridge-owned]').forEach((el) => {
        const key = el.getAttribute('data-ridge-owned');
        const n = Math.max(0, Math.floor(Number(data.ranchRidgeSelections?.[key]) || 0));
        el.textContent = `x${n}`;
    });
}

function saveQuantitiesToLocalStorage() {
    // Update quantities from the page
    const cowsCell = document.querySelector('.qty-cows');
    // Never persist ranch cows below the ridge-bonus floor. Don't fight an
    // in-progress hand-edit (blur snaps it back); just save the floor value.
    const cowsQty = Math.max(parseInt(cowsCell?.textContent || '0', 10) || 0, ranchBonusFloor());
    if (cowsCell && document.activeElement !== cowsCell && cowsCell.textContent !== String(cowsQty)) {
        cowsCell.textContent = String(cowsQty);
    }
    data.qty = {
        Hay: parseInt(document.querySelector('.qty-hay').textContent) || 0,
        Grain: parseInt(document.querySelector('.qty-grain').textContent) || 0,
        Fruit: parseInt(document.querySelector('.qty-fruit').textContent) || 0,
        Farm: parseInt(document.querySelector('.qty-farm').textContent) || 0,
        Cows: cowsQty,
        Harvester: parseInt(document.querySelector('.qty-harvester').textContent) || 0,
        Tractor: parseInt(document.querySelector('.qty-tractor').textContent) || 0
    };
    
    const usernameCell = document.getElementById('editableUsername');
    data.username = usernameCell.innerText.trim() === 'Enter name' ? '' : usernameCell.innerText.trim();

    // Ridge ownership only changes through the buy modal (which sets counts
    // and bonus together); recompute here as a consistency guard.
    data.ranchRidgeBonus = getRanchRidgeBonusFromSelections(data.ranchRidgeSelections);

    // Transactions are already maintained in the global data object
    // Don't read from DOM as it only shows 10 entries
    // console.log("Data to be saved:", data);
    // Save the updated data to localStorage
    localStorage.setItem('farmingGameData', JSON.stringify(data));
}

  
function getTransactionData(transactionClass) {
    const transactionCells = document.querySelectorAll(`.${transactionClass}`);
    const transactions = Array.from(transactionCells).map(cell => cell.textContent);
    // Save all transactions - totals need to reflect all entries
    return transactions;
}
 
document.querySelectorAll('.cash-transaction, .loan-transaction').forEach(cell => {
    cell.addEventListener('blur', saveQuantitiesToLocalStorage);
});

function loadFromLocalStorage() {
    const savedData = localStorage.getItem('farmingGameData');
    if (savedData) {
        const loadedData = JSON.parse(savedData);
        // Update the global data object
        data = normalizeSavedState(loadedData);
        // Persist the normalized game metadata so legacy saves keep one stable
        // creation time and game id across both load paths and future reloads.
        localStorage.setItem('farmingGameData', JSON.stringify(data));
        // Apply quantity data to the page
        document.querySelector('.qty-hay').textContent = data.qty.Hay.toString();
        document.querySelector('.qty-grain').textContent = data.qty.Grain.toString();
        document.querySelector('.qty-fruit').textContent = data.qty.Fruit.toString();
        // Ensure you have a .qty-farm and .qty-cows class elements in your HTML
        document.querySelector('.qty-farm').textContent = data.qty.Farm.toString();
        document.querySelector('.qty-cows').textContent = data.qty.Cows.toString();
        document.querySelector('.qty-harvester').textContent = data.qty.Harvester.toString();
        document.querySelector('.qty-tractor').textContent = data.qty.Tractor.toString();

        // Restore ranch ridge selection (do not re-apply bonus; qty already includes it)
        data.ranchRidgeBonus = typeof loadedData.ranchRidgeBonus === 'number'
            ? loadedData.ranchRidgeBonus
            : getRanchRidgeBonusFromSelections(data.ranchRidgeSelections);
        // Pre-floor saves may hold fewer cows than the owned bonus (bonus
        // cows were sellable then). Restore the floor — the bonus is paid
        // property and can never be sold away.
        const floor = ranchBonusFloor();
        if ((Number(data.qty.Cows) || 0) < floor) {
            data.qty.Cows = floor;
            document.querySelector('.qty-cows').textContent = String(floor);
            localStorage.setItem('farmingGameData', JSON.stringify(data));
        }

        // Ridge ownership restores from data; the menu shows owned counts
        // (refreshed by updateUpgradedRidgesDisplay below).
        
        // Update the transaction lists
        updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });
        populateRollTable();
        const usernameCell = document.getElementById('editableUsername');
        usernameCell.innerText = data.username || 'Enter name';
        // Debugging: Log out loaded transaction data
        // console.log("Loaded transactions for cash:", loadedData.transactions.cash);
        // console.log("Loaded transactions for loan:", loadedData.transactions.loan);
        updateTotals();
        calculateNet();
        updateUpgradedRidgesDisplay();
        recordHistoryPoint(getCurrentTotalWorthFromDOM() || 0);
    } else {
        // First run: seed with a default starting state.
        data = getBaseState();
        localStorage.setItem('farmingGameData', JSON.stringify(data));

        document.querySelector('.qty-hay').textContent = data.qty.Hay.toString();
        document.querySelector('.qty-grain').textContent = data.qty.Grain.toString();
        document.querySelector('.qty-fruit').textContent = data.qty.Fruit.toString();
        document.querySelector('.qty-farm').textContent = data.qty.Farm.toString();
        document.querySelector('.qty-cows').textContent = data.qty.Cows.toString();
        document.querySelector('.qty-harvester').textContent = data.qty.Harvester.toString();
        document.querySelector('.qty-tractor').textContent = data.qty.Tractor.toString();

        updateTransactionLists({ cash: data.transactions.cash, loan: data.transactions.loan });

        const usernameCell = document.getElementById('editableUsername');
        usernameCell.innerText = 'Enter name';

        populateRollTable();
        updateTotals();
        calculateNet();
        recordHistoryPoint(getCurrentTotalWorthFromDOM() || 0);
    }
    startGameClock();
}

function updateTransactionLists(transactionsData) {
    const table = document.getElementById('financialTable'); // Ensure this is the correct ID of your table

    // Clear existing transactions except the first row which is for input
    clearTransactionsExceptFirst('cash-transaction');
    clearTransactionsExceptFirst('loan-transaction');

    // Define a function to update a single transaction list
    const updateSingleTransactionList = (transactions, transactionClass) => {
        const safeTransactions = Array.isArray(transactions) ? transactions : [];
        // Limit transactions to last 10
        const limitedTransactions = safeTransactions.slice(0, 10);
        limitedTransactions.forEach((transactionValue, index) => {
            // Table layout in index.html:
            // Row 0 = cash/loan inputs
            // Row 1 = Transaction / Total headers
            // Row 2 = first transaction row
            let row = table.rows[index + 2];
            if (!row) {
                row = table.insertRow();
                createTransactionCell(row, 'cash-transaction', '', false);
                createTransactionCell(row, 'cash-total');
                createTransactionCell(row, 'loan-transaction', '', false);
                createTransactionCell(row, 'loan-total', '', false);
            }

            // Update the cell value for the transaction
            const transactionCell = row.querySelector(`.${transactionClass}`);
            if (transactionCell) {
                // Apply formatting only if the value is not an empty string
                const cellContent = transactionValue === '' ? '' : numberWithCommasAndDecimals(transactionValue);
                transactionCell.textContent = cellContent;
            }
        });
    };

    // Update both cash and loan transactions
    updateSingleTransactionList(transactionsData.cash, 'cash-transaction');
    updateSingleTransactionList(transactionsData.loan, 'loan-transaction');

    // Remove any rows beyond the first 10 transaction rows
    // Row 0 = cash/loan inputs, Row 1 = transaction headers, Row 2 = first transaction
    const maxRows = 12; // 2 header rows + 10 transaction rows
    while (table.rows.length > maxRows) {
        table.deleteRow(table.rows.length - 1);
    }
}

// Make sure to call updateTransactionList whenever you load the data from localStorage
// For example:
loadFromLocalStorage();

// Function to show the modal
function showModal() {
    document.getElementById('resetModal').classList.remove('hidden');
}

// Function to hide the modal
function hideModal() {
    document.getElementById('resetModal').classList.add('hidden');
}

// Function to show the extra rules modal
function showExtraRulesModal() {
    document.getElementById('extraRulesModal').classList.remove('hidden');
}

// Function to hide the extra rules modal
function hideExtraRulesModal() {
    document.getElementById('extraRulesModal').classList.add('hidden');
}

// Pay/gain modal state is declared with the other top-level state (see
// isGainMode / payModeSelection / gainModeSelection above) — see note there.

// Function to update modal title and button text based on mode
function updateModalForMode() {
    const titleElement = document.getElementById('pay-per-acre-title');
    const confirmButton = document.getElementById('confirmPayPerAcre');
    
    if (isGainMode) {
        if (titleElement) titleElement.textContent = 'Gain Per Acre';
        if (confirmButton) confirmButton.textContent = 'Gain';
    } else {
        if (titleElement) titleElement.textContent = 'Pay Per Acre';
        if (confirmButton) confirmButton.textContent = 'Pay';
    }
}

// Function to show the pay per acre modal
function showPayPerAcreModal() {
    document.getElementById('payPerAcreModal').classList.remove('hidden');
    
    // Restore the selection based on current mode
    const selection = isGainMode ? gainModeSelection : payModeSelection;
    
    // Remove selected class from all buttons
    document.querySelectorAll('.pay-acre-button').forEach(btn => btn.classList.remove('selected'));
    
    // Find and select the appropriate button
    const buttonToSelect = document.querySelector(`.pay-acre-button[data-pay-type="${selection.payType}"][data-per-acre="${selection.perAcre}"]`);
    if (buttonToSelect) {
        buttonToSelect.classList.add('selected');
    }
    
    updatePayPerAcreDisplay();
}

// Function to hide the pay per acre modal
function hidePayPerAcreModal() {
    document.getElementById('payPerAcreModal').classList.add('hidden');
}

// Function to show the pay off loan modal
function showPayOffLoanModal() {
    const modal = document.getElementById('payOffLoanModal');
    modal.classList.remove('hidden');
    
    // Update displays
    const currentCash = getCurrentCashTotal();
    const currentLoan = getCurrentLoanTotal();
    const maxPayoff = Math.min(currentCash, currentLoan);
    
    document.getElementById('currentLoanDisplay').textContent = `Current Loan: $${currentLoan.toLocaleString()}`;
    document.getElementById('currentCashDisplay').textContent = `Available Cash: $${currentCash.toLocaleString()}`;
    document.getElementById('maxPayoffDisplay').textContent = `Max Payoff: $${maxPayoff.toLocaleString()}`;
    
    // Set slider to max payoff
    const slider = document.getElementById('loanPayoffSlider');
    if (slider) {
        slider.min = 0;
        slider.max = maxPayoff;
        slider.value = maxPayoff;
        updateLoanPayoffDisplay();
        
        // Add event listener for slider changes
        slider.oninput = updateLoanPayoffDisplay;
    }
}

// Function to update the loan payoff display
function updateLoanPayoffDisplay() {
    const slider = document.getElementById('loanPayoffSlider');
    const display = document.getElementById('loanPayoffAmountDisplay');
    if (slider && display) {
        display.textContent = `$${parseFloat(slider.value).toLocaleString()}`;
    }
}

// Function to hide the pay off loan modal
function hidePayOffLoanModal() {
    document.getElementById('payOffLoanModal').classList.add('hidden');
}

// Function to perform loan payoff
function performPayOffLoan() {
    const slider = document.getElementById('loanPayoffSlider');
    const payoffAmount = parseFloat(slider.value) || 0;
    
    if (payoffAmount <= 0) {
        // alert('Please enter a valid payment amount.');
        return;
    }
    
    const currentCash = getCurrentCashTotal();
    const currentLoan = getCurrentLoanTotal();
    const maxPayoff = Math.min(currentCash, currentLoan);
    
    if (payoffAmount > maxPayoff) {
        // alert(`Maximum payoff is $${maxPayoff.toLocaleString()}. You cannot pay more than your available cash ($${currentCash.toLocaleString()}) or your current loan ($${currentLoan.toLocaleString()}).`);
        return;
    }
    
    // Subtract from both cash and loan
    const payoffCashBefore = ledgerLen('cash');
    const payoffLoanBefore = ledgerLen('loan');
    addCashTransactionValue(-payoffAmount);
    addLoanTransactionValue(-payoffAmount);
    pushUndoAction({
        label: `Pay off loan $${payoffAmount.toLocaleString()}`,
        cash: ledgerLen('cash') - payoffCashBefore,
        loan: ledgerLen('loan') - payoffLoanBefore
    });
    
    // Update button states
    updateActionButtonStates();
}

// Event listener for the reset button — host-aware (imposterirl style: host controls reset)
document.getElementById('resetButton').addEventListener('click', (e) => {
    const title = document.getElementById('modal-title');
    const desc = document.querySelector('#resetModal .text-sm.text-gray-500');
    if (currentRoomCode && isHost) {
        if (title) title.textContent = `Reset Room ${currentRoomCode}?`;
        if (desc) desc.textContent = 'Host will clear this room\'s leaderboard, trades, and start a fresh game for everyone in the room.';
    } else if (currentRoomCode && !isHost) {
        if (title) title.textContent = 'Reset My Game?';
        if (desc) desc.textContent = 'You are not host — this will only reset your own farm.';
    } else {
        if (title) title.textContent = 'Reset Game';
        if (desc) desc.textContent = "It's pretty obvious what this button does. You don't really need to read about it.";
    }
    showModal();
});

// Event listener for the extra rules button
document.getElementById('extraRulesButton').addEventListener('click', showExtraRulesModal);

// Event listener for the confirm reset button in the modal — host resets room, others reset self (imposterirl style)
document.getElementById('confirmReset').addEventListener('click', async (event) => {
    event.preventDefault();
    if (currentRoomCode && isHost) await resetRoomForHost();
    else await performReset();
    hideModal();
});

// Event listener for the cancel button in the modal
document.getElementById('cancelReset').addEventListener('click', (event) => {
    event.preventDefault();
    hideModal();
});

// Event listener for the close extra rules button
document.getElementById('closeExtraRules').addEventListener('click', (event) => {
    event.preventDefault();
    hideExtraRulesModal();
});

// Event listener for the pay per acre button
document.getElementById('payPerAcreBtn').addEventListener('click', (event) => {
    event.preventDefault();
    isGainMode = false;
    updateModalForMode();
    showPayPerAcreModal();
});

// Short on cash button (cell, left of Pay Per Acre): cash covers it → open
// the pay modal; cash short → borrow the total + $1,000 extra and pay it.
document.getElementById('shortOnCashBtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    const total = currentPayPerAcreTotal();
    if (!(total > 0)) return;
    updateTotals();
    if (getCurrentCashTotal() >= total) {
        isGainMode = false;
        updateModalForMode();
        showPayPerAcreModal();
    } else {
        borrowForExpense(total, 'Per-acre pay');
    }
});

// Event listener for the gain per acre button
document.getElementById('gainPerAcreBtn').addEventListener('click', (event) => {
    event.preventDefault();
    isGainMode = true;
    updateModalForMode();
    showPayPerAcreModal();
});

// Event listener for the confirm pay per acre button
document.getElementById('confirmPayPerAcre').addEventListener('click', (event) => {
    event.preventDefault();
    performPayPerAcre();
    hidePayPerAcreModal();
});

// Event listener for the borrow-for-expense button (pay mode, cash short:
// borrows the expense plus $1,000 extra, pays, closes on success)
document.getElementById('borrowPayPerAcreBtn')?.addEventListener('click', (event) => {
    event.preventDefault();
    const selectedButton = document.querySelector('.pay-acre-button.selected');
    if (!selectedButton || isGainMode) return;
    const totalPayment = (getAcresForType(selectedButton.getAttribute('data-pay-type')) || 0)
        * (parseFloat(selectedButton.getAttribute('data-per-acre')) || 0);
    if (borrowForExpense(totalPayment, 'Per-acre pay')) hidePayPerAcreModal();
});

// Event listener for the cancel pay per acre button
document.getElementById('cancelPayPerAcre').addEventListener('click', (event) => {
    event.preventDefault();
    hidePayPerAcreModal();
});

// Event listener for the pay off loan button
document.getElementById('payOffLoanBtn').addEventListener('click', (event) => {
    event.preventDefault();
    showPayOffLoanModal();
});

// Event listener for the confirm pay off loan button
document.getElementById('confirmPayOffLoan').addEventListener('click', (event) => {
    event.preventDefault();
    performPayOffLoan();
    hidePayOffLoanModal();
});

// Event listener for the cancel pay off loan button
document.getElementById('cancelPayOffLoan').addEventListener('click', (event) => {
    event.preventDefault();
    hidePayOffLoanModal();
});

function updatePayPerAcreDisplay() {
    const selectedButton = document.querySelector('.pay-acre-button.selected');
    if (!selectedButton) {
        const acresDisplay = document.getElementById('acresDisplay');
        const paymentDisplay = document.getElementById('paymentDisplay');
        if (acresDisplay) acresDisplay.textContent = 'Acres: 0';
        if (paymentDisplay) paymentDisplay.textContent = 'Total Payment: $0';
        return;
    }
    
    const payType = selectedButton.getAttribute('data-pay-type');
    const perAcreValue = parseFloat(selectedButton.getAttribute('data-per-acre'));
    
    const acres = getAcresForType(payType);
    const totalPayment = acres * perAcreValue;
    
    const acresDisplay = document.getElementById('acresDisplay');
    const paymentDisplay = document.getElementById('paymentDisplay');
    
    if (acresDisplay) {
        acresDisplay.textContent = `Acres: ${acres.toLocaleString()}`;
    }
    if (paymentDisplay) {
        paymentDisplay.textContent = `Total Payment: $${totalPayment.toLocaleString()}`;
    }

    // Short on cash in pay mode? Offer the borrow button: full expense plus
    // $1,000 extra on the loan. Hidden in gain mode and when cash covers.
    const borrowBtn = document.getElementById('borrowPayPerAcreBtn');
    const borrowHint = document.getElementById('borrowPayPerAcreHint');
    if (borrowBtn) {
        updateTotals();
        const loan = totalPayment + EXPENSE_LOAN_EXTRA;
        const show = !isGainMode && totalPayment > 0 && getCurrentCashTotal() < totalPayment;
        borrowBtn.classList.toggle('hidden', !show);
        borrowBtn.classList.toggle('inline-flex', show);
        if (borrowHint) borrowHint.classList.toggle('hidden', true);
        if (show) {
            const capOk = getCurrentLoanTotal() + loan <= debtCap();
            borrowBtn.textContent = `Borrow $${totalPayment.toLocaleString()} + $1,000 extra (loan $${loan.toLocaleString()})`;
            setButtonDisabled(borrowBtn, !capOk);
            if (borrowHint) {
                borrowHint.textContent = capOk
                    ? 'Pays the expense now; you keep $1,000 cash.'
                    : `Debt cap $${debtCap().toLocaleString()} blocks this loan.`;
                borrowHint.classList.toggle('hidden', false);
            }
        }
    }
}

// Add event listeners to pay per acre buttons
document.querySelectorAll('.pay-acre-button').forEach(button => {
    button.addEventListener('click', function() {
        // Remove selected class from all buttons
        document.querySelectorAll('.pay-acre-button').forEach(btn => btn.classList.remove('selected'));
        // Add selected class to clicked button
        this.classList.add('selected');
        
        // Store the selection based on current mode
        const payType = this.getAttribute('data-pay-type');
        const perAcre = this.getAttribute('data-per-acre');
        if (isGainMode) {
            gainModeSelection = { payType, perAcre };
        } else {
            payModeSelection = { payType, perAcre };
        }
        
        // Update display
        updatePayPerAcreDisplay();
    });
});

function getAcresForType(type) {
    if (type === 'total') {
        return getTotalAcres();
    } else if (type === 'hay') {
        const qty = parseFloat(document.querySelector('.qty-hay').textContent) || 0;
        return qty * 10;
    } else if (type === 'grain') {
        const qty = parseFloat(document.querySelector('.qty-grain').textContent) || 0;
        return qty * 10;
    } else if (type === 'fruit') {
        const qty = parseFloat(document.querySelector('.qty-fruit').textContent) || 0;
        return qty * 5;
    }
    return 0;
}

function getTotalAcres() {
    let totalAcres = 0;
    // Hay, grain, fruit
    document.querySelectorAll('tr[data-acres-per-unit]').forEach(row => {
        const acresPerUnit = parseFloat(row.getAttribute('data-acres-per-unit')) || 0;
        const qtyCell = row.querySelector('.qty-cell span.editable');
        if (!qtyCell) return;
        const qtyRaw = qtyCell.textContent.replace(/,/g, '').trim();
        const qty = parseFloat(qtyRaw) || 0;
        totalAcres += qty * acresPerUnit;
    });
    return totalAcres;
}

function performPayPerAcre() {
    const selectedButton = document.querySelector('.pay-acre-button.selected');
    if (!selectedButton) {
        // alert('Please select a payment option.');
        return;
    }
    
    const payType = selectedButton.getAttribute('data-pay-type');
    const perAcreValue = parseFloat(selectedButton.getAttribute('data-per-acre'));
    
    const acres = getAcresForType(payType);
    const totalPayment = acres * perAcreValue;
    
    if (totalPayment <= 0) {
        // alert('No acres to process.');
        return;
    }
    
    const currentCash = getCurrentCashTotal();
    const acreCashBefore = ledgerLen('cash');
    if (isGainMode) {
        // For gain mode, just add the amount
        addCashTransactionValue(totalPayment);
        pushUndoAction({
            label: `Per-acre gain $${totalPayment.toLocaleString()}`,
            cash: ledgerLen('cash') - acreCashBefore,
            loan: 0
        });
    } else {
        // For pay mode, check if we have enough cash
        if (currentCash < totalPayment) {
            // alert(
            //     'Insufficient cash to pay. You need $' +
            //         totalPayment.toLocaleString() +
            //         ' but only have $' +
            //         currentCash.toLocaleString() +
            //         '.'
            // );
            return;
        }
        // Pay the amount
        addCashTransactionValue(-totalPayment);
        pushUndoAction({
            label: `Per-acre pay $${totalPayment.toLocaleString()}`,
            cash: ledgerLen('cash') - acreCashBefore,
            loan: 0
        });
    }
    
    // Update button states after transaction
    updateActionButtonStates();
}

// Current pay-mode total from the stored selection (what the modal opens
// with), so the cell button can act without opening the modal.
function currentPayPerAcreTotal() {
    const perAcre = parseFloat(payModeSelection.perAcre) || 0;
    return (getAcresForType(payModeSelection.payType) || 0) * perAcre;
}
// Net effect: +$1,000 cash, +(expense + $1,000) loan. Blocked by the debt
// cap. One undoable action covering every leg (constant declared with the
// other top-level state — see note there).
function borrowForExpense(expense, label) {
    const amount = Math.round(Number(expense) || 0);
    if (!(amount > 0)) return false;
    updateTotals();
    const loan = amount + EXPENSE_LOAN_EXTRA;
    if (getCurrentLoanTotal() + loan > debtCap()) return false;
    const cashBefore = ledgerLen('cash');
    const loanBefore = ledgerLen('loan');
    addLoanTransactionValue(loan);
    addCashTransactionValue(loan);
    addCashTransactionValue(-amount);
    pushUndoAction({
        label: `${label} $${amount.toLocaleString()} — borrowed $${loan.toLocaleString()}`,
        cash: ledgerLen('cash') - cashBefore,
        loan: ledgerLen('loan') - loanBefore
    });
    updateActionButtonStates();
    return true;
}

async function resetRoomForHost() {
    if (!currentRoomCode || !isHost) {
        document.getElementById('roomStatus').textContent = 'Only host can reset the room';
        return;
    }
    try {
        await authReady;
        invalidatePendingLeaderboardSaves();
        const resetWrite = leaderboardWriteQueue.then(async () => {
            // delete only this room's leaderboard entries + trades subcollection
            const qSnap = await getDocs(query(collection(db, 'leaderboard'), where('roomCode', '==', currentRoomCode)));
            const dels = [];
            qSnap.forEach(d => dels.push(deleteDoc(d.ref)));
            await Promise.all(dels);
            try {
                const tradesSnap = await getDocs(collection(db, 'rooms', currentRoomCode, 'trades'));
                const tDels = [];
                tradesSnap.forEach(d => tDels.push(deleteDoc(d.ref)));
                await Promise.all(tDels);
            } catch {}
        });
        leaderboardWriteQueue = resetWrite.catch((err)=>{ console.error('Error resetting room',err); return undefined; });
        await resetWrite;
        invalidatePendingLeaderboardSaves();
        // signal other clients to reset their local game too — mirror imposterirl resetGameForNewRound via room doc
        const resetAt = new Date().toISOString();
        await setDoc(doc(db, 'rooms', currentRoomCode), { lastHostResetAt: resetAt, last_activity_at: resetAt }, { merge: true });
        try { localStorage.setItem('lastSeenHostResetAt_'+currentRoomCode, resetAt); } catch {}
        // local host reset too
        await performReset({ keepRoom: true });
        document.getElementById('roomStatus').textContent = `Room ${currentRoomCode} reset by host`;
        hideModal();
    } catch (err) { console.error('Error resetting room', err); }
}

async function resetLeaderboardForAllPlayers() {
    try {
        await authReady;
        invalidatePendingLeaderboardSaves();

        // Put the delete behind the same queue as leaderboard writes. This
        // prevents a save from recreating a document while the reset is still
        // deleting it, and makes later saves run after the reset completes.
        const resetWrite = leaderboardWriteQueue.then(async () => {
            const querySnapshot = await getDocs(collection(db, 'leaderboard'));
            const deletePromises = [];
            querySnapshot.forEach((leaderboardDoc) => {
                deletePromises.push(deleteDoc(leaderboardDoc.ref));
            });
            await Promise.all(deletePromises);
        });
        leaderboardWriteQueue = resetWrite.catch((err) => {
            console.error('Error resetting leaderboard: ', err);
            return undefined;
        });
        await resetWrite;
        // Discard saves assembled while the delete was in flight. They carry
        // the old game's metadata and must not recreate the just-cleared data.
        invalidatePendingLeaderboardSaves();
        // A successful global reset starts a fresh local game clock as well.
        // Keep the player's current board values, but do not carry history or
        // the previous game's elapsed-time origin into the new leaderboard.
        data.game = createGame();
        resetHistoryCacheForNewGame();
        saveQuantitiesToLocalStorage();
        startGameClock();
        const username = document.getElementById('editableUsername')?.innerText.trim();
        const totalWorth = getCurrentTotalWorthFromDOM();
        if (username && username !== 'Enter name' && totalWorth !== null) {
            scheduleLeaderboardSave(totalWorth);
        }
        console.log('Leaderboard reset for all players');
        hideModal();
    } catch (err) {
        console.error('Error resetting leaderboard: ', err);
    }
}

// Clicking the "Reset Game" title inside the modal follows the same rule as
// Confirm: host resets the room, everyone else resets only themselves. It must
// never wipe the global board (one misclick used to clear every room).
async function resetFromModalTitle(e) {
    if (e) e.preventDefault();
    if (currentRoomCode && isHost) await resetRoomForHost();
    else await performReset();
    hideModal();
}
const resetModalTitle = document.getElementById('modal-title');
if (resetModalTitle) {
    resetModalTitle.addEventListener('click', resetFromModalTitle);
    resetModalTitle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            resetFromModalTitle(e);
        }
    });
}

async function performReset(opts = {}) {
    hideModal();
    invalidatePendingLeaderboardSaves();
    
    const baseState = getBaseState();
    // keep room association if host reset signaled (imposterirl style: resetGameForNewRound keeps room_code)
    if (opts.keepRoom && currentRoomCode) {
        // host room code stays, game id will be fresh via createGame()
    }

    // Update the data object
    data = baseState;
    resetHistoryCacheForNewGame();
    manualInterestOverride = null;

    // Reset quantity fields to the base state
    document.querySelector('.qty-hay').textContent = '1';
    document.querySelector('.qty-grain').textContent = '1';
    document.querySelector('.qty-fruit').textContent = '0';
    document.querySelector('.qty-farm').textContent = '0';
    document.querySelector('.qty-cows').textContent = '0';
    document.querySelector('.qty-harvester').textContent = '0';
    document.querySelector('.qty-tractor').textContent = '0';

    data.ranchRidgeBonus = 0;
    data.ranchRidgeSelections = getBaseState().ranchRidgeSelections;

    const ranchRidgeMenu = document.getElementById('ranchRidgeMenu');
    const ranchRidgeButton = document.getElementById('ranchRidgeButton');
    if (ranchRidgeMenu) ranchRidgeMenu.classList.add('hidden');
    if (ranchRidgeButton) ranchRidgeButton.setAttribute('aria-expanded', 'false');

    // Clear transaction fields
    document.querySelectorAll('.cash-transaction, .loan-transaction').forEach(cell => {
        cell.textContent = '';
    });

    // Remove all rows except the first one for transactions
    clearTransactionsExceptFirst('cash-transaction');
    clearTransactionsExceptFirst('loan-transaction');

    // Set initial transaction values
    const firstCashCell = document.querySelector('.cash-transaction');
    const firstLoanCell = document.querySelector('.loan-transaction');
    if (firstCashCell) firstCashCell.textContent = '5000';
    if (firstLoanCell) firstLoanCell.textContent = '5000';

    // Note: Game reset should NOT wipe the global leaderboard.
    // After resetting local state, the normal net worth save flow will update only this player's entry.
    
    // Save the reset state to localStorage
    localStorage.setItem('farmingGameData', JSON.stringify(baseState));

    // Update totals and other calculations
    updateTotals(); // Updates all totals
    calculateNet();
    // updateNetCash();
    // Repopulate the roll table
    populateRollTable();
    recordHistoryPoint(getCurrentTotalWorthFromDOM() || 0);
    startGameClock();
}

async function resetForRoomStart() {
    // On direct URL joins, wait until persisted per-device data has loaded
    // before replacing it with the identical fresh-game baseline.
    if (document.readyState === 'loading') {
        await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
    }
    await performReset({ keepRoom: true });
}


function clearTransactionsExceptFirst(transactionClass) {
    const table = document.getElementById('financialTable'); // Use the correct ID for your table
    // Avoid relying on the CSS :has() selector (not supported in all browsers).
    const rows = Array.from(table.rows).filter(row => row.querySelector(`.${transactionClass}`));
    
    // Remove all rows except the first one with transaction class
    rows.forEach((row, index) => {
        if (index > 0) {
            row.remove();
        } else {
            // Clear the content of the first row's cells
            const cells = row.querySelectorAll(`.${transactionClass}`);
            cells.forEach(cell => {
                cell.textContent = '';
                // Transaction cells are no longer editable
            });
        }
    });
}

// document.getElementById('resetButton').addEventListener('click', resetData); 

document.querySelectorAll('.editable').forEach(cell => {
    cell.addEventListener('input', saveQuantitiesToLocalStorage);
});

// Load data when the document is fully loaded
document.addEventListener('DOMContentLoaded', loadFromLocalStorage);


const editableUsernameEl = document.getElementById('editableUsername');
if (editableUsernameEl && editableUsernameEl.dataset.usernameHandlersBound !== '1') {
        editableUsernameEl.dataset.usernameHandlersBound = '1';

        editableUsernameEl.addEventListener('focus', function() {
                const defaultText = 'Enter name';
                if (this.innerText === defaultText) {
                        window.getSelection().selectAllChildren(this);
                }
        });

        editableUsernameEl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                        e.preventDefault();
                        editableUsernameEl.blur();
                        commitUsernameEdit();
                }
        });

        editableUsernameEl.addEventListener('blur', commitUsernameEdit);
}

window.addEventListener('DOMContentLoaded', (event) => {
    // Ensure transaction cells are not editable
    document.querySelectorAll('.cash-transaction, .loan-transaction').forEach(cell => {
        cell.contentEditable = 'false';
    });
    
    // Attach event listeners to quantity cells
    const qtyCells = document.querySelectorAll('#spreadsheet .editable');
    qtyCells.forEach(cell => {
        cell.addEventListener('input', calculateNet);
    });
    document.querySelectorAll('#spreadsheet .editable').forEach(cell => {
        cell.addEventListener('input', calculateNet);
        cell.addEventListener('input', populateRollTable);
    });

    calculateNet(); // Initial calculation on page load
    updateUpgradedRidgesDisplay();
    wireManualInterestCell();
    //console.log(document.getElementById('cashInput'));
    makeEditableCellsExitOnEnter();
    const cashUndoCell = document.getElementById('cashUndoCell');
    if (cashUndoCell) {
        cashUndoCell.addEventListener('click', undoLastAction);
    }    const loanUndoCell = document.getElementById('loanUndoCell');
    if (loanUndoCell) {
        loanUndoCell.addEventListener('click', undoLastAction);
    }
    const cashInput = document.getElementById('cashInput');
    if (cashInput) {
        const quickTxButtons = document.querySelectorAll('[data-quick-transaction-value]');
        quickTxButtons.forEach((btn) => {
            btn.addEventListener('click', () => {
                const rawValue = btn.getAttribute('data-quick-transaction-value');
                if (!rawValue) return;
                cashInput.value = rawValue;
                handleTransaction('cashInput', 'cash-transaction', 'cash-total');
            });
        });

        // Make roll table payout buttons clickable to add as cash transactions.
        // Use event delegation so it keeps working even if buttons are created later.
        const rollTable = document.querySelector('.roll-table');
        if (rollTable && rollTable.dataset.rollClickBound !== '1') {
            rollTable.dataset.rollClickBound = '1';
            rollTable.addEventListener('click', (e) => {
                let btn = e.target;
                
                // Check if the clicked element is a button or inside a button
                if (btn.tagName !== 'BUTTON') {
                    btn = btn.closest('button.roll-cell-button');
                }
                
                if (!btn || !btn.classList.contains('roll-cell-button')) {
                    return;
                }

                // Debug logging to trace roll button clicks
                console.log('Roll button clicked');

                const text = (btn.textContent || '').trim();
                if (!text) return;

                const numericText = text.replace(/,/g, '');
                const value = parseFloat(numericText);
                if (!Number.isFinite(value)) {
                    console.warn('Roll button value not finite', { text, numericText });
                    return;
                }

                // Sandbox preview blocks confirm(), so just add automatically.
                const rollCashBefore = ledgerLen('cash');
                addCashTransactionValue(value);
                pushUndoAction({
                    label: `Roll payout $${value.toLocaleString()}`,
                    cash: ledgerLen('cash') - rollCashBefore,
                    loan: 0
                });
                console.log(`Roll payout ${text} added to cash transactions`);
            });
        }

        cashInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                //console.log('Enter pressed on cashInput');
                handleTransaction('cashInput', 'cash-transaction', 'cash-total');
                cashInput.blur();
                e.preventDefault();
            }
        });
        cashInput.addEventListener('blur', () => {
            if (cashInput.value.trim() !== '') {
                handleTransaction('cashInput', 'cash-transaction', 'cash-total');
            }
        });
    }

    const loanInput = document.getElementById('loanInput');
    if (loanInput) {
        loanInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                handleTransaction('loanInput', 'loan-transaction', 'loan-total');
                loanInput.blur();
                e.preventDefault();
            }
        });
        loanInput.addEventListener('blur', () => {
            if (loanInput.value.trim() !== '') {
                handleTransaction('loanInput', 'loan-transaction', 'loan-total');
            }
        });
    }
    // Phone keypads have no minus key: the +/- buttons flip the sign of the
    // cash/loan inputs so negative transactions can be entered on mobile.
    document.querySelectorAll('.sign-toggle').forEach((toggle) => {
        toggle.addEventListener('click', () => {
            const target = document.getElementById(toggle.getAttribute('data-target'));
            if (!target) return;
            const raw = target.value.trim();
            target.value = raw.startsWith('-') ? raw.slice(1) : (raw ? '-' + raw : '-');
            target.focus();
        });
    });
    // Transaction cells are no longer editable
    // const transactionCells = document.querySelectorAll('.cash-transaction, .loan-transaction');
    // transactionCells.forEach(makeCellEditable);

    const payInterestBtn = document.getElementById('payInterestBtn');
    if (payInterestBtn) {
        payInterestBtn.addEventListener('click', (event) => {
            event.preventDefault();
            // Ensure all data is in sync
            updateTotals();

            const interest = getCurrentInterestValue();
            if (!(interest > 0)) {
                // A pinned $0 is a real state with an exit: paying clears it
                // and resumes auto. Otherwise say exactly why it is $0.
                if (manualInterestOverride != null) {
                    manualInterestOverride = null;
                    updateInterest();
                    updateActionButtonStates();
                    sayStatus(`Custom interest cleared — auto interest $${getCurrentInterestValue().toLocaleString()} (loan $${getCurrentLoanTotal().toLocaleString()} × ${roomEcon().interestPct}%).`);
                } else {
                    sayStatus(`No interest due — loan $${getCurrentLoanTotal().toLocaleString()} × ${roomEcon().interestPct}% = $0. Host sets Interest % in Room Settings.`);
                }
                return;
            }

            const currentCash = getCurrentCashTotal();
            if (currentCash < interest) {
                sayStatus(`Short $${(interest - currentCash).toLocaleString()} for interest — cash $${currentCash.toLocaleString()} vs $${interest.toLocaleString()} due. Use Borrow.`);
                updateActionButtonStates();
                return;
            }

            // Pay the interest
            const interestCashBefore = ledgerLen('cash');
            addCashTransactionValue(-interest);
            // A typed-in amount is spent — snap back to auto calc.
            manualInterestOverride = null;
            updateInterest();
            pushUndoAction({
                label: `Pay interest $${interest.toLocaleString()}`,
                cash: ledgerLen('cash') - interestCashBefore,
                loan: 0
            });
            
            // Update button states after payment
            updateActionButtonStates();
        });
    }

    // Borrow-for-expense button (shown instead of Pay Interest when cash is
    // short: borrows the interest plus $1,000 extra, then pays it).
    document.getElementById('borrowInterestBtn')?.addEventListener('click', (event) => {
        event.preventDefault();
        updateTotals();
        const interest = getCurrentInterestValue();
        const loan = interest + EXPENSE_LOAN_EXTRA;
        if (!(interest > 0)) {
            if (manualInterestOverride != null) {
                manualInterestOverride = null;
                updateInterest();
                updateActionButtonStates();
                sayStatus(`Custom interest cleared — auto interest $${getCurrentInterestValue().toLocaleString()} (loan $${getCurrentLoanTotal().toLocaleString()} × ${roomEcon().interestPct}%).`);
            } else {
                sayStatus(`No interest due — loan $${getCurrentLoanTotal().toLocaleString()} × ${roomEcon().interestPct}% = $0. Host sets Interest % in Room Settings.`);
            }
            return;
        }
        if (getCurrentLoanTotal() + loan > debtCap()) {
            sayStatus(`Debt cap $${debtCap().toLocaleString()} blocks the $${loan.toLocaleString()} loan — pay down debt or ask the host to raise the cap.`);
            updateActionButtonStates();
            return;
        }
        if (borrowForExpense(interest, 'Pay interest')) {
            // Borrowed+p paid — snap back to auto calc on the new loan total.
            manualInterestOverride = null;
            updateTotals();
        }
    });

    // Add event listeners for quantity +/- buttons
    document.querySelectorAll('.qty-btn').forEach(button => {
        button.addEventListener('click', function() {
            const targetClass = this.getAttribute('data-target');
            const qtyCell = document.querySelector(`.${targetClass}`);
            if (qtyCell) {
                let currentQty = parseInt(qtyCell.textContent) || 0;
                if (this.classList.contains('qty-plus')) {
                    currentQty++;
                } else if (this.classList.contains('qty-minus')) {
                    // Ranch cows stop at the ridge-bonus floor (bonus cows
                    // aren't sellable/steppable stock); everything else at 0.
                    const floor = targetClass === 'qty-cows' ? ranchBonusFloor() : 0;
                    currentQty = Math.max(floor, currentQty - 1);
                }
                qtyCell.textContent = currentQty;
                calculateNet();
                populateRollTable();
                saveQuantitiesToLocalStorage();
            }
        });
    });

    // Add event listeners for roll table asset taps
    const rollTable = document.querySelector('.roll-table');
    const assetTds = rollTable.querySelectorAll('tr:not(:first-child) td:first-child');
    assetTds.forEach(td => {
        td.addEventListener('click', () => {
            const asset = td.textContent.split(' ')[0];
            let state = parseInt(td.getAttribute('data-state') || 0);
            if (asset === 'Fruit' || asset === 'Cows') {
                state = (state + 1) % 2; // Only 0 and 1
            } else {
                state = (state + 1) % 3; // 0, 1, 2
            }
            td.setAttribute('data-state', state);
            updateAssetDisplay(td, state);
            populateRollTable();
        });
    });

    function updateAssetDisplay(td, state) {
        const asset = td.textContent.split(' ')[0]; // Get base asset name
        if (state === 0) {
            td.textContent = asset;
            td.style.color = '';
            td.style.backgroundColor = '';
        } else if (state === 1) {
            td.textContent = asset + ' x1/2';
            td.style.color = 'red';
            td.style.backgroundColor = '';
        } else if (state === 2 && (asset === 'Hay' || asset === 'Grain')) {
            td.textContent = asset + ' x2';
            td.style.color = 'green';
            td.style.backgroundColor = '';
        }
    }

    // Add event listeners for buy buttons
    document.querySelectorAll('.buy-btn[data-asset]').forEach(button => {
        button.addEventListener('click', function() {
            const asset = this.getAttribute('data-asset');
            const row = this.closest('tr');
            const qtyCell = row.cells[2]; // Qty column
            const costCell = row.cells[3]; // Cost column
            const qtyValueEl = qtyCell.querySelector('span.editable');
            const costRaw = ((costCell.querySelector('.cost-price') || costCell).textContent || '').replace(/,/g, '').trim();
            const cost = parseFloat(costRaw) || 0;
            const totalCost = cost; // Always buy 1
            if (totalCost <= 0) {
                // alert('Cost is invalid.');
                return;
            }

            // Show modal
            showBuyModal(asset, cost, totalCost);
        });
    });

    // Modal event listeners
    const buyModal = document.getElementById('buyModal');
    const downPaymentSlider = document.getElementById('downPaymentSlider');
    const confirmBuy = document.getElementById('confirmBuy');
    const cancelBuy = document.getElementById('cancelBuy');

    let currentAsset, currentCost, currentTotalCost, currentQtyValueEl, currentBaseCost;
    let lastDownPaymentPercent = 20; // Remember last setting
    let lastDownPaymentAmount = 0; // Remember last dollar amount
    let minValidDownPayment = 0;

    // Recompute slider bounds from the CURRENT total cost. The down payment
    // may draw on cash plus unused debt room (the shortfall is borrowed
    // automatically at confirm), so a buyer with cash + borrowing power
    // always gets the full range instead of a collapsed single price.
    // Disables Confirm when even maximum debt makes the purchase impossible.
    function refreshDownPaymentSlider() {
        updateTotals();
        const bounds = getBuyBounds(currentTotalCost);
        const currentLoanTotal = getCurrentLoanTotal();

        minValidDownPayment = bounds.min;

        downPaymentSlider.step = 100;
        downPaymentSlider.min = bounds.min;
        downPaymentSlider.max = bounds.max;
        if (!bounds.feasible) {
            // Unreachable minimum: collapse the range; Confirm stays disabled below
            downPaymentSlider.min = downPaymentSlider.max;
        }

        document.getElementById('minDownPayment').textContent = Number(downPaymentSlider.min).toLocaleString();
        document.getElementById('maxDownPayment').textContent = Number(downPaymentSlider.max).toLocaleString();

        const minVal = parseInt(downPaymentSlider.min);
        const maxVal = parseInt(downPaymentSlider.max);
        const desired = Number.isFinite(lastDownPaymentAmount) ? lastDownPaymentAmount : minVal;
        let chosen = Math.min(Math.max(desired, minVal), maxVal);
        chosen = Math.round(chosen / 100) * 100;
        chosen = Math.min(chosen, maxVal); // re-clamp: rounding can overshoot a non-round max
        downPaymentSlider.value = chosen;

        const shortfall = Math.max(0, chosen - bounds.cash);
        const loanOk = currentLoanTotal + Math.round(currentTotalCost - chosen) + shortfall <= debtCap();
        setButtonDisabled(confirmBuy, !(bounds.feasible && loanOk));

        const hint = document.getElementById('buyCashHint');
        if (hint) {
            const errorClasses = ['text-red-600'];
            const infoClasses = ['text-yellow-700'];
            if (bounds.feasible && loanOk) {
                if (shortfall > 0) {
                    hint.textContent = `Includes $${shortfall.toLocaleString()} borrowed for the down payment`;
                    hint.classList.remove(...errorClasses);
                    hint.classList.add(...infoClasses);
                    hint.classList.remove('hidden');
                } else {
                    hint.classList.add('hidden');
                }
            } else if (!bounds.feasible) {
                hint.textContent = `Not affordable: $${bounds.min.toLocaleString()} down needed, $${bounds.max.toLocaleString()} available`;
                hint.classList.remove(...infoClasses);
                hint.classList.add(...errorClasses);
                hint.classList.remove('hidden');
            } else {
                hint.textContent = `Loan would exceed the $${debtCap().toLocaleString()} debt limit`;
                hint.classList.remove(...infoClasses);
                hint.classList.add(...errorClasses);
                hint.classList.remove('hidden');
            }
        }

        updateModalAmounts(parseInt(downPaymentSlider.value));
    }

    function showBuyModal(asset, cost, totalCost) {
        currentAsset = asset;
        currentBaseCost = cost; // Base cost
        currentCost = cost;
        currentTotalCost = totalCost;

        // Find the qty span for this asset
        const qtySpan = document.querySelector(`.qty-${asset}`);
        currentQtyValueEl = qtySpan;

        document.getElementById('modalTitle').textContent = `Buy ${asset.charAt(0).toUpperCase() + asset.slice(1)}`;

        // Bulk tiers: benchmark-unlocked increments off the live board max
        // (any one player crossing a benchmark unlocks it for everyone).
        purchaseMult = 1;
        rebuildBulkSelect(asset);

        // Show ridge select for Ranch Cows
        const ridgeDiv = document.getElementById('ridgeSelectDiv');
        const ridgeSelect = document.getElementById('ridgeSelect');
        if (asset === 'cows') {
            ridgeDiv.classList.remove('hidden');
            ridgeSelect.value = 'ahtanum'; // Default to the first named ridge
        } else {
            ridgeDiv.classList.add('hidden');
        }
        // Price at 1x, then step down from the selected mult until the debt
        // room covers it (probes the already-scaled cost each step so a
        // lower mult is never overcharged).
        stepBulkToFeasible();
        buyModal.classList.remove('hidden');
    }

    // (Re)build the quantity select for the unlocked tier and hint line.
    function rebuildBulkSelect(asset) {
        const sel = document.getElementById('purchaseMult');
        const hint = document.getElementById('bulkHint');
        const worth = boardMaxNetWorth(marketBoard());
        const tier = bulkMult(worth, asset);
        sel.innerHTML = '';
        for (let m = 1; m <= tier; m++) {
            const opt = document.createElement('option');
            opt.value = String(m);
            opt.textContent = m === 1 ? 'Single (1x)' : `${m}x bulk`;
            sel.appendChild(opt);
        }
        sel.value = '1';
        if (hint) {
            if (tier <= 1) {
                const first = bulkNext(worth, asset);
                hint.textContent = first
                    ? `Bulk buys unlock at $${first.min.toLocaleString()} net worth (${first.mult}x).`
                    : 'Bulk buys unlock with room net-worth benchmarks.';
            } else {
                const next = bulkNext(worth, asset);
                hint.textContent = next
                    ? `Unlocked ${tier}x — next: ${next.mult}x at $${next.min.toLocaleString()}.`
                    : `Max bulk unlocked (${tier}x).`;
            }
        }
    }

    // Drop the selected multiplier until cash + debt room covers the
    // already-scaled total. Never raises — only affordability steps down.
    function stepBulkToFeasible() {
        const sel = document.getElementById('purchaseMult');
        updateModalCosts();
        while (purchaseMult > 1 && !getBuyBounds(currentTotalCost).feasible) {
            purchaseMult--;
            if (sel) sel.value = String(purchaseMult);
            updateModalCosts();
        }
    }

    function updateRidgeCost(multiplier = 1) {
        const ridgeSelect = document.getElementById('ridgeSelect');
        const selectedRidge = ridgeSelect.value;
        // Named ridges grant their bonus per unit bought, and are
        // repeat-buyable: each purchase adds more of the same ridge.
        const perUnitBonus = RIDGE_BONUS_BY_KEY[selectedRidge] || 0;
        if (!(perUnitBonus > 0)) return; // unknown selection — price nothing
        // Cost = bonus * 10000 * multiplier, with the rubberband rule applied
        // (it prices everything; seasons/estate leave ridges alone).
        const unitBase = perUnitBonus * 10000;
        const unit = computeMarketPrice(unitBase, 'cows', currentMarketCtx('cows')).price;
        const ridgeCost = unit * multiplier;
        currentCost = ridgeCost;
        currentTotalCost = ridgeCost;
        const ridgeName = ridgeSelect.options[ridgeSelect.selectedIndex]?.text || selectedRidge;
        document.getElementById('assetInfo').textContent = `Buying ${multiplier}x ${ridgeName} at $${unit.toLocaleString()} each.` + marketNote('cows');
        document.getElementById('totalCost').textContent = ridgeCost.toLocaleString();

        refreshDownPaymentSlider();
    }

    // Add event listener for ridge select
    document.getElementById('ridgeSelect').addEventListener('change', () => {
        stepBulkToFeasible();
    });

    // Bulk quantity select: reprice at the chosen mult, stepping down while
    // the debt room can't cover it.
    document.getElementById('purchaseMult').addEventListener('change', function() {
        purchaseMult = Math.max(1, parseInt(this.value, 10) || 1);
        stepBulkToFeasible();
    });

    function updateModalCosts() {
        if (currentAsset === 'cows') {
            updateRidgeCost(purchaseMult);
        } else {
            currentTotalCost = currentBaseCost * purchaseMult;
            document.getElementById('assetInfo').textContent = `Buying ${purchaseMult} ${currentAsset} at $${currentBaseCost.toLocaleString()} each.` + marketNote(currentAsset);
            document.getElementById('totalCost').textContent = currentTotalCost.toLocaleString();

            refreshDownPaymentSlider();
        }
    }

    function updateModalAmounts(downPaymentAmount) {
        const downPayment = downPaymentAmount;
        const loanAmount = Math.round(currentTotalCost - downPayment);
        document.getElementById('downPaymentAmount').textContent = downPayment.toLocaleString();
        document.getElementById('downPaymentSummary').textContent = downPayment.toLocaleString();
        document.getElementById('loanAmount').textContent = loanAmount.toLocaleString();

        // Calculate after purchase (a down-payment shortfall is borrowed,
        // so cash never drops below $0 even when debt funds part of it)
        updateTotals();
        const currentCash = getCurrentCashTotal();
        const currentLoan = getCurrentLoanTotal();
        const shortfall = Math.max(0, downPayment - currentCash);
        const cashAfter = currentCash - downPayment + shortfall;
        const loanAfter = currentLoan + loanAmount + shortfall;
        document.getElementById('cashAfter').textContent = cashAfter.toLocaleString();
        document.getElementById('loanAfter').textContent = loanAfter.toLocaleString();
    }

    downPaymentSlider.addEventListener('input', function() {
        const downPaymentAmount = parseInt(this.value);
        updateModalAmounts(downPaymentAmount);
    });

    confirmBuy.addEventListener('click', function() {
        const downPayment = parseInt(downPaymentSlider.value);
        lastDownPaymentAmount = downPayment; // Remember for next time
        const loanAmount = Math.round(currentTotalCost - downPayment);

        // Cash covers the down payment, borrowing the shortfall automatically
        // when debt room allows (the slider only offers feasible choices).
        updateTotals();
        const currentCash = getCurrentCashTotal();
        const shortfall = Math.max(0, downPayment - currentCash);
        const currentLoanTotal = getCurrentLoanTotal();

        // Check if loan would exceed the debt limit (remainder + borrowed down payment)
        if (currentLoanTotal + loanAmount + shortfall > debtCap()) {
            // alert('Loan would exceed the debt limit. Current debt: $' + currentLoanTotal.toLocaleString() + ', Additional loan: $' + loanAmount.toLocaleString() + '.');
            return;
        }

        // Borrowing covers the shortfall first, so this can never fail, but
        // keep the guard as a backstop against stale totals.
        if (currentCash < downPayment - shortfall) {
            showCashFloorWarning(downPayment);
            return;
        }

        // Validate cows/ridge selection BEFORE moving any money so a failed
        // check can never deduct cash/loan without a purchase.
        let qtyIncrease = 1;
        let ridgeMsg = '';
        let pendingRidgeSelection = null;
        let pendingRidgeCount = 0;

        if (currentAsset === 'cows') {
            const ridgeSelect = document.getElementById('ridgeSelect');
            const selectedRidge = ridgeSelect.value;
            // Ridges are repeat-buyable property: each purchase adds more of
            // the same ridge (and its bonus cows), charged per unit.
            // qtyIncrease is single-unit here; the shared multiplier below
            // scales it for bulk, matching currentTotalCost.
            const perUnitBonus = RIDGE_BONUS_BY_KEY[selectedRidge] || 0;
            if (!(perUnitBonus > 0)) return;
            qtyIncrease = perUnitBonus;
            ridgeMsg = ` (${ridgeSelect.options[ridgeSelect.selectedIndex].text} x${purchaseMult})`;
            pendingRidgeSelection = selectedRidge;
            pendingRidgeCount = purchaseMult;
        }

        qtyIncrease *= purchaseMult;

        // All checks passed — now move the money and apply the purchase.
        // The borrowed shortfall lands first so the down payment can never
        // trip the cash floor; net effect: buyer spends all available cash
        // and debts the rest.
        const buyCashBefore = ledgerLen('cash');
        const buyLoanBefore = ledgerLen('loan');
        if (shortfall > 0) {
            addCashTransactionValue(shortfall);
            addLoanTransactionValue(shortfall);
        }
        // Add cash transaction (negative for payment). The full down payment
        // leaves cash — the shortfall was borrowed on top first, so this
        // nets to spending all available cash and debting the rest.
        // (Paying only downPayment - shortfall would hand the buyer the
        // borrowed shortfall as free cash and disagree with the preview.)
        addCashTransactionValue(-downPayment);
        // Add loan transaction (positive for loan)
        addLoanTransactionValue(loanAmount);
        // One undoable action: every ledger leg plus the qty/ridge gains, so
        // undo can never refund the money while keeping the asset.
        pushUndoAction({
            label: `Buy ${qtyIncrease} ${currentAsset}${ridgeMsg} $${currentTotalCost.toLocaleString()}`,
            cash: ledgerLen('cash') - buyCashBefore,
            loan: ledgerLen('loan') - buyLoanBefore,
            qty: { targetClass: `qty-${currentAsset}`, delta: qtyIncrease },
            ridge: pendingRidgeSelection !== null
                ? { key: pendingRidgeSelection, count: pendingRidgeCount }
                : null
        });

        if (pendingRidgeSelection !== null) {
            const counts = normalizeRidgeCounts(data.ranchRidgeSelections);
            counts[pendingRidgeSelection] = (counts[pendingRidgeSelection] || 0) + pendingRidgeCount;
            data.ranchRidgeSelections = counts;
            data.ranchRidgeBonus = getRanchRidgeBonusFromSelections(counts);
        }

        let currentQty = parseInt(currentQtyValueEl.textContent) || 0;
        currentQty += qtyIncrease;
        currentQtyValueEl.textContent = currentQty;

        calculateNet();
        populateRollTable();
        saveQuantitiesToLocalStorage();

        // alert(`Purchased ${qtyIncrease} ${currentAsset}${ridgeMsg} for $${currentTotalCost.toLocaleString()}. Down payment: $${downPayment.toLocaleString()}, Loan: $${loanAmount.toLocaleString()}`);
        buyModal.classList.add('hidden');
    });

    cancelBuy.addEventListener('click', function() {
        buyModal.classList.add('hidden');
    });

    const ranchRidgeButton = document.getElementById('ranchRidgeButton');
    const ranchRidgeMenu = document.getElementById('ranchRidgeMenu');

    function setRanchRidgeMenuOpen(isOpen) {
        if (!ranchRidgeMenu || !ranchRidgeButton) return;
        ranchRidgeMenu.classList.toggle('hidden', !isOpen);
        ranchRidgeButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    }

    if (ranchRidgeButton && ranchRidgeMenu) {
        ranchRidgeButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const isOpen = !ranchRidgeMenu.classList.contains('hidden');
            setRanchRidgeMenuOpen(!isOpen);
        });

        document.addEventListener('click', (e) => {
            if (!ranchRidgeMenu.classList.contains('hidden')) {
                const clickedInside = ranchRidgeMenu.contains(e.target) || ranchRidgeButton.contains(e.target);
                if (!clickedInside) setRanchRidgeMenuOpen(false);
            }
        });
    }

    // NOTE: the ridge menu is display-only (owned counts). Ridge ownership
    // changes exclusively through the buy modal (with payment), so there is
    // intentionally no toggle handler here — the old checkbox handler let
    // anyone grant themselves bonus cows for free.

    // Initial total calculation
    updateTotals();
    // If you have a loanInput similar to cashInput, initialize it here as well.
});
