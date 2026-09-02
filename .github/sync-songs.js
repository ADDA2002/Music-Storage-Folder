#!/usr/bin/env node
// Syncs songs/ folder from this repo to Firebase Realtime Database.
// Handles add, delete, AND rename by comparing file SHAs.

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

function getCover(name) {
  return COVERS[Math.abs(hash(name)) % COVERS.length];
}

// Map SHA -> Firebase id (tracks that came from the same file content)
const firebaseIdBySha = new Map();

async function getGitHubFiles() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/songs?ref=main`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sync-action' } }
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub list failed: ${res.status}`);
  const data = await res.json();
  return data
    .filter((f) => f.type === 'file' && f.name.toLowerCase().endsWith('.mp3'))
    .map((f) => ({ name: f.name, sha: f.sha }));
}

async function getFirebaseSongs() {
  const res = await fetch(`${FIREBASE_DB_URL}/songs.json`);
  if (!res.ok) throw new Error(`Firebase read failed: ${res.status}`);
  const data = await res.json();
  return data || {};
}

function buildTrack(id, name, sha, addedAt) {
  return {
    id: String(id),
    title: prettyTitle(name),
    artist: 'Unknown Artist',
    url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/songs/${encodeURIComponent(name)}`,
    cover: getCover(name),
    sha,
    addedAt: addedAt || Date.now(),
  };
}

async function main() {
  const githubFiles = await getGitHubFiles();
  console.log(`GitHub: ${githubFiles.length} files`);
  githubFiles.forEach((f) => console.log(`  - ${f.name} (sha: ${f.sha})`));

  const fb = await getFirebaseSongs();
  const fbUrls = {};
  const fbIds = {};
  const fbShas = {};
  for (const [id, song] of Object.entries(fb)) {
    if (!song || !song.url) continue;
    fbUrls[id] = song;
    fbIds[song.url] = id;
    if (song.sha) firebaseIdBySha.set(song.sha, id);
  }

  const newSongs = {};
  const desiredUrls = new Set(githubFiles.map((f) =>
    `https://raw.githubusercontent.com/${GITHUB_REPO}/main/songs/${encodeURIComponent(f.name)}`
  ));

  // Assign Firebase IDs to each github file
  const assigned = new Set(); // Firebase IDs that have been assigned
  const githubBySha = new Map(githubFiles.map((f) => [f.sha, f]));
  const githubByName = new Map(githubFiles.map((f) => [f.name, f]));

  for (const [id, song] of Object.entries(fb)) {
    if (!song || !song.url) continue;
    const gh = githubByName.get(song.url.split('/songs/')[1]?.split('/')[0] ? '' : '');
    const isDesired = desiredUrls.has(song.url);

    if (isDesired) {
      // Still in GitHub — keep with same ID
      const { sha: _sha, ...rest } = song;
      newSongs[id] = rest;
      assigned.add(id);
    } else {
      // Deleted from GitHub — check if renamed (same SHA, new name)
      if (song.sha && githubBySha.has(song.sha)) {
        // It's renamed — reuse same ID with new name
        const newGh = githubBySha.get(song.sha);
        newSongs[id] = buildTrack(id, newGh.name, newGh.sha, song.addedAt);
        assigned.add(id);
        console.log(`  Renamed: "${song.title}" -> "${newGh.name}" (keeping id ${id})`);
      } else {
        // Truly deleted
        newSongs[id] = null;
        console.log(`  Deleted: "${song.title}"`);
      }
    }
  }

  // Add new files (not yet in Firebase)
  for (const gh of githubFiles) {
    const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/songs/${encodeURIComponent(gh.name)}`;
    if (fbIds[url]) continue; // already handled above

    // Try to reuse ID by SHA
    let id = firebaseIdBySha.get(gh.sha);
    if (!id || assigned.has(id)) {
      // Find next free ID
      const usedIds = new Set(Object.keys(newSongs).filter((k) => newSongs[k] !== null));
      let next = 1;
      while (usedIds.has(String(next))) next++;
      id = String(next);
    }

    newSongs[id] = buildTrack(id, gh.name, gh.sha);
    assigned.add(id);
    console.log(`  Added: "${prettyTitle(gh.name)}" (id ${id})`);
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
  console.log(`Done. ${kept} songs in Firebase, ${deleted} removed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
