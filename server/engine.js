import { db, getSettings } from './db.js';
import { activateLore } from './lorebook.js';
import { communitiesBlock, createCommunity, findCommunity, join as joinCommunity, memberIds, announceCommunity } from './communities.js';
import { completeJSON, httpError } from './openrouter.js';
import {
  applyUpdates, notifyForPost, personas, resolver, simulateEngagement, worldContext, followerCount, UPDATES_SCHEMA, UPDATES_RULES
} from './worldstate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PALETTE = ['#e0567a', '#6c7cff', '#22a699', '#f29f3d', '#9b5de5', '#3fa7d6', '#e76f51', '#59a14f', '#d4a017', '#c44ed8'];

export function colorFor(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export function makeHandle(name = '') {
  return name.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'user';
}

export const clip = (s = '', n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const arr = (v) => (Array.isArray(v) ? v : []);
const join = (parts) => parts.filter(Boolean).join('\n\n');

export function getWorld(worldId) {
  const w = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId);
  if (!w) throw httpError(404, 'World not found');
  return w;
}

/**
 * Characters live inside the fiction. Without this, models mix the engine's meta instructions ("the human",
 * "the user", "the platform you run") and author/creator lore into what characters believe about the person
 * they're talking to (e.g. deciding the user's persona built the app).
 */
const IN_WORLD_FRAME = `IN-WORLD FRAME: inside the story, the social network is just an ordinary app everyone uses. No character knows who made it or runs it, that it is simulated, or anything about "the human", "the user", "the author" or "personas" — those words are instructions for you, never things characters know. Every account the human plays is, to the characters, simply another person with their own life; treat them exactly as their character description says, not as an admin, creator or narrator. Lore about the real-world author of this multiverse is background only: no character connects it to anyone on the platform unless their own lore says they know the author.

`;

/** The stable part of every prompt. Kept first and identical across calls so provider prompt caching can kick in. */
export function worldPreamble(world) {
  const s = getSettings();
  let out = s.styleGuide?.trim() ? `${s.styleGuide.trim()}\n\n` : '';
  out += IN_WORLD_FRAME;
  out += `UNIVERSE: ${world.name}\n`;
  if (world.summary) out += `${world.summary}\n`;
  else if (world.description) out += `${world.description}\n`;
  if (world.rules?.trim()) out += `\nUNIVERSE RULES (always follow):\n${world.rules.trim()}\n`;
  const notes = db.prepare('SELECT content FROM director_notes WHERE world_id = ? AND active = 1 ORDER BY id').all(world.id);
  if (notes.length) {
    out += `\nDIRECTOR NOTES (the author's standing corrections for this universe — they override everything above):\n${notes.map((n) => `- ${n.content}`).join('\n')}\n`;
  }
  return out;
}

export const fmtFollowers = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));

/** Who the character really is (for lore and continuity); `name` is just what their profile shows. */
export const realName = (c) => c.real_name?.trim() || c.name;
/** Every name the character can be recognized by. */
export const knownNames = (c) => [...new Set([c.name, c.real_name].filter((n) => n?.trim()))];

/** Character description as the AI sees it. `persona` holds the free-form description the user pasted. */
export function characterCard(c, { brief = false } = {}) {
  let s = `${c.name} (@${c.handle})`;
  if (c.real_name?.trim() && c.real_name.trim() !== c.name) s += ` — real name: ${c.real_name.trim()}`;
  if (c.bio) s += ` — bio: "${clip(c.bio, 200)}"`;
  if (c.kind !== 'player') s += ` · ${fmtFollowers(followerCount(c))} followers`;
  if (c.persona) s += `\n${clip(c.persona, brief ? 700 : 6000)}`;
  if (c.style) s += `\nVoice: ${clip(c.style, brief ? 160 : 800)}`;
  if (c.knowledge?.trim()) s += `\nWHAT ${(c.real_name || c.name).toUpperCase()} KNOWS (from the lore — this is genuinely known to them): ${clip(c.knowledge.trim(), brief ? 500 : 3000)}`;
  return s;
}

export function uniqueHandle(worldId, wanted, exceptId = 0) {
  const base = makeHandle(wanted);
  let handle = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM characters WHERE world_id = ? AND handle = ? AND id != ?').get(worldId, handle, exceptId)) handle = `${base}${++n}`;
  return handle;
}

const defaultFollowers = () => Math.round(40 + Math.random() ** 3 * 8000);

/** Seed for an auto-generated handle: the core of the display name, without tags like "| something" or "(something)". */
function handleSeed(c) {
  const core = String(c.name || '').split(/\s*[|(\[{·•,—–]\s*|\s+-\s+/)[0].trim();
  return core && makeHandle(core) !== 'user' ? core : c.realName || c.real_name || c.name;
}

export function insertCharacter(worldId, c) {
  const handle = uniqueHandle(worldId, c.handle || handleSeed(c));
  const followers = c.followers !== '' && c.followers != null && Number.isFinite(Number(c.followers)) ? Number(c.followers) : defaultFollowers();
  const r = db
    .prepare('INSERT INTO characters (world_id, kind, name, handle, bio, persona, style, color, active, followers, real_name, lore_entry_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(worldId, c.kind || 'custom', String(c.name).trim(), handle, c.bio || '', c.persona || c.description || '', c.style || '', c.color || colorFor(c.name), c.active === 0 || c.active === false ? 0 : 1, followers, String(c.realName ?? c.real_name ?? '').trim(), Number(c.lore_entry_id) || null);
  return db.prepare('SELECT * FROM characters WHERE id = ?').get(r.lastInsertRowid);
}

export function aiCharacters(worldId) {
  return db.prepare("SELECT * FROM characters WHERE world_id = ? AND active = 1 AND kind != 'player'").all(worldId);
}

export function sample(list, n) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

export function personaBlock(ps) {
  if (!ps.length) return '';
  return `ACCOUNTS PLAYED BY THE HUMAN — NEVER write posts, replies, DMs, actions or dialogue for them. In-world they are ordinary people; characters only know what is in these descriptions and what they have actually seen:\n${ps.map((p) => characterCard(p, { brief: true })).join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

/** The author's own rules for what kind of random users this universe has. */
export const npcRules = (world) =>
  world.npc_instructions?.trim()
    ? `THE AUTHOR'S INSTRUCTIONS FOR GENERATING USERS (follow these exactly, they override the defaults). When the author says "username" or "name" they mean the display name ("name" field); only "handle" or "@" means the handle:\n${world.npc_instructions.trim()}`
    : '';

/** What each field of a generated account means. Kept universe-neutral: formats come from the author's instructions. */
export const ACCOUNT_FIELDS = `Field meanings:
- "name": the DISPLAY NAME shown on their profile — what people call their username. Like real people online it is usually a nickname, alias, joke or stylized name (lowercase, emoji and symbols are fine), NOT their full legal name. Only celebrities, officials, businesses and news accounts use their real name. Anything the author wants added to usernames goes here.
- "handle": the @handle. Short (max 15 chars), lowercase letters, numbers and underscores only, no spaces. Keep it clean: nothing extra unless the author explicitly asks for it in the handle.
- "realName": their actual full name (private; used for continuity, not shown on posts).`;

export async function generateCharacters(worldId, { count = 5, theme = '' } = {}) {
  const world = getWorld(worldId);
  count = Math.max(1, Math.min(15, Number(count) || 5));
  const existing = db.prepare('SELECT name, real_name FROM characters WHERE world_id = ?').all(worldId).flatMap(knownNames);
  const titles = db
    .prepare('SELECT title FROM lore_entries WHERE world_id = ? AND enabled = 1 ORDER BY priority DESC LIMIT 120')
    .all(worldId)
    .map((e) => e.title);
  const lore = activateLore(worldId, `${theme}\n${titles.slice(0, 15).join('\n')}`);

  const out = await completeJSON({
    task: 'generate-users', expect: 'characters',
    maxTokens: 450 * count + 600,
    temperature: 1,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}\nYou invent believable social-media users who live in this universe: locals, fans, critics, officials, stans, trolls, rivals, news/gossip accounts. Each has a distinct voice and opinions rooted in the lore. Do not duplicate existing names.
${ACCOUNT_FIELDS}
Return ONLY JSON: {"characters":[{"name":string,"handle":string,"realName":string,"bio":string (profile bio, <25 words),"description":string (personality, background, ties to the lore, how they type online; 50-120 words),"followers":number (realistic audience size)}]}`
      },
      {
        role: 'user',
        content: join([
          lore.text && `RELEVANT LORE:\n${lore.text}`,
          titles.length && `Known lore topics: ${titles.join(', ')}`,
          existing.length && `Existing users (do not reuse): ${existing.join(', ')}`,
          npcRules(world),
          `Create ${count} new users.${theme ? ` Focus: ${theme}` : ''}`
        ])
      }
    ]
  });
  const list = Array.isArray(out) ? out : out.characters || [];
  return list.filter((c) => c?.name).slice(0, count).map((c) => insertCharacter(worldId, { ...c, kind: 'generated' }));
}

/** Expands a rough idea into a description. */
export async function draftCharacter(worldId, { name, idea }) {
  const world = getWorld(worldId);
  const lore = activateLore(worldId, `${name}\n${idea}`);
  return completeJSON({
    task: 'draft-character',
    maxTokens: 700,
    temperature: 0.9,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}\nFlesh out a character for this universe, consistent with the lore.\n${ACCOUNT_FIELDS}\nReturn ONLY JSON: {"name":string,"handle":string,"realName":string,"bio":string (<25 words),"description":string (personality, background, relationships, how they type online; 80-180 words)}`
      },
      { role: 'user', content: `${lore.text ? `RELEVANT LORE:\n${lore.text}\n\n` : ''}Name: ${name || '(invent one)'}\nIdea: ${idea || '(surprise me)'}` }
    ]
  });
}

// ---------------------------------------------------------------------------
// Bulk character import: split a pasted document of descriptions into characters
// ---------------------------------------------------------------------------

/** Free split: by markdown headings, "Name:" lines, --- separators, or big blank-line gaps. */
export function splitCharactersFree(text) {
  const t = text.replace(/\r\n?/g, '\n').trim();
  let blocks;
  if (/^#{1,6}\s+/m.test(t)) blocks = t.split(/\n(?=#{1,6}\s+)/);
  else if (/^\s*name\s*:/im.test(t)) blocks = t.split(/\n(?=\s*name\s*:)/i);
  else if (/\n\s*(-{3,}|\*{3,}|_{3,})\s*\n/.test(t)) blocks = t.split(/\n\s*(?:-{3,}|\*{3,}|_{3,})\s*\n/);
  else blocks = t.split(/\n\s*\n\s*\n/);
  return blocks
    .map((b) => b.trim())
    .filter(Boolean)
    .map((b) => {
      const [first, ...rest] = b.split('\n');
      const name = first.replace(/^#{1,6}\s*|^\s*name\s*[:\-]\s*/i, '').replace(/[*_#]/g, '').trim().slice(0, 60);
      const description = rest.join('\n').trim();
      return { name, handle: makeHandle(name), bio: '', description: description || b };
    });
}

/**
 * AI-assisted split. To keep it cheap the model never rewrites the descriptions: it only returns
 * names, handles, bios and the first words of each character's section; we slice the text locally.
 */
export async function splitCharactersAI(worldId, text) {
  const world = getWorld(worldId);
  const pieces = [];
  const maxChars = 40000;
  for (let i = 0; i < text.length; i += maxChars) pieces.push(text.slice(i, i + maxChars));
  const result = [];
  for (const piece of pieces) {
    const out = await completeJSON({
      task: 'import-characters', expect: 'characters',
      maxTokens: 2500,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: `The user pasted character descriptions for social-media accounts in the universe "${world.name}". Identify each separate character.
For each, return: "name"; "handle" (a fitting social-media handle, no @); "bio" (a short in-character profile bio, <20 words, based on the description); "start" (the EXACT first 6-10 words of that character's section, copied verbatim so it can be found in the text).
Return ONLY JSON: {"characters":[{"name":string,"handle":string,"bio":string,"start":string}]}`
        },
        { role: 'user', content: piece }
      ]
    });
    const list = (Array.isArray(out) ? out : out.characters || []).filter((c) => c?.name);
    const located = list
      .map((c) => ({ ...c, at: findLoose(piece, c.start || c.name) }))
      .filter((c) => c.at >= 0)
      .sort((a, b) => a.at - b.at);
    located.forEach((c, i) => {
      const end = i + 1 < located.length ? located[i + 1].at : piece.length;
      result.push({ name: c.name, handle: makeHandle(c.handle || c.name), bio: c.bio || '', description: piece.slice(c.at, end).trim() });
    });
    if (!located.length) result.push(...splitCharactersFree(piece));
  }
  return result;
}

function findLoose(haystack, needle = '') {
  const exact = haystack.indexOf(needle);
  if (exact >= 0) return exact;
  const words = needle.split(/\s+/).filter(Boolean).slice(0, 6).map(escapeRe);
  if (!words.length) return -1;
  const m = haystack.match(new RegExp(words.join('[\\s*_#:\\-]+'), 'i'));
  return m ? m.index : -1;
}

// ---------------------------------------------------------------------------
// World tick: the world moves on. One batched request for posts, replies, DMs, follows and drama.
// ---------------------------------------------------------------------------

function recentFeed(worldId, communityId = null) {
  const roots = db
    .prepare(
      `SELECT p.id, p.content, p.likes, c.handle, c.kind, k.slug AS community, (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id) AS replies
       FROM posts p JOIN characters c ON c.id = p.character_id LEFT JOIN communities k ON k.id = p.community_id
       WHERE p.world_id = ? AND p.parent_id IS NULL AND (? IS NULL OR p.community_id = ?) ORDER BY p.id DESC LIMIT 14`
    )
    .all(worldId, communityId, communityId)
    .reverse();
  const replies = db
    .prepare(
      `SELECT p.id, p.parent_id, p.content, c.handle, c.kind FROM posts p JOIN characters c ON c.id = p.character_id
       WHERE p.world_id = ? AND p.parent_id IS NOT NULL ORDER BY p.id DESC LIMIT 10`
    )
    .all(worldId)
    .reverse();
  return { roots, replies };
}

/** Picks who acts this tick: people in hot storylines are more likely to show up. */
/**
 * Picks who acts this tick: a friend group (someone plus the people they're closest to) so people who
 * know each other interact, people in hot storylines, then a few random others.
 */
function pickActors(worldId, pool, n) {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const chosen = new Set();
  const seed = sample(pool, 1)[0];
  if (seed) {
    chosen.add(seed.id);
    const close = db
      .prepare('SELECT to_id FROM relationships WHERE world_id = ? AND from_id = ? AND abs(score) >= 30 ORDER BY abs(score) DESC LIMIT 6')
      .all(worldId, seed.id)
      .map((r) => r.to_id)
      .filter((cid) => byId.has(cid));
    for (const cid of sample(close, Math.ceil(n / 2))) chosen.add(cid);
  }
  const hot = db
    .prepare("SELECT involved FROM storylines WHERE world_id = ? AND status = 'active' ORDER BY heat DESC LIMIT 4")
    .all(worldId)
    .flatMap((s) => JSON.parse(s.involved || '[]'))
    .filter((cid) => byId.has(cid));
  for (const cid of sample([...new Set(hot)], Math.ceil(n / 3))) if (chosen.size < n) chosen.add(cid);
  for (const c of sample(pool.filter((c) => !chosen.has(c.id)), n - chosen.size)) chosen.add(c.id);
  return [...chosen].slice(0, n).map((cid) => byId.get(cid));
}

/** Maps a post id (root or reply) to the root id of its thread, within this world only. */
function rootOf(worldId, id) {
  if (id == null) return null;
  const p = db.prepare('SELECT id, parent_id FROM posts WHERE id = ? AND world_id = ?').get(Number(id), worldId);
  return p ? p.parent_id || p.id : null;
}

const humanTag = (p) => `@${p.handle}${p.kind === 'player' ? ' (HUMAN)' : ''}`;

export async function worldTick(worldId, { count = 5, topic = '', allowDm, communityId = null } = {}) {
  const s = getSettings();
  const world = getWorld(worldId);
  count = Math.max(1, Math.min(20, Number(count) || 5));
  const pool = aiCharacters(worldId);
  if (!pool.length) throw httpError(400, 'No active AI characters in this world. Create or generate some first.');
  const focus = communityId ? findCommunity(worldId, Number(communityId)) : null;
  if (communityId && !focus) throw httpError(404, 'Community not found in this universe');
  let actors = pickActors(worldId, pool, Math.min(pool.length, Math.max(4, count + 2)));
  if (focus) {
    // inside a community, mostly its members talk (plus a newcomer or two)
    const members = new Set(memberIds(focus.id));
    const inside = sample(pool.filter((c) => members.has(c.id)), Math.max(3, count));
    actors = [...inside, ...actors.filter((a) => !members.has(a.id)).slice(0, 2)];
  }
  const postCount = db.prepare('SELECT COUNT(*) AS n FROM posts WHERE world_id = ?').get(worldId).n;
  const communityCount = db.prepare('SELECT COUNT(*) AS n FROM communities WHERE world_id = ?').get(worldId).n;
  // groups form once there's enough going on to form around, and rarely
  const newCommunityAllowed = !focus && postCount >= 12 && communityCount < 40 && Math.random() < 0.18;
  const communities = communitiesBlock(worldId, focus?.id);
  const ps = personas(worldId);
  const dmsAllowed = ps.length > 0 && (allowDm ?? Math.random() < s.dmChance);
  const newUserAllowed = Math.random() < 0.15; // now and then someone new joins the platform
  const { roots, replies } = recentFeed(worldId, focus?.id ?? null);

  const state = worldContext(worldId, { focus: actors, others: ps, memoriesPer: 3 });
  const lore = activateLore(worldId, [topic, state, ...actors.flatMap(knownNames), ...roots.slice(-6).map((p) => p.content)].join('\n'));

  const schema = `{"posts":[{"handle":string,"content":string,"replyTo":number|null,"community":slug|null}],
${newCommunityAllowed ? '"newCommunity":{"name":string,"description":string,"creator":handle,"members":[handles]}|null,\n' : ''}
${dmsAllowed ? '"dms":[{"from":handle,"to":persona handle,"content":string}],\n' : ''}${newUserAllowed ? '"newUsers":[{"name":string,"handle":string,"realName":string,"bio":string,"description":string,"followers":number}],\n' : ''}"follows":[{"from":handle,"to":handle}],"unfollows":[{"from":handle,"to":handle}],
"likes":[{"handle":string,"postId":number}],
${UPDATES_SCHEMA}}`;

  const out = await completeJSON({
    task: 'tick', expect: 'posts',
    maxTokens: 200 * count + 900,
    temperature: 1,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}
You advance the social network of this universe by one step of time. Show the fallout of earlier drama, continue storylines, start new ones occasionally (including platform-wide events), and react to what the human posted. Posts can be new, or replies to existing posts (replyTo = the number from a [post N] label in the feed). Write arguments as several separate replies from different accounts. NPCs may leak screenshots of DMs or group chats in posts.
${dmsAllowed ? '"dms": optionally 0-2 private messages from NPCs to the human\'s personas, only when motivated (drama, relationships, something the human did, flirting, threats, gossip).' : ''}
Use #hashtags naturally now and then (topics, events, fandoms, places) — not on every post. ${focus ? `This round happens INSIDE the community c/${focus.slug} ("${focus.name}"): most posts have "community":"${focus.slug}" and fit its topic.` : '"community": the slug if the post is made inside one of the existing communities (only by people who would be in it), else null.'}
${newCommunityAllowed ? '"newCommunity": optionally (only if a group would naturally form around a recurring topic, place, universe or fandom in what people are posting — e.g. people from one universe, a town, a fandom) one new community, founded by an NPC, with the NPCs who would join. Its first posts can be in this same response. Usually null.' : ''}
${newUserAllowed ? `"newUsers": optionally 0-1 brand-new account joining the platform because of current events (a new user may also post in this same response using their handle).\n${ACCOUNT_FIELDS}` : ''}
"follows"/"unfollows"/"likes": realistic social reactions (people unfollow after drama, follow after viral posts, like posts they agree with).
${UPDATES_RULES}
Return ONLY JSON: ${schema}`
      },
      {
        role: 'user',
        content: join([
          lore.text && `RELEVANT LORE:\n${lore.text}`,
          state && `WORLD STATE (hidden from users):\n${state}`,
          `NPCs WHO MAY ACT NOW:\n${actors.map((a) => characterCard(a, { brief: true })).join('\n\n')}`,
          personaBlock(ps),
          newUserAllowed && npcRules(world),
          communities,
          roots.length && `RECENT ${focus ? `POSTS IN c/${focus.slug}` : 'FEED'}:\n${roots.map((p) => `[post ${p.id}] ${humanTag(p)}${p.community && !focus ? ` in c/${p.community}` : ''} (${p.likes} likes, ${p.replies} replies): ${clip(p.content, 220)}`).join('\n')}`,
          replies.length && `RECENT REPLIES:\n${replies.map((r) => `[post ${r.id}] (reply on post ${r.parent_id}) ${humanTag(r)}: ${clip(r.content, 160)}`).join('\n')}`,
          `Write ${count} posts/replies now.${topic ? ` Current event/topic: ${topic}` : ''}`
        ])
      }
    ]
  });

  const allowed = new Set(pool.map((c) => c.id));
  const aliases = new Map(); // handle the model used -> the account actually created
  if (newUserAllowed) {
    for (const u of arr(out.newUsers).slice(0, 1)) {
      const who = u?.realName || u?.name;
      if (u?.name && !db.prepare("SELECT 1 FROM characters WHERE world_id = ? AND (lower(name) = lower(?) OR lower(real_name) = lower(?))").get(worldId, u.name, who)) {
        const c = insertCharacter(worldId, { ...u, kind: 'generated' });
        allowed.add(c.id);
        aliases.set(makeHandle(u.handle || u.name), c);
      }
    }
  }
  const resolve = resolver(worldId);
  const find = (h) => aliases.get(makeHandle(String(h ?? ''))) || resolve(h);
  let founded = null;
  const nc = newCommunityAllowed && out.newCommunity;
  if (nc?.name && find(nc.creator) && allowed.has(find(nc.creator).id) && !findCommunity(worldId, nc.name)) {
    const members = arr(nc.members).map(find).filter((c) => c && allowed.has(c.id)).map((c) => c.id);
    founded = createCommunity(worldId, { name: nc.name, description: nc.description, creatorId: find(nc.creator).id, memberIds: members });
    announceCommunity(worldId, founded);
  }
  const ins = db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content, likes, community_id) VALUES (?, ?, ?, ?, ?, ?)');
  const created = [];
  for (const p of arr(out.posts).slice(0, count)) {
    const author = find(p?.handle);
    if (!author || !allowed.has(author.id) || !p.content) continue; // never as a persona
    const parent = rootOf(worldId, p.replyTo);
    // replies live where their thread is; new posts go where the model put them (or the community in focus)
    const where = parent
      ? db.prepare('SELECT community_id FROM posts WHERE id = ?').get(parent).community_id
      : (p.community ? findCommunity(worldId, p.community)?.id : null) ?? focus?.id ?? null;
    if (where) joinCommunity(where, author.id);
    const id = Number(ins.run(worldId, author.id, parent, String(p.content).trim(), parent ? 0 : Math.floor(Math.random() * 20), where).lastInsertRowid);
    notifyForPost(worldId, id);
    created.push(id);
  }

  let dms = 0;
  if (dmsAllowed) {
    const { deliverDm } = await import('./chat.js');
    for (const d of arr(out.dms).slice(0, 2)) {
      const from = find(d?.from), to = find(d?.to);
      if (!from || !to || !allowed.has(from.id) || to.kind !== 'player' || !d.content) continue;
      deliverDm(worldId, from, to, String(d.content).trim());
      dms++;
    }
  }

  const tickStart = db.prepare("SELECT datetime('now') AS t").get().t;
  applyUpdates(worldId, { ...(out.updates || {}), follows: out.follows, unfollows: out.unfollows, likes: out.likes }, 'feed');
  coolDownStorylines(worldId, tickStart);
  simulateEngagement(worldId);
  db.prepare('UPDATE worlds SET last_tick_at = CURRENT_TIMESTAMP WHERE id = ?').run(worldId);
  return { created, dms, community: founded };
}

/** Drama nobody touched this tick cools off, and fizzles out entirely once it's cold, so old plots don't linger forever. */
function coolDownStorylines(worldId, since) {
  db.prepare("UPDATE storylines SET heat = MAX(0, heat - 8) WHERE world_id = ? AND status = 'active' AND updated_at < ?").run(worldId, since);
  db.prepare("UPDATE storylines SET status = 'resolved' WHERE world_id = ? AND status = 'active' AND heat < 15").run(worldId);
}

// ---------------------------------------------------------------------------
// Thread replies
// ---------------------------------------------------------------------------

const lastThreadGen = new Map();

/** Decides whether opening a thread should make new replies appear (random, with a cooldown). */
export function rollViewReplies(postId) {
  const s = getSettings();
  const root = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!root || !aiCharacters(root.world_id).length) return false;
  if (Date.now() - (lastThreadGen.get(root.id) || 0) < 3 * 60_000) return false;
  const lastReply = db
    .prepare('SELECT c.kind FROM posts p JOIN characters c ON c.id = p.character_id WHERE p.parent_id = ? ORDER BY p.id DESC LIMIT 1')
    .get(root.id);
  // a human reply nobody has answered yet makes a response more likely
  const chance = lastReply?.kind === 'player' ? Math.min(1, s.viewReplyChance * 2) : s.viewReplyChance;
  const yes = Math.random() < chance;
  if (!yes) lastThreadGen.set(root.id, Date.now()); // don't re-roll on every open
  return yes;
}

/**
 * AI characters reply to a thread in one batched request.
 * humanReplyId: set when the user just replied, so someone answers them directly.
 */
export async function generateReplies(postId, { count, humanReplyId } = {}) {
  const first = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!first) throw httpError(404, 'Post not found');
  const root = first.parent_id ? db.prepare('SELECT * FROM posts WHERE id = ?').get(first.parent_id) : first;
  const world = getWorld(root.world_id);
  lastThreadGen.set(root.id, Date.now());
  count = Number(count) || 2 + Math.floor(Math.random() * 3);

  const thread = db
    .prepare(
      `SELECT p.id, p.content, p.character_id, c.handle, c.name, c.kind FROM posts p JOIN characters c ON c.id = p.character_id
       WHERE p.id = ? OR p.parent_id = ? ORDER BY p.id`
    )
    .all(root.id, root.id);
  const shown = thread.length > 26 ? [thread[0], ...thread.slice(-25)] : thread;
  const pool = aiCharacters(world.id);
  if (!pool.length) throw httpError(400, 'No active AI characters in this world.');

  const human = humanReplyId ? thread.find((t) => t.id === Number(humanReplyId)) : null;
  const text = shown.map((t) => t.content).join('\n');
  const mentioned = pool.filter((c) => new RegExp(`@${escapeRe(c.handle)}\\b|${knownNames(c).map((n) => `\\b${escapeRe(n)}\\b`).join('|')}`, 'i').test(human ? human.content : text));
  const participants = pool.filter((c) => thread.some((t) => t.character_id === c.id));
  const op = pool.find((c) => c.id === root.character_id);
  const lastAuthor = thread[thread.length - 1]?.character_id;
  // OP defends their post, people who were called out answer back, plus some newcomers
  const core = [...new Set([...mentioned, ...(op && op.id !== lastAuthor ? [op] : []), ...sample(participants, 2)])];
  const newcomers = sample(pool.filter((c) => !core.includes(c)), Math.max(1, count - core.length));
  const responders = [...core, ...newcomers].slice(0, Math.max(count, mentioned.length + 1));

  const ps = personas(world.id);
  const humansHere = ps.filter((p) => thread.some((t) => t.character_id === p.id));
  const state = worldContext(world.id, { focus: responders, others: humansHere, memoriesPer: 3 });
  const lore = activateLore(world.id, `${text}\n${responders.flatMap(knownNames).join(' ')}`, undefined, { boost: responders.flatMap(knownNames) });

  const out = await completeJSON({
    task: 'replies', expect: 'replies',
    maxTokens: 170 * count + 600,
    temperature: 0.95,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}
You write the next replies in a social-media thread, each in the replying user's own voice and consistent with the lore, their memories and relationships. React to the thread: agree, argue, dunk, joke, bring receipts, escalate drama. The same user may reply more than once if they're arguing. Address specific people with @handle.
${UPDATES_RULES}
Return ONLY JSON: {"replies":[{"handle":string,"content":string}],"likes":[{"handle":string,"postId":number}],${UPDATES_SCHEMA}}`
      },
      {
        role: 'user',
        content: join([
          lore.text && `RELEVANT LORE:\n${lore.text}`,
          state && `WORLD STATE (hidden from users):\n${state}`,
          `USERS WHO CAN REPLY:\n${responders.map((r) => characterCard(r, { brief: true })).join('\n\n')}`,
          personaBlock(humansHere),
          `THREAD:\n${shown.map((t) => `[post ${t.id}] ${humanTag(t)}: ${t.content}`).join('\n')}`,
          human
            ? `The human (@${human.handle}) just replied (post ${human.id}). At least one reply must respond directly to them. Write ${count} replies.`
            : `Write ${count} new replies.`
        ])
      }
    ]
  });

  const find = resolver(world.id);
  const allowed = new Set(responders.map((r) => r.id));
  const ins = db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content, likes, community_id) VALUES (?, ?, ?, ?, ?, ?)');
  const created = [];
  for (const r of arr(out.replies).slice(0, count + 2)) {
    const c = find(r?.handle);
    if (!c || !allowed.has(c.id) || !r.content) continue;
    if (root.community_id) joinCommunity(root.community_id, c.id);
    const id = Number(ins.run(world.id, c.id, root.id, String(r.content).trim(), Math.floor(Math.random() ** 2 * 60), root.community_id ?? null).lastInsertRowid);
    notifyForPost(world.id, id);
    created.push(id);
  }
  applyUpdates(world.id, { ...(out.updates || {}), likes: out.likes }, 'thread');
  return created;
}
