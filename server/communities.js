import { db, tx } from './db.js';
import { httpError } from './openrouter.js';
import { notify } from './worldstate.js';

// Communities (groups like "Snowdin" or a universe-only group) and hashtags, per universe.
// Communities appear as the world plays out (the world tick may start one) or are made by the author.

export function slugify(name = '') {
  return String(name).toLowerCase().replace(/^[#c/]+/, '').replace(/[^a-z0-9]+/g, '').slice(0, 30) || 'group';
}

function uniqueSlug(worldId, name) {
  const base = slugify(name);
  let slug = base;
  for (let n = 2; db.prepare('SELECT 1 FROM communities WHERE world_id = ? AND slug = ?').get(worldId, slug); n++) slug = `${base}${n}`;
  return slug;
}

export function createCommunity(worldId, { name, description = '', creatorId = null, memberIds = [] }) {
  if (!String(name || '').trim()) throw httpError(400, 'Give the community a name.');
  const existing = findCommunity(worldId, name);
  if (existing) return existing;
  const r = db.prepare('INSERT INTO communities (world_id, name, slug, description, creator_id) VALUES (?, ?, ?, ?, ?)')
    .run(worldId, String(name).trim().slice(0, 60), uniqueSlug(worldId, name), String(description).slice(0, 300), creatorId);
  const id = Number(r.lastInsertRowid);
  tx(() => {
    for (const m of new Set([creatorId, ...memberIds].filter(Boolean))) join(id, m);
  });
  return db.prepare('SELECT * FROM communities WHERE id = ?').get(id);
}

export function join(communityId, characterId) {
  db.prepare('INSERT OR IGNORE INTO community_members (community_id, character_id) VALUES (?, ?)').run(communityId, characterId);
}

export function leave(communityId, characterId) {
  db.prepare('DELETE FROM community_members WHERE community_id = ? AND character_id = ?').run(communityId, characterId);
}

/** Finds a community in this universe by slug, "c/slug" or name. */
export function findCommunity(worldId, ref) {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    return db.prepare('SELECT * FROM communities WHERE id = ? AND world_id = ?').get(Number(ref), worldId) || null;
  }
  return db.prepare('SELECT * FROM communities WHERE world_id = ? AND (slug = ? OR lower(name) = lower(?))').get(worldId, slugify(ref), String(ref).trim()) || null;
}

export function memberIds(communityId) {
  return db.prepare('SELECT character_id FROM community_members WHERE community_id = ?').all(communityId).map((r) => r.character_id);
}

/** Communities with member/post counts, most active first; `personaId` marks the ones you joined. */
export function listCommunities(worldId, personaId = null) {
  return db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS members,
        (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) AS posts,
        (SELECT MAX(p.id) FROM posts p WHERE p.community_id = c.id) AS lastPost,
        EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = c.id AND m.character_id = ?) AS joined
       FROM communities c WHERE c.world_id = ? ORDER BY COALESCE(lastPost, 0) DESC, c.id DESC`
    )
    .all(personaId ?? 0, worldId);
}

/** The communities block for prompts (the most active ones, plus the one in focus). */
export function communitiesBlock(worldId, focusId = null, limit = 12) {
  const list = listCommunities(worldId);
  const shown = list.slice(0, limit);
  const focus = focusId && list.find((c) => c.id === focusId);
  if (focus && !shown.includes(focus)) shown.push(focus);
  if (!shown.length) return '';
  return `COMMUNITIES ON THE PLATFORM (groups people post in):\n${shown.map((c) => `- c/${c.slug} "${c.name}" (${c.members} members): ${c.description}`).join('\n')}`;
}

export const HASHTAG = /(^|[^\w&])#([A-Za-z][\w]{1,40})/g;

/** Trending hashtags: recent posts count more. */
export function trendingHashtags(worldId, limit = 15) {
  const posts = db.prepare('SELECT content FROM posts WHERE world_id = ? ORDER BY id DESC LIMIT 400').all(worldId);
  const score = new Map();
  const label = new Map();
  posts.forEach((p, i) => {
    const seen = new Set();
    for (const [, , tag] of p.content.matchAll(HASHTAG)) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      score.set(key, (score.get(key) || 0) + Math.exp(-i / 120));
      if (!label.has(key)) label.set(key, tag);
    }
  });
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, s]) => ({ tag: label.get(key), posts: posts.filter((p) => p.content.toLowerCase().includes(`#${key}`)).length, score: s }));
}

/** When a new community is founded, let the personas know about it like a platform suggestion would. */
export function announceCommunity(worldId, community) {
  notify(worldId, { type: 'event', text: `New community: c/${community.slug} — ${community.name}` });
}
