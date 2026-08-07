// Background battlelog collector.
//
// Runs on a schedule via GitHub Actions. It fetches your most recent battles from the
// Brawl Stars API (through the RoyaleAPI proxy, which is IP-agnostic) and appends any new
// ones to data/battlelog.json. The website then reads that file and feeds the entries
// through its normal match-processing pipeline, so games are recorded even when the site
// is closed.
//
// Required environment variables (set as GitHub repo secrets):
//   BS_API_KEY      - a Brawl Stars API token created for the RoyaleAPI proxy IP (45.79.218.79)
//   BS_PLAYER_TAG   - your player tag, e.g. #2ABC123 (the leading # is optional)
// Optional:
//   PROXY_BASE      - override the API base (default https://bsproxy.royaleapi.dev/v1)
//   MAX_ARCHIVE     - max raw entries to keep (default 500)

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const API_KEY = process.env.BS_API_KEY;
const RAW_TAG = process.env.BS_PLAYER_TAG || '';
const PROXY_BASE = (process.env.PROXY_BASE || 'https://bsproxy.royaleapi.dev/v1').replace(/\/$/, '');
const MAX_ARCHIVE = Number(process.env.MAX_ARCHIVE) || 500;
const OUT_FILE = 'data/battlelog.json';

if (!API_KEY) {
    console.error('Missing BS_API_KEY environment variable.');
    process.exit(1);
}
if (!RAW_TAG) {
    console.error('Missing BS_PLAYER_TAG environment variable.');
    process.exit(1);
}

const tag = RAW_TAG.trim().replace(/^#/, '').toUpperCase();

/** Stable per-entry key: battleTime + its index within a same-battleTime group (Bo3-safe). */
function computeKeys(items) {
    const counts = new Map();
    return items.map(it => {
        const bt = String(it?.battleTime || '');
        const n = counts.get(bt) || 0;
        counts.set(bt, n + 1);
        return `${bt}#${n}`;
    });
}

async function readArchive() {
    try {
        const txt = await readFile(OUT_FILE, 'utf8');
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed)) return parsed;
        if (Array.isArray(parsed.items)) return parsed.items;
    } catch {
        /* no existing archive yet */
    }
    return [];
}

async function main() {
    const url = `${PROXY_BASE}/players/%23${tag}/battlelog`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' }
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error(`Battlelog fetch failed: HTTP ${res.status}. ${body.slice(0, 300)}`);
        // 403 usually means the API key isn't whitelisted for the proxy IP (45.79.218.79).
        process.exit(1);
    }

    const data = await res.json();
    const fetched = Array.isArray(data.items) ? data.items : [];
    if (!fetched.length) {
        console.log('No battles returned; nothing to do.');
        return;
    }

    const existing = await readArchive();
    const existingKeys = new Set(existing.map(it => it._k).filter(Boolean));

    const fetchedKeys = computeKeys(fetched);
    const fresh = [];
    fetched.forEach((it, i) => {
        const k = fetchedKeys[i];
        if (!existingKeys.has(k)) {
            fresh.push({ ...it, _k: k });
        }
    });

    if (!fresh.length) {
        console.log('No new battles since last run.');
        return;
    }

    // Newest first: prepend the fresh entries, then cap the archive size.
    const merged = [...fresh, ...existing].slice(0, MAX_ARCHIVE);

    await mkdir(dirname(OUT_FILE), { recursive: true });
    await writeFile(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), items: merged }, null, 0));
    console.log(`Added ${fresh.length} new battle(s). Archive now holds ${merged.length}.`);
}

main().catch(err => {
    console.error('Sync script error:', err);
    process.exit(1);
});
