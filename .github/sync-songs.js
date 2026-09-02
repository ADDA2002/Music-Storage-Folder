#!/usr/bin/env node
// Syncs songs/ folder from this repo to Firebase Realtime Database.

const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const GITHUB_REPO = process.env.GITHUB_REPO;

const COVERS = [
  'https://images.unsplash.com/photo-1518609878373-06d740f60d8b?auto=format&fit=crop&w=300&q=80',
  'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=300&q=80',
  'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=300&q=80',
  'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?auto=format&fit=crop&w=300&q=80',
  'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=300&q=80',
];

function prettyTitle(name) {
  return name
    .replace(/\.mp3$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

async function listMp3s() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/songs?ref=main`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sync-action' } }
  );
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`GitHub list failed: ${res.status}`);
  }
  const data = await res.json();
  return data
    .filter((f) => f.type === 'file' && f.name.toLowerCase().endsWith('.mp3'))
    .map((f) => f.name);
}

async function getCurrentFirebase() {
  const res = await fetch(`${FIREBASE_DB_URL}/songs.json`);
  if (!res.ok) throw new Error(`Firebase read failed: ${res.status}`);
  const data = await res.json();
  return data || {};
}

function buildTrack(id, name) {
  return {
    id: String(id),
    title: prettyTitle(name),
    artist: 'Unknown Artist',
    url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/songs/${encodeURIComponent(name)}`,
    cover: COVERS[Math.abs(hash(name)) % COVERS.length],
    addedAt: Date.now(),
  };
}

async function main() {
  console.log('Listing songs on GitHub...');
  const githubFiles = await listMp3s();
  console.log(`Found ${githubFiles.length} files`);

  console.log('Reading current Firebase state...');
  const fb = await getCurrentFirebase();

  const fbByUrl = {};
  for (const id of Object.keys(fb)) {
    if (fb[id]?.url) fbByUrl[fb[id].url] = id;
  }

  const targetUrl = (name) =>
    `https://raw.githubusercontent.com/${GITHUB_REPO}/main/songs/${encodeURIComponent(name)}`;

  const newSongs = {};
  githubFiles.forEach((name, idx) => {
    const url = targetUrl(name);
    const existingId = fbByUrl[url];
    const id = existingId || String(idx + 1);
    newSongs[id] = buildTrack(id, name);
  });

  const desiredUrls = new Set(githubFiles.map(targetUrl));
  for (const id of Object.keys(fb)) {
    if (fb[id]?.url && !desiredUrls.has(fb[id].url)) {
      newSongs[id] = null;
    }
  }

  console.log('Writing to Firebase...');
  const writeRes = await fetch(`${FIREBASE_DB_URL}/songs.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(newSongs),
  });
  if (!writeRes.ok) {
    const err = await writeRes.text();
    throw new Error(`Firebase write failed: ${writeRes.status} ${err}`);
  }
  const kept = Object.values(newSongs).filter((s) => s !== null).length;
  const deleted = Object.values(newSongs).filter((s) => s === null).length;
  console.log(`Done. ${kept} kept, ${deleted} deleted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
