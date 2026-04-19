// App State
let brawlers = [];
let rankedMaps = [];
let matches = JSON.parse(localStorage.getItem('brawl_matches')) || [];
let userProfile = JSON.parse(localStorage.getItem('brawl_profile')) || null;
let officialApiKey = localStorage.getItem('brawl_api_key') || '';
/** When set, official + community API requests go to this origin (trailing slash ok). Empty = this site’s origin (Vercel/Netlify). */
let apiProxyOrigin = (localStorage.getItem('brawl_proxy_origin') || '').trim().replace(/\/$/, '');
let isSyncing = false; // Sync lock to prevent race conditions

// Name normalization for cross-API matching
// Supercell API uses 'LARRY & LAWRIE', 'MR. P'
// BrawlAPI uses      'LARRY-LAWRIE',  'MR-P'
function normalizeBrawlerName(name) {
    if (!name) return "";
    return name.toUpperCase().trim()
        .replace(/[^A-Z0-9]/g, ''); // strip ALL non-alphanumeric
}

// Browser IP Detection Helper
async function getBrowserIP() {
    try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        return data.ip || 'Unknown';
    } catch (err) {
        return 'Detection Failed (Check VPN/CORS)';
    }
}

/** Base URL for /api/official and /api/* proxies (never call Supercell from the browser — they do not allow CORS). */
function getProxyBaseUrl() {
    if (window.location.protocol === 'file:') {
        return 'http://127.0.0.1:8000';
    }
    if (apiProxyOrigin) return apiProxyOrigin;
    return window.location.origin;
}

function isNetworkOrCorsFailure(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    if (err.name === 'TypeError') return true;
    return /Failed to fetch|NetworkError|Load failed|aborted|timeout/i.test(String(err.message || ''));
}

/** IPv4/IPv6 from Supercell error text (e.g. "from IP 1.2.3.4" or "Invalid IP: …"). */
function extractIpFromApiMessage(msg) {
    if (!msg || typeof msg !== 'string') return null;
    let m = msg.match(/Invalid IP:?\s*([0-9a-fA-F:\.]+)/i);
    if (m) return m[1].trim();
    m = msg.match(/from IP\s+([0-9a-fA-F:\.]+)/i);
    if (m) return m[1].trim();
    return null;
}

function keyIpWhitelistHint(message) {
    const ip = extractIpFromApiMessage(String(message || ''));
    if (ip) {
        return `Whitelist ${ip} for this key at developer.brawlstars.com (server IP Supercell sees — not your home Wi‑Fi).`;
    }
    return 'Allowed IP list for this key at developer.brawlstars.com must include the proxy server IP Supercell sees.';
}

const OFFICIAL_API_FETCH_MS = 30000;

// Official Supercell API — always via same-origin or configured proxy (server forwards Authorization).
async function smartBrawlFetch(endpoint) {
    const headers = { 'Authorization': `Bearer ${officialApiKey}` };
    const base = getProxyBaseUrl();
    const url = `${base}/api/official${endpoint}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), OFFICIAL_API_FETCH_MS);
    const opts = { headers, cache: 'no-store', signal: ctrl.signal };
    try {
        if (window.location.protocol === 'file:') {
            try {
                return await fetch(url, opts);
            } catch (err) {
                console.warn('[Network] Local proxy unreachable:', err);
                throw err;
            }
        }
        return await fetch(url, opts);
    } finally {
        clearTimeout(timer);
    }
}

/** BrawlAPI (brawlers/maps) — try proxy first, then public API if the host has no rewrite. */
async function fetchBrawlApiJson(path) {
    const candidates = [];
    if (window.location.protocol === 'file:') {
        candidates.push('http://127.0.0.1:8000');
    }
    const proxyBase = getProxyBaseUrl();
    if (!candidates.includes(proxyBase)) candidates.push(proxyBase);

    const tried = new Set();
    for (const base of candidates) {
        if (tried.has(base)) continue;
        tried.add(base);
        try {
            const res = await fetch(`${base}/api${path}`, { cache: 'no-store' });
            const ct = res.headers.get('content-type') || '';
            if (res.ok && ct.includes('application/json')) {
                return await res.json();
            }
        } catch (_) { /* try next */ }
    }
    const res = await fetch(`https://api.brawlapi.com/v1${path}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`BrawlAPI ${path} HTTP ${res.status}`);
    return await res.json();
}

// Global Game Mode Icon Safety Map (using official Brawlify IDs)
const MODE_ICON_MAP = {
    'GEM-GRAB': '48000000', 'GEM_GRAB': '48000000', 'GEMGRAB': '48000000',
    'HEIST': '48000002',
    'BOUNTY': '48000003',
    'BRAWL-BALL': '48000005', 'BRAWL_BALL': '48000005', 'BRAWLBALL': '48000005',
    'HOT-ZONE': '48000017', 'HOT_ZONE': '48000017', 'HOTZONE': '48000017',
    'KNOCKOUT': '48000020',
    'DUELS': '48000024',
    'WIPEOUT': '48000025',
    'PAYLOAD': '48000026',
    'BASKET-BRAWL': '48000022', 'BASKET_BRAWL': '48000022',
    'SOLO-SHOWDOWN': '48000006', 'SOLO_SHOWDOWN': '48000006'
};

// The active pool of Ranked Maps (Edit this array when ranked seasons change)
const defaultRankedPool = [
    // Brawl Ball
    "Beach Ball", "Center Stage", "Pinball Dreams", "Sneaky Fields", "Spiraling Out", "Triple Dribble",
    // Gem Grab
    "Double Swoosh", "Gem Fort", "Hard Rock Mine", "Undermine",
    // Heist
    "Bridge Too Far", "Hot Potato", "Kaboom Canyon", "Safe Zone",
    // Hot Zone
    "Dueling Beetles", "Open Business", "Parallel Plays", "Ring of Fire",
    // Knockout
    "Belle's Rock", "Flaring Phoenix", "New Horizons", "Out in the Open",
    // Bounty
    "Dry Season", "Hideout", "Layer Cake", "Shooting Star"
];

let RANKED_POOL = JSON.parse(localStorage.getItem('ranked_maps_v2')) || defaultRankedPool;

// Form State
let selectedBrawler = null;
let selectedMode = null;

// Analytics State
let playedMaps = [];
let selectedAnalyticsMap = null;
let activeMatchTab = 'ranked'; // 'ranked' or 'trophy'

// DOM Elements
const navLinks = document.querySelectorAll('.nav-links li');
const views = document.querySelectorAll('.view');
const modalOverlay = document.getElementById('add-match-modal');
const addMatchBtn = document.getElementById('add-match-btn');
const closeBtns = document.querySelectorAll('.close-modal');
const matchForm = document.getElementById('add-match-form');
const clearAllBtn = document.getElementById('clear-all-btn');

// Dropdown Elements
const brawlerDropdown = document.getElementById('brawler-dropdown');
const brawlerSearch = document.getElementById('brawler-search');
const brawlerOptions = document.getElementById('brawler-options');
const brawlerIcon = document.getElementById('brawler-selected-icon');

const modeDropdown = document.getElementById('mode-dropdown');
const modeSearch = document.getElementById('mode-search');
const modeOptions = document.getElementById('mode-options');
const modeIcon = document.getElementById('mode-selected-icon');

// Settings Elements
const mapPoolInput = document.getElementById('map-pool-input');
const savePoolBtn = document.getElementById('save-pool-btn');
const savePoolMsg = document.getElementById('save-pool-msg');

// Profile Elements
const linkAccountModal = document.getElementById('link-account-modal');
const openLinkModalBtn = document.getElementById('open-link-modal-btn');
const closeLinkBtn = document.getElementById('close-link-btn');
const editProfileBtn = document.getElementById('edit-profile-btn');
const linkAccountForm = document.getElementById('link-account-form');
const profileUnlinked = document.getElementById('profile-unlinked');
const profileLinked = document.getElementById('profile-linked');
const profileUsername = document.getElementById('profile-username');
const profileTag = document.getElementById('profile-tag');
const profileAvatar = document.getElementById('profile-avatar');
const profileLiveStats = document.getElementById('profile-live-stats');
const profileTrophies = document.getElementById('profile-trophies');
const profileHighest = document.getElementById('profile-highest');
const profile3v3 = document.getElementById('profile-3v3');
const profileClub = document.getElementById('profile-club');
const apiStatusBadge = document.getElementById('api-status-badge');
const syncIndicator = document.getElementById('sync-indicator');

// Collection Elements
const collectionGrid = document.getElementById('collection-grid');
const collectionCount = document.getElementById('collection-count');

// Settings Elements - Expanded
const apiTokenInput = document.getElementById('api-token-input');
const apiProxyInput = document.getElementById('api-proxy-input');
const saveApiBtn = document.getElementById('save-api-btn');
const saveApiMsg = document.getElementById('save-api-msg');

// Map Analytics Elements
const analyticsMapDropdown = document.getElementById('analytics-map-dropdown');
const analyticsMapSearch = document.getElementById('analytics-map-search');
const analyticsMapOptions = document.getElementById('analytics-map-options');
const analyticsMapIcon = document.getElementById('analytics-map-selected-icon');
const analyticsBrawlersList = document.getElementById('analytics-brawlers-list');

// Initialization
async function init() {
    updateProfileCard();
    renderMatches();
    updateDashboard();
    
    // Populate Settings Textarea
    mapPoolInput.value = RANKED_POOL.join('\n');
    apiTokenInput.value = officialApiKey;
    if (apiProxyInput) apiProxyInput.value = localStorage.getItem('brawl_proxy_origin') || '';
    
    setupDropdowns();
    await fetchGameData();
    
    // Initial purge of non-rotation matches
    purgeNonRotationMatches();
    const savedCollection = JSON.parse(localStorage.getItem('brawl_collection_data')) || [];
    if (savedCollection.length > 0) renderCollection(savedCollection);
    
    // Initialize Resource Tracker
    loadResources();
    setupResourceForm();
    
    // Initial fetch logs & start auto-sync loop (45s interval for reliability)
    if (officialApiKey) {
        syncBattlelog();
        fetchLiveProfile(); // Also refresh profile on load
    }
    setInterval(() => {
        if (officialApiKey) syncBattlelog();
    }, 45000); // Poll every 45 seconds for matched games
    
    // Refresh profile/collection every 3 minutes
    setInterval(() => {
        if (officialApiKey) fetchLiveProfile();
    }, 180000);
    
    // Manual sync button
    const syncNowBtn = document.getElementById('sync-now-btn');
    if (syncNowBtn) {
        syncNowBtn.addEventListener('click', () => {
            syncBattlelog();
            fetchLiveProfile();
        });
    }
}

// Navigation Logic
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navLinks.forEach(nav => nav.classList.remove('active'));
        link.classList.add('active');
        const targetView = link.dataset.view;
        views.forEach(view => {
            if (view.id === targetView) {
                view.classList.add('active');
            } else {
                view.classList.remove('active');
            }
        });
    });
});

// Settings Save Logic
savePoolBtn.addEventListener('click', async () => {
    const rawVal = mapPoolInput.value;
    const newPool = rawVal.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    RANKED_POOL = newPool;
    localStorage.setItem('ranked_maps_v2', JSON.stringify(RANKED_POOL));
    
    savePoolMsg.style.display = 'block';
    setTimeout(() => { savePoolMsg.style.display = 'none'; }, 3000);
    
    // 1. Purge historical matches that are no longer in rotation
    purgeNonRotationMatches();
    
    // 2. Re-fetch and re-filter using our new pool
    await fetchGameData();
});

saveApiBtn.addEventListener('click', async () => {
    officialApiKey = apiTokenInput.value.trim();
    localStorage.setItem('brawl_api_key', officialApiKey);

    const rawProxy = apiProxyInput ? apiProxyInput.value.trim().replace(/\/$/, '') : '';
    apiProxyOrigin = rawProxy;
    if (rawProxy) localStorage.setItem('brawl_proxy_origin', rawProxy);
    else localStorage.removeItem('brawl_proxy_origin');
    
    saveApiMsg.style.display = 'block';
    setTimeout(() => { saveApiMsg.style.display = 'none'; }, 3000);
    
    await fetchGameData();
    await fetchLiveProfile();
});

// Modal Logic
addMatchBtn.addEventListener('click', () => {
    modalOverlay.classList.add('active');
});

openLinkModalBtn.addEventListener('click', () => {
    linkAccountModal.classList.add('active');
    if (userProfile) {
        document.getElementById('link-username').value = userProfile.username;
        document.getElementById('link-tag').value = userProfile.tag;
    }
});

editProfileBtn.addEventListener('click', () => {
    linkAccountModal.classList.add('active');
    if (userProfile) {
        document.getElementById('link-username').value = userProfile.username;
        document.getElementById('link-tag').value = userProfile.tag;
    }
});

closeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
        closeModal();
    });
});

closeLinkBtn.addEventListener('click', () => {
    linkAccountModal.classList.remove('active');
});

function closeModal() {
    modalOverlay.classList.remove('active');
    matchForm.reset();
    document.getElementById('result-win').checked = true;
    
    // Reset dropdowns
    selectedBrawler = null;
    brawlerSearch.value = '';
    brawlerIcon.style.display = 'none';
    renderBrawlerOptions(brawlers);

    selectedMode = null;
    modeSearch.value = '';
    modeIcon.style.display = 'none';
    renderModeOptions(rankedMaps);
}

// Dropdown Setup
function setupDropdowns() {
    // Focus actions
    brawlerSearch.addEventListener('focus', () => {
        brawlerDropdown.classList.add('open');
        brawlerSearch.value = '';
        renderBrawlerOptions(brawlers);
    });

    modeSearch.addEventListener('focus', () => {
        modeDropdown.classList.add('open');
        modeSearch.value = '';
        renderModeOptions(rankedMaps);
    });

    analyticsMapSearch.addEventListener('focus', () => {
        analyticsMapDropdown.classList.add('open');
        analyticsMapSearch.value = '';
        renderAnalyticsMapOptions(playedMaps);
    });

    // Close options when clicking outside
    document.addEventListener('click', (e) => {
        if (!brawlerDropdown.contains(e.target)) {
            brawlerDropdown.classList.remove('open');
            if (selectedBrawler) brawlerSearch.value = selectedBrawler.name;
            else brawlerSearch.value = '';
        }
        if (!modeDropdown.contains(e.target)) {
            modeDropdown.classList.remove('open');
            if (selectedMode) modeSearch.value = `${selectedMode.modeName} - ${selectedMode.mapName}`;
            else modeSearch.value = '';
        }
        if (!analyticsMapDropdown.contains(e.target)) {
            analyticsMapDropdown.classList.remove('open');
            if (selectedAnalyticsMap) analyticsMapSearch.value = `${selectedAnalyticsMap.modeName} - ${selectedAnalyticsMap.mapName}`;
            else analyticsMapSearch.value = '';
        }
    });

    // Search Filtering
    brawlerSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = brawlers.filter(b => b.name.toLowerCase().includes(query));
        renderBrawlerOptions(filtered);
    });

    modeSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = rankedMaps.filter(map => {
            const mode = map.gameMode;
            if (!mode) return false;
            const str = `${mode.name.replace(/-/g, ' ')} - ${map.name.replace(/-/g, ' ')}`.toLowerCase();
            return str.includes(query);
        });
        renderModeOptions(filtered);
    });

    analyticsMapSearch.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        const filtered = playedMaps.filter(pm => {
            return `${pm.modeName} - ${pm.mapName}`.toLowerCase().includes(query);
        });
        renderAnalyticsMapOptions(filtered);
    });
}

function renderBrawlerOptions(list) {
    brawlerOptions.innerHTML = '';
    if (list.length === 0) {
        brawlerOptions.innerHTML = '<div class="dropdown-option" style="color: var(--text-muted); cursor: default;">No brawlers found</div>';
        return;
    }

    list.forEach(b => {
        const div = document.createElement('div');
        div.className = 'dropdown-option';
        div.innerHTML = `<img src="${b.imageUrl}" alt="${b.name}"><span>${b.name}</span>`;
        div.addEventListener('click', () => {
            selectedBrawler = b;
            brawlerSearch.value = b.name;
            brawlerIcon.src = b.imageUrl;
            brawlerIcon.style.display = 'block';
            brawlerDropdown.classList.remove('open');
        });
        brawlerOptions.appendChild(div);
    });
}

function renderModeOptions(list) {
    modeOptions.innerHTML = '';
    if (list.length === 0) {
        modeOptions.innerHTML = '<div class="dropdown-option" style="color: var(--text-muted); cursor: default;">No ranked maps found</div>';
        return;
    }

    list.forEach(map => {
        const mode = map.gameMode;
        if (!mode) return;
        
        const div = document.createElement('div');
        div.className = 'dropdown-option';
        
        // Use mapping for more robust icons
        const normalizedMode = mode.name.toUpperCase().replace(/[\s\-\.]+/g, '-');
        const modeId = MODE_ICON_MAP[normalizedMode] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '_')] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '')];
        const modeIconUrl = modeId 
            ? `https://cdn.brawlify.com/game-modes/regular/${modeId}.png`
            : `https://cdn.brawlify.com/gamemode/header/${mode.hash.toLowerCase()}.png`;
        
        const cleanModeName = mode.name.replace(/-/g, ' ');
        const cleanMapName = map.name.replace(/-/g, ' ');

        div.innerHTML = `
            <img src="${modeIconUrl}" alt="${cleanModeName}">
            <span>${cleanModeName} - ${cleanMapName}</span>
        `;
        div.addEventListener('click', () => {
            selectedMode = {
                modeName: cleanModeName,
                mapName: cleanMapName,
                modeIcon: modeIconUrl
            };
            modeSearch.value = `${cleanModeName} - ${cleanMapName}`;
            modeIcon.src = modeIconUrl;
            modeIcon.style.display = 'block';
            modeDropdown.classList.remove('open');
        });
        modeOptions.appendChild(div);
    });
}

function renderAnalyticsMapOptions(list) {
    analyticsMapOptions.innerHTML = '';
    if (list.length === 0) {
        analyticsMapOptions.innerHTML = '<div class="dropdown-option" style="color: var(--text-muted); cursor: default;">No map data yet</div>';
        return;
    }

    list.forEach(pm => {
        const div = document.createElement('div');
        div.className = 'dropdown-option';
        
        div.innerHTML = `
            <img src="${pm.modeIcon}" alt="${pm.modeName}">
            <span>${pm.modeName} - ${pm.mapName}</span>
        `;
        div.addEventListener('click', () => {
            selectedAnalyticsMap = pm;
            analyticsMapSearch.value = `${pm.modeName} - ${pm.mapName}`;
            analyticsMapIcon.src = pm.modeIcon;
            analyticsMapIcon.style.display = 'block';
            analyticsMapDropdown.classList.remove('open');
            updateAnalyticsData();
        });
        analyticsMapOptions.appendChild(div);
    });
}

// Fetch Data from BrawlAPI
async function fetchGameData() {
    try {
        const brawlersData = await fetchBrawlApiJson('/brawlers');
        brawlers = brawlersData.list.sort((a, b) => a.name.localeCompare(b.name));
        
        brawlerSearch.placeholder = "Select a Brawler...";
        brawlerSearch.disabled = false;
        renderBrawlerOptions(brawlers);

        const mapsData = await fetchBrawlApiJson('/maps');
        
        // Deduplicate maps by their sanitized name
        const uniqueMaps = [];
        const seenNames = new Set();
        mapsData.list.forEach(m => {
            const normalizedName = m.name.replace(/-/g, ' ').toLowerCase();
            if (!seenNames.has(normalizedName)) {
                seenNames.add(normalizedName);
                uniqueMaps.push(m);
            }
        });
        
        // Filter out specific maps listed in the ranked pool memory
        rankedMaps = uniqueMaps.filter(m => {
            const normalizedName = m.name.replace(/-/g, ' ').toLowerCase();
            return RANKED_POOL.some(rankedName => rankedName.replace(/-/g, ' ').toLowerCase() === normalizedName);
        });
        
        modeSearch.placeholder = "Select Ranked Map & Mode...";
        modeSearch.disabled = false;
        renderModeOptions(rankedMaps);

    } catch (error) {
        console.error("Error fetching BrawlAPI data:", error);
        if (window.location.protocol === 'file:' || error.name === 'TypeError') {
            brawlerSearch.placeholder = "⚠️ Proxy missing. Live mode selection disabled.";
            modeSearch.placeholder = "⚠️ Run Launch.bat to enable map selection.";
        } else {
            brawlerSearch.placeholder = "Error loading brawlers.";
            modeSearch.placeholder = "Error loading maps.";
        }
    }
}

// Profile Logic
linkAccountForm.addEventListener('submit', (e) => {
    e.preventDefault();
    
    const username = document.getElementById('link-username').value.trim();
    const tag = document.getElementById('link-tag').value.trim().toUpperCase();
    
    if (!tag.startsWith('#')) {
        alert("Player Tag must start with a `#` symbol.");
        return;
    }

    userProfile = {
        username,
        tag,
        icon: "https://cdn.brawlify.com/profile-icons/regular/28000000.png" // Default generic icon until API hooked
    };
    
    localStorage.setItem('brawl_profile', JSON.stringify(userProfile));
    linkAccountModal.classList.remove('active');
    updateProfileCard();
});

function updateProfileCard() {
    if (userProfile) {
        profileUnlinked.style.display = 'none';
        profileLinked.style.display = 'flex';
        profileUsername.textContent = userProfile.username;
        profileTag.textContent = userProfile.tag;
        profileAvatar.src = userProfile.icon;
        
        // Hide API specific stats by default until fetched
        profileLiveStats.style.display = 'none';
        profileClub.style.display = 'none';
        apiStatusBadge.style.display = 'none';
        
        if (officialApiKey) fetchLiveProfile();
    } else {
        profileUnlinked.style.display = 'flex';
        profileLinked.style.display = 'none';
    }
}

async function fetchLiveProfile() {
    if (!userProfile || !officialApiKey) return;
    
    apiStatusBadge.style.display = 'block';
    apiStatusBadge.style.color = 'var(--text-muted)';
    apiStatusBadge.textContent = 'API Syncing...';
    
    // Developer Sandbox Bypass for server outages
    if (officialApiKey === 'SANDBOX_TEST') {
        setTimeout(() => {
            apiStatusBadge.style.color = 'var(--color-win)';
            apiStatusBadge.textContent = 'Live Synced ✓ (Sandbox)';
            
            profileLiveStats.style.display = 'flex';
            profileTrophies.textContent = (45120).toLocaleString();
            profileHighest.textContent = (46000).toLocaleString();
            profile3v3.textContent = (12540).toLocaleString();
            profileClub.style.display = 'inline-block';
            profileClub.textContent = 'Antigravity Esports';
            
            const sandboxBrawlers = [
                { name: "SHELLY", power: 11, hasHypercharge: true, starPowers: [{name: "Shell Shock"}, {name: "Band-Aid"}], gadgets: [{name:"Fast Forward"}], gears: [{name: "Speed"}, {name: "Damage"}] },
                { name: "EDGAR", power: 9, starPowers: [{name: "Fisticuffs"}], gadgets: [{name:"Let's Fly"}], gears: [] },
                { name: "PIPER", power: 10, starPowers: [{name: "Ambush"}], gadgets: [{name:"Auto Aimer"}, {name:"Homemade Recipe"}], gears: [{name: "Damage"}] },
                { name: "MORTIS", power: 11, hasHypercharge: true, starPowers: [{name: "Creepy Harvest"}, {name: "Coiled Snake"}], gadgets: [{name:"Combo Spinner"}], gears: [{name: "Damage"}] },
                { name: "CROW", power: 8, starPowers: [], gadgets: [{name:"Defense Booster"}], gears: [] }
            ];
            
            localStorage.setItem('brawl_collection_data', JSON.stringify(sandboxBrawlers));
            renderCollection(sandboxBrawlers);
            
            setTimeout(() => { apiStatusBadge.style.display = 'none'; }, 4000);
        }, 800);
        return;
    }
    
    try {
        const tagFormatted = userProfile.tag.replace('#', '');
        const res = await smartBrawlFetch(`/players/%23${tagFormatted}`);
        const ct = res.headers.get('content-type') || '';

        if (!res.ok) {
            let hint = `API error (${res.status})`;
            if (res.status === 404 || !ct.includes('application/json')) {
                hint = 'No proxy here (e.g. GitHub Pages). Deploy this repo on Vercel/Netlify, or set “Proxy site URL” in Settings to that deployment.';
            } else {
                try {
                    const errData = await res.json();
                    if (res.status === 403) {
                        apiStatusBadge.style.color = 'var(--color-loss)';
                        apiStatusBadge.textContent = `⚠️ ${keyIpWhitelistHint(errData.message)}`;
                        console.error('[Profile] 403:', errData.message || errData);
                        return;
                    }
                    if (errData.message) hint = errData.message;
                } catch { /* keep hint */ }
            }
            apiStatusBadge.style.color = 'var(--color-loss)';
            apiStatusBadge.textContent = hint;
            return;
        }

        let data;
        try {
            data = await res.json();
        } catch (parseErr) {
            apiStatusBadge.style.color = 'var(--color-loss)';
            apiStatusBadge.textContent = 'Bad response from proxy (not JSON). Redeploy or check Vercel logs.';
            console.error(parseErr);
            return;
        }

        // Supercell sometimes returns HTTP 200 with a JSON error body (no `trophies`).
        if (data.reason && typeof data.trophies !== 'number') {
            apiStatusBadge.style.color = 'var(--color-loss)';
            apiStatusBadge.textContent = `⚠️ ${keyIpWhitelistHint(data.message)}`;
            console.warn('[Profile] Error-shaped JSON:', data.reason, data.message);
            return;
        }

        // Note: `if (data.trophies)` is wrong — trophy count can be 0 and is still valid.
        if (typeof data.trophies === 'number') {
            // Update successful
            apiStatusBadge.style.color = 'var(--color-win)';
            apiStatusBadge.textContent = 'Live Synced ✓';
            
            // Map JSON response to UI
            profileLiveStats.style.display = 'flex';
            profileTrophies.textContent = data.trophies.toLocaleString();
            profileHighest.textContent = (data.highestTrophies ?? 0).toLocaleString();
            profile3v3.textContent = (data['3vs3Victories'] || 0).toLocaleString();
            
            // Sync Profile Icon from API
            if (data.icon && data.icon.id) {
                userProfile.icon = `https://cdn.brawlify.com/profile-icons/regular/${data.icon.id}.png`;
                localStorage.setItem('brawl_profile', JSON.stringify(userProfile));
                profileAvatar.src = userProfile.icon;
            }

            if (data.club && data.club.name) {
                profileClub.style.display = 'inline-block';
                profileClub.textContent = data.club.name;
            } else {
                profileClub.style.display = 'none';
            }
            
            // Sync Collection
            if (data.brawlers) {
                localStorage.setItem('brawl_collection_data', JSON.stringify(data.brawlers));
                renderCollection(data.brawlers);
            }
            
            // Wait 3 seconds and fade out the badge for cleanliness
            setTimeout(() => { apiStatusBadge.style.display = 'none'; }, 3000);
        } else {
            apiStatusBadge.style.color = 'var(--color-loss)';
            const msg = [data.reason, data.message].filter(Boolean).join(' — ') || 'Unexpected API response (no player data). Check player tag.';
            apiStatusBadge.textContent = msg;
            console.warn('[Profile] OK but not a player JSON:', data);
        }
        
    } catch (err) {
        apiStatusBadge.style.color = 'var(--color-loss)';
        if (window.location.protocol === 'file:') {
            apiStatusBadge.textContent = 'Run Launch.bat (local proxy) or open the deployed site on Vercel/Netlify.';
        } else if (err.name === 'AbortError') {
            apiStatusBadge.textContent = `Request timed out (${OFFICIAL_API_FETCH_MS / 1000}s). Proxy or upstream API is slow or unreachable.`;
        } else if (isNetworkOrCorsFailure(err)) {
            apiStatusBadge.textContent = 'Cannot reach API proxy. If you use GitHub Pages, set “Proxy site URL” to your Vercel deployment of this repo.';
        } else {
            apiStatusBadge.textContent = 'Failed to fetch profile';
        }
        console.error(err);
    }
}

// Form Submission (Add Match)
matchForm.addEventListener('submit', (e) => {
    e.preventDefault();

    if (!selectedBrawler) {
        alert("Please select a Brawler.");
        return;
    }
    if (!selectedMode) {
        alert("Please select a Ranked Map & Mode.");
        return;
    }

    const result = document.querySelector('input[name="result"]:checked').value;

    const match = {
        id: Date.now().toString(),
        brawlerId: selectedBrawler.id,
        brawlerName: selectedBrawler.name,
        brawlerIcon: selectedBrawler.imageUrl,
        modeName: selectedMode.modeName,
        mapName: selectedMode.mapName,
        modeIcon: selectedMode.modeIcon,
        result,
        isRanked: true, // Manual entries are assumed ranked for this tracker
        date: new Date().toISOString()
    };

    matches.unshift(match);
    localStorage.setItem('brawl_matches', JSON.stringify(matches));
    
    closeModal();
    renderMatches();
    updateDashboard();
});

// Match History Tab Switching
window.switchMatchTab = function(tabName) {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    const targetTab = document.querySelector(`.sub-tab[data-tab="${tabName}"]`);
    if (targetTab) targetTab.classList.add('active');
    activeMatchTab = tabName;
    renderMatches();
};

// Clear All Matches
clearAllBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to delete all match history?")) {
        matches = [];
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
        renderMatches();
        updateDashboard();
    }
});

// Render Match History List
function renderMatches() {
    const listContainer = document.getElementById('matches-list-container');
    
    // Filter matches based on the active tab
    const filteredMatches = matches.filter(m => {
        if (activeMatchTab === 'ranked') {
            return m.isRanked !== false; // Include legacy (undefined) as ranked, and explicit isRanked: true
        } else {
            return m.isRanked === false; // Only explicit trophy matches
        }
    });

    if (filteredMatches.length === 0) {
        listContainer.innerHTML = `<div class="empty-state">No ${activeMatchTab} matches recorded yet.</div>`;
        return;
    }

    listContainer.innerHTML = '';
    
    filteredMatches.forEach((match, index) => {
        const item = document.createElement('div');
        item.className = 'match-item';
        
        const dateStr = new Date(match.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute:'2-digit' });

        item.innerHTML = `
            <div class="match-item-left">
                <img src="${match.brawlerIcon || 'https://via.placeholder.com/40'}" alt="${match.brawlerName}" class="brawler-avatar" onerror="this.src='https://via.placeholder.com/40'">
                <div class="match-item-details">
                    <h4>${match.brawlerName}</h4>
                    <p>${match.modeName} - ${match.mapName} • ${dateStr}</p>
                </div>
            </div>
            <div style="display: flex; align-items: center; gap: 1rem;">
                <div class="match-item-result result-${match.result}">
                    ${match.result}
                </div>
                <button class="delete-match-btn" title="Delete Match">&times;</button>
            </div>
        `;
        
        item.querySelector('.delete-match-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteMatch(match.id);
        });

        listContainer.appendChild(item);
    });
}

function deleteMatch(id) {
    matches = matches.filter(m => m.id !== id);
    localStorage.setItem('brawl_matches', JSON.stringify(matches));
    renderMatches();
    updateDashboard();
}

/**
 * Permanently deletes matches from maps that are not in the current RANKED_POOL.
 * @param {boolean} silent If true, skips re-rendering (useful during sync)
 * @returns {number} The number of purged items
 */
function purgeNonRotationMatches(silent = false) {
    if (!matches || matches.length === 0) return 0;
    
    const beforeCount = matches.length;
    const rankedPoolLower = RANKED_POOL.map(rp => rp.toLowerCase().replace(/[\s\-\.]+/g, ' '));
    
    matches = matches.filter(m => {
        // Preserve all Trophy matches permanently. We only purge out-of-rotation Ranked games.
        if (m.isRanked === false) return true;
        
        const normalizedMatchMap = (m.mapName || '').toLowerCase().replace(/[\s\-\.]+/g, ' ');
        return rankedPoolLower.includes(normalizedMatchMap);
    });
    
    const purged = beforeCount - matches.length;
    if (purged > 0) {
        localStorage.setItem('brawl_matches', JSON.stringify(matches));
        if (!silent) {
            renderMatches();
            updateDashboard();
        }
    }
    return purged;
}

// SYNC LOGIC (Supercell Official API)
// ======================================
let lastSyncTime = null;

async function syncBattlelog() {
    if (isSyncing) return;
    if (!userProfile || !userProfile.tag) {
        alert("Please link your account at the top first!");
        return;
    }

    // Safety check - wait for brawlers to load if they haven't yet
    if (brawlers.length === 0) {
        const syncStatus = document.getElementById('sync-status-text');
        if (syncStatus) {
            syncStatus.textContent = "Waiting for game data...";
            syncStatus.style.color = "var(--color-win)";
        }
        await new Promise(r => setTimeout(r, 1500)); 
    }

    isSyncing = true;
    const syncStatus = document.getElementById('sync-status-text');
    if (syncStatus) {
        syncStatus.textContent = "Syncing...";
        syncStatus.style.color = "var(--color-win)";
    }
    
    // --- Auto-purge non-ranked matches ---
    const purged = purgeNonRotationMatches(true); // silent mode for sync
    if (purged > 0) {
        console.log(`[Sync] Purged ${purged} historical non-ranked matches`);
    }
    
    try {
        let items = [];
        
        if (officialApiKey === 'SANDBOX_TEST') {
            // Fake Mock Data for Sandbox
            const modes = ['brawlBall', 'gemGrab', 'heist', 'knockout', 'bounty', 'hotZone'];
            const maps = ['Center Stage', 'Hard Rock Mine', 'Hot Potato', 'Flaring Phoenix', 'Shooting Star', 'Ring of Fire'];
            const brawlerNames = ['MORTIS', 'SHELLY', 'CROW', 'EDGAR', 'PIPER'];
            const idx = Math.floor(Math.random() * modes.length);
            items = [
                {
                    battleTime: new Date().toISOString().replace(/[-:]/g, '').replace('.', ''),
                    event: { mode: modes[idx], map: maps[idx] },
                    battle: {
                        mode: modes[idx], type: "ranked", 
                        result: Math.random() > 0.4 ? "victory" : "defeat",
                        teams: [[{ tag: userProfile.tag, name: userProfile.username, brawler: { name: brawlerNames[Math.floor(Math.random() * brawlerNames.length)] } }]]
                    }
                }
            ];
            await new Promise(r => setTimeout(r, 800));
        } else {
            // Official Fetch
            const tagFormatted = userProfile.tag.replace('#', '');
            const res = await smartBrawlFetch(`/players/%23${tagFormatted}/battlelog`);
            
            if (!res.ok) {
                const ct = res.headers.get('content-type') || '';
                let errorMsg = `Sync error (${res.status})`;
                if (res.status === 404 || !ct.includes('application/json')) {
                    errorMsg = 'No API proxy on this host. Use Vercel/Netlify for this repo, or set “Proxy site URL” in Settings.';
                } else {
                    try {
                        const errData = await res.json();
                        if (res.status === 403) {
                            errorMsg = `⚠️ ${keyIpWhitelistHint(errData.message)}`;
                            console.error('[Sync] 403 Forbidden:', errData.hint || errData.message || 'IP mismatch');
                        } else if (errData.message) {
                            errorMsg = `Error: ${errData.message}`;
                        }
                    } catch { /* couldn't parse error body */ }
                }
                
                if (syncStatus) {
                    syncStatus.textContent = errorMsg;
                    syncStatus.style.color = 'var(--color-loss)';
                }
                console.warn(`[Sync] Battlelog fetch failed: HTTP ${res.status}`);
                return;
            }
            
            // Reset status color on success
            if (syncStatus) syncStatus.style.color = 'var(--text-muted)';
            
            const data = await res.json();
            if (data.reason && !Array.isArray(data.items)) {
                const ip = extractIpFromApiMessage(String(data.message || ''));
                const errorMsg = ip
                    ? `⚠️ ${keyIpWhitelistHint(data.message)}`
                    : [data.reason, data.message].filter(Boolean).join(' — ');
                if (syncStatus) {
                    syncStatus.textContent = errorMsg;
                    syncStatus.style.color = 'var(--color-loss)';
                }
                console.warn('[Sync] Error JSON from battlelog:', data);
                return;
            }
            if (data.items) items = data.items;
            console.log(`[Sync] Fetched ${items.length} battlelog entries`);
        }
        
        let newCount = 0;
        let skippedCount = 0;
        let updatedCount = 0;
        
        items.forEach(item => {
            // Safety check for malformed entries
            if (!item.battle || !item.event) {
                skippedCount++;
                return;
            }
            
            // Categorize match type — Ranked vs Trophy
            const battleType = (item.battle.type || '').toLowerCase();
            // The API uses "ranked" for standard Trophy ladder matches. 
            // True competitive mode is "soloranked" or "teamranked" or "competitive".
            const isRanked = battleType === 'soloranked' || battleType === 'teamranked' || battleType === 'competitive';
            
            // Find User's Brawler in the teams data
            let myBrawlerName = "";
            let foundPlayer = false;
            
            // Handle team-based modes (never use team array index as "rank" — it is not win/loss.)
            if (item.battle.teams) {
                for (let i = 0; i < item.battle.teams.length; i++) {
                    let team = item.battle.teams[i];
                    for (let p of team) {
                        if (p.tag === userProfile.tag) {
                            myBrawlerName = p.brawler.name.toUpperCase();
                            foundPlayer = true;
                            break;
                        }
                    }
                    if (foundPlayer) break;
                }
            }
            
            // Handle solo modes (Showdown, etc.) — players array instead of teams
            if (!foundPlayer && item.battle.players) {
                for (let i = 0; i < item.battle.players.length; i++) {
                    let p = item.battle.players[i];
                    if (p.tag === userProfile.tag) {
                        myBrawlerName = p.brawler.name.toUpperCase();
                        foundPlayer = true;
                        break;
                    }
                }
            }
            
            if (!foundPlayer) {
                console.log(`[Sync] Skipped match: could not find player ${userProfile.tag}`);
                skippedCount++;
                return;
            }
            
            // Resolve brawler icon from loaded global data
            const normalizedMyBrawler = normalizeBrawlerName(myBrawlerName);
            const mappedBrawler = brawlers.find(b => normalizeBrawlerName(b.name) === normalizedMyBrawler);
            
            // Try to find map in ranked pool for icon, but DON'T skip if not found
            const mappedMap = rankedMaps.find(m => m.name === (item.event.map || ''));
            
            // Determine result: prefer official `battle.result` (3v3 / most modes). Rank rules only when that is absent (Showdown-style).
            let result = 'loss';
            const rawResult = (item.battle.result || '').toLowerCase();
            const modeStr = (item.battle.mode || item.event.mode || '').toLowerCase();

            if (rawResult === 'victory' || rawResult === 'win') {
                result = 'win';
            } else if (rawResult === 'defeat' || rawResult === 'loss') {
                result = 'loss';
            } else if (rawResult === 'draw') {
                result = 'draw';
            } else {
                const placement = item.battle.rank;
                if (placement !== undefined && placement !== null) {
                    const r = Number(placement);
                    if (!Number.isNaN(r)) {
                        if (r === 1) {
                            result = 'win';
                        } else if (modeStr.includes('solo') && r <= 4) {
                            result = 'win';
                        } else if (modeStr.includes('duo') && r <= 2) {
                            result = 'win';
                        } else if (modeStr.includes('trio') && r <= 2) {
                            result = 'win';
                        } else if (r === 5 && modeStr.includes('solo')) {
                            result = 'draw';
                        } else if (r === 3 && modeStr.includes('duo')) {
                            result = 'draw';
                        }
                    }
                }
            }
            
            // Parse the actual battle time for accurate history
            let battleDate;
            try {
                // Brawl Stars API format: "20260407T123456.000Z" 
                const bt = item.battleTime;
                battleDate = new Date(
                    bt.slice(0,4) + '-' + bt.slice(4,6) + '-' + bt.slice(6,8) + 'T' +
                    bt.slice(9,11) + ':' + bt.slice(11,13) + ':' + bt.slice(13,15) + 'Z'
                ).toISOString();
            } catch {
                battleDate = new Date().toISOString();
            }
            
            const newMatch = {
                id: item.battleTime,
                source: 'api',  // Tag as API-synced so it never gets purged
                brawlerId: mappedBrawler ? mappedBrawler.id : 0,
                brawlerName: mappedBrawler ? mappedBrawler.name : myBrawlerName,
                brawlerIcon: mappedBrawler ? mappedBrawler.imageUrl : '',
                modeName: mappedMap?.gameMode?.name || item.battle.mode || item.event.mode || 'Ranked',
                mapName: item.event.map || 'Unknown Map',
                modeIcon: mappedMap?.gameMode?.imageUrl || '',
                result,
                isRanked: isRanked,
                date: battleDate
            };
            
            // Duplicate & Retroactive Update Check
            const existingIdx = matches.findIndex(m => m.id === item.battleTime);
            if (existingIdx !== -1) {
                // Background repair: update previously broken entries
                const oldMatch = matches[existingIdx];
                if (oldMatch.isRanked !== isRanked || oldMatch.result !== result) {
                    oldMatch.isRanked = isRanked;
                    oldMatch.result = result;
                    updatedCount++;
                }
            } else {
                matches.unshift(newMatch);
                newCount++;
            }
        });
        
        if (newCount > 0 || purged > 0 || updatedCount > 0) {
            localStorage.setItem('brawl_matches', JSON.stringify(matches));
            renderMatches();
            updateDashboard();
            if (newCount > 0) console.log(`[Sync] Added ${newCount} new matches`);
            if (updatedCount > 0) console.log(`[Sync] Repaired ${updatedCount} existing matches`);
        }
        
        // Update sync status display
        lastSyncTime = new Date();
        if (syncStatus) {
            const timeStr = lastSyncTime.toLocaleTimeString();
            let statusParts = [];
            if (newCount > 0) statusParts.push(`+${newCount} match${newCount > 1 ? 'es' : ''}`);
            if (purged > 0) statusParts.push(`${purged} non-ranked removed`);
            syncStatus.textContent = statusParts.length > 0
                ? `${statusParts.join(', ')} • ${timeStr}`
                : `Up to date • ${timeStr}`;
        }
        
    } catch (err) {
        console.error("Auto Sync Failed:", err);
        const syncStatus = document.getElementById('sync-status-text');
        if (syncStatus) {
            if (window.location.protocol === 'file:') {
                syncStatus.textContent = 'Offline — start the local server (Launch.bat) for API sync.';
            } else if (isNetworkOrCorsFailure(err)) {
                syncStatus.textContent = 'Cannot reach API proxy. Deploy on Vercel/Netlify or set “Proxy site URL” in Settings.';
            } else {
                syncStatus.textContent = 'Sync failed — check API key and developer portal IP whitelist.';
            }
        }
    } finally {
        isSyncing = false;
    }
}

// Global IP Checker for Debugging
async function handleCheckIP() {
    const btn = document.getElementById('check-ip-btn');
    const display = document.getElementById('ip-display');
    if (!btn || !display) return;

    btn.textContent = 'Checking...';
    display.style.display = 'inline-block';
    display.textContent = 'Detecting...';
    
    const ip = await getBrowserIP();
    display.textContent = `Current Browser IP: ${ip}`;
    btn.textContent = 'Check Connection IP';
}

// Render Dashboard
function updateDashboard() {
    // Filter for only ranked matches for analytics
    const rankedMatches = matches.filter(m => m.isRanked !== false); // Assume true if missing (for legacy) but sync sets true
    const totalMatches = rankedMatches.length;
    
    document.getElementById('overall-match-count').textContent = `${totalMatches} Ranked Matches`;

    if (totalMatches === 0) {
        document.getElementById('overall-winrate-text').textContent = '0%';
        document.getElementById('overall-winrate-circle').style.background = `conic-gradient(var(--bg-surface) 360deg, var(--bg-surface) 0deg)`;
        
        document.getElementById('top-brawlers-list').innerHTML = '<li class="empty-state">No ranked matches recorded yet.</li>';
        document.getElementById('best-modes-list').innerHTML = '<li class="empty-state">No ranked matches recorded yet.</li>';
        return;
    }

    // Extract Played Maps for Analytics (only maps currently in rotation)
    const uniqueMapsMap = new Map();
    const rankedPoolLower = RANKED_POOL.map(rp => rp.toLowerCase().replace(/[\s\-\.]+/g, ' '));
    
    rankedMatches.forEach(m => {
        const normalizedMap = (m.mapName || '').toLowerCase().replace(/[\s\-\.]+/g, ' ');
        if (!rankedPoolLower.includes(normalizedMap)) return; // Only show maps in current rotation
        
        const key = `${m.modeName} - ${m.mapName}`;
        if (!uniqueMapsMap.has(key)) {
            // Find better icon if current one is broken
            let icon = m.modeIcon;
            if (!icon || icon === "undefined" || icon === "") {
                const normalizedMode = m.modeName.toUpperCase().replace(/[\s\-\.]+/g, '-');
                const modeId = MODE_ICON_MAP[normalizedMode] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '_')] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '')];
                if (modeId) icon = `https://cdn.brawlify.com/game-modes/regular/${modeId}.png`;
            }
            uniqueMapsMap.set(key, { modeName: m.modeName, mapName: m.mapName, modeIcon: icon || 'https://cdn.brawlify.com/game-modes/regular/48000000.png' });
        }
    });
    playedMaps = Array.from(uniqueMapsMap.values());
    if (selectedAnalyticsMap) updateAnalyticsData();

    // 1. Overall Win Rate
    const wins = rankedMatches.filter(m => m.result === 'win').length;
    const winRate = Math.round((wins / totalMatches) * 100);
    
    document.getElementById('overall-winrate-text').textContent = `${winRate}%`;
    document.getElementById('overall-winrate-circle').style.background = `conic-gradient(var(--accent-blue) ${winRate * 3.6}deg, var(--bg-surface) 0deg)`;

    // 2. Top Brawlers
    const brawlerStats = {};
    rankedMatches.forEach(m => {
        if (!brawlerStats[m.brawlerId]) {
            brawlerStats[m.brawlerId] = { name: m.brawlerName, icon: m.brawlerIcon, matches: 0, wins: 0 };
        }
        brawlerStats[m.brawlerId].matches++;
        if (m.result === 'win') brawlerStats[m.brawlerId].wins++;
    });

    const sortedBrawlers = Object.values(brawlerStats)
        .map(b => ({ ...b, winRate: Math.round((b.wins / b.matches) * 100) }))
        .sort((a, b) => {
            if (b.winRate === a.winRate) return b.matches - a.matches;
            return b.winRate - a.winRate;
        })
        .slice(0, 3);

    const brawlersList = document.getElementById('top-brawlers-list');
    brawlersList.innerHTML = '';
    sortedBrawlers.forEach(b => {
        brawlersList.innerHTML += `
            <li>
                <div class="brawler-info">
                    <img src="${b.icon || 'https://via.placeholder.com/40'}" class="brawler-avatar" onerror="this.src='https://via.placeholder.com/40'">
                    <div>
                        <strong>${b.name}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted)">${b.matches} matches</div>
                    </div>
                </div>
                <span class="win-rate-badge">${b.winRate}% SR</span>
            </li>
        `;
    });

    // 3. Best Modes
    const modeStats = {};
    matches.forEach(m => {
        const modeKey = `${m.modeName} - ${m.mapName}`;
        if (!modeStats[modeKey]) {
            // Fallback icon lookup if missing in match record
            let icon = m.modeIcon;
            if (!icon || icon === "undefined") {
                const foundMap = rankedMaps.find(rm => rm.name === m.mapName);
                if (foundMap && foundMap.gameMode) {
                    icon = foundMap.gameMode.imageUrl;
                }
            }
            
            modeStats[modeKey] = { 
                name: modeKey, 
                icon: icon || "", 
                matches: 0, 
                wins: 0, 
                color: m.modeColor || '#444' 
            };
        }
        modeStats[modeKey].matches++;
        if (m.result === 'win') modeStats[modeKey].wins++;
    });

    const sortedModes = Object.values(modeStats)
        .map(stats => {
            // Split "Mode - Map Names" back to just the Map Name for display
            const mapName = stats.name.includes(' - ') ? stats.name.split(' - ')[1] : stats.name;
            const modeName = stats.name.includes(' - ') ? stats.name.split(' - ')[0] : 'GEM-GRAB';
            
            // Refined icon logic: 
            // 1. Check if we already have a clean URL
            let finalIcon = (stats.icon && stats.icon !== "undefined" && stats.icon !== "") ? stats.icon : null;
            
            // 2. Try to generate from safety mapping if missing
            if (!finalIcon) {
                const normalizedMode = modeName.toUpperCase().replace(/[\s\-\.]+/g, '-');
                const modeId = MODE_ICON_MAP[normalizedMode] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '_')] || MODE_ICON_MAP[normalizedMode.replace(/-/g, '')];
                if (modeId) {
                    finalIcon = `https://cdn.brawlify.com/game-modes/regular/${modeId}.png`;
                }
            }
            
            // 3. Absolute fallback
            if (!finalIcon) {
                finalIcon = 'https://cdn.brawlify.com/game-modes/regular/48000000.png';
            }

            return { ...stats, displayName: mapName, icon: finalIcon, winRate: Math.round((stats.wins / stats.matches) * 100) };
        })
        .sort((a, b) => {
            if (b.winRate === a.winRate) return b.matches - a.matches;
            return b.winRate - a.winRate;
        })
        .slice(0, 3);

    const modesList = document.getElementById('best-modes-list');
    modesList.innerHTML = '';
    sortedModes.forEach(m => {
        modesList.innerHTML += `
            <li style="display: flex; align-items: center; justify-content: space-between; gap: 1rem;">
                <div class="mode-info" style="display: flex; align-items: center; gap: 1rem; flex: 1; min-width: 0;">
                    <div style="width: 44px; height: 44px; border-radius: var(--radius-sm); background-color: rgba(255,255,255,0.05); border: 1px solid var(--border-color); display: flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0;">
                        <img src="${m.icon || 'https://cdn.brawlify.com/game-modes/regular/Unknown.png'}" style="width: 80%; height: 80%; object-fit: contain;">
                    </div>
                    <div style="min-width: 0;">
                        <strong style="display: block; font-size: 1rem; color: var(--text-main); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${m.displayName}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted)">${m.matches} matches played</div>
                    </div>
                </div>
                <div class="win-rate-badge" style="text-align: right; min-width: fit-content; flex-shrink: 0; font-size: 1.1rem; color: var(--accent-yellow); line-height: 1.1;">
                    <div style="font-weight: 800;">${m.winRate}%</div>
                    <div style="font-size: 0.7rem; opacity: 0.8; letter-spacing: 1px;">WIN RATE</div>
                </div>
            </li>
        `;
    });
}

// Render Analytics Tab
function updateAnalyticsData() {
    if (!selectedAnalyticsMap) {
        analyticsBrawlersList.innerHTML = '<li class="empty-state">Select a map above to see brawler win rates.</li>';
        return;
    }

    // Filter for only ranked matches for analytics
    const rankedMatches = matches.filter(m => m.isRanked !== false);

    const mapMatches = rankedMatches.filter(m => m.modeName === selectedAnalyticsMap.modeName && m.mapName === selectedAnalyticsMap.mapName);
    
    if (mapMatches.length === 0) {
        analyticsBrawlersList.innerHTML = '<li class="empty-state">No data available for this map.</li>';
        return;
    }

    const brawlerStats = {};
    mapMatches.forEach(m => {
        if (!brawlerStats[m.brawlerId]) {
            brawlerStats[m.brawlerId] = { name: m.brawlerName, icon: m.brawlerIcon, matches: 0, wins: 0 };
        }
        brawlerStats[m.brawlerId].matches++;
        if (m.result === 'win') brawlerStats[m.brawlerId].wins++;
    });

    const sortedBrawlers = Object.values(brawlerStats)
        .map(b => ({ ...b, winRate: Math.round((b.wins / b.matches) * 100) }))
        .sort((a, b) => {
            if (b.winRate === a.winRate) return b.matches - a.matches;
            return b.winRate - a.winRate;
        });

    analyticsBrawlersList.innerHTML = '';
    sortedBrawlers.forEach(b => {
        analyticsBrawlersList.innerHTML += `
            <li>
                <div class="brawler-info">
                    <img src="${b.icon || 'https://via.placeholder.com/40'}" class="brawler-avatar" onerror="this.src='https://via.placeholder.com/40'">
                    <div>
                        <strong>${b.name}</strong>
                        <div style="font-size: 0.8rem; color: var(--text-muted)">${b.matches} matches (${b.wins}W - ${b.matches - b.wins}L)</div>
                    </div>
                </div>
                <span class="win-rate-badge" style="background-color: ${b.winRate >= 50 ? 'rgba(76, 219, 143, 0.1)' : 'rgba(235, 87, 87, 0.1)'}; color: ${b.winRate >= 50 ? 'var(--color-win)' : 'var(--color-loss)'}">${b.winRate}% SR</span>
            </li>
        `;
    });
}

// Render Collection Grid
function renderCollection(brawlersData) {
    if (!brawlersData || brawlersData.length === 0) {
        collectionGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); margin-top: 3rem;">No Brawler data mapped yet. Link an account first!</div>`;
        return;
    }
    
    collectionCount.textContent = `${brawlersData.length} Brawlers Unlocked`;
    
    // Sort logically: Power level descending, then alphabetically
    const sorted = [...brawlersData].sort((a, b) => {
        if (b.power !== a.power) return b.power - a.power;
        return a.name.localeCompare(b.name);
    });
    
    collectionGrid.innerHTML = '';

    // --- HD Portrait System ---
    // Brawltime.ninja serves 4x higher-res portraits than brawlify CDN.
    // However, 5 brawlers return empty 0-byte PNGs (200 status with no data).
    // For those, we skip HD entirely and go straight to the brawlify fallback.
    const BRAWLTIME_MISSING = new Set([
        '8-BIT', '8_BIT', '8BIT',
        'R-T', 'R_T', 'RT',
        'MR-P', 'MR_P', 'MR P', 'MR. P', 'MRP',
        'LARRY-LAWRIE', 'LARRY & LAWRIE', 'LARRY AND LAWRIE',
        'JAE-YONG', 'JAE_YONG', 'JAEYONG'
    ]);

    const SLUG_OVERRIDES = {
        'EL PRIMO': 'el_primo',
        'EL-PRIMO': 'el_primo',
        'BUZZ LIGHTYEAR': 'buzz_lightyear',
        'BUZZ-LIGHTYEAR': 'buzz_lightyear',
    };

    function toBrawltimeSlug(name) {
        const upper = name.toUpperCase().trim();
        if (SLUG_OVERRIDES[upper]) return SLUG_OVERRIDES[upper];
        return name.toLowerCase().trim()
            .replace(/[\s\-\.]+/g, '_')
            .replace(/[^a-z0-9_]/g, '');
    }

    function getPortraitUrl(name, globalBrawler) {
        const upper = name.toUpperCase().trim();
        // If this brawler is known to be missing on brawltime, skip HD entirely
        if (BRAWLTIME_MISSING.has(upper)) {
            return globalBrawler ? (globalBrawler.imageUrl2 || globalBrawler.imageUrl || '') : '';
        }
        const slug = toBrawltimeSlug(name);
        return `https://media.brawltime.ninja/brawlers/${slug}/avatar.png`;
    }
    
    sorted.forEach(b => {
        const normalizedPlayerName = normalizeBrawlerName(b.name);
        const globalBrawler = brawlers.find(gb => normalizeBrawlerName(gb.name) === normalizedPlayerName);
        const properName = globalBrawler ? globalBrawler.name : b.name;

        // Smart portrait URL: HD if available, fallback to brawlify
        const portraitUrl = getPortraitUrl(properName, globalBrawler);
        const fallbackUrl = globalBrawler ? (globalBrawler.imageUrl2 || globalBrawler.imageUrl || '') : '';
        
        // Safety checks for API arrays
        const gCount = b.gadgets ? b.gadgets.length : 0;
        const spCount = b.starPowers ? b.starPowers.length : 0;
        const gearCount = b.gears ? b.gears.length : 0;
        
        const normalizeStr = str => str.toUpperCase().replace(/[\s\-\.]+/g, '').replace(/[^A-Z0-9]/g, '');

        // Try to map exact item graphics via normalized matching
        let gImage = null;
        if (gCount > 0 && b.gadgets[0] && globalBrawler && globalBrawler.gadgets) {
            const match = globalBrawler.gadgets.find(g => normalizeStr(g.name) === normalizeStr(b.gadgets[0].name));
            if (match) gImage = match.imageUrl;
        }

        let spImage = null;
        if (spCount > 0 && b.starPowers[0] && globalBrawler && globalBrawler.starPowers) {
            const match = globalBrawler.starPowers.find(sp => normalizeStr(sp.name) === normalizeStr(b.starPowers[0].name));
            if (match) spImage = match.imageUrl;
        }
        
        // Create Hero Card
        const card = document.createElement('div');
        card.className = 'brawler-hero-card';
        if (b.hasHypercharge) card.classList.add('hypercharged-card');
        if (b.power === 11) card.classList.add('maxed-card');
        
        // Revised Level Indicator
        const levelVisual = b.power === 11 
            ? `<div class="level-max-indicator">
                 MAX
                 <div class="level-max-glow"></div>
               </div>`
            : `<div class="level-number-indicator">
                    <span>${b.power}</span>
               </div>`;
        
        let gadgetNode = gImage 
            ? `<img src="${gImage}" class="stat-icon-img" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><div class="gadget-fallback" style="display:none; width: 14px; height: 14px; background: ${gCount > 0 ? '#1ada46' : '#111'}; border: 2px solid ${gCount > 0 ? '#0e8a2a' : '#000'}; transform: rotate(45deg);"></div>`
            : `<div style="width: 14px; height: 14px; background: ${gCount > 0 ? '#1ada46' : '#111'}; border: 2px solid ${gCount > 0 ? '#0e8a2a' : '#000'}; transform: rotate(45deg); box-shadow: 0 2px 4px rgba(0,0,0,0.5);"></div>`;

        let spNode = spImage 
            ? `<img src="${spImage}" class="stat-icon-img sp-icon" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><svg class="sp-fallback" style="display:none; width: 24px; height: 24px; color: ${spCount > 0 ? '#FFD700' : '#111'};" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`
            : `<svg style="width: 24px; height: 24px; color: ${spCount > 0 ? '#FFD700' : '#111'}; filter: drop-shadow(0 2px 2px rgba(0,0,0,0.5));" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>`;

        const g1Active = gearCount >= 1;
        const g2Active = gearCount >= 2;

        // Build the portrait with an onload check for empty 0-byte responses
        const escapedFallback = fallbackUrl.replace(/'/g, "\\'");

        card.innerHTML = `
            <!-- Top Portrait -->
            <div class="brawler-portrait-wrap" ${b.hasHypercharge ? 'style="animation: hyperPulse 1.5s infinite alternate;"' : ''}>
                <!-- Trophy Badge -->
                <div class="trophy-tag">
                    <img src="https://media.brawltime.ninja/assets/icon/trophy.png" class="trophy-img" alt="Trophies">
                    <span class="trophy-count">${b.trophies || 0}</span>
                </div>

                <img src="${portraitUrl}" 
                     class="brawler-portrait-img" 
                     alt="${properName}"
                     onload="if(this.naturalWidth<2||this.naturalHeight<2){this.src='${escapedFallback}';this.onload=null;}"
                     onerror="this.src='${escapedFallback}'; this.onerror=null;"
                     loading="lazy">
                ${b.hasHypercharge ? '<div class="hyper-badge">HYPER</div>' : ''}
                <div class="brawler-name-label">${properName}</div>
            </div>
            
            <!-- Bottom Stats Bar -->
            <div class="brawler-stats-bar">
                ${levelVisual}
                
                <div class="brawler-stat-icons">
                    ${gadgetNode}
                    ${spNode}
                    <div class="gear-ring ${g1Active ? 'gear-active' : 'gear-locked'}"><div class="gear-inner"></div></div>
                    <div class="gear-ring ${g2Active ? 'gear-active' : 'gear-locked'}"><div class="gear-inner"></div></div>
                </div>
            </div>
        `;
        collectionGrid.appendChild(card);
    });
}

// ======================================
// Resource Tracker
// ======================================
const RESOURCE_KEYS = ['coins', 'pp', 'gems', 'bling', 'credits', 'stardrops'];

function loadResources() {
    const saved = JSON.parse(localStorage.getItem('brawl_resources')) || {};
    
    RESOURCE_KEYS.forEach(key => {
        const val = saved[key] || 0;
        const displayEl = document.getElementById(`res-${key}-val`);
        const inputEl = document.getElementById(`res-${key}-input`);
        if (displayEl) displayEl.textContent = Number(val).toLocaleString();
        if (inputEl) inputEl.value = val;
    });
    
    const lastUpdated = document.getElementById('resources-last-updated');
    if (lastUpdated && saved._lastUpdated) {
        const d = new Date(saved._lastUpdated);
        lastUpdated.textContent = `Last updated: ${d.toLocaleDateString()} at ${d.toLocaleTimeString()}`;
    }
}

function setupResourceForm() {
    const form = document.getElementById('resource-form');
    if (!form) return;
    
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        
        const data = { _lastUpdated: new Date().toISOString() };
        RESOURCE_KEYS.forEach(key => {
            const inputEl = document.getElementById(`res-${key}-input`);
            data[key] = inputEl ? parseInt(inputEl.value) || 0 : 0;
        });
        
        localStorage.setItem('brawl_resources', JSON.stringify(data));
        loadResources(); // refresh display cards
        
        const msg = document.getElementById('res-save-msg');
        if (msg) {
            msg.style.display = 'block';
            setTimeout(() => { msg.style.display = 'none'; }, 3000);
        }
    });
}

// Start app
init();
