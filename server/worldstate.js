import { db, estimateTokens, getSettings, tx } from './db.js';

// Everything in here is scoped by world_id: handles are only ever resolved against the
// characters of the same world, so nothing can leak between universes.

export function worldCharacters(worldId) {
  return db.prepare('SELECT * FROM characters WHERE world_id = ?').all(worldId);
}

/** "3h ago" style age of an SQLite timestamp, for prompts. */
export function ago(ts) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

export function personas(worldId) {
  return db.prepare("SELECT * FROM characters WHERE world_id = ? AND kind = 'player'").all(worldId);
}

/** Returns a lookup that resolves "@handle", "handle" or "Full Name" to a character in this world. */
export function resolver(worldId) {
  const chars = worldCharacters(worldId);
  const map = new Map();
  for (const c of chars) {
    map.set(c.handle.toLowerCase(), c);
    for (const n of [c.name, c.real_name]) if (n?.trim() && !map.has(n.trim().toLowerCase())) map.set(n.trim().toLowerCase(), c);
  }
  // Models often shorten handles (@kael for @kael_storm) or use first names: accept those when unambiguous.
  const loose = (key) => {
    const hits = chars.filter((c) => c.handle.toLowerCase().startsWith(key) || [c.name, c.real_name].some((n) => n?.toLowerCase().split(/\s+/)[0] === key));
    return hits.length === 1 ? hits[0] : null;
  };
  return (h) => {
    const key = String(h ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!key) return null;
    return map.get(key) || (key.length >= 3 ? loose(key) : null);
  };
}

const clampScore = (n) => Math.max(-100, Math.min(100, Math.round(Number(n) || 0)));

/**
 * Applies the "updates" block that generation prompts may return:
 * { storylines:[{title,summary,involved,status,heat}], relationships:[{from,to,status,score}], memories:[{handle,memory}],
 *   follows:[{from,to}], unfollows:[{from,to}], likes:[{handle,postId}] }
 */
export function applyUpdates(worldId, u, source = 'feed') {
  if (!u || typeof u !== 'object') return;
  const find = resolver(worldId);
  tx(() => {
    for (const s of arr(u.storylines)) {
      if (!s?.title) continue;
      const involved = arr(s.involved).map(find).filter(Boolean).map((c) => c.id);
      const existing = db.prepare('SELECT * FROM storylines WHERE world_id = ? AND lower(title) = lower(?)').get(worldId, String(s.title));
      const status = s.status === 'resolved' ? 'resolved' : 'active';
      const heat = Math.max(0, Math.min(100, Number(s.heat) || 50));
      const visibility = s.visibility === 'private' ? 'private' : 'public';
      if (existing) {
        const merged = [...new Set([...JSON.parse(existing.involved || '[]'), ...involved])];
        // once something is public it can't become secret again
        const vis = existing.visibility === 'public' ? 'public' : visibility;
        db.prepare('UPDATE storylines SET summary = ?, involved = ?, status = ?, heat = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(String(s.summary || existing.summary), JSON.stringify(merged), status, heat, vis, existing.id);
        if (vis === 'public' && existing.visibility !== 'public' && heat >= 70) notify(worldId, { type: 'event', text: `Trending: ${s.title}` });
      } else {
        db.prepare('INSERT INTO storylines (world_id, title, summary, involved, status, heat, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(worldId, String(s.title).slice(0, 120), String(s.summary || ''), JSON.stringify(involved), status, heat, visibility);
        if (heat >= 70 && visibility === 'public') notify(worldId, { type: 'event', text: `Trending: ${s.title}` });
      }
    }

    for (const r of arr(u.relationships)) {
      const a = find(r?.from), b = find(r?.to);
      if (!a || !b || a.id === b.id) continue;
      db.prepare(
        `INSERT INTO relationships (world_id, from_id, to_id, status, score) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(from_id, to_id) DO UPDATE SET status = excluded.status, score = excluded.score, updated_at = CURRENT_TIMESTAMP`
      ).run(worldId, a.id, b.id, String(r.status || '').slice(0, 160), clampScore(r.score));
    }

    for (const m of arr(u.memories)) {
      const c = find(m?.handle);
      if (!c || c.kind === 'player' || !m.memory) continue;
      const recent = db.prepare('SELECT content FROM memories WHERE character_id = ? ORDER BY id DESC LIMIT 15').all(c.id);
      const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (recent.some((r) => norm(r.content) === norm(m.memory))) continue; // models often restate known facts
      db.prepare('INSERT INTO memories (world_id, character_id, content, source) VALUES (?, ?, ?, ?)').run(worldId, c.id, String(m.memory).slice(0, 400), source);
    }
    // keep memory lists bounded per character
    db.prepare(
      `DELETE FROM memories WHERE world_id = ? AND id IN (
         SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY character_id ORDER BY id DESC) AS rn FROM memories WHERE world_id = ?) WHERE rn > 40)`
    ).run(worldId, worldId);

    for (const f of arr(u.follows)) {
      const a = find(f?.from), b = find(f?.to);
      if (a && b && a.kind !== 'player') follow(worldId, a.id, b.id);
    }
    for (const f of arr(u.unfollows)) {
      const a = find(f?.from), b = find(f?.to);
      if (a && b && a.kind !== 'player') db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(a.id, b.id);
    }
    for (const l of arr(u.likes)) {
      const c = find(l?.handle);
      const post = db.prepare('SELECT * FROM posts WHERE id = ? AND world_id = ?').get(Number(l?.postId), worldId);
      if (c && post && c.kind !== 'player') like(worldId, post, c);
    }
  });
}

const arr = (v) => (Array.isArray(v) ? v : []);

export function follow(worldId, followerId, followeeId) {
  if (followerId === followeeId) return false;
  const r = db.prepare('INSERT OR IGNORE INTO follows (world_id, follower_id, followee_id) VALUES (?, ?, ?)').run(worldId, followerId, followeeId);
  if (r.changes) {
    const followee = db.prepare('SELECT kind FROM characters WHERE id = ?').get(followeeId);
    if (followee?.kind === 'player') notify(worldId, { type: 'follow', personaId: followeeId, actorId: followerId });
  }
  return !!r.changes;
}

export function like(worldId, post, liker) {
  const r = db.prepare('INSERT OR IGNORE INTO post_likes (post_id, character_id) VALUES (?, ?)').run(post.id, liker.id);
  if (!r.changes) return false;
  db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(post.id);
  const author = db.prepare('SELECT kind FROM characters WHERE id = ?').get(post.character_id);
  if (author?.kind === 'player' && liker.id !== post.character_id) notify(worldId, { type: 'like', personaId: post.character_id, actorId: liker.id, postId: post.id });
  return true;
}

export function notify(worldId, { type, personaId = null, actorId = null, postId = null, conversationId = null, text = '' }) {
  db.prepare('INSERT INTO notifications (world_id, persona_id, type, actor_id, post_id, conversation_id, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(worldId, personaId, type, actorId, postId, conversationId, text);
}

/** After an AI post/reply is created: notify personas who were replied to or @mentioned. */
export function notifyForPost(worldId, postId) {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!p) return;
  const notified = new Set([p.character_id]);
  if (p.parent_id) {
    const root = db.prepare('SELECT p.character_id, c.kind FROM posts p JOIN characters c ON c.id = p.character_id WHERE p.id = ?').get(p.parent_id);
    if (root?.kind === 'player' && !notified.has(root.character_id)) {
      notify(worldId, { type: 'reply', personaId: root.character_id, actorId: p.character_id, postId: p.parent_id });
      notified.add(root.character_id);
    }
  }
  const find = resolver(worldId);
  for (const [, token] of p.content.matchAll(/@([A-Za-z0-9_]+)/g)) {
    const c = find(token);
    if (!c || c.kind !== 'player' || notified.has(c.id)) continue;
    notify(worldId, { type: 'mention', personaId: c.id, actorId: p.character_id, postId: p.parent_id || p.id });
    notified.add(c.id);
  }
}

export function followerCount(c) {
  const n = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?').get(c.id).n;
  return (c.followers || 0) + n;
}

/**
 * Free (no AI) engagement simulation: recent posts keep gathering likes and reposts
 * roughly in proportion to the author's audience, decaying with age.
 */
export function simulateEngagement(worldId) {
  const recent = db
    .prepare(
      `SELECT p.id, p.character_id, p.likes, c.followers, c.kind,
         (SELECT COUNT(*) FROM follows f WHERE f.followee_id = c.id) AS realFollowers,
         (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id) AS replies
       FROM posts p JOIN characters c ON c.id = p.character_id
       WHERE p.world_id = ? AND p.parent_id IS NULL ORDER BY p.id DESC LIMIT 40`
    )
    .all(worldId);
  const upd = db.prepare('UPDATE posts SET likes = likes + ?, reposts = reposts + ? WHERE id = ?');
  const playerGains = new Map();
  recent.forEach((p, i) => {
    const audience = (p.followers || 0) + p.realFollowers * 50 + 30;
    const decay = Math.exp(-i / 8);
    const drama = 1 + Math.min(p.replies, 10) / 4; // threads with arguments go viral
    const add = Math.floor(Math.sqrt(audience) * decay * drama * Math.random() * 0.8);
    if (add > 0) {
      upd.run(add, Math.floor(add * Math.random() * 0.2), p.id);
      if (p.kind === 'player') playerGains.set(p.id, add);
    }
  });
  for (const [postId, n] of playerGains) {
    const post = db.prepare('SELECT character_id FROM posts WHERE id = ?').get(postId);
    if (n >= 5) notify(worldId, { type: 'like', personaId: post.character_id, postId, text: `${n} more people liked your post` });
  }
}

// ---------------------------------------------------------------------------
// Context injected into prompts
// ---------------------------------------------------------------------------

/**
 * Builds the "what's going on / what they remember" block for a set of characters.
 * focus: characters whose perspective matters (speaker, authors, responders)
 * others: people they are interacting with (e.g. the player's persona)
 */
export function worldContext(worldId, { focus = [], others = [], budget = getSettings().worldStateBudget, memoriesPer = 5 } = {}) {
  const ids = new Set([...focus, ...others].map((c) => c.id));
  const focusIds = new Set(focus.map((c) => c.id));
  const name = new Map(worldCharacters(worldId).map((c) => [c.id, `@${c.handle}`]));
  const parts = [];

  const stories = db.prepare("SELECT * FROM storylines WHERE world_id = ? AND status = 'active' ORDER BY heat DESC, updated_at DESC LIMIT 20").all(worldId);
  const relevant = stories
    .map((s) => ({ s, inv: JSON.parse(s.involved || '[]') }))
    // private storylines are only known to the NPCs involved in them
    .filter(({ s, inv }) => s.visibility !== 'private' || inv.some((i) => focusIds.has(i)))
    .sort((a, b) => b.inv.filter((i) => ids.has(i)).length - a.inv.filter((i) => ids.has(i)).length || b.s.heat - a.s.heat)
    .slice(0, 6);
  if (relevant.length) {
    parts.push(
      'ONGOING STORYLINES / DRAMA:\n' +
        relevant
          .map(({ s, inv }) => {
            const who = inv.map((i) => name.get(i)).filter(Boolean).join(', ');
            const tag = s.visibility === 'private' ? ` PRIVATE — only ${who} know; nobody else may reference it unless told` : '';
            return `- ${s.title} [heat ${s.heat}, last updated ${ago(s.updated_at)}${tag}] (${who}): ${s.summary}`;
          })
          .join('\n')
    );
  }

  if (focusIds.size) {
    // each NPC only knows their own feelings about people, not everyone else's
    const list = [...focusIds].join(',');
    const rels = db
      .prepare(`SELECT * FROM relationships WHERE world_id = ? AND from_id IN (${list}) ORDER BY abs(score) DESC, updated_at DESC LIMIT 30`)
      .all(worldId)
      // relationships between the people in this scene first
      .sort((a, b) => (ids.has(b.from_id) && ids.has(b.to_id)) - (ids.has(a.from_id) && ids.has(a.to_id)))
      .slice(0, 14);
    if (rels.length) {
      parts.push('RELATIONSHIPS (how X feels about Y):\n' + rels.map((r) => `- ${name.get(r.from_id)} → ${name.get(r.to_id)}: ${r.status} (${r.score})`).join('\n'));
    }
  }

  for (const c of focus) {
    const mem = db.prepare('SELECT content, created_at FROM memories WHERE character_id = ? ORDER BY id DESC LIMIT ?').all(c.id, memoriesPer);
    // ages matter: "was at the gas station" from days ago is not where they are now
    if (mem.length) parts.push(`@${c.handle} REMEMBERS (oldest first; things change, old ones may be outdated):\n` + mem.reverse().map((m) => `- [${ago(m.created_at)}] ${m.content}`).join('\n'));
  }

  let out = '';
  for (const p of parts) {
    if (estimateTokens(out + p) > budget) break;
    out += (out ? '\n\n' : '') + p;
  }
  return out;
}

/** Public interactions between two characters (posts mentioning each other, replies in shared threads). */
export function publicHistory(worldId, a, b, limit = 6) {
  return db
    .prepare(
      `SELECT p.id, p.content, p.parent_id, c.handle FROM posts p JOIN characters c ON c.id = p.character_id
       WHERE p.world_id = ? AND (
         (p.character_id = ? AND (p.content LIKE ? OR p.parent_id IN (SELECT id FROM posts WHERE character_id = ?)))
         OR (p.character_id = ? AND (p.content LIKE ? OR p.parent_id IN (SELECT id FROM posts WHERE character_id = ?)))
       ) ORDER BY p.id DESC LIMIT ?`
    )
    .all(worldId, a.id, `%@${b.handle}%`, b.id, b.id, `%@${a.handle}%`, a.id, limit)
    .reverse();
}

export function recentPostsBy(characterId, limit = 4) {
  return db.prepare('SELECT id, content FROM posts WHERE character_id = ? ORDER BY id DESC LIMIT ?').all(characterId, limit).reverse();
}

export const UPDATES_SCHEMA = `"updates":{
  "storylines":[{"title":string,"summary":string (current state, 1-2 sentences),"involved":[handles],"status":"active"|"resolved","heat":0-100,"visibility":"public"|"private"}],
  "relationships":[{"from":handle,"to":handle,"status":string (e.g. "furious after the leak"),"score":-100..100}],
  "memories":[{"handle":string,"memory":string (what this NPC will remember, 1 sentence)}]
}`;

export const UPDATES_RULES = `In "updates", record consequences so the world stays continuous: new or evolving drama (reuse an existing storyline title to update it), relationship changes, and things NPCs will remember. Only include real changes; empty arrays are fine. Never add memories for the human's personas.`;
