/**
 * RGS OCP Dashboard - Multi-level Drill-down
 * Level 0: Clusters overview (table)
 * Level 1: Cluster drill-down (flat env table + cluster nodes)
 * Level 2: Env detail (pod/node/ingress tables)
 * Alt:     Environments overview table (Grafana-style)
 */

const S = {
    clusters: [],
    drops: [],
    clusterNodes: [],
    envTableData: [],
    quickLinks: {},
    threshold: 95.0,
    currentView: 'env-table',
    currentCluster: null,
    currentDrop: null,
    currentEnv: null,
    envData: null,
    podSortBy: 'name',
    podSortDir: 'asc',
    podSearch: '',
    podColFilters: {},
    nodeSortBy: 'name',
    nodeSortDir: 'asc',
    nodeSearch: '',
    nodeColFilters: {},
    ingressColFilters: {},
    ingressSort: { col: 'name', dir: 'asc' },
    filters: {
        clusterSearch: '',
        clusterColFilters: {},
        clusterSort: { col: 'short_name', dir: 'asc' },
        dropEnvSearch: '',
        clusterEnvSort: { col: 'name', dir: 'asc' },
        clusterEnvColFilters: {},
    },
    envTableSort: { col: 'name', dir: 'asc' },
    envTableColFilters: {},
    expandedEnvs: new Set(), // legacy; kept for savePrefs compat
    sectionCollapsed: { nodes: false, pods: true, ingress: false },
    // user preferences (persisted)
    prefs: {
        showVersions: false,    // toggle for pv_* columns in env overview
        density: 'comfortable', // 'comfortable' | 'compact'
    },
    // Cloud provider filter: 'ocp' or 'aws'. Filters clusters and env-table views.
    provider: 'all',     // 'all' | 'ocp' | 'aws' — drives the unified fleet filter
    fleetFilter: 'all',  // kept in sync with provider; used by sub-renders
    // URLs page sub-tab when provider==='all' and both clouds are present
    urlsCloudTab: 'ocp', // 'ocp' | 'aws'
    // URLs page: set of cluster_ids whose service row is expanded
    urlsSelectedCluster: null,
    urlsSelectedEnv: null,
    urlsExpandedOcpClusters: null, // Set — initialised lazily in _renderUrlsOcpLayout
};

// ------------------------------------------------------------------
// Persistence: filters / sort / user prefs in localStorage.
// Safe to call at any time; errors (quota, disabled) are swallowed.
// ------------------------------------------------------------------
const _PERSIST_KEY = 'ocp-dash:state';
function savePrefs() {
    try {
        const snapshot = {
            prefs: S.prefs,
            filters: S.filters,
            envTableSort: S.envTableSort,
            envTableColFilters: S.envTableColFilters,
            expandedEnvs: Array.from(S.expandedEnvs),
            sectionCollapsed: S.sectionCollapsed,
            provider: S.provider,
        };
        localStorage.setItem(_PERSIST_KEY, JSON.stringify(snapshot));
    } catch (e) { /* ignore */ }
}
function loadPrefs() {
    try {
        const raw = localStorage.getItem(_PERSIST_KEY); if (!raw) return;
        const snap = JSON.parse(raw) || {};
        if (snap.prefs)            Object.assign(S.prefs, snap.prefs);
        if (snap.filters)          Object.assign(S.filters, snap.filters);
        if (snap.envTableSort)     S.envTableSort = snap.envTableSort;
        if (snap.envTableColFilters) S.envTableColFilters = snap.envTableColFilters;
        if (Array.isArray(snap.expandedEnvs)) S.expandedEnvs = new Set(snap.expandedEnvs);
        if (snap.sectionCollapsed) Object.assign(S.sectionCollapsed, snap.sectionCollapsed);
        if (snap.provider === 'ocp' || snap.provider === 'aws') S.provider = snap.provider;
    } catch (e) { /* ignore */ }
}

// ---- Cloud provider switching (OCP / AWS EKS) ----
const PROVIDER_META = {
    all: { label: 'Rogers Multi-Cloud Dashboard',  subtitle: 'OCP + AWS Clusters', short: 'Fleet' },
    ocp: { label: 'OpenShift',    subtitle: 'OpenShift Container Platform', short: 'OCP' },
    aws: { label: 'AWS EKS',      subtitle: 'Amazon Elastic Kubernetes Service', short: 'EKS' },
};

function _applyProviderUI(p) {
    const meta = PROVIDER_META[p] || PROVIDER_META.ocp;
    document.querySelectorAll('.provider-btn').forEach(b => {
        const active = b.dataset.provider === p;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const header = document.querySelector('.header');
    if (header) header.setAttribute('data-provider', p);
    document.querySelectorAll('.brand-logo-svg').forEach(svg => {
        svg.classList.toggle('active', svg.id === `logo-${p}`);
    });
    const sub = document.getElementById('header-subtitle');
    if (sub) sub.textContent = meta.subtitle;
    _refreshClusterBadge();
}

function _refreshClusterBadge() {
    const label = document.getElementById('cluster-badge-label');
    if (!label) return;
    const meta = PROVIDER_META[S.provider] || PROVIDER_META.ocp;
    const count = (S.clusters || []).filter(_clusterMatchesProvider).length;
    // "All" view has no meaningful per-provider word, so omit it ("5 clusters"
    // instead of the awkward "5 Fleet clusters"). OCP/EKS keep their label.
    const desc = S.provider === 'all' ? '' : `${meta.short} `;
    if (count > 0) {
        label.textContent = `${count} ${desc}cluster${count === 1 ? '' : 's'}`;
    } else {
        label.textContent = `No ${desc}clusters`;
    }
}

function setProvider(p) {
    if (p !== 'ocp' && p !== 'aws' && p !== 'all') return;
    if (S.provider === p) return;
    S.provider = p;
    S.fleetFilter = p;
    // Auto-select matching URLs sub-tab when switching to a specific cloud
    if (p === 'ocp') S.urlsCloudTab = 'ocp';
    else if (p === 'aws') S.urlsCloudTab = 'aws';
    else S.urlsCloudTab = 'ocp'; // default to OCP when switching back to All
    _applyProviderUI(p);
    savePrefs();
    try { render(); } catch (_) { /* ignore */ }
}

function _clusterMatchesProvider(c) {
    if (S.provider === 'all' || !S.provider) return true;
    const p = (c.cloud || 'ocp').toLowerCase();
    return p === S.provider;
}

function _envMatchesProvider(e) {
    if (S.provider === 'all' || !S.provider) return true;
    const p = (e.cloud || 'ocp').toLowerCase();
    return p === S.provider;
}

function markRefresh() { /* no-op: data freshness is shown by reloading the page */ }

// ---- Skeleton loaders (replace boring spinners with shimmer placeholders) ----
function _skeletonTable(label) {
    const rows = Array.from({length: 8}, () => `
        <div class="skeleton-row">
            <div class="skeleton" style="width:140px"></div>
            <div class="skeleton" style="width:180px"></div>
            <div class="skeleton" style="width:80px"></div>
            <div class="skeleton" style="width:100px"></div>
            <div class="skeleton" style="width:160px"></div>
            <div class="skeleton" style="width:90px"></div>
            <div class="skeleton" style="width:120px"></div>
            <div class="skeleton" style="width:120px"></div>
        </div>`).join('');
    return `<div class="loading-screen">
        <div class="skeleton-card">
            <div class="skeleton" style="width:200px;height:16px;margin-bottom:14px"></div>
            ${rows}
        </div>
        <p style="text-align:center;color:var(--text-muted);font-size:12px;margin-top:8px">${label}…</p>
    </div>`;
}
function _skeletonEnvDetail(name) {
    const card = (h, w) => `<div class="skeleton-card"><div class="skeleton" style="width:${w};height:${h}"></div></div>`;
    return `<div class="loading-screen">
        ${card('22px', '320px')}
        ${card('80px', '100%')}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:16px">
            ${Array.from({length:6}, ()=>`<div class="skeleton-card"><div class="skeleton" style="width:60%;height:14px;margin-bottom:10px"></div><div class="skeleton" style="width:40%;height:24px"></div></div>`).join('')}
        </div>
        ${card('220px', '100%')}
        <p style="text-align:center;color:var(--text-muted);font-size:12px;margin-top:8px">Loading ${name}…</p>
    </div>`;
}

// ---- Helpers ----
const $ = id => document.getElementById(id);
const _debounceTimers = {};
function debounced(key, fn, delay = 200) { clearTimeout(_debounceTimers[key]); _debounceTimers[key] = setTimeout(fn, delay); }
const fmt = d => { if (!d) return 'N/A'; try { return new Date(d).toLocaleString('en-US', {month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch { return d; } };
function usageBar(pct) {
    let lv = 'low'; if (pct>80) lv='critical'; else if (pct>60) lv='high'; else if (pct>40) lv='medium';
    const c = lv==='low'?'green':lv==='medium'?'yellow':lv==='high'?'orange':'red';
    return `<div class="usage-bar"><div class="usage-bar-track"><div class="usage-bar-fill ${lv}" style="width:${pct}%"></div></div><span class="usage-bar-label" style="color:var(--accent-${c})">${pct}%</span></div>`;
}
function badge(text, cls) { return `<span class="status-badge ${cls}">${text}</span>`; }

// Compact sanity chip: replaces the old 80px bar. Returns a color-coded pill
// (dot + percentage) that fits in ~55–70px. Accepts the raw sanity value
// (e.g. "93.96%" or "N/A") and its numeric counterpart. When the env row
// includes passed/total counts the tooltip shows them too.
function sanityChip(rawLabel, pv, passed, total) {
    if (rawLabel === 'N/A' || rawLabel === undefined || rawLabel === null) {
        return '<span class="sanity-chip none" title="No sanity data">N/A</span>';
    }
    const n = Number(pv) || 0;
    const lvl = n >= 95 ? 'pass' : n >= 80 ? 'ok' : n >= 60 ? 'warn' : 'fail';
    const display = (typeof rawLabel === 'string' && rawLabel.includes('%')) ? rawLabel : `${n}%`;
    let tip = `Sanity ${display}`;
    if (passed !== undefined && total !== undefined && String(total) !== '' && String(total) !== '0') {
        tip += ` (${passed}/${total} passed)`;
    }
    return `<span class="sanity-chip ${lvl}" title="${tip}"><span class="sanity-dot"></span>${display}</span>`;
}

// ============================================================
// Column RESIZE (generic, persisted in localStorage)
// ------------------------------------------------------------
// Usage pattern for any table that wants resizable columns:
//   1. Columns array entries get an optional numeric `width` (default hint).
//   2. <table> gets `class="... resizable-table"` and `data-colw-key="<id>"`.
//   3. <th> gets `data-col-key="<col.key>"` plus `resizableThStyle(key,col)`
//      applied inline AND a trailing `colResizerHtml()` handle.
//   4. After rendering, the handle wires itself via onmousedown.
// Widths persist per-browser via localStorage (keyed by table id).
// ============================================================
const _COL_RESIZE_MIN = 40;
function _colWidthsKey(tableKey) { return `ocp-dash:colw:${tableKey}`; }
function loadColWidths(tableKey) {
    try { return JSON.parse(localStorage.getItem(_colWidthsKey(tableKey)) || '{}') || {}; } catch (e) { return {}; }
}
function saveColWidths(tableKey, widths) {
    try { localStorage.setItem(_colWidthsKey(tableKey), JSON.stringify(widths)); } catch (e) { /* quota / disabled */ }
}
function resolvedColWidth(tableKey, col) {
    const saved = loadColWidths(tableKey);
    const w = Number(saved[col.key]);
    if (w && w >= _COL_RESIZE_MIN) return w;
    return Number(col.width) || 120;
}
function resizableThStyle(tableKey, col) {
    const w = resolvedColWidth(tableKey, col);
    return `style="width:${w}px;min-width:${_COL_RESIZE_MIN}px;max-width:${w}px;position:relative"`;
}
function colResizerHtml() {
    // stopPropagation on click so the sortable <th> click handler doesn't fire while resizing.
    return `<span class="col-resizer" onmousedown="startColResize(event,this)" onclick="event.stopPropagation()"></span>`;
}
let _resizeCtx = null;
function startColResize(ev, handle) {
    ev.preventDefault();
    ev.stopPropagation();
    const th = handle.closest('th');
    if (!th) return;
    const table = th.closest('table');
    if (!table) return;
    const tableKey = table.getAttribute('data-colw-key');
    const colKey = th.getAttribute('data-col-key');
    if (!tableKey || !colKey) return;
    _resizeCtx = {
        th, tableKey, colKey,
        startX: ev.clientX,
        startW: th.getBoundingClientRect().width,
    };
    document.body.classList.add('col-resizing');
    document.addEventListener('mousemove', _onColResizeMove);
    document.addEventListener('mouseup', _onColResizeUp, { once: true });
}
function _onColResizeMove(ev) {
    if (!_resizeCtx) return;
    const dx = ev.clientX - _resizeCtx.startX;
    const w = Math.max(_COL_RESIZE_MIN, Math.round(_resizeCtx.startW + dx));
    _resizeCtx.th.style.width = w + 'px';
    _resizeCtx.th.style.minWidth = w + 'px';
    _resizeCtx.th.style.maxWidth = w + 'px';
}
function _onColResizeUp() {
    document.body.classList.remove('col-resizing');
    document.removeEventListener('mousemove', _onColResizeMove);
    if (!_resizeCtx) return;
    const { tableKey, colKey, th } = _resizeCtx;
    const w = Math.round(th.getBoundingClientRect().width);
    const saved = loadColWidths(tableKey);
    saved[colKey] = w;
    saveColWidths(tableKey, saved);
    _resizeCtx = null;
}
function resetColWidths(tableKey, rerenderFn) {
    try { localStorage.removeItem(_colWidthsKey(tableKey)); } catch (e) {}
    if (typeof rerenderFn === 'function') rerenderFn();
}
// Handy wrapper: rerender callback is keyed by table id so the HTML stays clean.
const _RESIZE_RERENDERERS = {
    'env-table':        () => renderEnvTable($('main-content')),
    'cluster-overview': () => renderClustersOverview($('main-content')),
    'cluster-env':      () => _rerenderClusterEnvTable && _rerenderClusterEnvTable(),
    'ingress':          () => _rerenderIngressTable && _rerenderIngressTable(),
};
function resetTableWidths(tableKey) {
    resetColWidths(tableKey, _RESIZE_RERENDERERS[tableKey]);
}
function resetWidthsBtn(tableKey, _unused) {
    return `<button class="toolbar-btn subtle" onclick="resetTableWidths('${tableKey}')" title="Reset column widths to defaults"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg><span>Reset Widths</span></button>`;
}

// ============================================================
// EXPORT: Reusable Excel export using SheetJS
// ============================================================
function _styleSheetHeaders(ws, data) {
    if (!data || data.length === 0) return;
    const cols = Object.keys(data[0]);
    cols.forEach((_, i) => {
        const cell = ws[XLSX.utils.encode_cell({r: 0, c: i})];
        if (cell) {
            cell.s = {
                font: {bold: true, color: {rgb: "FFFFFF"}},
                fill: {fgColor: {rgb: "2C3E50"}},
                alignment: {horizontal: "center"},
            };
        }
    });
    const colWidths = cols.map(k => {
        const maxLen = Math.max(k.length, ...data.map(r => String(r[k]||'').length));
        return {wch: Math.min(maxLen + 2, 50)};
    });
    ws['!cols'] = colWidths;
}

function exportToExcel(data, sheetName, fileName) {
    if (typeof XLSX === 'undefined') { alert('Excel export library not loaded.'); return; }
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(data);
    _styleSheetHeaders(ws, data);
    XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0,31));
    XLSX.writeFile(wb, fileName);
}
function exportMultiSheet(sheets, fileName) {
    if (typeof XLSX === 'undefined') { alert('Excel export library not loaded.'); return; }
    const wb = XLSX.utils.book_new();
    sheets.forEach(s => {
        if (!s.data || s.data.length === 0) return;
        const ws = XLSX.utils.json_to_sheet(s.data);
        _styleSheetHeaders(ws, s.data);
        XLSX.utils.book_append_sheet(wb, ws, s.name.substring(0,31));
    });
    XLSX.writeFile(wb, fileName);
}

// SVG icons
const ICON_EXPORT = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
const ICON_COL_FILTER = '<svg class="col-filter-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
const ICON_EDIT = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
const ICON_FREE = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>';
const ICON_COPY = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>';
const ICON_CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

// Clipboard helper: copies `text` and shows a transient confirmation on the
// originating element. Falls back to a hidden textarea when the async API
// is unavailable (older browsers or non-HTTPS contexts).
function copyToClipboard(text, sourceEl) {
    const done = () => {
        if (!sourceEl) return;
        const orig = sourceEl.innerHTML;
        sourceEl.classList.add('copied');
        if (sourceEl.classList.contains('creds-copy-btn')) sourceEl.innerHTML = ICON_CHECK;
        setTimeout(() => {
            sourceEl.classList.remove('copied');
            if (sourceEl.classList.contains('creds-copy-btn')) sourceEl.innerHTML = orig;
        }, 1200);
    };
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => {/* swallow */});
            return;
        }
    } catch (e) {/* fall through */}
    try {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        done();
    } catch (e) {/* ignore */}
}

// ---- Reusable filter/export builders ----
// ---- Active Filters Bar: shows applied filters as removable pills + Clear All ----
function activeFiltersBar(filters, clearAllFn) {
    if (!filters || filters.length === 0) return '';
    let html = `<div class="active-filters-bar">`;
    filters.forEach(f => {
        const esc = (f.clearFn || '').replace(/"/g, '&quot;');
        html += `<span class="active-filter-pill" title="${f.label}: ${f.value}"><span class="afp-label">${f.label}:</span> <span class="afp-value">${f.value}</span><span class="afp-remove" onclick="${esc}">&times;</span></span>`;
    });
    html += `<button class="active-filter-clear-all" onclick="${clearAllFn.replace(/"/g, '&quot;')}">Clear All</button>`;
    html += `</div>`;
    return html;
}

function _colFilterPills(colFilters, colDefs, removeFn) {
    const pills = [];
    Object.keys(colFilters).forEach(col => {
        const sel = colFilters[col];
        if (!sel || sel.length === 0) return;
        const colDef = colDefs.find(c => c.key === col);
        const label = colDef ? colDef.label : col;
        sel.forEach(v => {
            const display = v === '' ? '(Blank)' : v;
            pills.push({ label, value: display, clearFn: `${removeFn}('${col}','${v.replace(/'/g, "\\'")}')` });
        });
    });
    return pills;
}

// Generic column filter: works for any table
// storeExpr = JS expression that resolves to the colFilters object, e.g. "S.filters.clusterColFilters"
// valsArr = array of unique values for this column
// applyCallbackFn = name of global function to call after apply, e.g. "renderClustersOverview($('main-content'))"
function toggleSelectAll(masterCb) {
    const dd = masterCb.closest('.col-filter-dropdown'); if (!dd) return;
    const checked = masterCb.checked;
    dd.querySelectorAll('.cfd-options .cfd-option input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
}
function _updateSelectAllState(dd) {
    const master = dd.querySelector('.cfd-select-all input'); if (!master) return;
    const boxes = dd.querySelectorAll('.cfd-options .cfd-option input[type="checkbox"]');
    const allChecked = [...boxes].every(cb => cb.checked);
    const noneChecked = [...boxes].every(cb => !cb.checked);
    master.checked = allChecked;
    master.indeterminate = !allChecked && !noneChecked;
}

function _positionFilterDropdown(dd, anchorRect) {
    dd.style.position = 'fixed';
    dd.style.zIndex = '500';
    dd.style.visibility = 'hidden';
    document.body.appendChild(dd);

    const ddRect = dd.getBoundingClientRect();
    const pad = 8;
    const vpW = window.innerWidth;
    const vpH = window.innerHeight;

    let top = anchorRect.bottom;
    let left = anchorRect.left;

    if (top + ddRect.height + pad > vpH) {
        const above = anchorRect.top - ddRect.height;
        if (above >= pad) {
            top = above;
        } else {
            top = Math.max(pad, vpH - ddRect.height - pad);
            const opts = dd.querySelector('.cfd-options');
            if (opts) opts.style.maxHeight = Math.max(80, vpH - top - 120) + 'px';
        }
    }

    if (left + ddRect.width + pad > vpW) left = Math.max(pad, vpW - ddRect.width - pad);

    dd.style.top = top + 'px';
    dd.style.left = left + 'px';
    dd.style.visibility = '';
}

function showGenericColFilter(col, storeExpr, valsArr, applyCallbackFn, event) {
    event.stopPropagation();
    document.querySelectorAll('.col-filter-dropdown').forEach(el => el.remove());
    const store = eval(storeExpr);
    const selected = store[col] || [];
    const allSelected = selected.length === 0;
    const dd = document.createElement('div'); dd.className = 'col-filter-dropdown';
    let html = `<div class="cfd-header">Filter by values:</div><input type="text" class="cfd-search" placeholder="Search..." oninput="filterColOptions(this)">`;
    html += `<label class="cfd-select-all"><input type="checkbox" ${allSelected ? 'checked' : ''} onchange="toggleSelectAll(this)"> Select All</label>`;
    html += `<div class="cfd-options">`;
    valsArr.forEach(v => {
        const esc = String(v).replace(/'/g, "\\'").replace(/"/g, '&quot;');
        html += `<label class="cfd-option"><input type="checkbox" value="${esc}" ${allSelected || selected.includes(v) ? 'checked' : ''} onchange="_updateSelectAllState(this.closest('.col-filter-dropdown'))"> ${v || '(Blank)'}</label>`;
    });
    html += `</div><div class="cfd-actions"><button class="cfd-btn ok" onclick="applyGenericColFilter('${col}','${storeExpr.replace(/'/g,"\\'")}','${applyCallbackFn.replace(/'/g,"\\'")}')">Ok</button><button class="cfd-btn cancel" onclick="cancelColFilter()">Cancel</button></div>`;
    dd.innerHTML = html;
    const th = event.currentTarget.closest('th'); const rect = th.getBoundingClientRect();
    _positionFilterDropdown(dd, rect);
    _updateSelectAllState(dd);
    document.addEventListener('click', _closeColFilterOutside, true);
}
function applyGenericColFilter(col, storeExpr, applyCallbackFn) {
    const dd = document.querySelector('.col-filter-dropdown'); if (!dd) return;
    const checked = [...dd.querySelectorAll('.cfd-option input:checked')].map(cb => cb.value);
    const allCount = dd.querySelectorAll('.cfd-option input').length;
    const store = eval(storeExpr);
    if (checked.length >= allCount) delete store[col];
    else store[col] = [...checked];
    dd.remove(); document.removeEventListener('click', _closeColFilterOutside, true);
    eval(applyCallbackFn);
    savePrefs();
}
function removeGenericColFilter(storeExpr, col, val, applyCallbackFn) {
    const store = eval(storeExpr);
    if (!store[col]) return;
    store[col] = store[col].filter(v => v !== val);
    if (store[col].length === 0) delete store[col];
    eval(applyCallbackFn);
}
function _genericColFilterPills(colFilters, colDefs, storeExpr, applyCallbackFn) {
    const pills = [];
    Object.keys(colFilters).forEach(col => {
        const sel = colFilters[col]; if (!sel || sel.length === 0) return;
        const colDef = colDefs.find(c => c.key === col);
        const label = colDef ? colDef.label : col;
        sel.forEach(v => {
            const display = v === '' ? '(Blank)' : v;
            pills.push({ label, value: display, clearFn: `removeGenericColFilter('${storeExpr.replace(/'/g,"\\'")}','${col}','${v.replace(/'/g,"\\'")}','${applyCallbackFn.replace(/'/g,"\\'")}')` });
        });
    });
    return pills;
}
function exportBtn(onClickCode, label) {
    return `<button class="toolbar-btn export-btn" onclick="${onClickCode}">${ICON_EXPORT}<span>${label || 'Export Excel'}</span></button>`;
}

// Canonical node-group abbreviations. Per-AZ variants (couchbase-a/-b/-c) and
// related groups (infra + ms360-infra) collapse to a single abbreviation so
// they are counted together in the UI.
function _roleAbbr(r) {
    const k = (r || '').toLowerCase();
    if (k === 'master') return 'M';
    if (k.startsWith('couchbase')) return 'C';
    if (k.startsWith('elasticsearch')) return 'E';
    if (k.includes('infra')) return 'I';        // infra + ms360-infra
    if (k.startsWith('application')) return 'A';
    if (k.startsWith('worker')) return 'W';
    if (k.startsWith('monitoring')) return 'MON';
    if (k.startsWith('lmt')) return 'L';
    return k.replace(/[^a-z0-9]/gi,'').slice(0,2).toUpperCase();
}
const ROLE_ABBR_FULL = { M:'Master', W:'Worker', A:'Application', I:'Infra', C:'Couchbase', E:'Elasticsearch', MON:'Monitoring', L:'LMT' };
const ROLE_ABBR_ORDER = ['M','W','A','I','C','E','MON','L'];
function _roleAbbrSortIdx(a) { const i = ROLE_ABBR_ORDER.indexOf(a); return i===-1?99:i; }
function _aggRolesFull(roles) {
    const agg = {};
    Object.keys(roles || {}).forEach(r => { const ab = _roleAbbr(r); agg[ab] = (agg[ab]||0) + (roles[r]||0); });
    return Object.keys(agg)
        .sort((a,b) => _roleAbbrSortIdx(a)-_roleAbbrSortIdx(b) || a.localeCompare(b))
        .map(ab => [ROLE_ABBR_FULL[ab]||ab, agg[ab]]);
}
function fmtNodeRoles(c) {
    const roles = c.node_roles || {};
    const agg = {};
    Object.keys(roles).forEach(r => { const ab = _roleAbbr(r); agg[ab] = (agg[ab]||0) + (roles[r]||0); });
    const keys = Object.keys(agg).sort((a,b) => _roleAbbrSortIdx(a)-_roleAbbrSortIdx(b) || a.localeCompare(b));
    const parts = keys.map(ab => `${ab}:${agg[ab]}`);
    const title = keys.map(ab => `${ROLE_ABBR_FULL[ab]||ab}: ${agg[ab]}`).join(', ');
    return `<span title="${title}">${c.total_nodes||0} (${parts.join(' ')})</span>`;
}
function nodeRolesToExcelCols(c) {
    const roles = c.node_roles || {};
    const result = {'Total Nodes': c.total_nodes || 0};
    Object.keys(roles).sort().forEach(r => { result[r.charAt(0).toUpperCase() + r.slice(1) + ' Nodes'] = roles[r]; });
    return result;
}

// ---- Navigation with browser history ----
function _buildHistoryState() {
    return {
        view: S.currentView,
        cluster: S.currentCluster,
        env: S.currentEnv,
    };
}

function navigate(view, param, skipPush) {
    S.currentView = view;
    if (view === 'clusters') { S.currentCluster = null; S.currentDrop = null; S.currentEnv = null; }
    else if (view === 'env-table') { S.currentCluster = param || null; S.currentDrop = null; S.currentEnv = null; }
    else if (view === 'urls') { S.currentCluster = null; S.currentDrop = null; S.currentEnv = null; }
    else if (view === 'crds') { S.currentCluster = null; S.currentDrop = null; S.currentEnv = null; }
    else if (view === 'drops') { S.currentCluster = param; S.currentDrop = null; S.currentEnv = null; S.filters.clusterEnvColFilters = {}; S.filters.clusterEnvSort = { col: 'name', dir: 'asc' }; S.filters.dropEnvSearch = ''; }
    else if (view === 'env-detail') { S.currentEnv = param; }
    if (!skipPush) {
        try { history.pushState(_buildHistoryState(), ''); } catch (_) {}
    }
    render();
}

window.addEventListener('popstate', function(e) {
    const state = e.state;
    if (!state) { navigate('env-table', null, true); return; }
    S.currentView = state.view || 'env-table';
    S.currentCluster = state.cluster || null;
    S.currentEnv = state.env || null;
    S.currentDrop = null;
    render();
});

// ---- Data fetch ----
let _clustersLoadedAt = 0;
async function loadClusters(force) { if (!force && S.clusters.length && (Date.now() - _clustersLoadedAt) < 25000) { _refreshClusterBadge(); return; } try { const r = await fetch('/api/clusters'); const d = await r.json(); S.clusters = d.clusters || []; _clustersLoadedAt = Date.now(); if (d.error) console.warn('Clusters API warning:', d.error); } catch(e) { S.clusters = []; } _refreshClusterBadge(); markRefresh(); }
async function loadDrops(clusterId) { const url = clusterId ? `/api/drops/${clusterId}` : '/api/drops'; const r = await fetch(url); const d = await r.json(); S.drops = d.drops; S.threshold = d.threshold; markRefresh(); }
async function loadClusterNodes(clusterId) { if (!clusterId) { S.clusterNodes = []; return; } try { const ctrl = new AbortController(); const tid = setTimeout(() => ctrl.abort(), 30000); const r = await fetch(`/api/cluster/${clusterId}/nodes`, {signal: ctrl.signal}); clearTimeout(tid); if (!r.ok) { S.clusterNodes = []; return; } const d = await r.json(); S.clusterNodes = d.nodes || []; if (d.error) console.warn('Nodes API:', d.error); } catch(e) { console.warn('loadClusterNodes failed:', e); S.clusterNodes = []; } }
async function loadEnvData(dc, envId) { const r = await fetch(`/api/env/${dc}/${envId}`); S.envData = await r.json(); markRefresh(); }
async function loadEnvSummary(dc, envId) { const r = await fetch(`/api/env/${dc}/${envId}/summary`); S.envData = await r.json(); markRefresh(); }
async function loadEnvPods(dc, envId) { const r = await fetch(`/api/env/${dc}/${envId}/pods`); return await r.json(); }
async function loadEnvTable(clusterId) { const url = clusterId ? `/api/environments/table/${clusterId}` : '/api/environments/table'; const r = await fetch(url); const d = await r.json(); S.envTableData = d.environments || []; S.threshold = d.threshold; markRefresh(); }

async function loadQuickLinks() {
    try { const r = await fetch('/api/config/quick-links'); const d = await r.json(); S.quickLinks = d.links || {}; } catch { S.quickLinks = {}; }
    renderQuickLinks();
}

const QL_ICONS = {
    jenkins:   '<svg width="16" height="16" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><!-- Red circle background --><circle cx="50" cy="50" r="48" fill="#D33833"/><!-- Bald head / face --><ellipse cx="50" cy="38" rx="20" ry="22" fill="#F5CBA7"/><!-- Side hair tufts --><path d="M30 30 Q26 22 30 16 Q33 26 30 30z" fill="#3D2B1F"/><path d="M70 30 Q74 22 70 16 Q67 26 70 30z" fill="#3D2B1F"/><!-- Ears --><ellipse cx="30" cy="38" rx="4" ry="5" fill="#F5CBA7"/><ellipse cx="70" cy="38" rx="4" ry="5" fill="#F5CBA7"/><!-- Eyes closed / squinting --><path d="M41 36 Q44 33 47 36" stroke="#3D2B1F" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M53 36 Q56 33 59 36" stroke="#3D2B1F" stroke-width="2" fill="none" stroke-linecap="round"/><!-- Nose --><ellipse cx="50" cy="42" rx="2" ry="1.5" fill="#C9956A"/><!-- Smile --><path d="M43 49 Q50 55 57 49" stroke="#3D2B1F" stroke-width="2" fill="none" stroke-linecap="round"/><!-- White shirt/jacket body --><path d="M24 100 Q24 70 50 65 Q76 70 76 100z" fill="#FAFAFA"/><!-- Jacket lapels --><path d="M50 65 L38 75 L34 100" fill="#2C3E50"/><path d="M50 65 L62 75 L66 100" fill="#2C3E50"/><!-- Bow tie --><path d="M44 67 L50 71 L56 67 L50 63z" fill="#C0392B"/><ellipse cx="50" cy="67" rx="2" ry="2" fill="#E74C3C"/><!-- Cup hint at bottom --><rect x="36" y="83" width="12" height="9" rx="2" fill="white" opacity="0.9"/></svg>',
    git:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3" stroke="#2684FF" fill="none"/><circle cx="6" cy="6" r="3" stroke="#2684FF" fill="none"/><path d="M6 21V9a9 9 0 009 9" stroke="#2684FF"/></svg>',
    package:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 9.4l-9-5.19M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" stroke="#16B364" fill="rgba(22,179,100,0.15)"/><polyline points="3.27 6.96 12 12.01 20.73 6.96" stroke="#16B364"/><line x1="12" y1="22.08" x2="12" y2="12" stroke="#16B364"/></svg>',
    openshift: '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#3b82f6"/><text x="12" y="16.5" text-anchor="middle" font-size="14" font-weight="bold" fill="#fff" font-family="sans-serif">O</text></svg>',
    upgrade:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    wrench:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#A78BFA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>',
    link:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>',
    argocd:    '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#EF7B4D" stroke="#EF7B4D"/><path d="M12 5.5c-3.58 0-6.5 2.92-6.5 6.5s2.92 6.5 6.5 6.5 6.5-2.92 6.5-6.5S15.58 5.5 12 5.5zm0 11a4.5 4.5 0 110-9 4.5 4.5 0 010 9z" fill="#fff"/><circle cx="12" cy="12" r="2" fill="#fff"/></svg>',
    aws:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6.5 11.5c0-3 2.5-5.5 5.5-5.5s5.5 2.5 5.5 5.5" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round"/><path d="M3 14.5c0 0 3 3.5 9 3.5s9-3.5 9-3.5" stroke="#22d3ee" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="11.5" r="1.5" fill="#22d3ee"/></svg>',
    checkpoint:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E040FB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M12 16v2"/><circle cx="12" cy="16" r="1"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
};
function _qlIcon(iconKey) {
    return QL_ICONS[iconKey] || QL_ICONS.link;
}

// Service-catalog icons (per discovered EKS ingress). Distinct from QL_ICONS
// because each one is tuned for the specific platform service.
const SERVICE_ICONS = {
    headlamp:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6"/><circle cx="12" cy="13" r="6"/><path d="M9 13l2 2 4-4"/></svg>',
    argocd:    '<svg width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#EF7B4D"/><circle cx="12" cy="12" r="4.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="12" cy="12" r="1.8" fill="#fff"/></svg>',
    keycloak:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#E11D48" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="12" r="4"/><path d="M13 12h8M17 12v3M21 12v3"/></svg>',
    apigw:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 12h6M15 12h6M9 9v6M15 9v6"/></svg>',
    c1web:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>',
    c1dash:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#06B6D4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="5" rx="1"/><rect x="13" y="10" width="8" height="11" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/></svg>',
    workflow:  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#F59E0B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="9" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><path d="M9 6h3a3 3 0 013 3M9 18h3a3 3 0 003-3"/></svg>',
    office:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 9h6M9 13h6M9 17h4"/></svg>',
    sky:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#0EA5E9" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 100-9 6 6 0 00-11.4 1.4A4 4 0 006 19h11.5z"/></svg>',
    mock:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
    couchbase: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#EA2328" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
    elastic:   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22C55E" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12c0-5 4-9 9-9 3 0 5.5 1.5 7 4l-7 5H3z"/><path d="M5 16c1.5 2.5 4 4 7 4 5 0 9-4 9-9 0-1 0-2-.5-3H5z"/></svg>',
    kafka:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M8 6l4 6M8 18l4-6M14 12l2 0"/></svg>',
};
function _serviceIcon(key) {
    return SERVICE_ICONS[key] || QL_ICONS.link;
}
function renderQuickLinks() {
    const bar = document.getElementById('quick-links-bar');
    if (!bar) return;
    bar.style.display = 'none';
}

// ---- View tabs + drill-down breadcrumb ----
function renderBreadcrumb() {
    // Highlight the active primary tab (Environments vs Clusters)
    const envTabActive = (S.currentView === 'env-table');
    const clustersTabActive = (S.currentView === 'clusters' || S.currentView === 'drops' || (S.currentView === 'env-detail' && S.currentCluster));
    const urlsTabActive = (S.currentView === 'urls');
    const crdsTabActive = (S.currentView === 'crds');
    document.querySelectorAll('.view-tab').forEach(btn => {
        const v = btn.getAttribute('data-view');
        const on = (v === 'env-table' && envTabActive) || (v === 'clusters' && clustersTabActive) || (v === 'urls' && urlsTabActive) || (v === 'crds' && crdsTabActive);
        btn.classList.toggle('active', on);
    });

    // Drill-down crumb shown on the right (empty on top-level tabs)
    const crumb = $('view-tabs-crumb');
    if (!crumb) return;
    const parts = [];
    if (S.currentCluster && (S.currentView === 'drops' || S.currentView === 'env-detail')) {
        const isDropsActive = (S.currentView === 'drops');
        parts.push(isDropsActive
            ? `<span class="vt-crumb-item vt-crumb-active">${S.currentCluster.short_name} <span class="vt-crumb-sub">(${S.currentCluster.full_name})</span></span>`
            : `<span class="vt-crumb-item vt-crumb-link" onclick="navigate('drops',S.currentCluster)">${S.currentCluster.short_name} <span class="vt-crumb-sub">(${S.currentCluster.full_name})</span></span>`);
    }
    if (S.currentEnv && S.envData && S.currentView === 'env-detail') {
        parts.push(`<span class="vt-crumb-item vt-crumb-active">${S.envData.environment}</span>`);
    }
    crumb.innerHTML = parts.length
        ? `<span class="vt-crumb-sep">›</span>` + parts.join(`<span class="vt-crumb-sep">›</span>`)
        : '';
}

// ---- Main render dispatcher ----
let _renderGen = 0;
async function render() {
    const gen = ++_renderGen;
    renderBreadcrumb();
    const main = $('main-content');
    if (S.currentView === 'clusters') {
        main.innerHTML = _skeletonTable('Loading clusters');
        await loadClusters();
        if (gen !== _renderGen) return;
        renderClustersOverview(main);
    } else if (S.currentView === 'env-table') {
        main.innerHTML = _skeletonTable('Loading environments');
        await loadEnvTable(S.currentCluster ? S.currentCluster.cluster_id : null);
        if (gen !== _renderGen) return;
        renderEnvTable(main);
    } else if (S.currentView === 'urls') {
        main.innerHTML = _skeletonTable('Loading URLs');
        await loadClusters();
        if (gen !== _renderGen) return;
        renderUrlsPage(main);
    } else if (S.currentView === 'crds') {
        main.innerHTML = _skeletonTable('Loading CRDs');
        await loadClusters();
        if (gen !== _renderGen) return;
        renderCrdsPage(main);
    } else if (S.currentView === 'drops') {
        main.innerHTML = _skeletonTable('Loading environments');
        const cid = S.currentCluster ? S.currentCluster.cluster_id : null;
        await Promise.all([loadDrops(cid), loadClusterNodes(cid)]);
        if (gen !== _renderGen) return;
        renderDropsOverview(main);
    } else if (S.currentView === 'env-detail') {
        main.innerHTML = _skeletonEnvDetail(S.currentEnv.name);
        S.podColFilters = {}; S.podSearch = '';
        S.podsLoaded = false;
        await loadEnvSummary(S.currentEnv.datacenter, S.currentEnv.env_id);
        if (gen !== _renderGen) return;
        renderEnvDetail(main);
    }
}

// ============================================================
// LEVEL 0: Clusters Overview (TABLE)
// ============================================================
const CLUSTER_COLS = [
    { key: 'short_name', label: 'Cluster',      filterable: true,  sortable: true,  width: 190 },
    { key: 'cloud',      label: 'Cloud',        filterable: true,  sortable: true,  width: 90 },
    { key: 'status',     label: 'Status',       filterable: true,  sortable: true,  width: 110 },
    { key: 'ocp_version',label: 'Version',      filterable: true,  sortable: true,  width: 110 },
    { key: 'total_nodes',label: 'Nodes',        filterable: false, sortable: true,  width: 200 },
    { key: 'total_envs', label: 'Environments', filterable: false, sortable: true,  width: 110 },
    { key: 'drops',      label: 'Drops',        filterable: false, sortable: false, width: 160 },
    { key: 'console',    label: 'Console',      filterable: false, sortable: false, width: 100 },
];
function _clusterUniqueVals(col) {
    if (col === 'cloud') {
        return [...new Set((S.clusters || []).map(c => ((c.cloud || 'ocp') === 'aws') ? 'EKS' : 'OCP'))].sort();
    }
    return [...new Set(S.clusters.map(c => String(c[col]||'')))].sort();
}

function getFilteredClusters() {
    let list = (S.clusters || []).filter(_clusterMatchesProvider);
    const cf = S.filters.clusterColFilters || {};
    Object.keys(cf).forEach(col => {
        const sel = cf[col]; if (!sel || sel.length === 0) return;
        list = list.filter(c => {
            if (col === 'cloud') return sel.includes(((c.cloud || 'ocp') === 'aws') ? 'EKS' : 'OCP');
            return sel.includes(String(c[col] || ''));
        });
    });
    if (S.filters.clusterSearch) {
        const q = S.filters.clusterSearch.toLowerCase();
        list = list.filter(c => c.full_name.toLowerCase().includes(q) || c.short_name.toLowerCase().includes(q) || (c.ocp_version||'').toLowerCase().includes(q) || (c.cloud||'').toLowerCase().includes(q) || (c.region||'').toLowerCase().includes(q) || c.drops.some(d => d.toLowerCase().includes(q)) || (c.environments||[]).some(e => e.toLowerCase().includes(q)));
    }
    const s = S.filters.clusterSort;
    if (s && s.col) {
        const dir = s.dir === 'desc' ? -1 : 1;
        list = list.slice().sort((a, b) => {
            let va = a[s.col], vb = b[s.col];
            if (typeof va === 'number' && typeof vb === 'number') { /* keep numeric */ }
            else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
            if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0;
        });
    }
    return list;
}

function _clusterActiveFilters() {
    const pills = _genericColFilterPills(S.filters.clusterColFilters || {}, CLUSTER_COLS, 'S.filters.clusterColFilters', "renderClustersOverview(document.getElementById('main-content'))");
    if (S.filters.clusterSearch) pills.push({ label: 'Search', value: S.filters.clusterSearch, clearFn: "S.filters.clusterSearch='';renderClustersOverview(document.getElementById('main-content'))" });
    return pills;
}
function clearAllClusterFilters() { S.filters.clusterColFilters = {}; S.filters.clusterSearch = ''; renderClustersOverview($('main-content')); savePrefs(); }

function showClusterColFilter(col, event) {
    showGenericColFilter(col, 'S.filters.clusterColFilters', _clusterUniqueVals(col), "renderClustersOverview(document.getElementById('main-content'))", event);
}
function toggleClusterSort(col) {
    const s = S.filters.clusterSort;
    if (s.col === col) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
    else { s.col = col; s.dir = 'asc'; }
    renderClustersOverview($('main-content'));
    savePrefs();
}
function _clusterHeadRow() {
    const cf = S.filters.clusterColFilters || {};
    const s = S.filters.clusterSort || {};
    return CLUSTER_COLS.map(c => {
        const hasFilter = cf[c.key] && cf[c.key].length > 0;
        const filterIcon = c.filterable ? `<span class="col-filter-icon-wrap ${hasFilter?'active':''}" onclick="showClusterColFilter('${c.key}',event)">${ICON_COL_FILTER}</span>` : '';
        const styleAttr = resizableThStyle('cluster-overview', c);
        if (c.sortable) {
            const arrow = s.col === c.key ? (s.dir === 'asc' ? ' ↑' : ' ↓') : '';
            return `<th class="sortable-th env-table-th" data-col-key="${c.key}" ${styleAttr} onclick="toggleClusterSort('${c.key}')">${filterIcon}${c.label}${arrow}${colResizerHtml()}</th>`;
        }
        return `<th class="env-table-th" data-col-key="${c.key}" ${styleAttr}>${filterIcon}${c.label}${colResizerHtml()}</th>`;
    }).join('');
}

function renderClustersOverview(main) {
    const filtered = getFilteredClusters();
    const afPills = _clusterActiveFilters();
    let html = `<div class="mini-toolbar">
        <input type="text" class="pod-search-input" id="cluster-search" placeholder="Search cluster, cloud, version, region, drop..." value="${S.filters.clusterSearch}" oninput="S.filters.clusterSearch=this.value;debounced('clusterSearch',()=>renderClustersOverview($('main-content')))" style="min-width:280px;">
        <span class="toolbar-count">${filtered.length} of ${S.clusters.length} clusters</span>
        <span class="mini-toolbar-spacer"></span>
        ${resetWidthsBtn('cluster-overview')}
        ${exportBtn("exportClusters()",'Export')}
    </div>`;
    html += activeFiltersBar(afPills, "clearAllClusterFilters()");
    html += `<div class="table-container"><div class="table-scroll"><table class="env-overview-table resizable-table" data-colw-key="cluster-overview">
        <thead><tr>${_clusterHeadRow()}</tr></thead><tbody>`;
    if (filtered.length === 0) {
        html += `<tr class="empty-row"><td colspan="${CLUSTER_COLS.length}">
            <div class="empty-state">
                <div class="empty-state-msg">No clusters match the current filters.</div>
                <button class="empty-state-btn" onclick="clearAllClusterFilters()">Clear filters</button>
            </div></td></tr>`;
    } else {
        filtered.forEach(c => {
            const stCls = c.status === 'Healthy' ? 'healthy' : 'unhealthy';
            const statusTip = (c.status_details && c.status_details.length) ? c.status_details.join('&#10;') : c.status;
            const {crd_releases: _cr, ...cNav} = c;
            const cJson = JSON.stringify(cNav).replace(/"/g,'&quot;');
            const isAws = (c.cloud || 'ocp') === 'aws';
            const cloudBadge = isAws
                ? `<span class="row-cloud-badge row-cloud-aws"><span class="row-cloud-dot"></span>EKS</span>`
                : `<span class="row-cloud-badge row-cloud-ocp"><span class="row-cloud-dot"></span>OCP</span>`;
            const consoleLabel = isAws ? 'Headlamp' : 'Open';
            const drops = (c.drops && c.drops.length) ? c.drops.join(', ') : '—';
            html += `<tr>
                <td class="env-tbl-cell env-tbl-name"><a style="cursor:pointer" onclick="navigate('drops',${cJson})" title="${c.short_name}">${c.full_name}</a></td>
                <td class="env-tbl-cell">${cloudBadge}</td>
                <td class="env-tbl-cell"><span class="cluster-status-badge ${stCls}" title="${statusTip}">${c.status}</span></td>
                <td class="env-tbl-cell"><span style="color:var(--accent-cyan);font-family:'JetBrains Mono',monospace;font-weight:700;font-size:13.5px">${c.ocp_version}</span></td>
                <td class="env-tbl-cell">${fmtNodeRoles(c)}</td>
                <td class="env-tbl-cell" style="font-weight:700;color:var(--accent-blue)">${c.total_envs}</td>
                <td class="env-tbl-cell">${drops}</td>
                <td class="env-tbl-cell"><a class="cluster-console-link" href="${c.console_url}" target="_blank" rel="noopener">${consoleLabel}</a></td>
            </tr>`;
        });
    }
    html += '</tbody></table></div></div>';
    main.innerHTML = html;
}

// ============================================================
// Unified Fleet View — same card for OCP + EKS
// ============================================================
//
// Design goals:
//   1. Show every cluster (OCP + EKS) in one consistent layout.
//   2. Make version / HF / CRD drift visible at a glance — any value
//      that differs from the fleet's "winning" value is amber/red.
//   3. Each card is self-contained: nodes, HFs, services, CRDs.
//
// All fleet-level drift detection happens in _computeFleetDrift() once
// per render so individual cards just look up `_FLEET_DRIFT` by key.
// ============================================================

let _FLEET_DRIFT = { fields: {}, hf: {}, crd: {} };

function _computeFleetDrift(clusters) {
    // Drift signal = same logical thing has different values across clusters.
    //
    // Key nuance: cluster version drift is meaningful WITHIN a cloud
    // (OCP 4.15.12 vs 4.15.10 = drift) but NOT across clouds (OCP 4.15
    // vs EKS 1.30 is not drift, they're different products). So per-cloud
    // buckets are computed for version-y fields, but HFs and CRDs are
    // fleet-wide since they're product-version Helm values written by the
    // same pipeline regardless of where the cluster runs.
    const drift = { fields: {}, hf: {}, crd: {} };
    if (!clusters || clusters.length < 2) {
        _FLEET_DRIFT = drift;
        return drift;
    }
    const winnerFromCounts = (counts) => {
        const values = Object.keys(counts);
        if (values.length < 2) return null;
        const winner = values.sort((a, b) => counts[b] - counts[a])[0];
        return { winner, counts };
    };

    // Per-cloud cluster-version drift
    const byCloud = {};
    clusters.forEach(c => {
        const cl = (c.cloud || 'ocp');
        (byCloud[cl] ||= []).push(c);
    });
    Object.entries(byCloud).forEach(([cl, list]) => {
        if (list.length < 2) return;
        const counts = {};
        list.forEach(c => {
            const v = (c.ocp_version || '').trim();
            if (v) counts[v] = (counts[v] || 0) + 1;
        });
        const w = winnerFromCounts(counts);
        if (w) drift.fields[`ocp_version.${cl}`] = w;
    });
    // Fleet-wide HF drift (per role+product) — same pipeline across clouds
    ['rt', 'au', 'bs'].forEach(role => {
        Object.keys(_HF_DISPLAY_FIELDS).forEach(fk => {
            const counts = {};
            clusters.forEach(c => {
                const v = ((c.hf_summary || {})[role] || {})[fk];
                if (v) counts[v] = (counts[v] || 0) + 1;
            });
            const w = winnerFromCounts(counts);
            if (w) drift.hf[`${role}.${fk}`] = w;
        });
    });
    // Fleet-wide CRD chart drift
    const crdMap = {};
    clusters.forEach(c => {
        (c.crd_releases || []).forEach(r => {
            const k = r.chart || r.name;
            if (!k) return;
            (crdMap[k] ||= {})[r.chart_version || ''] =
                (crdMap[k][r.chart_version || ''] || 0) + 1;
        });
    });
    Object.entries(crdMap).forEach(([chart, counts]) => {
        const w = winnerFromCounts(counts);
        if (w) drift.crd[chart] = w;
    });
    _FLEET_DRIFT = drift;
    return drift;
}

// Which fields from the product-versions CM to display per role-ns.
// Order matters — drives the column order on the HF strip.
const _HF_DISPLAY_FIELDS = {
    baseline: 'Baseline', platform: 'Platform', catalog: 'Catalog',
    csr: 'CSR', oc: 'OC', oh: 'OH', care: 'CARE', mass: 'MASS',
    backoffice: 'BackOffice',
};

function _fmtHfVersion(ver, hf) {
    if (!ver) return '';
    return hf ? `${ver}.${hf}` : ver;
}

function _humanCpu(milli) {
    if (!milli) return '0';
    const cores = milli / 1000;
    return cores >= 10 ? cores.toFixed(0) : cores.toFixed(2);
}
function _humanMem(bytes) {
    if (!bytes) return '0';
    const gib = bytes / (1024 * 1024 * 1024);
    return gib >= 100 ? gib.toFixed(0) : gib.toFixed(1);
}
function _usageBar(pct, color) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    const cls = p >= 85 ? 'bar-hot' : p >= 65 ? 'bar-warm' : 'bar-ok';
    return `<div class="usage-bar"><div class="usage-bar-fill ${cls}" style="width:${p}%;background:${color || ''}"></div><span class="usage-bar-pct">${p}%</span></div>`;
}

function _renderNodeRow(n) {
    const capCpu = n.capacity?.cpu_m || 0;
    const capMem = n.capacity?.mem_bytes || 0;
    const useCpu = n.usage?.cpu_m || 0;
    const useMem = n.usage?.mem_bytes || 0;
    const cpuPct = capCpu ? (useCpu / capCpu) * 100 : 0;
    const memPct = capMem ? (useMem / capMem) * 100 : 0;
    const stCls = n.status === 'Ready' ? 'healthy' : 'unhealthy';
    const ver = (n.k8s_version || '').replace(/^v/, '');
    const shortName = (n.name || '').split('.')[0];
    const ng = n.nodegroup ? `<span class="node-ng-pill">${n.nodegroup}</span>` : '';
    return `<tr>
        <td><div class="node-name" title="${n.name}">${shortName}</div>${ng}</td>
        <td><span class="node-role">${n.role || 'worker'}</span></td>
        <td><span class="node-ver">${ver || '—'}</span></td>
        <td><span class="node-itype">${n.instance_type || '—'}</span></td>
        <td><span class="node-zone">${n.zone || '—'}</span></td>
        <td>
            <div class="node-resource">
                ${_usageBar(cpuPct)}
                <div class="node-resource-num">${_humanCpu(useCpu)} / ${_humanCpu(capCpu)} cores</div>
            </div>
        </td>
        <td>
            <div class="node-resource">
                ${_usageBar(memPct)}
                <div class="node-resource-num">${_humanMem(useMem)} / ${_humanMem(capMem)} GiB</div>
            </div>
        </td>
        <td><span class="cluster-status-badge ${stCls}">${n.status || 'Unknown'}</span></td>
    </tr>`;
}

function _renderHfStrip(c) {
    const hf = c.hf_summary || {};
    if (!hf.any) {
        return `<div class="fleet-hf-empty">HF data not yet published — the pipeline will populate <code>product-versions</code> CM</div>`;
    }
    const roles = [
        { k: 'rt', label: 'Runtime',         accent: '#3B82F6' },
        { k: 'au', label: 'Authoring',       accent: '#10B981' },
        { k: 'bs', label: 'Backing Services', accent: '#F59E0B' },
    ];
    let html = `<div class="fleet-hf-strip">`;
    roles.forEach(({ k, label, accent }) => {
        const rd = hf[k];
        if (!rd || !Object.keys(rd).length) {
            html += `<div class="fleet-hf-role fleet-hf-role-empty" style="--accent:${accent}">`;
            html += `<div class="fleet-hf-role-name">${label}</div><div class="fleet-hf-empty-inline">no data</div>`;
            html += `</div>`;
            return;
        }
        html += `<div class="fleet-hf-role" style="--accent:${accent}">`;
        html += `<div class="fleet-hf-role-name">${label}</div>`;
        html += `<div class="fleet-hf-pairs">`;
        Object.entries(_HF_DISPLAY_FIELDS).forEach(([fk, lbl]) => {
            const ver = rd[fk];
            if (!ver) return;
            const hfNum = rd[fk + '_hf'];
            const display = _fmtHfVersion(ver, hfNum);
            const drift = _FLEET_DRIFT.hf[`${k}.${fk}`];
            const cls = drift && display !== _fmtHfVersion(drift.winner, hfNum) ? 'fleet-hf-drift' : '';
            const tip = drift && cls
                ? `Fleet drift — ${Object.entries(drift.counts).map(([v,n])=>`${v} (${n})`).join(', ')}`
                : '';
            html += `<span class="fleet-hf-pair ${cls}" title="${tip}">`;
            html += `<span class="fleet-hf-pair-k">${lbl}</span>`;
            html += `<span class="fleet-hf-pair-v">${display}</span>`;
            html += `</span>`;
        });
        html += `</div></div>`;
    });
    html += `</div>`;
    return html;
}

function _renderServiceChips(c) {
    const services = Array.isArray(c.services) ? c.services : [];
    if (!services.length) {
        const fallback = [];
        if (c.console_url) fallback.push({ key: 'console', label: c.cloud === 'aws' ? 'Headlamp' : 'Console', icon: c.cloud === 'aws' ? 'headlamp' : 'openshift', url: c.console_url });
        if (c.vault_url)   fallback.push({ key: 'vault',   label: 'Vault', icon: 'vault', url: c.vault_url });
        if (c.argocd_url)  fallback.push({ key: 'argocd',  label: 'ArgoCD', icon: 'argocd', url: c.argocd_url });
        if (!fallback.length) return '';
        return `<div class="fleet-svc-chips">` +
            fallback.map(s => `<a class="fleet-svc-chip" href="${s.url}" target="_blank" rel="noopener" title="${s.url}"><span class="ql-icon">${_serviceIcon(s.icon)}</span><span>${s.label}</span></a>`).join('') +
            `</div>`;
    }
    // Show ALL discovered services with icons; group by NS visually using accent bars.
    const NS_ORDER = ['openshift-console', 'vault', 'openshift-argocd', 'argocd', 'headlamp',
                      'authoring', 'runtime', 'backingservices', 'rgs-mst-authoring',
                      'rgs-mst-runtime', 'rgs-mst-backingservices'];
    const sorted = [...services].sort((a, b) => {
        const ia = NS_ORDER.indexOf(a.namespace || ''); const ib = NS_ORDER.indexOf(b.namespace || '');
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    let html = `<div class="fleet-svc-chips">`;
    sorted.forEach(s => {
        html += `<a class="fleet-svc-chip" href="${s.url}" target="_blank" rel="noopener" title="${s.host || s.url} (${s.namespace})">`;
        html += `<span class="ql-icon">${_serviceIcon(s.icon)}</span>`;
        html += `<span>${s.label}</span>`;
        html += `</a>`;
    });
    html += `</div>`;
    return html;
}

function _renderFleetCard(c) {
    const stCls = c.status === 'Healthy' ? 'healthy' : 'unhealthy';
    const statusTip = (c.status_details && c.status_details.length) ? c.status_details.join('&#10;') : c.status;
    const nodes = Array.isArray(c.nodes) ? c.nodes : [];
    const cloud = (c.cloud || 'ocp');

    // Aggregates
    let totalCpuCap = 0, totalCpuUse = 0, totalMemCap = 0, totalMemUse = 0;
    const nodegroups = new Set();
    nodes.forEach(n => {
        totalCpuCap += n.capacity?.cpu_m || 0;
        totalCpuUse += n.usage?.cpu_m || 0;
        totalMemCap += n.capacity?.mem_bytes || 0;
        totalMemUse += n.usage?.mem_bytes || 0;
        if (n.nodegroup) nodegroups.add(n.nodegroup);
    });
    const aggCpuPct = totalCpuCap ? (totalCpuUse / totalCpuCap) * 100 : 0;
    const aggMemPct = totalMemCap ? (totalMemUse / totalMemCap) * 100 : 0;
    const ngList = nodegroups.size ? Array.from(nodegroups).join(' · ') : '';
    const k8sVer = (c.ocp_version || '').replace(/^v/, '') || '—';
    const verDrift = _FLEET_DRIFT.fields[`ocp_version.${cloud}`];
    const verCls = verDrift && (c.ocp_version || '') !== verDrift.winner ? 'fleet-drift' : '';
    const verTip = verCls && verDrift
        ? `${cloud === 'aws' ? 'EKS' : 'OCP'} drift — ${Object.entries(verDrift.counts).map(([v,n])=>`${v} (${n})`).join(', ')}`
        : '';

    // Cloud badge
    const cloudBadge = cloud === 'aws'
        ? `<span class="fleet-cloud-badge cloud-aws"><span class="fleet-cloud-dot"></span>EKS</span>`
        : `<span class="fleet-cloud-badge cloud-ocp"><span class="fleet-cloud-dot"></span>OCP</span>`;

    // Node-role mini-strip: e.g. "12 nodes (Master 3 · Worker 9)" — per-AZ and
    // infra/ms360-infra groups are aggregated to match the overview table.
    const roleEntries = _aggRolesFull(c.node_roles || {}).filter(([, n]) => n > 0);
    const roleStr = roleEntries.length
        ? ' (' + roleEntries.map(([r, n]) => `${r} ${n}`).join(' · ') + ')'
        : '';

    // Provider / region pill
    const providerPill = c.provider ? `<span class="fleet-meta-pill"><span class="fleet-meta-k">Provider</span>${c.provider}</span>` : '';
    const regionPill = c.region ? `<span class="fleet-meta-pill"><span class="fleet-meta-k">Region</span>${c.region}</span>` : '';

    let html = `<div class="fleet-card fleet-card-${cloud}">`;

    // ── Head ──
    html += `<div class="fleet-card-head">
        <div class="fleet-card-title-row">
            ${cloudBadge}
            <span class="fleet-card-name" title="${c.full_name}">${c.short_name || c.full_name}</span>
            <span class="cluster-status-badge ${stCls}" title="${statusTip}">${c.status}</span>
            <span class="mini-toolbar-spacer"></span>
            <span class="fleet-ver-pill ${verCls}" title="${verTip}">
                ${cloud === 'aws' ? 'K8s' : 'OCP'} <b>${k8sVer}</b>
            </span>
        </div>
        <div class="fleet-card-meta">
            ${regionPill}${providerPill}
            <span class="fleet-meta-pill"><span class="fleet-meta-k">Nodes</span>${c.total_nodes || nodes.length}${roleStr}</span>
            ${ngList ? `<span class="fleet-meta-pill"><span class="fleet-meta-k">Node groups</span>${ngList}</span>` : ''}
            <span class="fleet-meta-pill"><span class="fleet-meta-k">CRDs</span>${c.crd_total || 0}</span>
            <span class="fleet-meta-pill"><span class="fleet-meta-k">Services</span>${(c.services || []).length}</span>
        </div>
    </div>`;

    // ── CPU / Mem aggregate ──
    if (nodes.length) {
        html += `<div class="eks-agg-row">
            <div class="eks-agg-box">
                <div class="eks-agg-label">Cluster CPU</div>
                ${_usageBar(aggCpuPct)}
                <div class="eks-agg-num">${_humanCpu(totalCpuUse)} / ${_humanCpu(totalCpuCap)} cores</div>
            </div>
            <div class="eks-agg-box">
                <div class="eks-agg-label">Cluster Memory</div>
                ${_usageBar(aggMemPct)}
                <div class="eks-agg-num">${_humanMem(totalMemUse)} / ${_humanMem(totalMemCap)} GiB</div>
            </div>
        </div>`;
    }

    // ── HF strip (per role-ns) ──
    html += _renderHfStrip(c);

    // ── Services chip row ──
    html += _renderServiceChips(c);

    // ── Nodes table (collapsible) ──
    if (nodes.length) {
        html += `<details class="eks-nodes-wrap">
            <summary class="eks-nodes-summary">Nodes (${nodes.length})</summary>
            <div class="eks-nodes-tbl-wrap">
                <table class="eks-nodes-tbl">
                    <thead><tr>
                        <th>Node</th><th>Role</th><th>K8s ver</th><th>Instance</th><th>Zone</th><th>CPU</th><th>Memory</th><th>Status</th>
                    </tr></thead>
                    <tbody>${nodes.map(_renderNodeRow).join('')}</tbody>
                </table>
            </div>
        </details>`;
    }

    html += `</div>`;
    return html;
}

// Provider filter chip strip — All / OCP / EKS
function _fleetProviderFilterStrip(clusters) {
    const cur = S.fleetFilter || 'all';
    const counts = {
        all: clusters.length,
        ocp: clusters.filter(c => (c.cloud || 'ocp') !== 'aws').length,
        aws: clusters.filter(c => (c.cloud || 'ocp') === 'aws').length,
    };
    const chip = (id, label) => `<button class="fleet-chip ${cur === id ? 'active' : ''}" onclick="S.fleetFilter='${id}';renderFleetOverview($('main-content'))">${label}<span class="fleet-chip-count">${counts[id]}</span></button>`;
    return `<div class="fleet-filter-strip">
        ${chip('all', 'All clusters')}${chip('ocp', 'OpenShift')}${chip('aws', 'AWS EKS')}
    </div>`;
}

// KPI strip — fleet-wide aggregates
function _fleetKpiStrip(clusters) {
    let nodes = 0, healthy = 0, degraded = 0, services = 0, crds = 0;
    let cpuCap = 0, cpuUse = 0, memCap = 0, memUse = 0;
    clusters.forEach(c => {
        nodes += c.total_nodes || (c.nodes || []).length;
        if (c.status === 'Healthy') healthy++; else degraded++;
        services += (c.services || []).length;
        crds += c.crd_total || 0;
        (c.nodes || []).forEach(n => {
            cpuCap += n.capacity?.cpu_m || 0; cpuUse += n.usage?.cpu_m || 0;
            memCap += n.capacity?.mem_bytes || 0; memUse += n.usage?.mem_bytes || 0;
        });
    });
    const cpuPct = cpuCap ? (cpuUse / cpuCap) * 100 : 0;
    const memPct = memCap ? (memUse / memCap) * 100 : 0;
    const driftCount = Object.keys(_FLEET_DRIFT.fields).length
                     + Object.keys(_FLEET_DRIFT.hf).length
                     + Object.keys(_FLEET_DRIFT.crd).length;
    return `<div class="fleet-kpi-strip">
        <div class="fleet-kpi"><div class="fleet-kpi-v">${clusters.length}</div><div class="fleet-kpi-l">Clusters</div></div>
        <div class="fleet-kpi"><div class="fleet-kpi-v">${nodes}</div><div class="fleet-kpi-l">Nodes</div></div>
        <div class="fleet-kpi fleet-kpi-ok"><div class="fleet-kpi-v">${healthy}</div><div class="fleet-kpi-l">Healthy</div></div>
        <div class="fleet-kpi ${degraded > 0 ? 'fleet-kpi-bad' : ''}"><div class="fleet-kpi-v">${degraded}</div><div class="fleet-kpi-l">Degraded</div></div>
        <div class="fleet-kpi"><div class="fleet-kpi-v">${services}</div><div class="fleet-kpi-l">Services</div></div>
        <div class="fleet-kpi"><div class="fleet-kpi-v">${crds}</div><div class="fleet-kpi-l">CRDs</div></div>
        <div class="fleet-kpi fleet-kpi-cpu">
            <div class="fleet-kpi-cpu-l">Fleet CPU</div>
            ${_usageBar(cpuPct)}
            <div class="fleet-kpi-cpu-n">${_humanCpu(cpuUse)} / ${_humanCpu(cpuCap)} cores</div>
        </div>
        <div class="fleet-kpi fleet-kpi-cpu">
            <div class="fleet-kpi-cpu-l">Fleet Memory</div>
            ${_usageBar(memPct)}
            <div class="fleet-kpi-cpu-n">${_humanMem(memUse)} / ${_humanMem(memCap)} GiB</div>
        </div>
        <div class="fleet-kpi ${driftCount > 0 ? 'fleet-kpi-warn' : 'fleet-kpi-ok'}"><div class="fleet-kpi-v">${driftCount}</div><div class="fleet-kpi-l">Drift signals</div></div>
    </div>`;
}

function renderFleetOverview(main) {
    const all = S.clusters || [];
    // Provider filter is driven by the header switcher (S.provider: all / ocp / aws).
    const scoped = all.filter(_clusterMatchesProvider);

    // Compute fleet-wide drift over the visible scope so highlighting matches what the user sees.
    _computeFleetDrift(scoped);

    // Search across name/region/version
    const q = (S.filters.clusterSearch || '').toLowerCase();
    const filtered = q ? scoped.filter(c => [
        c.full_name, c.short_name, c.cluster_id, c.region, c.ocp_version, c.provider
    ].some(v => (v || '').toLowerCase().includes(q))) : scoped;

    // Sort: degraded first, then by cloud (ocp first), then by name.
    filtered.sort((a, b) => {
        if (a.status !== 'Healthy' && b.status === 'Healthy') return -1;
        if (a.status === 'Healthy' && b.status !== 'Healthy') return 1;
        const ac = (a.cloud || 'ocp'), bc = (b.cloud || 'ocp');
        if (ac !== bc) return ac === 'ocp' ? -1 : 1;
        return (a.full_name || '').localeCompare(b.full_name || '');
    });

    let html = `<div class="fleet-toolbar">
        <input type="text" class="pod-search-input" id="cluster-search" placeholder="Search cluster, region, version, provider..." value="${S.filters.clusterSearch || ''}" oninput="S.filters.clusterSearch=this.value;debounced('clusterSearch',()=>renderFleetOverview($('main-content')))" style="min-width:280px;">
        <span class="mini-toolbar-spacer"></span>
        ${exportBtn("exportClusters()",'Export')}
    </div>`;

    html += _fleetKpiStrip(scoped);

    if (!filtered.length) {
        html += `<div class="empty-state"><div class="empty-state-msg">No clusters match the current filter.</div></div>`;
        main.innerHTML = html;
        return;
    }

    html += `<div class="fleet-grid">`;
    filtered.forEach(c => { html += _renderFleetCard(c); });
    html += `</div>`;

    main.innerHTML = html;
}

// ============================================================
// URLs Page — Design B: Left-rail cluster list + right service panel
// ============================================================

// Shared role metadata (RT=blue, AU=green, BS=amber) — same across the whole app
const URL_ROLE_META = {
    rt: { label: 'Runtime',          color: '#3B82F6', cls: 'rt' },
    au: { label: 'Authoring',        color: '#10B981', cls: 'au' },
    bs: { label: 'Backing Services', color: '#F59E0B', cls: 'bs' },
};
const URL_ROLE_ORDER  = ['rt', 'au', 'bs'];
const URL_CLUSTER_KEYS = new Set(['console', 'headlamp', 'vault', 'argocd']);

function _urlRoleOf(ns) {
    const n = (ns || '').toLowerCase();
    if (n === 'runtime'      || n.endsWith('-runtime'))         return 'rt';
    if (n === 'authoring'    || n.endsWith('-authoring'))       return 'au';
    if (n === 'backingservices' || n.endsWith('-backingservices')) return 'bs';
    return null;
}
function _urlEnvOf(ns) {
    const n = (ns || '').toLowerCase();
    if (['runtime','authoring','backingservices'].includes(n)) return null;
    for (const sfx of ['-runtime','-authoring','-backingservices'])
        if (n.endsWith(sfx)) return ns.slice(0, ns.length - sfx.length);
    return null;
}

// Build { envName → { rt:[], au:[], bs:[] } } and clusterSvcs[] from a cluster
function _urlBuildServiceMap(c) {
    const services  = Array.isArray(c.services) ? c.services : [];
    const cloud     = c.cloud || 'ocp';
    const clusterSvcs = services.filter(s => URL_CLUSTER_KEYS.has(s.key));
    const seen        = new Set(clusterSvcs.map(s => s.key));

    const consoleUrl = c.headlamp_url || c.console_url;
    if (!seen.has('headlamp') && !seen.has('console') && consoleUrl)
        clusterSvcs.unshift({ key: cloud==='aws'?'headlamp':'console',
            label: cloud==='aws'?'Headlamp':'Console',
            icon:  cloud==='aws'?'headlamp':'openshift', url: consoleUrl });
    if (!seen.has('vault')  && c.vault_url)
        clusterSvcs.push({ key:'vault',  label:'Vault',  icon:'vault',  url:c.vault_url });
    if (!seen.has('argocd') && c.argocd_url)
        clusterSvcs.push({ key:'argocd', label:'ArgoCD', icon:'argocd', url:c.argocd_url });

    const envMap = {};
    services.filter(s => !URL_CLUSTER_KEYS.has(s.key)).forEach(s => {
        const role = _urlRoleOf(s.namespace);
        if (!role) return;
        const env = _urlEnvOf(s.namespace) || '__flat__';
        if (!envMap[env]) envMap[env] = { rt:[], au:[], bs:[] };
        envMap[env][role].push(s);
    });

    const envNames = Object.keys(envMap).sort((a,b) => {
        if (a === '__flat__') return 0;
        const am = a.toLowerCase().includes('mst'), bm = b.toLowerCase().includes('mst');
        if (am && !bm) return -1; if (!am && bm) return 1;
        return a.localeCompare(b);
    });

    return { clusterSvcs, envMap, envNames,
             isFlat: envNames.length === 1 && envNames[0] === '__flat__' };
}

// Render the right-hand service panel for one cluster (Design B)
// Render the RT/AU/BS service rows for one env (shared by both OCP and EKS layouts)
function _renderUrlEnvServices(envName, roleGroups, isFlat) {
    let html = '';
    URL_ROLE_ORDER.forEach(role => {
        const list = roleGroups[role];
        if (!list?.length) return;
        const meta = URL_ROLE_META[role];
        html += `<div class="usp-ns-row usp-ns-${meta.cls}" style="--ns-color:${meta.color}">`;
        html += `<div class="usp-ns-label">${meta.label}</div>`;
        html += `<div class="usp-svc-wrap">`;
        list.forEach(s => {
            html += `<a class="usp-svc" href="${s.url}" target="_blank" rel="noopener" title="${s.host||s.url}">
                <span class="ql-icon">${_serviceIcon(s.icon)}</span><span>${s.label}</span></a>`;
        });
        html += `</div></div>`;
    });
    return html;
}

// ── Header strip shared by both layouts ─────────────────────────────────────
function _renderUrlClusterHeader(c, clusterSvcs) {
    const isAws = (c.cloud || 'ocp') === 'aws';
    const cloudBadge = isAws
        ? `<span class="row-cloud-badge row-cloud-aws"><span class="row-cloud-dot"></span>EKS</span>`
        : `<span class="row-cloud-badge row-cloud-ocp"><span class="row-cloud-dot"></span>OCP</span>`;
    let html = `<div class="usp-head"><div class="usp-title-row">
        ${cloudBadge}
        <span class="usp-cluster-name">${c.short_name || c.full_name}</span>`;
    clusterSvcs.forEach(s => {
        html += `<a class="usp-action-btn usp-btn-${s.key}" href="${s.url}" target="_blank" rel="noopener">
            <span class="ql-icon">${_serviceIcon(s.icon)}</span>${s.label}</a>`;
    });
    html += `</div></div>`;
    return html;
}

// ══════════════════════════════════════════════════════════════════════════════
// OCP Layout — horizontal cluster tabs + left env rail + right service panel
// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// OCP Layout — Design A: accordion (clusters expand inline)
// First cluster auto-expanded; click header to toggle any cluster.
// ══════════════════════════════════════════════════════════════════════════════
function _urlsOcpToggle(clusterId) {
    if (!S.urlsExpandedOcpClusters) S.urlsExpandedOcpClusters = new Set();
    if (S.urlsExpandedOcpClusters.has(clusterId)) S.urlsExpandedOcpClusters.delete(clusterId);
    else S.urlsExpandedOcpClusters.add(clusterId);
    renderUrlsPage(document.getElementById('main-content'));
}

function _renderUrlsOcpLayout(clusters) {
    if (!clusters.length)
        return `<div class="empty-state"><div class="empty-state-msg">No OCP clusters configured.</div></div>`;

    // Auto-expand first cluster on first load
    if (!S.urlsExpandedOcpClusters) S.urlsExpandedOcpClusters = new Set();
    if (!S.urlsExpandedOcpClusters.size)
        S.urlsExpandedOcpClusters.add(clusters[0].cluster_id);

    let html = `<div class="uoa-wrap">`;

    clusters.forEach(c => {
        const { clusterSvcs, envMap, envNames } = _urlBuildServiceMap(c);
        const isOpen = S.urlsExpandedOcpClusters.has(c.cluster_id);
        const validEnvs = envNames.filter(e => URL_ROLE_ORDER.some(r => envMap[e][r]?.length));
        const totalSvcs = validEnvs.reduce((n, e) =>
            n + URL_ROLE_ORDER.reduce((m, r) => m + (envMap[e][r]?.length||0), 0), 0);

        // ── Cluster header row ────────────────────────────────────────────────
        html += `<div class="uoa-cluster ${isOpen?'open':''}">`;
        html += `<div class="uoa-cluster-hdr" onclick="_urlsOcpToggle('${c.cluster_id}')">
            <span class="uoa-chevron">${isOpen?'▾':'▸'}</span>
            <span class="ocp-cloud-badge"><span class="ocp-cloud-dot"></span>OCP</span>
            <span class="uoa-cluster-name">${c.short_name || c.full_name}</span>
            <span class="uoa-svc-total">${totalSvcs} services</span>
            <div class="uoa-cluster-actions" onclick="event.stopPropagation()">`;
        clusterSvcs.forEach(s => {
            html += `<a class="usp-action-btn usp-btn-${s.key}" href="${s.url}" target="_blank" rel="noopener">
                <span class="ql-icon">${_serviceIcon(s.icon)}</span>${s.label}</a>`;
        });
        html += `</div></div>`;

        // ── Expanded body ─────────────────────────────────────────────────────
        if (isOpen) {
            if (!validEnvs.length) {
                html += `<div class="uoa-body"><div class="usp-empty">No services discovered yet.</div></div>`;
            } else {
                html += `<div class="uoa-body">`;
                validEnvs.forEach(envName => {
                    const roleGroups = envMap[envName];
                    const total = URL_ROLE_ORDER.reduce((n,r) => n + (roleGroups[r]?.length||0), 0);
                    html += `<div class="uoa-env-block">`;
                    html += `<div class="uoa-env-hdr">
                        <span class="uoa-env-name">${envName}</span>
                        <span class="uoa-env-cnt">${total}</span>
                    </div>`;
                    URL_ROLE_ORDER.forEach(role => {
                        const list = roleGroups[role];
                        if (!list?.length) return;
                        const meta = URL_ROLE_META[role];
                        html += `<div class="usp-ns-row usp-ns-${meta.cls}" style="--ns-color:${meta.color}">`;
                        html += `<div class="usp-ns-label">${meta.label}</div>`;
                        html += `<div class="usp-svc-wrap">`;
                        list.forEach(s => {
                            html += `<a class="usp-svc" href="${s.url}" target="_blank" rel="noopener" title="${s.host||s.url}">
                                <span class="ql-icon">${_serviceIcon(s.icon)}</span><span>${s.label}</span></a>`;
                        });
                        html += `</div></div>`;
                    });
                    html += `</div>`; // uoa-env-block
                });
                html += `</div>`; // uoa-body
            }
        }

        html += `</div>`; // uoa-cluster
    });

    html += `</div>`; // uoa-wrap
    return html;
}

// ══════════════════════════════════════════════════════════════════════════════
// EKS Layout — left cluster rail + right service panel (flat namespaces)
// ══════════════════════════════════════════════════════════════════════════════
function _renderUrlsEksLayout(clusters) {
    if (!clusters.length)
        return `<div class="empty-state"><div class="empty-state-msg">No EKS clusters configured.</div></div>`;

    if (!S.urlsSelectedCluster || !clusters.find(c => c.cluster_id === S.urlsSelectedCluster))
        S.urlsSelectedCluster = clusters[0].cluster_id;
    const selected = clusters.find(c => c.cluster_id === S.urlsSelectedCluster) || clusters[0];
    const { clusterSvcs, envMap, envNames } = _urlBuildServiceMap(selected);

    let html = `<div class="usb-layout">`;

    // Left rail — cluster list
    html += `<div class="usb-rail">`;
    html += `<div class="usb-rail-head">Clusters</div>`;
    clusters.forEach(c => {
        const active = c.cluster_id === selected.cluster_id;
        const svcCount = (c.services||[]).filter(s=>!URL_CLUSTER_KEYS.has(s.key)).length;
        html += `<div class="usb-rail-item ${active?'active':''}"
            onclick="S.urlsSelectedCluster='${c.cluster_id}';renderUrlsPage($('main-content'))">
            <div class="usb-ri-name" title="${c.full_name}">${c.short_name || c.full_name}</div>
            <div class="usb-ri-meta">
                <span class="row-cloud-badge row-cloud-aws" style="font-size:9px;padding:1px 6px"><span class="row-cloud-dot"></span>EKS</span>
                <span class="usb-ri-ver">${c.ocp_version||''}</span>
                ${svcCount?`<span class="usb-ri-cnt">${svcCount}</span>`:''}
            </div>
        </div>`;
    });
    html += `</div>`;

    // Right panel — cluster header + flat NS services
    html += `<div class="usb-panel">`;
    html += _renderUrlClusterHeader(selected, clusterSvcs);
    if (envNames.length) {
        html += `<div class="usp-env-list" style="padding:16px 20px">`;
        envNames.forEach(envName => {
            const roleGroups = envMap[envName];
            const total = URL_ROLE_ORDER.reduce((n,r) => n + (roleGroups[r]?.length||0), 0);
            if (!total) return;
            html += `<div class="usp-env-card">`;
            html += _renderUrlEnvServices(envName, roleGroups, true);
            html += `</div>`;
        });
        html += `</div>`;
    } else {
        html += `<div class="usp-empty">No services discovered yet.</div>`;
    }
    html += `</div>`;

    html += `</div>`;
    return html;
}

// Entry point — routes to OCP or EKS layout based on the active cloud tab
function _renderUrlsDesignB(clusters) {
    if (!clusters.length)
        return `<div class="empty-state"><div class="empty-state-msg">No clusters configured.</div></div>`;
    const isAws = clusters.every(c => (c.cloud||'ocp') === 'aws');
    return isAws ? _renderUrlsEksLayout(clusters) : _renderUrlsOcpLayout(clusters);
}

// ── Helper: render Platform Tools panel ──────────────────────────────────
function _renderPlatformToolsPanel(links) {
    let sections = [];
    if (Array.isArray(links)) {
        const toolLinks = links.filter(l => l.icon !== 'openshift');
        if (toolLinks.length) sections = [{ label: 'All', icon: 'wrench', links: toolLinks }];
    } else if (links && typeof links === 'object') {
        sections = Object.values(links);
    }
    if (!sections.length) {
        return `<div class="pt-empty">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>
            <p>No platform tools configured.</p>
            <p class="pt-empty-hint">Set the <code>QUICK_LINKS</code> env var or update the <code>ocp-dashboard-config</code> ConfigMap.</p>
        </div>`;
    }
    let html = `<div class="pt-panel">`;
    sections.forEach(sec => {
        html += `<div class="pt-section-card">`;
        html += `<div class="pt-section-head">${_qlIcon(sec.icon || 'wrench')}<span>${sec.label || 'Tools'}</span></div>`;
        html += `<div class="pt-btn-grid">`;
        (sec.links || []).forEach(l => {
            html += `<a class="quick-link-btn pt-link-btn" href="${l.url}" target="_blank" rel="noopener">`;
            html += `<span class="ql-icon">${_qlIcon(l.icon)}</span><span>${l.label}</span></a>`;
        });
        html += `</div></div>`;
    });
    html += `</div>`;
    return html;
}

function renderUrlsPage(main) {
    const clusters = S.clusters || [];
    const links = S.quickLinks || {};

    // Determine which tabs exist
    const providerClusters = clusters.filter(_clusterMatchesProvider);
    const ocpClusters  = providerClusters.filter(c => (c.cloud || 'ocp') !== 'aws');
    const awsClusters  = providerClusters.filter(c => (c.cloud || 'ocp') === 'aws');
    const hasPlatform  = Array.isArray(links) ? links.length > 0 : Object.keys(links).length > 0;
    const hasOcp       = ocpClusters.length > 0;
    const hasAws       = awsClusters.length > 0;

    // When the header is already scoped to one cloud, only show that cloud + platform
    const showOcpTab  = S.provider !== 'aws'  && hasOcp;
    const showAwsTab  = S.provider !== 'ocp'  && hasAws;
    const showPlatTab = hasPlatform;

    // Resolve active tab — default to first available
    const availTabs = [
        showOcpTab  && 'ocp',
        showAwsTab  && 'aws',
        showPlatTab && 'platform',
    ].filter(Boolean);
    if (!availTabs.includes(S.urlsCloudTab)) S.urlsCloudTab = availTabs[0] || 'ocp';
    const active = S.urlsCloudTab;

    const ICON_OCP = QL_ICONS.openshift;
    const ICON_AWS = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6.5 17.5Q12 22 17.5 17.5" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round"/><path d="M4 14l2 1.5M20 14l-2 1.5" stroke="#22d3ee" stroke-width="2" stroke-linecap="round"/></svg>`;
    const ICON_PLAT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/></svg>`;

    let html = `<div class="urls-page">`;
    html += `<div class="urls-page-header">
        <h2 class="urls-page-title"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg> URLs</h2>
        <button class="toolbar-btn" onclick="exportUrlsPage()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export</button>
    </div>`;

    // ── Tab strip ─────────────────────────────────────────────────────────────
    if (availTabs.length > 1) {
        html += `<div class="urls-cloud-tabs">`;
        if (showOcpTab)  html += `<button class="urls-tab-btn ${active==='ocp'?'active':''}" onclick="S.urlsCloudTab='ocp';S.urlsSelectedCluster=null;S.urlsSelectedEnv=null;S.urlsExpandedOcpClusters=null;renderUrlsPage($('main-content'))">${ICON_OCP}<span>OpenShift</span><span class="urls-tab-count">${ocpClusters.length}</span></button>`;
        if (showAwsTab)  html += `<button class="urls-tab-btn ${active==='aws'?'active':''}" onclick="S.urlsCloudTab='aws';S.urlsSelectedCluster=null;S.urlsSelectedEnv=null;renderUrlsPage($('main-content'))">${ICON_AWS}<span>AWS EKS</span><span class="urls-tab-count">${awsClusters.length}</span></button>`;
        if (showPlatTab) html += `<button class="urls-tab-btn ${active==='platform'?'active':''}" onclick="S.urlsCloudTab='platform';renderUrlsPage($('main-content'))">${ICON_PLAT}<span>Platform Tools</span></button>`;
        html += `</div>`;
    }

    // ── Tab panel ─────────────────────────────────────────────────────────────
    html += `<div class="urls-tab-panel">`;
    if (active === 'platform') {
        html += _renderPlatformToolsPanel(links);
    } else {
        const tabClusters = active === 'aws' ? awsClusters : ocpClusters;
        html += _renderUrlsDesignB(tabClusters);
    }
    html += `</div>`;

    html += `</div>`;
    main.innerHTML = html;
}

function exportUrlsPage() {
    const clusters = (S.clusters || []).filter(_clusterMatchesProvider);
    const links = S.quickLinks || [];
    const sheets = [];
    if (Array.isArray(links)) {
        const toolRows = links.filter(l => l.icon !== 'openshift').map(l => ({ 'Label': l.label, 'URL': l.url }));
        if (toolRows.length) sheets.push({ name: 'Platform Tools', data: toolRows });
    } else if (links && typeof links === 'object') {
        Object.values(links).forEach(sec => {
            const rows = (sec.links || []).map(l => ({ 'Label': l.label, 'URL': l.url }));
            if (rows.length) sheets.push({ name: sec.label || 'Tools', data: rows });
        });
    }
    const isAws = S.provider === 'aws';
    if (isAws) {
        // One row per (cluster, discovered service) — much richer than a few fixed cols
        const rows = [];
        clusters.forEach(c => {
            const list = Array.isArray(c.services) ? c.services : [];
            if (c.headlamp_url && !list.some(s => s.key === 'headlamp')) {
                rows.push({ 'Cluster': c.full_name, 'Region': c.region || '', 'Service': 'Headlamp (Cluster UI)', 'Namespace': 'headlamp', 'URL': c.headlamp_url });
            }
            if (c.argocd_url && !list.some(s => s.key === 'argocd')) {
                rows.push({ 'Cluster': c.full_name, 'Region': c.region || '', 'Service': 'ArgoCD', 'Namespace': 'argocd', 'URL': c.argocd_url });
            }
            list.forEach(s => {
                rows.push({
                    'Cluster': c.full_name,
                    'Region': c.region || '',
                    'Service': s.label,
                    'Namespace': s.namespace || '',
                    'URL': s.url,
                });
            });
        });
        sheets.push({ name: 'AWS EKS Services', data: rows });
        exportMultiSheet(sheets, 'AWS_URLs.xlsx');
        return;
    }
    const clusterRows = clusters.map(c => ({
        'Cluster': c.full_name,
        'Short': c.short_name,
        'Console': c.console_url || '',
        'Vault': c.vault_url || '',
        'ArgoCD': c.argocd_url || '',
    }));
    sheets.push({ name: 'OCP Clusters', data: clusterRows });
    exportMultiSheet(sheets, 'OCP_URLs.xlsx');
}

// ============================================================
// CRDs Page — cross-cluster CRD comparison table
// ============================================================
if (!S._crdSearch) S._crdSearch = '';
function renderCrdsPage(main) {
    const clusters = (S.clusters || []).filter(_clusterMatchesProvider);
    let html = '<div class="urls-page">';
    html += `<div class="urls-page-header"><h2 class="urls-page-title"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg> CRD / Prerequisites</h2>`;
    html += `<div style="display:flex;align-items:center;gap:10px">`;
    html += `<input type="text" class="pod-search-input" placeholder="Search release name..." value="${S._crdSearch}" oninput="S._crdSearch=this.value;debounced('crdSearch',()=>renderCrdsPage($('main-content')))" style="min-width:220px">`;
    html += `<button class="toolbar-btn" onclick="exportCrdsPage()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export</button>`;
    html += `</div></div>`;

    if (clusters.length === 0) {
        html += '<div class="empty-state"><div class="empty-state-msg">No cluster data loaded yet.</div></div>';
        html += '</div>';
        main.innerHTML = html;
        return;
    }

    const allNames = new Set();
    const clusterMap = {};
    clusters.forEach(c => {
        const byName = {};
        (c.crd_releases || []).forEach(r => {
            allNames.add(r.name);
            byName[r.name] = r;
        });
        clusterMap[c.cluster_id] = { label: c.short_name, full: c.full_name, byName };
    });
    let sortedNames = [...allNames].sort();
    if (S._crdSearch) {
        const q = S._crdSearch.toLowerCase();
        sortedNames = sortedNames.filter(n => n.toLowerCase().includes(q));
    }
    const clusterIds = clusters.map(c => c.cluster_id);

    const crdNsList = [...new Set(clusters.map(c => c.crd_namespace || 'ms360-platform-crd'))];
    const crdNsLabel = crdNsList.length === 1 ? crdNsList[0] : crdNsList.join(', ');
    html += `<div class="crd-compare-info">${sortedNames.length} unique releases across ${clusters.length} clusters <span style="color:var(--text-muted);font-size:11px">(namespace: ${crdNsLabel})</span></div>`;
    html += '<div class="crd-compare-wrap"><table class="crd-compare-table"><thead><tr>';
    html += '<th class="crd-compare-th-name">Release Name</th>';
    clusterIds.forEach(cid => {
        const cm = clusterMap[cid];
        html += `<th class="crd-compare-th-cluster" title="${cm.full}">${cm.label}</th>`;
    });
    html += '</tr></thead><tbody>';

    sortedNames.forEach(name => {
        html += '<tr>';
        html += `<td class="crd-compare-name">${name}</td>`;
        const versions = new Set();
        clusterIds.forEach(cid => {
            const r = clusterMap[cid].byName[name];
            if (r) versions.add(r.chart_version || r.name);
        });
        const hasMismatch = versions.size > 1;
        clusterIds.forEach(cid => {
            const r = clusterMap[cid].byName[name];
            if (!r) {
                html += `<td class="crd-compare-cell crd-compare-missing">—</td>`;
            } else {
                const ver = r.chart_version || '';
                const stCls = r.status === 'deployed' ? 'crd-st-ok' : 'crd-st-warn';
                const mismatchCls = hasMismatch ? ' crd-compare-mismatch' : '';
                html += `<td class="crd-compare-cell${mismatchCls}"><span class="crd-compare-ver">${ver}</span> <span class="crd-status ${stCls}">${r.status}</span></td>`;
            }
        });
        html += '</tr>';
    });

    html += '</tbody></table></div></div>';
    main.innerHTML = html;
}

function exportCrdsPage() {
    const clusters = (S.clusters || []).filter(_clusterMatchesProvider);
    const rows = [];
    clusters.forEach(c => {
        (c.crd_releases || []).forEach(r => {
            rows.push({
                'Cluster': c.full_name,
                'Short Name': c.short_name,
                'CRD Namespace': c.crd_namespace || 'ms360-platform-crd',
                'Release Name': r.name,
                'Chart': r.chart || r.name,
                'Chart Version': r.chart_version || '',
                'Revision': r.revision,
                'Status': r.status,
            });
        });
    });
    exportToExcel(rows, 'CRD Releases', 'OCP_CRDs.xlsx');
}

function exportClusters() {
    const data = getFilteredClusters().map(c => ({
        'Cluster Name': c.full_name,
        'Short Name': c.short_name,
        'Cloud': (c.cloud || 'ocp') === 'aws' ? 'EKS' : 'OCP',
        'Region': c.region || '',
        'Status': c.status,
        'Version': c.ocp_version,
        ...nodeRolesToExcelCols(c),
        'Environments': c.total_envs,
        'Environment Names': (c.environments || []).join(', '),
        'Drops': c.drops.join(', '),
        'Console URL': c.console_url,
        'Vault URL': c.vault_url || '',
        'API URL': c.api_url,
    }));
    exportToExcel(data, 'Clusters', 'OCP_Clusters.xlsx');
}

// ============================================================
// LEVEL 1: Cluster Drill-down — flat env table + nodes table
// ============================================================
function getAllDropEnvs() { const all = []; S.drops.forEach(drop => drop.environments.forEach(e => all.push({...e, drop_version: drop.drop_version}))); return all; }

// Column definitions for the cluster env table (same pattern as env-table)
const CLUSTER_ENV_COLS = [
    { key: 'name',               label: 'Environment', filterable: true,  width: 160 },
    { key: 'drop_version',       label: 'Drop',        filterable: true,  width: 90  },
    { key: 'is_master',          label: 'Type',        filterable: true,  width: 85  },
    { key: 'bitbucket_branch',   label: 'Branch',      filterable: true,  width: 140 },
    { key: 'sanity_passrate',    label: 'Sanity %',    filterable: true,  width: 80  },
    { key: 'sanity_jar_version', label: 'JAR Version', filterable: true,  width: 120 },
    { key: 'env_owner',          label: 'Owner',       filterable: true,  width: 120 },
];

function _clusterEnvUniqueVals(col, allEnvs) {
    const vals = new Set();
    allEnvs.forEach(e => {
        let v = e[col];
        if (col === 'is_master') v = (v === true || v === 'true') ? 'Master' : 'Regular';
        if (v === undefined || v === null) v = '';
        vals.add(String(v));
    });
    return [...vals].sort();
}

function _getFilteredClusterEnvs(allEnvs) {
    let list = allEnvs;
    const cf = S.filters.clusterEnvColFilters || {};
    Object.keys(cf).forEach(col => {
        const sel = cf[col]; if (!sel || sel.length === 0) return;
        list = list.filter(e => {
            let v = e[col];
            if (col === 'is_master') v = (v === true || v === 'true') ? 'Master' : 'Regular';
            if (v === undefined || v === null) v = '';
            return sel.includes(String(v));
        });
    });
    if (S.filters.dropEnvSearch) {
        const q = S.filters.dropEnvSearch.toLowerCase();
        list = list.filter(e => e.name.toLowerCase().includes(q) || (e.env_owner||'').toLowerCase().includes(q) || (e.drop_version||'').toLowerCase().includes(q));
    }
    const s = S.filters.clusterEnvSort || { col: 'name', dir: 'asc' };
    if (s.col) {
        const dir = s.dir === 'desc' ? -1 : 1;
        list = list.slice().sort((a, b) => {
            let va = a[s.col], vb = b[s.col];
            if (s.col === 'is_master') { va = (va === true || va === 'true') ? 1 : 0; vb = (vb === true || vb === 'true') ? 1 : 0; }
            else if (s.col === 'sanity_passrate') { va = a.sanity_passrate_value || 0; vb = b.sanity_passrate_value || 0; }
            else { va = String(va || '').toLowerCase(); vb = String(vb || '').toLowerCase(); }
            if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0;
        });
    }
    return list;
}

function _clusterEnvHeadRow(allEnvs) {
    const s = S.filters.clusterEnvSort || { col: 'name', dir: 'asc' };
    const cf = S.filters.clusterEnvColFilters || {};
    return CLUSTER_ENV_COLS.map(c => {
        const arrow = s.col === c.key ? (s.dir === 'asc' ? ' ↑' : ' ↓') : '';
        const hasFilter = cf[c.key] && cf[c.key].length > 0;
        const filterIcon = c.filterable ? `<span class="col-filter-icon-wrap ${hasFilter?'active':''}" onclick="showClusterEnvColFilter('${c.key}',event)">${ICON_COL_FILTER}</span>` : '';
        return `<th class="sortable-th env-table-th" data-col-key="${c.key}" ${resizableThStyle('cluster-env', c)} onclick="toggleClusterEnvSort('${c.key}')">${filterIcon}${c.label}${arrow}${colResizerHtml()}</th>`;
    }).join('');
}

function toggleClusterEnvSort(col) {
    if (!S.filters.clusterEnvSort) S.filters.clusterEnvSort = { col: 'name', dir: 'asc' };
    if (S.filters.clusterEnvSort.col === col) S.filters.clusterEnvSort.dir = S.filters.clusterEnvSort.dir === 'asc' ? 'desc' : 'asc';
    else { S.filters.clusterEnvSort.col = col; S.filters.clusterEnvSort.dir = 'asc'; }
    _rerenderClusterEnvTable();
    savePrefs();
}

function showClusterEnvColFilter(col, event) {
    if (!S.filters.clusterEnvColFilters) S.filters.clusterEnvColFilters = {};
    const allEnvs = getAllDropEnvs();
    showGenericColFilter(col, 'S.filters.clusterEnvColFilters', _clusterEnvUniqueVals(col, allEnvs), "_rerenderClusterEnvTable()", event);
}

function _clusterEnvRow(e) {
    const passrateCell = sanityChip(e.sanity_passrate, e.sanity_passrate_value, e.sanity_passed_tests, e.sanity_total_tests);
    const typeCell = (e.is_master === true || e.is_master === 'true') ? '<span class="master-badge">MASTER</span>' : '<span style="color:var(--text-muted)">Regular</span>';
    const ownerCell = (e.env_owner === 'Free' || !e.env_owner) ? '<span class="owner-badge free">Free</span>' : `<span class="owner-badge">${e.env_owner}</span>`;
    return `<tr>
        <td class="env-tbl-cell env-tbl-name"><a style="cursor:pointer" onclick="navigateToEnvFromDrop('${e.drop_version}','${e.datacenter}','${e.env_id}','${e.name}')">${e.name}</a></td>
        <td class="env-tbl-cell"><span class="drop-version-tag" style="font-size:11px;padding:2px 10px">${e.drop_version}</span></td>
        <td class="env-tbl-cell">${typeCell}</td>
        <td class="env-tbl-cell branch-cell">${e.bitbucket_branch || 'N/A'}</td>
        <td class="env-tbl-cell">${passrateCell}</td>
        <td class="env-tbl-cell jar-cell">${e.sanity_jar_version || 'N/A'}</td>
        <td class="env-tbl-cell">${ownerCell}<span class="owner-edit-btn" title="Change owner" onclick="showOwnerDialog('${e.datacenter}','${e.env_id}','${e.env_owner||'Free'}')">${ICON_EDIT}</span></td>
    </tr>`;
}

function _clusterEnvActiveFilters() {
    const pills = _colFilterPills(S.filters.clusterEnvColFilters || {}, CLUSTER_ENV_COLS, 'removeClusterEnvColFilter');
    if (S.filters.dropEnvSearch) pills.push({ label: 'Search', value: S.filters.dropEnvSearch, clearFn: "S.filters.dropEnvSearch='';_rerenderClusterEnvTable()" });
    return pills;
}
function removeClusterEnvColFilter(col, val) {
    const cf = S.filters.clusterEnvColFilters; if (!cf || !cf[col]) return;
    cf[col] = cf[col].filter(v => v !== val);
    if (cf[col].length === 0) delete cf[col];
    _rerenderClusterEnvTable();
}
function clearAllClusterEnvFilters() { S.filters.clusterEnvColFilters = {}; S.filters.dropEnvSearch = ''; _rerenderClusterEnvTable(); savePrefs(); }

function _rerenderClusterEnvTable() {
    const tbody = $('cluster-env-tbody'); const thead = $('cluster-env-thead');
    if (!tbody) return;
    const allEnvs = getAllDropEnvs();
    if (thead) thead.innerHTML = _clusterEnvHeadRow(allEnvs);
    const filtered = _getFilteredClusterEnvs(allEnvs);
    const countEl = $('cluster-env-count');
    if (countEl) countEl.textContent = `${filtered.length} of ${allEnvs.length} environments`;
    tbody.innerHTML = filtered.length === 0
        ? `<tr class="empty-row"><td colspan="${CLUSTER_ENV_COLS.length}"><div class="empty-state"><div class="empty-state-msg">No environments match the current filters.</div><button class="empty-state-btn" onclick="clearAllClusterEnvFilters()">Clear filters</button></div></td></tr>`
        : filtered.map(_clusterEnvRow).join('');
    const afBar = $('cluster-env-active-filters');
    if (afBar) afBar.outerHTML = _clusterEnvActiveFiltersHtml();
    const searchEl = $('drop-env-search');
    if (searchEl) searchEl.value = S.filters.dropEnvSearch;
}
function _clusterEnvActiveFiltersHtml() {
    const pills = _clusterEnvActiveFilters();
    return `<div id="cluster-env-active-filters">${activeFiltersBar(pills, "clearAllClusterEnvFilters()")}</div>`;
}

function renderDropsOverview(main) {
    let html = '';
    if (S.currentCluster) {
        const c = S.currentCluster;
        html += `<div class="cluster-info-banner">
            <div class="cib-item"><div class="cib-icon">&#9741;</div><div class="cib-text"><span class="cib-label">Cluster</span><span class="cib-val" title="${c.full_name}">${c.short_name || c.full_name}</span></div></div>
            <div class="cib-div"></div>
            <div class="cib-item"><div class="cib-icon ocp">&#9881;</div><div class="cib-text"><span class="cib-label">${(c.cloud||'ocp')==='aws' ? 'K8s Version' : 'OCP Version'}</span><span class="cib-val ocp-ver">${c.ocp_version}</span></div></div>
            <div class="cib-div"></div>
            <div class="cib-item"><div class="cib-icon">&#9635;</div><div class="cib-text"><span class="cib-label">Nodes</span><span class="cib-val">${fmtNodeRoles(c)}</span></div></div>
            <div class="cib-div"></div>
            <div class="cib-item"><a class="drop-link" href="${c.console_url}" target="_blank">Open Console</a></div>
        </div>`;
    }

    if (!S.filters.clusterEnvSort) S.filters.clusterEnvSort = { col: 'name', dir: 'asc' };
    if (!S.filters.clusterEnvColFilters) S.filters.clusterEnvColFilters = {};
    const allEnvs = getAllDropEnvs();
    const filtered = _getFilteredClusterEnvs(allEnvs);

    html += `<div class="mini-toolbar">
        <span class="toolbar-title" style="font-size:13px">Environments</span>
        <input type="text" class="pod-search-input" id="drop-env-search" placeholder="Search env, owner, drop..." value="${S.filters.dropEnvSearch}" oninput="S.filters.dropEnvSearch=this.value;debounced('dropEnvSearch',()=>_rerenderClusterEnvTable())" style="min-width:220px">
        <span class="toolbar-count" id="cluster-env-count">${filtered.length} of ${allEnvs.length} environments</span>
        <span class="mini-toolbar-spacer"></span>
        ${resetWidthsBtn('cluster-env')}
        ${exportBtn("exportDropsEnvs()",'Export')}
    </div>`;
    html += _clusterEnvActiveFiltersHtml();

    const clusterEnvBody = filtered.length === 0
        ? `<tr class="empty-row"><td colspan="${CLUSTER_ENV_COLS.length}">
            <div class="empty-state">
                <div class="empty-state-msg">No environments match the current filters.</div>
                <button class="empty-state-btn" onclick="clearAllClusterEnvFilters()">Clear filters</button>
            </div></td></tr>`
        : filtered.map(_clusterEnvRow).join('');
    html += `<div class="table-container"><div class="table-scroll"><table class="env-overview-table resizable-table" data-colw-key="cluster-env">
        <thead><tr id="cluster-env-thead">${_clusterEnvHeadRow(allEnvs)}</tr></thead>
        <tbody id="cluster-env-tbody">${clusterEnvBody}</tbody>
    </table></div></div>`;

    // Cluster Nodes section (TABLE, collapsible)
    if (S.currentCluster) {
        const nc = S.sectionCollapsed.nodes;
        const nodeCount = S.clusterNodes.length;
        html += `<div class="section" id="nodes-section" style="margin-top:24px">
            <div class="section-header collapsible-header" onclick="toggleSection('nodes')">
                <h2><span class="drop-chevron ${nc?'':'expanded'}" id="section-chevron-nodes">&#9654;</span> Cluster Nodes <span class="badge">${nodeCount}</span></h2>
                <div class="section-header-actions" onclick="event.stopPropagation()">${exportBtn("exportNodes()",'Export')}</div>
                </div>
            <div id="section-body-nodes" class="section-collapsible ${nc?'collapsed':''}">`;
        if (nodeCount > 0) {
            html += `<div class="pod-filters-bar">
                    <input type="text" class="pod-search-input" id="node-search" placeholder="Search node name or role..." value="${S.nodeSearch}" oninput="S.nodeSearch=this.value;debounced('nodeSearch',()=>{renderNodeTable();_updateNodeActiveFilters()})" style="min-width:220px">
                    <span class="toolbar-count" id="node-filter-count"></span>
                </div>
                <div id="node-active-filters"></div>
                <div class="table-container"><div class="table-scroll"><table class="env-overview-table">
                    <thead><tr id="node-thead">${_nodeTableHeadRow()}</tr></thead>
                    <tbody id="node-tbody"></tbody>
                </table></div></div>`;
        } else {
            html += `<div style="padding:24px;text-align:center;color:var(--text-muted)">
                <p style="font-size:14px">No node data available.</p>
                <p style="font-size:12px;margin-top:4px">The service account may not have permission to list cluster nodes. Check RBAC (ClusterRole needs <code>list</code> on <code>nodes</code> and <code>pods</code>).</p>
            </div>`;
        }
        html += `</div></div>`;
    }

    main.innerHTML = html;
    if (S.currentCluster && S.clusterNodes.length > 0) setTimeout(() => { renderNodeTable(); _updateNodeActiveFilters(); }, 0);
}
function toggleSection(name) {
    S.sectionCollapsed[name] = !S.sectionCollapsed[name];
    const body = document.getElementById(`section-body-${name}`);
    const chevron = document.getElementById(`section-chevron-${name}`);
    if (body) body.classList.toggle('collapsed', S.sectionCollapsed[name]);
    if (chevron) chevron.classList.toggle('expanded', !S.sectionCollapsed[name]);
    savePrefs();
}

function exportDropsEnvs() {
    const allEnvs = getAllDropEnvs(); const filtered = _getFilteredClusterEnvs(allEnvs); const c = S.currentCluster;
    const clusterInfo = c ? { 'Cluster': c.full_name, 'OCP Version': c.ocp_version, ...nodeRolesToExcelCols(c) } : {};
    const data = filtered.map(e => ({ ...clusterInfo, 'Drop': e.drop_version, 'Environment': e.name, 'Owner': e.env_owner, 'Branch': e.bitbucket_branch, 'Master': (e.is_master === true || e.is_master === 'true') ? 'Yes' : 'No', 'Sanity Pass Rate': e.sanity_passrate, 'JAR Version': e.sanity_jar_version || 'N/A' }));
    exportToExcel(data, 'Environments', `OCP_Envs_${c ? c.short_name : 'All'}.xlsx`);
}

function navigateToEnvFromDrop(dropVersion, dc, envId, envName) { navigate('env-detail', { datacenter: dc, env_id: envId, name: envName }); }


// ============================================================
// NODE TABLE (shared by drops & env views)
// ============================================================
const NODE_COLS = [
    { key: 'name',    label: 'Node Name', sortable: true,  filterable: true },
    { key: 'role',    label: 'Role',      sortable: true,  filterable: true },
    { key: 'status',  label: 'Status',    sortable: true,  filterable: true },
    { key: 'cpu',     label: 'CPU %',     sortable: true,  filterable: false },
    { key: 'memory',  label: 'Memory %',  sortable: true,  filterable: false },
    { key: 'cpu_cap', label: 'Total CPU',  sortable: true,  filterable: true },
    { key: 'mem_cap', label: 'Total Mem',  sortable: true,  filterable: true },
    { key: 'pods',    label: 'Pods',      sortable: true,  filterable: false },
    { key: 'version', label: 'Version',   sortable: true,  filterable: true },
];
function _nodeUniqueVals(col) {
    const nodes = S.clusterNodes || [];
    const map = {
        name: n => n.name || '', role: n => n.role || '', status: n => n.status || '',
        cpu_cap: n => n.cpu_capacity || '', mem_cap: n => n.mem_capacity || '',
        version: n => n.kubelet_version || '',
    };
    const fn = map[col] || (n => String(n[col] || ''));
    return [...new Set(nodes.map(fn))].sort();
}
function showNodeColFilter(col, event) {
    showGenericColFilter(col, 'S.nodeColFilters', _nodeUniqueVals(col), "renderNodeTable();_updateNodeActiveFilters()", event);
}

function _nodeTableHeadRow() {
    const cf = S.nodeColFilters || {};
    return NODE_COLS.map(c => {
        const hasFilter = cf[c.key] && cf[c.key].length > 0;
        const filterIcon = c.filterable ? `<span class="col-filter-icon-wrap ${hasFilter?'active':''}" onclick="showNodeColFilter('${c.key}',event)">${ICON_COL_FILTER}</span>` : '';
        if (!c.sortable) return `<th class="env-table-th">${filterIcon}${c.label}</th>`;
        const arrow = S.nodeSortBy === c.key ? (S.nodeSortDir === 'asc' ? ' ↑' : ' ↓') : '';
        return `<th class="sortable-th env-table-th" onclick="toggleNodeSort('${c.key}')">${filterIcon}${c.label}${arrow}</th>`;
    }).join('');
}

function toggleNodeSort(key) {
    if (S.nodeSortBy === key) S.nodeSortDir = S.nodeSortDir === 'asc' ? 'desc' : 'asc';
    else { S.nodeSortBy = key; S.nodeSortDir = key === 'name' || key === 'role' ? 'asc' : 'desc'; }
    renderNodeTable();
}

function renderNodeTable() {
    const tbody = $('node-tbody'); if (!tbody) return;
    const thead = $('node-thead'); if (thead) thead.innerHTML = _nodeTableHeadRow();
    let nodes = S.clusterNodes || [];
    const totalBefore = nodes.length;
    const cf = S.nodeColFilters || {};
    Object.keys(cf).forEach(col => {
        const sel = cf[col]; if (!sel || sel.length === 0) return;
        const map = {
            name: n => n.name || '', role: n => n.role || '', status: n => n.status || '',
            cpu_cap: n => n.cpu_capacity || '', mem_cap: n => n.mem_capacity || '',
            version: n => n.kubelet_version || '',
        };
        const fn = map[col] || (n => String(n[col] || ''));
        nodes = nodes.filter(n => sel.includes(fn(n)));
    });
    if (S.nodeSearch) { const q = S.nodeSearch.toLowerCase(); nodes = nodes.filter(n => n.name.toLowerCase().includes(q) || (n.role||'').toLowerCase().includes(q) || (n.status||'').toLowerCase().includes(q)); }
    nodes = _sortItems(nodes, S.nodeSortBy, S.nodeSortDir, { name: n=>n.name, role: n=>n.role||'', status: n=>n.status||'', cpu: n=>n.cpu_usage_pct||0, memory: n=>n.mem_usage_pct||0, cpu_cap: n=>n.cpu_capacity||'', mem_cap: n=>n.mem_capacity||'', pods: n=>n.pods_count||0, version: n=>n.kubelet_version||'' });
    const countEl = $('node-filter-count');
    if (countEl) countEl.textContent = `${nodes.length} of ${totalBefore} nodes`;
    tbody.innerHTML = nodes.map(n => `<tr>
        <td class="env-tbl-cell" style="font-weight:600;color:var(--text-primary);font-size:12px">${n.name}</td>
        <td class="env-tbl-cell"><span class="role-badge ${n.role}">${n.role}</span></td>
        <td class="env-tbl-cell">${badge(n.status, n.status.toLowerCase())}</td>
        <td class="env-tbl-cell">${usageBar(n.cpu_usage_pct)}</td>
        <td class="env-tbl-cell">${usageBar(n.mem_usage_pct)}</td>
        <td class="env-tbl-cell">${n.cpu_capacity} cores</td>
        <td class="env-tbl-cell">${n.mem_capacity}</td>
        <td class="env-tbl-cell">${n.pods_count}</td>
        <td class="env-tbl-cell" style="font-size:11px">${n.kubelet_version}</td>
    </tr>`).join('');
}

function _updateNodeActiveFilters() {
    const el = $('node-active-filters'); if (!el) return;
    const pills = _genericColFilterPills(S.nodeColFilters || {}, NODE_COLS, 'S.nodeColFilters', "renderNodeTable();_updateNodeActiveFilters()");
    if (S.nodeSearch) pills.push({ label: 'Search', value: S.nodeSearch, clearFn: "S.nodeSearch='';document.getElementById('node-search').value='';renderNodeTable();_updateNodeActiveFilters()" });
    el.innerHTML = activeFiltersBar(pills, "clearAllNodeFilters()");
}
function clearAllNodeFilters() {
    S.nodeSearch = ''; S.nodeColFilters = {};
    const searchEl = $('node-search'); if (searchEl) searchEl.value = '';
    renderNodeTable(); _updateNodeActiveFilters();
}

function exportNodes() {
    const nodes = S.clusterNodes || [];
    const clusterName = S.currentCluster ? S.currentCluster.full_name : 'cluster';
    exportToExcel(nodes.map(n => ({ 'Node Name': n.name, 'Role': n.role, 'Status': n.status, 'CPU %': n.cpu_usage_pct, 'Memory %': n.mem_usage_pct, 'CPU Cap': n.cpu_capacity, 'Mem Cap': n.mem_capacity, 'Pods': n.pods_count, 'OS Image': n.os_image, 'Kubelet': n.kubelet_version })), 'Nodes', `Nodes_${clusterName}.xlsx`);
}

// ============================================================
// LEVEL 2: Environment Detail
// ============================================================
function renderEnvDetail(main, summaryOnly) {
    const d = S.envData; if (!d) return;
    const meta = d.env_metadata || {};
    const sanity = d.sanity || {};
    const pass = sanity.sanity_passrate_value >= d.threshold;
    const hasPods = !summaryOnly && d.summary;
    let html = '<div class="env-detail-page">';

    html += `<div class="toolbar compact"><div class="toolbar-left"><span class="toolbar-title">${d.environment}</span></div><div class="toolbar-right">${exportBtn("exportFullEnv()",'Export Full Environment')}</div></div>`;

    html += `<div class="env-info-banner">
        <div class="eib-item"><div class="eib-icon">&#9830;</div><div class="eib-text"><span class="eib-label">Drop</span><span class="eib-val drop-version">${meta.drop_version||'N/A'}</span></div></div>
        <div class="eib-div"></div>
        <div class="eib-item"><div class="eib-icon br">&#9734;</div><div class="eib-text"><span class="eib-label">Branch</span>${meta.bitbucket_repo_url?`<a class="eib-val branch-link" href="${meta.bitbucket_repo_url}" target="_blank">${meta.bitbucket_branch}</a>`:`<span class="eib-val">${meta.bitbucket_branch||'N/A'}</span>`}</div></div>
        <div class="eib-div"></div>
        <div class="eib-item"><div class="eib-icon ow">&#9679;</div><div class="eib-text"><span class="eib-label">Owner</span><span class="eib-val owner-badge ${(meta.env_owner==='Free'||!meta.env_owner)?'free':''}">${meta.env_owner||'Free'}</span><span class="owner-edit-btn" title="Change owner" onclick="showOwnerDialog('${S.currentEnv.datacenter}','${S.currentEnv.env_id}','${meta.env_owner||'Free'}')">${ICON_EDIT}</span></div></div>
        <div class="eib-div"></div>
        <div class="eib-item"><div class="eib-icon">&#9638;</div><div class="eib-text"><span class="eib-label">Environment</span><span class="eib-val">${d.environment}</span></div></div>
        ${meta.jenkins_deploy_pipeline ? `<div class="eib-div"></div><div class="eib-item"><a class="drop-link sm" href="${meta.jenkins_deploy_pipeline}" target="_blank">Deploy Pipeline</a><a class="drop-link sm" href="${meta.jenkins_automation_pipeline||'#'}" target="_blank">Automation</a></div>` : ''}
    </div>`;

    const icon = pass ? '&#10003;' : '&#10007;';
    html += `<div class="sanity-banner ${pass?'pass':'fail'}">
        <div class="sanity-left"><div class="sanity-icon">${icon}</div><div class="sanity-info"><h3>Sanity Test Pass Rate</h3><div class="sanity-rate">${sanity.sanity_passrate}</div><div class="sanity-threshold">Threshold: ${d.threshold}% ${pass?'- PASSED':'- FAILED'}</div></div></div>
        <div class="sanity-meta">
            <div class="sm-item"><label>Total</label><span>${sanity.total_tests}</span></div>
            <div class="sm-item"><label>Passed</label><span>${sanity.passed_tests}</span></div>
            <div class="sm-item"><label>Failed</label><span style="color:var(--accent-red)">${sanity.failed_tests||0}</span></div>
            <div class="sm-item"><label>JAR Version</label><span class="jar-cell">${sanity.sanity_jar_version||'N/A'}</span></div>
            <div class="sm-item"><label>Suite</label><span>${sanity.suite}</span></div>
            <div class="sm-item"><label>Triggered by</label><span class="deploy-triggered-by">${sanity.triggered_by||'N/A'}</span></div>
            <div class="sm-item"><label>Last Run</label><span>${fmt(sanity.last_run)}</span></div>
            ${sanity.jenkins_build_url?`<a class="sanity-jenkins-btn" href="${sanity.jenkins_build_url}" target="_blank">Jenkins #${sanity.jenkins_build_number}</a>`:''}
        </div>
    </div>`;

    if (sanity.history && sanity.history.length > 0) {
        html += `<div class="section"><div class="section-header"><h2>Sanity History <span class="badge">Last ${sanity.history.length} builds</span></h2><div class="section-header-actions">${exportBtn("exportSanityHistory()",'Export')}</div></div>
        <div class="table-container"><div class="table-scroll"><table><thead><tr><th>Build #</th><th>Pass Rate</th><th>Total</th><th>Passed</th><th>Failed</th><th>JAR Version</th><th>Triggered by</th><th>Timestamp</th><th>Jenkins URL</th></tr></thead><tbody>`;
        sanity.history.forEach(h => { const hp = h.sanity_passrate_value >= d.threshold; html += `<tr><td>${h.jenkins_build_number}</td><td><span class="sanity-inline ${hp?'pass':'fail'}">${h.sanity_passrate}</span></td><td>${h.total_tests}</td><td>${h.passed_tests}</td><td style="color:var(--accent-red)">${h.failed_tests||0}</td><td class="jar-cell">${h.sanity_jar_version||'N/A'}</td><td class="deploy-triggered-by">${h.triggered_by||'N/A'}</td><td>${fmt(h.last_run)}</td><td>${h.jenkins_build_url?`<a class="drop-link sm" href="${h.jenkins_build_url}" target="_blank">View</a>`:''}</td></tr>`; });
        html += '</tbody></table></div></div></div>';
    }

    // Product HF Versions — Option D: per-namespace 3-column comparison
    html += _renderProductVersionsByNs(d.product_versions || {});

    const cdf = d.catalog_data_files || {};
    html += `<div class="section"><div class="section-header"><h2>Catalog Data Files <span class="badge">deployed via Jenkins</span></h2></div>
        <div class="table-container"><div class="table-scroll"><table><thead><tr><th>Item</th><th>File Name</th><th>Deployed By</th><th>Timestamp</th><th>Jenkins</th></tr></thead><tbody>
            <tr><td>Custom Data ZIP</td><td class="jar-cell">${cdf.custom_data_zip||'N/A'}</td><td class="deploy-triggered-by">${cdf.deployed_by||'N/A'}</td><td>${fmt(cdf.deploy_timestamp)}</td><td>${cdf.jenkins_data_deploy_url?`<a class="drop-link sm" href="${cdf.jenkins_data_deploy_url}" target="_blank">View</a>`:''}</td></tr>
            <tr><td>Custom BP ZIP</td><td class="jar-cell">${cdf.custom_bp_zip||'N/A'}</td><td class="deploy-triggered-by">${cdf.deployed_by||'N/A'}</td><td>${fmt(cdf.deploy_timestamp)}</td><td></td></tr>
        </tbody></table></div></div></div>`;

    const ns = d.namespaces;
    html += `<div class="section"><div class="section-header"><h2>Last Jenkins Deployment <span class="badge">per namespace</span></h2><div class="section-header-actions">${exportBtn("exportDeployments()",'Export')}</div></div>
    <div class="table-container"><div class="table-scroll"><table><thead><tr><th>Namespace</th><th>Status</th><th>Build #</th><th>Ran by</th><th>Timestamp</th><th>Jenkins</th></tr></thead><tbody>`;
    ['runtime','authoring','backingservices'].forEach(k => {
        const dep = (ns[k]||{}).deployment||{};
        const st = (dep.jenkins_deploy_status||'N/A').toLowerCase();
        const sc = st==='success'?'success':st==='failure'?'failure':st==='unstable'?'unstable':'unknown';
        html += `<tr><td><span class="ns-badge ${k}">${k}</span></td><td><span class="deploy-status ${sc}">${dep.jenkins_deploy_status||'N/A'}</span></td><td>${dep.jenkins_deploy_build_number||'N/A'}</td><td class="deploy-triggered-by">${dep.triggered_by||'N/A'}</td><td>${fmt(dep.jenkins_deploy_timestamp)}</td><td>${dep.jenkins_deploy_url?`<a class="drop-link sm" href="${dep.jenkins_deploy_url}" target="_blank">View</a>`:''}</td></tr>`;
    });
    html += '</tbody></table></div></div></div>';

    // Ingress (collapsible, with column filters & sorting)
    S.ingressColFilters = {};
    S.ingressSort = { col: 'name', dir: 'asc' };
    const ic = S.sectionCollapsed.ingress;
    const filteredIngress = _getFilteredIngress();
    html += `<div class="section"><div class="section-header collapsible-header" onclick="toggleSection('ingress')">
        <h2><span class="drop-chevron ${ic?'':'expanded'}" id="section-chevron-ingress">&#9654;</span> Ingress / Routes <span class="badge" id="ingress-badge">${filteredIngress.length}</span></h2>
        <div class="section-header-actions" onclick="event.stopPropagation()">${resetWidthsBtn('ingress')}${exportBtn("exportIngress()",'Export')}</div></div>
    <div id="section-body-ingress" class="section-collapsible ${ic?'collapsed':''}">
    <div id="ingress-active-filters"></div>
    <div class="table-container"><div class="table-scroll"><table class="resizable-table" data-colw-key="ingress"><thead id="ingress-thead"><tr>${_ingressHeadRow()}</tr></thead><tbody id="ingress-tbody">`;
    html += filteredIngress.length === 0
        ? `<tr class="empty-row"><td colspan="${INGRESS_COLS.length}"><div class="empty-state"><div class="empty-state-msg">No routes match the current filters.</div><button class="empty-state-btn" onclick="clearAllIngressFilters()">Clear filters</button></div></td></tr>`
        : filteredIngress.map(_ingressRow).join('');
    html += '</tbody></table></div></div></div></div>';

    // Pod summary cards (counts only — fast). The full pod list has been
    // removed from env-detail intentionally: it was the single biggest source
    // of slowness on envs with 250+ pods, and the actionable info (which
    // pods are unhealthy) is shown right below in the Unhealthy callout.
    html += _renderPodSummary(d.summary || {}, ns, d.unhealthy_pods || []);

    html += '</div>';
    main.innerHTML = html;
}

// ------------------------------------------------------------------
// Option D: Product Versions — per-namespace 3-column comparison view.
// Backend's `product_versions.by_ns` carries one entry per NS (rt/au/bs)
// with that NS's deployed values, plus a `divergent` array marking the
// product keys whose versions disagree across NSs.
// ------------------------------------------------------------------
function _renderProductVersionsByNs(pv) {
    const PRODUCTS = [
        { key: 'baseline',   label: 'Baseline'        },
        { key: 'platform',   label: 'Platform'        },
        { key: 'catalog',    label: 'Catalog'         },
        { key: 'csr',        label: 'CSR'             },
        { key: 'oc',         label: 'OC'              },
        { key: 'oh',         label: 'OH'              },
        { key: 'care',       label: 'Care'            },
        { key: 'mass',       label: 'MASS'            },
        { key: 'd1_suite',   label: 'D1 Suite (CEP)'  },
        { key: 'backoffice', label: 'Backoffice'      },
        { key: 'mpp',        label: 'MPP'             },
    ];
    const NS_ROLES = [
        { role: 'rt', label: 'Runtime',         cls: 'ns-rt' },
        { role: 'au', label: 'Authoring',       cls: 'ns-au' },
        { role: 'bs', label: 'BackingServices', cls: 'ns-bs' },
    ];
    const byNs = pv.by_ns || {};
    const divergent = new Set(pv.divergent || []);
    const hasAny = PRODUCTS.some(p => NS_ROLES.some(r => byNs[r.role] && byNs[r.role][p.key]));
    const cell = (role, key) => {
        const v = byNs[role] ? (byNs[role][key] || '') : '';
        if (!v) return `<span class="dash">—</span>`;
        const hf = byNs[role] ? (byNs[role][`${key}_hf`] || '') : '';
        const hfHtml = hf ? `<span class="pv-hf" title="Hotfix #${hf}">HF#${hf}</span>` : '';
        const div = divergent.has(key) ? ' divergent' : '';
        return `<span class="pv-cell-stack${div}"><span class="pv-pill">${v}</span>${hfHtml}</span>`;
    };
    let html = `<div class="section"><div class="section-header"><h2>Product Versions
            <span class="badge">${hasAny ? 'per namespace' : 'N/A'}</span>
            ${divergent.size ? `<span class="badge danger" title="${divergent.size} product(s) differ across namespaces">⚠ ${divergent.size} divergent</span>` : ''}
        </h2></div>`;
    if (!hasAny) {
        html += `<div style="padding:16px;color:var(--text-muted)">No product version data available. Versions are populated after a deployment run.</div></div>`;
        return html;
    }
    html += `<div class="table-container"><div class="table-scroll"><table class="pv-compare-table">
        <thead><tr>
            <th class="pv-product-col">Product</th>
            ${NS_ROLES.map(r => `<th><span class="ns-pill ${r.cls}">${r.role.toUpperCase()}</span> ${r.label}</th>`).join('')}
        </tr></thead><tbody>`;
    PRODUCTS.forEach(p => {
        const isDiv = divergent.has(p.key);
        const lblCls = isDiv ? ' divergent' : '';
        html += `<tr class="${isDiv ? 'pv-row-divergent' : ''}">
            <td class="pv-product-name${lblCls}">${p.label}${isDiv ? ' <span class="pv-divergent-mark" title="Versions differ across namespaces">⚠</span>' : ''}</td>
            ${NS_ROLES.map(r => `<td class="pv-cell">${cell(r.role, p.key)}</td>`).join('')}
        </tr>`;
    });
    if (pv.last_update) {
        html += `<tr><td class="muted">Last Updated</td><td colspan="3" class="muted">${fmt(pv.last_update)}</td></tr>`;
    }
    html += `</tbody></table></div></div></div>`;
    return html;
}

function _renderPodSummary(sm, ns, unhealthy) {
    const total = sm.total_pods || 0;
    const running = sm.running_pods || 0;
    const failed = sm.failed_pods || 0;
    let html = `<div class="summary-grid" id="summary-cards">
        ${sumCard('Total Pods', total, `${running} running`, 'blue')}
        ${sumCard('Running', running, total>0?`${((running/total)*100).toFixed(1)}% healthy`:'', 'green')}
        ${sumCard('Failed', failed, failed>0?'Needs attention':'All healthy', failed>0?'red':'green')}
        ${sumCard('Runtime', ns.runtime?ns.runtime.pod_count:0, `${ns.runtime?ns.runtime.running_count:0} running`, 'blue')}
        ${sumCard('Authoring', ns.authoring?ns.authoring.pod_count:0, `${ns.authoring?ns.authoring.running_count:0} running`, 'purple')}
        ${sumCard('Backing', ns.backingservices?ns.backingservices.pod_count:0, `${ns.backingservices?ns.backingservices.running_count:0} running`, 'cyan')}
    </div>`;

    // Unhealthy callout — only render when there are pods that need attention.
    if (unhealthy && unhealthy.length > 0) {
        html += `<div class="section unhealthy-section">
            <div class="section-header"><h2><span class="unhealthy-icon">⚠</span> Unhealthy Pods <span class="badge danger">${unhealthy.length}</span></h2></div>
            <div class="table-container"><div class="table-scroll"><table>
                <thead><tr><th>Pod Name</th><th>Namespace</th><th>Status</th><th>Reason</th><th>Ready</th><th>Restarts</th></tr></thead>
                <tbody>
                    ${unhealthy.map(p => {
                        const role = p.namespace.endsWith('-runtime')?'rt':p.namespace.endsWith('-authoring')?'au':'bs';
                        const roleLbl = role==='rt'?'runtime':role==='au'?'authoring':'backingservices';
                        const restartCls = p.restarts > 0 ? 'restarts-bad' : '';
                        return `<tr>
                            <td style="font-weight:500">${p.name}</td>
                            <td><span class="ns-pill ns-${role}">${roleLbl}</span></td>
                            <td><span class="deploy-status failure">${p.status}</span></td>
                            <td class="muted">${p.reason || '—'}</td>
                            <td>${p.ready}</td>
                            <td class="${restartCls}">${p.restarts}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table></div></div>
        </div>`;
    } else if (total > 0) {
        // Healthy, give visual reassurance instead of an empty section
        html += `<div class="all-healthy-banner">
            <span class="ahb-icon">&#10003;</span>
            <div><h3>All ${total} pods are healthy</h3>
            <p>Every pod across runtime, authoring, and backingservices is in a Running, Succeeded or Completed state.</p></div>
        </div>`;
    }
    return html;
}

// ---- Pod table with sort & column filters in headers ----
const POD_COLS = [
    { key: 'name',      label: 'Pod Name',  sortable: true,  filterable: true },
    { key: 'service',   label: 'Service',   sortable: true,  filterable: true },
    { key: 'namespace', label: 'Namespace', sortable: true,  filterable: true },
    { key: 'status',    label: 'Status',    sortable: true,  filterable: true },
    { key: 'ready',     label: 'Ready',     sortable: true,  filterable: true },
    { key: 'restarts',  label: 'Restarts',  sortable: true,  filterable: false },
    { key: 'cpu',       label: 'CPU %',     sortable: true,  filterable: false },
    { key: 'memory',    label: 'Memory %',  sortable: true,  filterable: false },
    { key: 'node',      label: 'Node',      sortable: true,  filterable: true },
];
function _podUniqueVals(col) {
    if (!S.envData || !S.envData.namespaces) return [];
    const ns = S.envData.namespaces;
    const allPods = [...(ns.runtime&&ns.runtime.pods||[]), ...(ns.authoring&&ns.authoring.pods||[]), ...(ns.backingservices&&ns.backingservices.pods||[])];
    const map = {
        name: p => p.name || '',
        service: p => p.service || '',
        status: p => p.status || '',
        ready: p => p.ready || '',
        node: p => p.node || '',
        namespace: p => { const n = p.namespace||''; return n.includes('runtime')?'runtime':n.includes('authoring')?'authoring':'backingservices'; },
    };
    const fn = map[col] || (p => String(p[col] || ''));
    return [...new Set(allPods.map(fn))].sort();
}
function showPodColFilter(col, event) {
    showGenericColFilter(col, 'S.podColFilters', _podUniqueVals(col), "renderPodRows();_updatePodActiveFilters()", event);
}
function _podTableHeadRow() {
    const cf = S.podColFilters || {};
    return POD_COLS.map(c => {
        const hasFilter = cf[c.key] && cf[c.key].length > 0;
        const filterIcon = c.filterable ? `<span class="col-filter-icon-wrap ${hasFilter?'active':''}" onclick="showPodColFilter('${c.key}',event)">${ICON_COL_FILTER}</span>` : '';
        if (!c.sortable) return `<th class="env-table-th">${filterIcon}${c.label}</th>`;
        const arrow = S.podSortBy === c.key ? (S.podSortDir === 'asc' ? ' ↑' : ' ↓') : '';
        return `<th class="sortable-th env-table-th" onclick="togglePodSort('${c.key}')">${filterIcon}${c.label}${arrow}</th>`;
    }).join('');
}

function togglePodSort(key) {
    if (S.podSortBy === key) S.podSortDir = S.podSortDir === 'asc' ? 'desc' : 'asc';
    else { S.podSortBy = key; S.podSortDir = key === 'name' || key === 'status' || key === 'node' ? 'asc' : 'desc'; }
    renderPodRows();
}

function _applyPodFilters(pods) {
    const cf = S.podColFilters || {};
    const colMap = {
        name: p => p.name || '',
        service: p => p.service || '',
        status: p => p.status || '',
        ready: p => p.ready || '',
        node: p => p.node || '',
        namespace: p => { const n = p.namespace||''; return n.includes('runtime')?'runtime':n.includes('authoring')?'authoring':'backingservices'; },
    };
    Object.keys(cf).forEach(col => {
        const sel = cf[col]; if (!sel || sel.length === 0) return;
        const fn = colMap[col] || (p => String(p[col] || ''));
        pods = pods.filter(p => sel.includes(fn(p)));
    });
    if (S.podSearch) { const q = S.podSearch.toLowerCase(); pods = pods.filter(p => p.name.toLowerCase().includes(q) || p.service.toLowerCase().includes(q)); }
    pods = _sortItems(pods, S.podSortBy, S.podSortDir, { name: p=>p.name, service: p=>p.service||'', namespace: p=>p.namespace||'', cpu: p=>p.cpu_usage_pct||0, memory: p=>p.mem_usage_pct||0, restarts: p=>p.restarts||0, ready: p=>p.ready||'', status: p=>p.status, node: p=>p.node||'' });
    return pods;
}
function _getFilteredPods() { const ns = S.envData.namespaces; if (!ns.runtime.pods || !ns.authoring.pods || !ns.backingservices.pods) return []; let pods = [...ns.runtime.pods, ...ns.authoring.pods, ...ns.backingservices.pods]; return _applyPodFilters(pods); }

function renderPodRows() {
    const tbody = $('pods-tbody'); if (!tbody || !S.envData) return;
    const thead = $('pod-thead'); if (thead) thead.innerHTML = _podTableHeadRow();
    const ns = S.envData.namespaces;
    if (!ns.runtime.pods || !ns.authoring.pods || !ns.backingservices.pods) return;
    let pods = [...ns.runtime.pods, ...ns.authoring.pods, ...ns.backingservices.pods];
    pods = _applyPodFilters(pods);
    tbody.innerHTML = pods.map(p => {
        const sc = p.status.toLowerCase().replace(/\s+/g,'');
        const nt = p.namespace.includes('runtime')?'runtime':p.namespace.includes('authoring')?'authoring':'backingservices';
        return `<tr>
            <td class="env-tbl-cell" style="color:var(--text-primary);font-weight:500;font-size:12px">${p.name}</td>
            <td class="env-tbl-cell" style="font-weight:600;color:var(--text-primary)">${p.service}</td>
            <td class="env-tbl-cell"><span class="ns-badge ${nt}">${nt}</span></td>
            <td class="env-tbl-cell">${badge(p.status,sc)}</td><td class="env-tbl-cell">${p.ready}</td>
            <td class="env-tbl-cell" style="color:${p.restarts>5?'var(--accent-red)':'var(--text-secondary)'};font-weight:${p.restarts>5?700:400}">${p.restarts}</td>
            <td class="env-tbl-cell">${usageBar(p.cpu_usage_pct)}</td><td class="env-tbl-cell">${usageBar(p.mem_usage_pct)}</td>
            <td class="env-tbl-cell" style="font-size:11px">${p.node}</td>
        </tr>`;
    }).join('');
}

function _sortItems(items, sortBy, sortDir, keyMap) {
    const dir = sortDir === 'desc' ? -1 : 1;
    const key = keyMap[sortBy];
    if (!key) return items;
    return items.slice().sort((a, b) => { let va = key(a), vb = key(b); if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb||'').toLowerCase(); } if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0; });
}

// ---- Summary card helper ----
function sumCard(label, value, sub, color) {
    return `<div class="summary-card"><div class="card-label">${label}</div><div class="card-value ${color}">${value}</div><div class="card-sub">${sub}</div></div>`;
}
function _podActiveFilters() {
    const pills = _genericColFilterPills(S.podColFilters || {}, POD_COLS, 'S.podColFilters', "renderPodRows();_updatePodActiveFilters()");
    if (S.podSearch) pills.push({ label: 'Search', value: S.podSearch, clearFn: "S.podSearch='';document.getElementById('pod-search').value='';renderPodRows();_updatePodActiveFilters()" });
    return pills;
}
function clearAllPodFilters() {
    S.podSearch = ''; S.podColFilters = {};
    renderPodRows(); _updatePodActiveFilters();
}
function _updatePodActiveFilters() {
    const el = $('pod-active-filters'); if (!el) return;
    const pills = _podActiveFilters();
    el.innerHTML = activeFiltersBar(pills, "clearAllPodFilters()");
}

// ============================================================
// INGRESS TABLE — column definitions & filtering
// ============================================================
const INGRESS_COLS = [
    { key: 'name',       label: 'Name',        filterable: true,  sortable: true,  width: 200 },
    { key: 'namespace',  label: 'Namespace',   filterable: true,  sortable: true,  width: 140 },
    { key: 'tls',        label: 'TLS',         filterable: true,  sortable: true,  width: 80  },
    { key: 'url',        label: 'URL',         filterable: false, sortable: true,  width: 360 },
    { key: 'credentials',label: 'Credentials', filterable: false, sortable: false, width: 200 },
];

function _ingressList() {
    return (S.envData && S.envData.ingress || []).map(ig => {
        const proto = ig.tls ? 'https' : 'http';
        return { ...ig, _tls: ig.tls ? 'TLS' : 'HTTP', _url: `${proto}://${ig.host}${ig.path}` };
    });
}
function _ingressUniqueVals(col) {
    const vals = new Set();
    _ingressList().forEach(ig => {
        let v;
        if (col === 'tls') v = ig._tls;
        else v = ig[col];
        vals.add(String(v || ''));
    });
    return [...vals].sort();
}
function _getFilteredIngress() {
    let list = _ingressList();
    const cf = S.ingressColFilters || {};
    Object.keys(cf).forEach(col => {
        if (!cf[col] || cf[col].length === 0) return;
        list = list.filter(ig => {
            let v;
            if (col === 'tls') v = ig._tls;
            else v = ig[col];
            return cf[col].includes(String(v || ''));
        });
    });
    const s = S.ingressSort;
    if (s && s.col) {
        const dir = s.dir === 'desc' ? -1 : 1;
        const valFn = { name: ig => ig.name || '', namespace: ig => ig.namespace || '', tls: ig => ig._tls || '', url: ig => ig._url || '' };
        const fn = valFn[s.col] || (ig => String(ig[s.col] || ''));
        list = list.slice().sort((a, b) => {
            const va = fn(a).toLowerCase(), vb = fn(b).toLowerCase();
            if (va < vb) return -1 * dir; if (va > vb) return 1 * dir; return 0;
        });
    }
    return list;
}
function showIngressColFilter(col, event) {
    showGenericColFilter(col, 'S.ingressColFilters', _ingressUniqueVals(col), "_rerenderIngressTable()", event);
}
function toggleIngressSort(col) {
    const s = S.ingressSort;
    if (s.col === col) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
    else { s.col = col; s.dir = 'asc'; }
    _rerenderIngressTable();
}
function _ingressHeadRow() {
    const cf = S.ingressColFilters || {};
    const s = S.ingressSort || {};
    return INGRESS_COLS.map(c => {
        const hasFilter = cf[c.key] && cf[c.key].length > 0;
        const filterIcon = c.filterable ? `<span class="col-filter-icon-wrap ${hasFilter?'active':''}" onclick="showIngressColFilter('${c.key}',event)">${ICON_COL_FILTER}</span>` : '';
        const styleAttr = resizableThStyle('ingress', c);
        if (c.sortable) {
            const arrow = s.col === c.key ? (s.dir === 'asc' ? ' ↑' : ' ↓') : '';
            return `<th class="sortable-th env-table-th" data-col-key="${c.key}" ${styleAttr} onclick="toggleIngressSort('${c.key}')">${filterIcon}${c.label}${arrow}${colResizerHtml()}</th>`;
        }
        return `<th class="env-table-th" data-col-key="${c.key}" ${styleAttr}>${filterIcon}${c.label}${colResizerHtml()}</th>`;
    }).join('');
}
function _ingressRow(ig) {
    const credsHtml = ig.username
        ? `<span class="creds-group">
              <span class="creds-user" title="Click to copy username" onclick="copyToClipboard('${String(ig.username).replace(/'/g,"\\'")}', this)">${ig.username}</span>
              <span class="creds-sep"> / </span>
              <span class="ingress-creds-pass" onclick="this.classList.toggle('revealed')" title="Click to reveal / hide">${ig.password}</span>
              <button class="creds-copy-btn" title="Copy password" onclick="event.stopPropagation();copyToClipboard('${String(ig.password||'').replace(/'/g,"\\'").replace(/"/g,'&quot;')}', this)">${ICON_COPY}</button>
           </span>`
        : '';
    return `<tr><td style="font-weight:600">${ig.name}</td><td><span class="ns-badge ${ig.namespace}">${ig.namespace}</span></td><td><span class="tls-badge ${ig.tls?'secure':'insecure'}">${ig._tls}</span></td><td><a href="${ig._url}" target="_blank" style="color:var(--accent-blue)">${ig._url}</a><button class="creds-copy-btn" title="Copy URL" onclick="copyToClipboard('${String(ig._url).replace(/'/g,"\\'")}', this)">${ICON_COPY}</button></td><td>${credsHtml}</td></tr>`;
}
function _rerenderIngressTable() {
    const thead = $('ingress-thead'); const tbody = $('ingress-tbody');
    if (!thead || !tbody) return;
    thead.innerHTML = `<tr>${_ingressHeadRow()}</tr>`;
    const filtered = _getFilteredIngress();
    tbody.innerHTML = filtered.length === 0
        ? `<tr class="empty-row"><td colspan="${INGRESS_COLS.length}"><div class="empty-state"><div class="empty-state-msg">No routes match the current filters.</div><button class="empty-state-btn" onclick="clearAllIngressFilters()">Clear filters</button></div></td></tr>`
        : filtered.map(_ingressRow).join('');
    const badge = $('ingress-badge');
    if (badge) badge.textContent = filtered.length;
    const afBar = $('ingress-active-filters');
    if (afBar) afBar.outerHTML = _ingressActiveFiltersHtml();
}
function _ingressActiveFilters() {
    return _colFilterPills(S.ingressColFilters || {}, INGRESS_COLS, 'removeIngressColFilter');
}
function _ingressActiveFiltersHtml() {
    const pills = _ingressActiveFilters();
    return `<div id="ingress-active-filters">${activeFiltersBar(pills, "clearAllIngressFilters()")}</div>`;
}
function removeIngressColFilter(col, val) {
    const cf = S.ingressColFilters; if (!cf[col]) return;
    cf[col] = cf[col].filter(v => v !== val);
    if (cf[col].length === 0) delete cf[col];
    _rerenderIngressTable();
}
function clearAllIngressFilters() { S.ingressColFilters = {}; S.ingressSort = { col: 'name', dir: 'asc' }; _rerenderIngressTable(); }

// ---- Export functions ----
function exportPods() { const pods = _getFilteredPods(); exportToExcel(pods.map(p => ({ 'Pod Name': p.name, 'Service': p.service, 'Namespace': p.namespace, 'Status': p.status, 'Ready': p.ready, 'Restarts': p.restarts, 'CPU %': p.cpu_usage_pct, 'Mem %': p.mem_usage_pct, 'Node': p.node })), 'Pods', `Pods_${S.envData.environment}.xlsx`); }
function exportIngress() { exportToExcel(_getFilteredIngress().map(ig => ({ 'Name': ig.name, 'Namespace': ig.namespace, 'Host': ig.host, 'Path': ig.path, 'TLS': ig._tls, 'URL': ig._url, 'Username': ig.username||'', 'Password': ig.password||'' })), 'Ingress', `Ingress_${S.envData.environment}.xlsx`); }
function exportSanityHistory() { const d = S.envData; const sanity = d.sanity || {}; const rows = [{...sanity, _label:'Latest'}, ...(sanity.history||[]).map((h,i)=>({...h,_label:`Build -${i+1}`}))]; exportToExcel(rows.map(h => ({ 'Label': h._label||'', 'Build #': h.jenkins_build_number, 'Pass Rate': h.sanity_passrate, 'Total': h.total_tests, 'Passed': h.passed_tests, 'Failed': h.failed_tests||0, 'JAR': h.sanity_jar_version||'N/A', 'Triggered by': h.triggered_by||'N/A', 'Timestamp': h.last_run||'' })), 'Sanity History', `Sanity_${d.environment}.xlsx`); }
function exportDeployments() { const ns = S.envData.namespaces; exportToExcel(['runtime','authoring','backingservices'].map(k => { const dep = ns[k].deployment||{}; return { 'Namespace': k, 'Status': dep.jenkins_deploy_status||'N/A', 'Build #': dep.jenkins_deploy_build_number||'N/A', 'Ran by': dep.triggered_by||'N/A', 'Timestamp': dep.jenkins_deploy_timestamp||'', 'Jenkins URL': dep.jenkins_deploy_url||'' }; }), 'Deployments', `Deployments_${S.envData.environment}.xlsx`); }

function exportFullEnv() {
    const d = S.envData; const ns = d.namespaces; const sanity = d.sanity || {}; const meta = d.env_metadata || {};
    const sheets = [];
    sheets.push({name: 'Summary', data: [{ 'Environment': d.environment, 'Cluster': d.datacenter, 'Drop': meta.drop_version, 'Branch': meta.bitbucket_branch, 'Owner': meta.env_owner, 'Sanity %': sanity.sanity_passrate, 'Total Pods': d.summary.total_pods, 'Running': d.summary.running_pods, 'Failed': d.summary.failed_pods }]});
    const allPods = [...ns.runtime.pods, ...ns.authoring.pods, ...ns.backingservices.pods];
    sheets.push({name: 'Pods', data: allPods.map(p => ({ 'Pod': p.name, 'Service': p.service, 'NS': p.namespace, 'Status': p.status, 'Ready': p.ready, 'Restarts': p.restarts, 'CPU %': p.cpu_usage_pct, 'Mem %': p.mem_usage_pct, 'Node': p.node }))});
    sheets.push({name: 'Nodes', data: (S.clusterNodes||[]).map(n => ({ 'Name': n.name, 'Role': n.role, 'Status': n.status, 'CPU %': n.cpu_usage_pct, 'Mem %': n.mem_usage_pct, 'CPU Cap': n.cpu_capacity, 'Mem Cap': n.mem_capacity, 'Pods': n.pods_count }))});
    sheets.push({name: 'Ingress', data: d.ingress.map(ig => ({ 'Name': ig.name, 'NS': ig.namespace, 'URL': `${ig.tls?'https':'http'}://${ig.host}${ig.path}`, 'TLS': ig.tls?'Yes':'No' }))});
    const sanityRows = [{...sanity, _label:'Latest'}, ...(sanity.history||[]).map((h,i)=>({...h,_label:`Build -${i+1}`}))];
    sheets.push({name: 'Sanity', data: sanityRows.map(h => ({ 'Label': h._label, 'Build #': h.jenkins_build_number, 'Pass Rate': h.sanity_passrate, 'Total': h.total_tests, 'Passed': h.passed_tests, 'Failed': h.failed_tests||0, 'JAR': h.sanity_jar_version||'N/A' }))});
    sheets.push({name: 'Deployments', data: ['runtime','authoring','backingservices'].map(k => { const dep = ns[k].deployment||{}; return { 'NS': k, 'Status': dep.jenkins_deploy_status||'N/A', 'Build #': dep.jenkins_deploy_build_number||'N/A', 'Ran by': dep.triggered_by||'N/A' }; })});
    const pvd = d.product_versions || {};
    const _hf = k => pvd[`${k}_hf`] ? `HF#${pvd[`${k}_hf`]}` : '';
    sheets.push({name: 'Product Versions', data: [
        { 'Product': 'Baseline',   'Version': pvd.baseline||'N/A',   'Hotfix': _hf('baseline') },
        { 'Product': 'Platform',   'Version': pvd.platform||'N/A',   'Hotfix': _hf('platform') },
        { 'Product': 'Catalog',    'Version': pvd.catalog||'N/A',    'Hotfix': _hf('catalog') },
        { 'Product': 'CSR',        'Version': pvd.csr||'N/A',        'Hotfix': _hf('csr') },
        { 'Product': 'OC',         'Version': pvd.oc||'N/A',         'Hotfix': _hf('oc') },
        { 'Product': 'OH',         'Version': pvd.oh||'N/A',         'Hotfix': _hf('oh') },
        { 'Product': 'Care',       'Version': pvd.care||'N/A',       'Hotfix': _hf('care') },
        { 'Product': 'MASS',       'Version': pvd.mass||'N/A',       'Hotfix': _hf('mass') },
        { 'Product': 'Backoffice', 'Version': pvd.backoffice||'N/A', 'Hotfix': _hf('backoffice') },
        { 'Product': 'D1 Suite',   'Version': pvd.d1_suite||'N/A',   'Hotfix': '' },
        { 'Product': 'MPP',        'Version': pvd.mpp||'N/A',        'Hotfix': '' },
    ]});
    exportMultiSheet(sheets, `Environment_${d.environment}.xlsx`);
}

// ============================================================
// ENVIRONMENTS TABLE VIEW (Grafana-style)
// ============================================================
const ENV_TABLE_COLS = [
    { key: 'cluster',         label: 'Cluster',     filterable: true,  width: 110 },
    { key: 'name',            label: 'Environment', filterable: true,  width: 145 },
    { key: 'drop_version',    label: 'Core Drop',   filterable: true,  width: 80  },
    { key: 'is_master',       label: 'Type',        filterable: true,  width: 80  },
    { key: 'branch',          label: 'Branch',      filterable: true,  width: 130 },
    { key: 'sanity_passrate', label: 'Sanity %',    filterable: true,  type: 'bar', width: 80  },
    { key: 'owner',           label: 'Owner',       filterable: true,  width: 95  },
    { key: 'ns_sync',         label: 'Version Align', filterable: true, group: 'versions', width: 115 },
    { key: 'pv_mpp',          label: 'MPP',         filterable: true,  group: 'versions', width: 130 },
    { key: 'pv_baseline',     label: 'Baseline',    filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_platform',     label: 'Platform',    filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_d1_suite',     label: 'D1 Suite',    filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_oc',           label: 'OC',          filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_oh',           label: 'OH',          filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_care',         label: 'Care',        filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_mass',         label: 'MASS',        filterable: true,  group: 'versions', width: 155 },
    { key: 'pv_csr',          label: 'CSR',         filterable: true,  group: 'versions', width: 160 },
    { key: 'pv_catalog',      label: 'Catalog',     filterable: true,  group: 'versions', width: 165 },
    { key: 'pv_backoffice',   label: 'Backoffice',  filterable: true,  group: 'versions', width: 170 },
    { key: 'last_update',     label: 'Last Update', filterable: false, width: 110 },
];

function _envTableUniqueVals(col) { const vals = new Set(); S.envTableData.forEach(e => { let v = e[col]; if (col==='is_master') v = v?'Master':'Regular'; if (col==='ns_sync') { const d = Array.isArray(e.pv_divergent) ? e.pv_divergent : []; const nk = e.pv_by_ns ? Object.keys(e.pv_by_ns) : []; const hasAny = nk.some(r => { const ns = e.pv_by_ns[r]; return ns && Object.keys(ns).some(k => k !== 'namespace' && k !== 'last_update' && !k.endsWith('_hf') && ns[k]); }); v = !hasAny ? 'No Data' : nk.length < 2 ? 'N/A' : d.length === 0 ? 'In Sync' : 'Mismatch'; } if (v===undefined||v===null) v=''; vals.add(String(v)); }); return [...vals].sort(); }

function _getFilteredEnvTable() {
    let list = (S.envTableData || []).filter(_envMatchesProvider); const cf = S.envTableColFilters;
    Object.keys(cf).forEach(col => { const sel = cf[col]; if (!sel || sel.length===0) return; list = list.filter(e => { let v = e[col]; if (col==='is_master') v=v?'Master':'Regular'; if (col==='ns_sync') { const d = Array.isArray(e.pv_divergent) ? e.pv_divergent : []; const nk = e.pv_by_ns ? Object.keys(e.pv_by_ns) : []; const hasAny = nk.some(r => { const ns = e.pv_by_ns[r]; return ns && Object.keys(ns).some(k => k !== 'namespace' && k !== 'last_update' && !k.endsWith('_hf') && ns[k]); }); v = !hasAny ? 'No Data' : nk.length < 2 ? 'N/A' : d.length === 0 ? 'In Sync' : 'Mismatch'; } if (v===undefined||v===null) v=''; return sel.includes(String(v)); }); });
    const s = S.envTableSort;
    if (s.col) { const dir = s.dir==='desc'?-1:1; list = list.slice().sort((a,b) => { let va=a[s.col],vb=b[s.col]; if (s.col==='is_master'){va=va?1:0;vb=vb?1:0;} else if (s.col==='sanity_passrate'){va=a.sanity_passrate_value||0;vb=b.sanity_passrate_value||0;} else if (s.col==='idle_days'){va=va||0;vb=vb||0;} else {va=String(va||'').toLowerCase();vb=String(vb||'').toLowerCase();} if (va<vb) return -1*dir; if (va>vb) return 1*dir; return 0; }); }
    return list;
}

function toggleEnvTableSort(col) { if (S.envTableSort.col===col) S.envTableSort.dir = S.envTableSort.dir==='asc'?'desc':'asc'; else { S.envTableSort.col=col; S.envTableSort.dir='asc'; } _rerenderEnvTableBody(); savePrefs(); }

function showColFilter(col, event) {
    showGenericColFilter(col, 'S.envTableColFilters', _envTableUniqueVals(col), "_rerenderEnvTableBody()", event);
}
function filterColOptions(input) { const q=input.value.toLowerCase(); input.closest('.col-filter-dropdown').querySelectorAll('.cfd-option').forEach(opt => { opt.style.display = opt.textContent.toLowerCase().includes(q)?'':'none'; }); }
function cancelColFilter() { document.querySelectorAll('.col-filter-dropdown').forEach(el=>el.remove()); document.removeEventListener('click',_closeColFilterOutside,true); }
function _closeColFilterOutside(e) { const dd=document.querySelector('.col-filter-dropdown'); if (dd&&!dd.contains(e.target)&&!e.target.closest('.col-filter-icon-wrap')&&!e.target.closest('.col-filter-icon')){ dd.remove(); document.removeEventListener('click',_closeColFilterOutside,true); } }
function _envTableActiveFilters() {
    return _colFilterPills(S.envTableColFilters, ENV_TABLE_COLS, 'removeEnvTableColFilter');
}
function removeEnvTableColFilter(col, val) {
    const cf = S.envTableColFilters; if (!cf[col]) return;
    cf[col] = cf[col].filter(v => v !== val);
    if (cf[col].length === 0) delete cf[col];
    _rerenderEnvTableBody();
}
function clearAllEnvTableFilters() { S.envTableColFilters = {}; _rerenderEnvTableBody(); savePrefs(); }

function _envTableActiveFiltersHtml() {
    const pills = _envTableActiveFilters();
    return `<div id="env-table-active-filters">${activeFiltersBar(pills, "clearAllEnvTableFilters()")}</div>`;
}
function _envVisibleCols() {
    return S.prefs.showVersions ? ENV_TABLE_COLS : ENV_TABLE_COLS.filter(c => c.group !== 'versions');
}
function _rerenderEnvTableBody() { const tbody=$('env-table-tbody'); const thead=$('env-table-thead'); if (!tbody) return; if (thead) thead.innerHTML=_envTableHeadRow(); const filtered=_getFilteredEnvTable(); const countEl=$('env-table-count'); if (countEl) countEl.textContent=`${filtered.length} of ${S.envTableData.length} environments`; tbody.innerHTML=_envTableBodyHtml(filtered); const afBar=$('env-table-active-filters'); if (afBar) afBar.outerHTML=_envTableActiveFiltersHtml(); }

function _envTableHeadRow() {
    return _envVisibleCols().map(c => {
        const arrow = S.envTableSort.col===c.key ? (S.envTableSort.dir==='asc'?' ↑':' ↓') : '';
        const hasFilter = S.envTableColFilters[c.key] && S.envTableColFilters[c.key].length>0;
        const filterIcon = c.filterable ? `<span class="col-filter-icon-wrap ${hasFilter?'active':''}" onclick="showColFilter('${c.key}',event)">${ICON_COL_FILTER}</span>` : '';
        return `<th class="sortable-th env-table-th" data-col-key="${c.key}" ${resizableThStyle('env-table', c)} onclick="toggleEnvTableSort('${c.key}')">${filterIcon}${c.label}${arrow}${colResizerHtml()}</th>`;
    }).join('');
}

// ------------------------------------------------------------------
// Per-namespace constants used by stacked version cells and env-detail.
// ------------------------------------------------------------------
const _NS_LABELS = { rt: 'Runtime', au: 'Authoring', bs: 'BackingServices' };
const _NS_ORDER  = ['rt', 'au', 'bs'];

function _envTableCellFor(e, col) {
    const hasNsData = e.pv_by_ns && Object.keys(e.pv_by_ns).length > 0;
    const isDivergent = (col.group === 'versions') && Array.isArray(e.pv_divergent)
        && e.pv_divergent.includes(col.key.replace(/^pv_/, ''));
    const noHfProducts = new Set(['pv_d1_suite', 'pv_mpp']);

    const _stackedVersionCell = (colKey) => {
        if (!hasNsData) {
            if (!e[colKey]) return `<td class="env-tbl-cell pv-cell"><span style="color:var(--text-muted)">—</span></td>`;
            const hf = !noHfProducts.has(colKey) ? e[`${colKey}_hf`] : '';
            const hfHtml = hf ? `<span class="pv-hf">HF#${hf}</span>` : '';
            return `<td class="env-tbl-cell pv-cell"><span class="pv-cell-stack"><span class="pv-pill">${e[colKey]}</span>${hfHtml}</span></td>`;
        }
        const pvKey = colKey.replace(/^pv_/, '');
        const present = _NS_ORDER.filter(r => e.pv_by_ns[r]);
        const hasAny = present.some(r => e.pv_by_ns[r][pvKey]);
        if (!hasAny) return `<td class="env-tbl-cell pv-cell"><span style="color:var(--text-muted)">—</span></td>`;

        const rows = present.map(r => {
            const ns = e.pv_by_ns[r];
            const ver = ns[pvKey] || '';
            if (!ver) return `<div class="pv-stack-row"><span class="pv-stack-ns ns-${r}">${r.toUpperCase()}</span><span class="pv-stack-ver empty">—</span></div>`;
            const hfKey = `${pvKey}_hf`;
            const hf = !noHfProducts.has(colKey) && ns[hfKey] ? ns[hfKey] : '';
            const hfHtml = hf ? `<span class="pv-hf pv-hf-inline">HF#${hf}</span>` : '';
            const divCls = isDivergent ? ' divergent' : '';
            return `<div class="pv-stack-row"><span class="pv-stack-ns ns-${r}">${r.toUpperCase()}</span><span class="pv-stack-ver${divCls}">${ver}${hfHtml}</span></div>`;
        }).join('');
        const warnHtml = isDivergent ? `<span class="pv-stack-warn" title="Version mismatch across namespaces">⚠ mismatch</span>` : '';
        return `<td class="env-tbl-cell pv-cell"><div class="pv-stack">${rows}${warnHtml}</div></td>`;
    };

    switch (col.key) {
        case 'cluster':         return `<td class="env-tbl-cell"><span class="env-tbl-cluster" title="${e.cluster}">${e.cluster_full || e.cluster}</span></td>`;
        case 'name': {
            const envLabel = (e.cloud === 'aws') ? (e.cluster || e.name) : e.name;
            return `<td class="env-tbl-cell env-tbl-name"><a style="cursor:pointer" title="${e.name}" onclick="navigate('env-detail',{datacenter:'${e.datacenter}',env_id:'${e.env_id}',name:'${e.name}'})">${envLabel}</a></td>`;
        }
        case 'ns_sync': {
            const divList = Array.isArray(e.pv_divergent) ? e.pv_divergent : [];
            const nsKeys = e.pv_by_ns ? Object.keys(e.pv_by_ns) : [];
            const hasAnyVersion = nsKeys.some(r => {
                const ns = e.pv_by_ns[r];
                return ns && Object.keys(ns).some(k => k !== 'namespace' && k !== 'last_update' && !k.endsWith('_hf') && ns[k]);
            });
            if (!hasAnyVersion) return `<td class="env-tbl-cell ns-sync-cell"><span class="ns-sync-badge ns-sync-nodata" title="No version data available">No Data</span></td>`;
            if (nsKeys.length < 2) return `<td class="env-tbl-cell ns-sync-cell"><span class="ns-sync-badge ns-sync-na" title="Only one namespace has data">—</span></td>`;
            if (divList.length === 0) return `<td class="env-tbl-cell ns-sync-cell"><span class="ns-sync-badge ns-sync-ok" title="All common product versions match across namespaces">✓ In Sync</span></td>`;
            const names = divList.map(k => k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())).join(', ');
            return `<td class="env-tbl-cell ns-sync-cell"><span class="ns-sync-badge ns-sync-mismatch" title="Version mismatch in: ${names}">⚠ ${divList.length} Mismatch${divList.length>1?'es':''}</span></td>`;
        }
        case 'drop_version':    return `<td class="env-tbl-cell">${e.drop_version}</td>`;
        case 'is_master':       return `<td class="env-tbl-cell">${e.is_master ? '<span class="master-badge">MASTER</span>' : '<span style="color:var(--text-muted)">Regular</span>'}</td>`;
        case 'branch':          return `<td class="env-tbl-cell branch-cell">${e.branch||'N/A'}</td>`;
        case 'sanity_passrate': return `<td class="env-tbl-cell">${sanityChip(e.sanity_passrate, e.sanity_passrate_value, e.sanity_passed_tests, e.sanity_total_tests)}</td>`;
        case 'owner':           return `<td class="env-tbl-cell">${(e.owner==='Free'||!e.owner) ? '<span class="owner-badge free">Free</span>' : `<span class="owner-badge">${e.owner}</span>`}</td>`;
        case 'last_update':     return `<td class="env-tbl-cell">${e.last_update?fmt(e.last_update):'<span style="color:var(--text-muted)">N/A</span>'}</td>`;
        default:
            if (col.group === 'versions') return _stackedVersionCell(col.key);
            return `<td class="env-tbl-cell">${e[col.key]||''}</td>`;
    }
}

function _envTableRow(e) {
    const cols = _envVisibleCols();
    return `<tr class="env-table-row">${cols.map(c => _envTableCellFor(e, c)).join('')}</tr>`;
}

function _envTableBodyHtml(filtered) {
    if (filtered.length === 0) {
        const colSpan = _envVisibleCols().length;
        return `<tr class="empty-row"><td colspan="${colSpan}">
            <div class="empty-state">
                <div class="empty-state-msg">No environments match the current filters.</div>
                <button class="empty-state-btn" onclick="clearAllEnvTableFilters()">Clear filters</button>
            </div></td></tr>`;
    }
    return filtered.map(_envTableRow).join('');
}

function toggleShowVersions() {
    S.prefs.showVersions = !S.prefs.showVersions;
    savePrefs();
    renderEnvTable($('main-content'));
}

function renderEnvTable(main) {
    const filtered = _getFilteredEnvTable();
    const vBtn = S.prefs.showVersions
        ? `<button class="toolbar-btn subtle" onclick="toggleShowVersions()" title="Hide product-version columns"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg><span>Hide Versions</span></button>`
        : `<button class="toolbar-btn subtle" onclick="toggleShowVersions()" title="Show product-version columns"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg><span>Show Versions</span></button>`;
    let html = `<div class="mini-toolbar">
        <span class="toolbar-count" id="env-table-count">${filtered.length} of ${S.envTableData.length} environments</span>
        <span class="mini-toolbar-spacer"></span>
        ${vBtn}
        ${resetWidthsBtn('env-table')}
        ${exportBtn("exportEnvTable()",'Export')}
    </div>`;
    html += _envTableActiveFiltersHtml();
    html += `<div class="table-container env-table-container"><div class="table-scroll"><table class="env-overview-table resizable-table" data-colw-key="env-table"><thead><tr id="env-table-thead">${_envTableHeadRow()}</tr></thead><tbody id="env-table-tbody">${_envTableBodyHtml(filtered)}</tbody></table></div></div>`;
    main.innerHTML = html;
}

function exportEnvTable() {
    const filtered = _getFilteredEnvTable();
    const _pvProducts = ['baseline','platform','catalog','csr','oc','oh','care','mass','backoffice','d1_suite','mpp'];
    const _nsLabels = { rt:'RT', au:'AU', bs:'BS' };
    exportToExcel(filtered.map(e => {
        const row = {
            'Cluster': e.cluster,
            'Cluster Full Name': e.cluster_full || e.cluster,
            'Environment': e.name,
            'Core Drop': e.drop_version,
            'Type': e.is_master ? 'Master' : 'Regular',
            'Branch': e.branch,
            'Sanity %': e.sanity_passrate,
            'Owner': e.owner || 'Free',
        };
        _pvProducts.forEach(p => {
            const label = p.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
            if (e.pv_by_ns && Object.keys(e.pv_by_ns).length) {
                _NS_ORDER.forEach(ns => {
                    const v = e.pv_by_ns[ns] ? (e.pv_by_ns[ns][p]||'') : '';
                    const hf = e.pv_by_ns[ns] ? (e.pv_by_ns[ns][`${p}_hf`]||'') : '';
                    row[`${label} (${_nsLabels[ns]})`] = v + (hf ? ` HF#${hf}` : '');
                });
            } else {
                row[label] = e[`pv_${p}`] || '';
            }
            if (Array.isArray(e.pv_divergent) && e.pv_divergent.includes(p)) {
                row[`${label} Mismatch`] = 'YES';
            }
        });
        row['JAR'] = e.sanity_jar_version;
        row['Last Update'] = e.last_update;
        return row;
    }), 'Environments', 'OCP_Environments_Overview.xlsx');
}

// ---- Init & Auto-refresh ----
async function initApp() { try { await render(); } catch (e) { $('main-content').innerHTML = `<div class="loading-screen"><p style="color:var(--accent-red)">Error: ${e.message}</p></div>`; } }

// ============================================================
// Density toggle (comfortable | compact)
// ------------------------------------------------------------
function applyDensity() {
    document.body.classList.toggle('density-compact', S.prefs.density === 'compact');
    const lbl = $('density-label');
    if (lbl) lbl.textContent = S.prefs.density === 'compact' ? 'Compact' : 'Comfortable';
}
function toggleDensity() {
    S.prefs.density = (S.prefs.density === 'compact') ? 'comfortable' : 'compact';
    applyDensity();
    savePrefs();
}

// ============================================================
// Keyboard shortcuts
//   /  focus first visible search input
//   Esc close any open filter dropdown or modal
//   ?  show a lightweight shortcuts help overlay
// ------------------------------------------------------------
function _isTypingIntoInput(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable;
}
function _focusFirstSearchInput() {
    const ids = ['env-table-search','cluster-search','drop-env-search','pod-search','node-search'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (el) { el.focus(); el.select && el.select(); return true; }
    }
    const any = document.querySelector('.pod-search-input, input[type="text"][placeholder*="earch"]');
    if (any) { any.focus(); any.select && any.select(); return true; }
    return false;
}
function showShortcutsHelp() {
    document.querySelectorAll('.shortcut-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'shortcut-overlay';
    overlay.innerHTML = `<div class="shortcut-box">
        <div class="shortcut-title">Keyboard shortcuts</div>
        <table class="shortcut-table">
            <tr><td><kbd>/</kbd></td><td>Focus search</td></tr>
            <tr><td><kbd>Esc</kbd></td><td>Close filter / dialog</td></tr>
            <tr><td><kbd>r</kbd></td><td>Reload page</td></tr>
            <tr><td><kbd>g</kbd> <kbd>e</kbd></td><td>Go to Environments</td></tr>
            <tr><td><kbd>g</kbd> <kbd>c</kbd></td><td>Go to Clusters</td></tr>
            <tr><td><kbd>g</kbd> <kbd>u</kbd></td><td>Go to URLs</td></tr>
            <tr><td><kbd>g</kbd> <kbd>d</kbd></td><td>Go to CRDs</td></tr>
            <tr><td><kbd>?</kbd></td><td>Show this help</td></tr>
        </table>
        <div class="shortcut-close"><button onclick="this.closest('.shortcut-overlay').remove()">Close</button></div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}
let _gPrefixTimer = null, _gPrefixActive = false;
function _installKeyboardShortcuts() {
    document.addEventListener('keydown', e => {
        // Esc: close any open col filter / shortcut overlay / owner dialog
        if (e.key === 'Escape') {
            let handled = false;
            document.querySelectorAll('.col-filter-dropdown').forEach(el => { el.remove(); handled = true; });
            document.querySelectorAll('.shortcut-overlay').forEach(el => { el.remove(); handled = true; });
            if (handled) { document.removeEventListener('click', _closeColFilterOutside, true); return; }
        }
        if (_isTypingIntoInput(e)) return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (_gPrefixActive) {
            if (e.key === 'e') { _gPrefixActive = false; navigate('env-table'); e.preventDefault(); return; }
            if (e.key === 'c') { _gPrefixActive = false; navigate('clusters'); e.preventDefault(); return; }
            if (e.key === 'u') { _gPrefixActive = false; navigate('urls'); e.preventDefault(); return; }
            if (e.key === 'd') { _gPrefixActive = false; navigate('crds'); e.preventDefault(); return; }
            _gPrefixActive = false;
        }
        if (e.key === '/') { if (_focusFirstSearchInput()) e.preventDefault(); return; }
        if (e.key === '?') { showShortcutsHelp(); e.preventDefault(); return; }
        if (e.key === 'r') { location.reload(); e.preventDefault(); return; }
        if (e.key === 'g') { _gPrefixActive = true; clearTimeout(_gPrefixTimer); _gPrefixTimer = setTimeout(() => { _gPrefixActive = false; }, 1200); return; }
    });
}

// ---- Owner Update ----
function showOwnerDialog(dc, envId, currentOwner, event) {
    if (event) event.stopPropagation();
    const overlay = document.createElement('div'); overlay.className = 'owner-dialog-overlay';
    const isFree = currentOwner==='Free'||currentOwner==='free'||!currentOwner;
    overlay.innerHTML = `<div class="owner-dialog"><div class="owner-dialog-title">Update Environment Owner</div><div class="owner-dialog-hint">Enter your name to claim this environment, or mark it as free.</div><input type="text" id="owner-input" class="owner-dialog-input" placeholder="Enter owner name..." value="${isFree?'':currentOwner}" autofocus><div class="owner-dialog-actions"><button class="owner-btn free" onclick="submitOwner('${dc}','${envId}','Free')">${ICON_FREE} Mark as Free</button><button class="owner-btn cancel" onclick="this.closest('.owner-dialog-overlay').remove()">Cancel</button><button class="owner-btn save" onclick="submitOwner('${dc}','${envId}',document.getElementById('owner-input').value)">Save</button></div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target===overlay) overlay.remove(); });
    document.getElementById('owner-input').focus();
    document.getElementById('owner-input').addEventListener('keydown', e => { if (e.key==='Enter') submitOwner(dc,envId,document.getElementById('owner-input').value); if (e.key==='Escape') overlay.remove(); });
}
async function submitOwner(dc, envId, newOwner) {
    newOwner = newOwner.trim(); if (!newOwner) { alert('Owner name cannot be empty'); return; }
    const overlay = document.querySelector('.owner-dialog-overlay'); const saveBtn = overlay.querySelector('.owner-btn.save'); saveBtn.textContent='Saving...'; saveBtn.disabled=true;
    try { const r = await fetch(`/api/env/${dc}/${envId}/owner`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({owner:newOwner})}); const data = await r.json(); if (data.status==='ok'){overlay.remove();render();}else{alert('Failed: '+(data.message||'Unknown'));saveBtn.textContent='Save';saveBtn.disabled=false;} } catch(e){alert('Failed: '+e.message);saveBtn.textContent='Save';saveBtn.disabled=false;}
}

document.addEventListener('DOMContentLoaded', () => {
    loadPrefs();
    applyDensity();
    _applyProviderUI(S.provider);
    loadQuickLinks();
    try { history.replaceState(_buildHistoryState(), ''); } catch (_) {}
    initApp();
    _installKeyboardShortcuts();
});
