// Farming Game backend adapter — PostgREST (Supabase-style) edition.
//
// Same function names as the Firebase modular surface scripts.js used, so the
// game code is unchanged apart from its import block. Identity is a local
// UUID (like imposterirl's localStorage player id) — no login, no console,
// nothing an AI can't mint with one line. Live updates are delivered by
// short polling (2.5s), the same as imposterirl's realtime fallback.
//
// Point the game at a backend with (first wins):
//   localStorage 'fgBackendUrl' (explicit per-device choice, e.g. localhost
//   for dev), window.FG_BACKEND_URL (baked default in index.html),
//   default localhost.

function resolveBackendUrl() {
    try {
        if (typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem('fgBackendUrl');
            if (stored) return stored;
        }
    } catch {}
    try {
        if (typeof window !== 'undefined' && window.FG_BACKEND_URL) return window.FG_BACKEND_URL;
    } catch {}
    return 'http://localhost:3002';
}

const BACKEND_URL = resolveBackendUrl();

// Firestore camelCase <-> Postgres snake_case. The game only ever sees the
// camelCase side, so its code is untouched.
const COLUMN_MAP = {
    rooms: {
        room_code: 'room_code', status: 'status',
        hostUid: 'host_uid', hostName: 'host_name',
        createdAt: 'created_at', updatedAt: 'updated_at',
        last_activity_at: 'last_activity_at',
        lastHostResetAt: 'last_host_reset_at',
        rules: 'rules'
    },
    leaderboard: {
        username: 'username', networth: 'networth', debt: 'debt', cash: 'cash',
        hay: 'hay', grain: 'grain', fruit: 'fruit', cows: 'cows', farm: 'farm',
        harvester: 'harvester', tractor: 'tractor', history: 'history',
        gameId: 'game_id', gameCreatedAt: 'game_created_at',
        gameDurationMs: 'game_duration_ms', roomCode: 'room_code',
        updatedAt: 'updated_at'
    },
    trades: {
        roomCode: 'room_code',
        buyerUid: 'buyer_uid', buyerName: 'buyer_name',
        sellerUid: 'seller_uid', sellerName: 'seller_name',
        asset: 'asset', qty: 'qty', price: 'price', status: 'status',
        createdAt: 'created_at', updatedAt: 'updated_at',
        createdBy: 'created_by'
    }
};
const REVERSE_MAP = {};
for (const [table, map] of Object.entries(COLUMN_MAP)) {
    REVERSE_MAP[table] = {};
    for (const [jsKey, sqlCol] of Object.entries(map)) {
        REVERSE_MAP[table][sqlCol] = jsKey;
    }
}

function tableFor(path) {
    if (path[0] === 'rooms' && path.length === 1) return { table: 'rooms', pk: 'room_code' };
    if (path[0] === 'leaderboard' && path.length === 1) return { table: 'leaderboard', pk: 'user_id' };
    if (path[0] === 'rooms' && path.length === 3 && path[2] === 'trades') {
        return { table: 'trades', pk: 'id' };
    }
    throw new Error(`backend: unsupported path ${path.join('/')}`);
}

function serializeValue(value) {
    if (value instanceof Date) return value.toISOString();
    return value;
}

function toRow(table, id, data) {
    const map = COLUMN_MAP[table];
    const row = {};
    for (const [key, value] of Object.entries(data || {})) {
        const col = map[key] || key;
        row[col] = serializeValue(value);
    }
    const pk = tableForPk(table);
    if (id !== null && id !== undefined) row[pk] = id;
    return row;
}

function tableForPk(table) {
    return table === 'rooms' ? 'room_code' : table === 'leaderboard' ? 'user_id' : 'id';
}

function fromRow(table, row) {
    const rev = REVERSE_MAP[table];
    const out = {};
    for (const [col, value] of Object.entries(row || {})) {
        out[rev[col] || col] = value;
    }
    return out;
}

function sqlCol(table, jsField) {
    return (COLUMN_MAP[table] && COLUMN_MAP[table][jsField]) || jsField;
}

async function rest(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${BACKEND_URL}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`backend ${method} ${path} -> ${res.status} ${text}`.slice(0, 300));
        err.status = res.status;
        if (res.status === 404 || res.status === 403) err.code = res.status === 403 ? 'permission-denied' : 'not-found';
        throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// --- App / auth (mirrors the Firebase calls scripts.js makes) ---

export function initializeApp(_config) {
    return { __backend: BACKEND_URL };
}

export function getFirestore(_app) {
    return { __backend: BACKEND_URL };
}

let _uid = null;
function myUid() {
    if (_uid) return _uid;
    try {
        _uid = localStorage.getItem('fgUid');
        if (!_uid) {
            _uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
                ? crypto.randomUUID()
                : `uid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem('fgUid', _uid);
        }
    } catch {
        _uid = `anon-${Math.random().toString(36).slice(2)}`;
    }
    return _uid;
}

const _auth = {
    get currentUser() {
        return { uid: myUid() };
    }
};

export function getAuth(_app) {
    return _auth;
}

export async function signInAnonymously(_authObj) {
    return { user: _auth.currentUser };
}

export function onAuthStateChanged(_authObj, cb) {
    queueMicrotask(() => {
        try {
            cb(_auth.currentUser);
        } catch {}
    });
    return () => {};
}

// --- Refs / queries (same builder names as the Firebase SDK) ---

export function collection(_db, ...path) {
    const { table, pk } = tableFor(path);
    return { kind: 'collection', table, pk, path };
}

export function doc(_db, ...path) {
    const id = path[path.length - 1];
    const { table, pk } = tableFor(path.slice(0, -1));
    return { kind: 'doc', table, pk, id, path };
}

export function where(field, op, value) {
    if (op !== '==') throw new Error(`backend: only '==' filters are supported (got ${op})`);
    return { kind: 'where', field, value };
}

export function orderBy(field, dir = 'asc') {
    return { kind: 'orderBy', field, dir: String(dir).toLowerCase() === 'desc' ? 'desc' : 'asc' };
}

export function limit(n) {
    return { kind: 'limit', n };
}

export function query(colRef, ...constraints) {
    if (!colRef || colRef.kind !== 'collection') throw new Error('backend: query() needs a collection first');
    return { kind: 'query', table: colRef.table, pk: colRef.pk, constraints };
}

function queryParams(target) {
    const params = [];
    const table = target.table;
    const constraints = target.kind === 'query' ? target.constraints : [];
    for (const c of constraints) {
        if (c.kind === 'where') {
            params.push(`${sqlCol(table, c.field)}=eq.${encodeURIComponent(serializeValue(c.value))}`);
        } else if (c.kind === 'orderBy') {
            params.push(`order=${sqlCol(table, c.field)}.${c.dir}`);
        } else if (c.kind === 'limit') {
            params.push(`limit=${Number(c.n) || 10}`);
        }
    }
    return params.length ? `?${params.join('&')}` : '';
}

function wrapDoc(table, pk, id, row) {
    const ref = { kind: 'doc', table, pk, id, path: null };
    return {
        id,
        ref,
        exists: () => row !== null && row !== undefined,
        data: () => (row ? fromRow(table, row) : undefined)
    };
}

function wrapQuerySnapshot(table, rows) {
    const docs = (rows || []).map((row) => {
        const pk = tableForPk(table);
        return wrapDoc(table, pk, row[pk], row);
    });
    return {
        docs,
        get empty() {
            return docs.length === 0;
        },
        get size() {
            return docs.length;
        },
        forEach(cb) {
            docs.forEach(cb);
        }
    };
}

// --- Reads / writes ---

export async function getDoc(ref) {
    const rows = await rest(`/${ref.table}?${ref.pk}=eq.${encodeURIComponent(ref.id)}&limit=1`);
    const row = Array.isArray(rows) && rows.length ? rows[0] : null;
    return wrapDoc(ref.table, ref.pk, ref.id, row);
}

export async function getDocs(target) {
    if (!target || (target.kind !== 'collection' && target.kind !== 'query')) {
        throw new Error('backend: getDocs() needs a collection or query');
    }
    const rows = await rest(`/${target.table}${queryParams(target)}`);
    return wrapQuerySnapshot(target.table, Array.isArray(rows) ? rows : []);
}

export async function setDoc(ref, data, _options) {
    const row = toRow(ref.table, ref.id, data);
    const idParam = `${ref.pk}=eq.${encodeURIComponent(ref.id)}`;
    // PATCH first: PostgREST upsert (POST + merge-duplicates) cannot write a
    // partial row — it takes the INSERT path and dies on NOT NULL columns the
    // payload omits (trades.room_code). PATCH updates in place; only a true
    // miss (empty representation) falls through to POST.
    const patched = await rest(`/${ref.table}?${idParam}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: row
    });
    if (Array.isArray(patched) && patched.length > 0) return;
    try {
        await rest(`/${ref.table}?on_conflict=${ref.pk}`, {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: row
        });
    } catch (e) {
        if (e && e.status === 409) {
            // Lost a create race: the row exists now, converge with one PATCH.
            await rest(`/${ref.table}?${idParam}`, { method: 'PATCH', body: row });
            return;
        }
        throw e;
    }
}

export async function deleteDoc(ref) {
    await rest(`/${ref.table}?${ref.pk}=eq.${encodeURIComponent(ref.id)}`, { method: 'DELETE' });
}

// Live updates via short polling (same role as imposterirl's realtime
// fallback). The callback fires immediately, then only when the payload
// actually changes, so render loops and claim-write loops stay quiet.
const POLL_MS = 2500;

export function onSnapshot(target, next, onError) {
    let stopped = false;
    let timer = null;
    let lastJson = null;
    const fetchOnce = async (initial) => {
        if (stopped) return;
        try {
            let snap;
            if (target.kind === 'doc') {
                snap = await getDoc(target);
            } else {
                snap = await getDocs(target);
            }
            const fingerprint = target.kind === 'doc'
                ? JSON.stringify(snap.exists() ? snap.data() : null)
                : JSON.stringify(snap.docs.map((d) => d.data()));
            if (initial || fingerprint !== lastJson) {
                lastJson = fingerprint;
                next(snap);
            }
        } catch (e) {
            if (typeof onError === 'function') {
                try {
                    onError(e);
                } catch {}
            }
        }
        if (!stopped) timer = setTimeout(() => fetchOnce(false), POLL_MS);
    };
    fetchOnce(true);
    return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
    };
}
