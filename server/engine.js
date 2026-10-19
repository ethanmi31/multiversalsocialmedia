import { db, estimateTokens, getSettings } from './db.js';
import { activateLore } from './lorebook.js';
import { complete, completeJSON, stream, httpError } from './openrouter.js';

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
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'user';
}

const clip = (s = '', n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

function getWorld(worldId) {
  const w = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId);
  if (!w) throw httpError(404, 'World not found');
  return w;
}

/** The stable part of every prompt. Kept first and identical across calls so provider prompt caching can kick in. */
function worldPreamble(world) {
  let out = `WORLD: ${world.name}\n`;
  if (world.summary) out += `${world.summary}\n`;
  else if (world.description) out += `${world.description}\n`;
  if (world.rules?.trim()) out += `\nWORLD RULES (always follow):\n${world.rules.trim()}\n`;
  return out;
}

function characterCard(c, { brief = false } = {}) {
  const lim = brief ? 350 : 4000;
  let s = `${c.name} (@${c.handle})`;
  if (c.bio) s += ` — ${clip(c.bio, brief ? 160 : 600)}`;
  if (c.persona) s += `\nPersonality/background: ${clip(c.persona, lim)}`;
  if (c.style) s += `\nVoice: ${clip(c.style, brief ? 150 : 800)}`;
  return s;
}

function uniqueHandle(worldId, wanted) {
  const base = makeHandle(wanted);
  let handle = base;
  let n = 1;
  while (db.prepare('SELECT 1 FROM characters WHERE world_id = ? AND handle = ?').get(worldId, handle)) handle = `${base}${++n}`;
  return handle;
}

export function insertCharacter(worldId, c) {
  const handle = uniqueHandle(worldId, c.handle || c.name);
  const r = db
    .prepare('INSERT INTO characters (world_id, kind, name, handle, bio, persona, style, color, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(worldId, c.kind || 'custom', c.name.trim(), handle, c.bio || '', c.persona || '', c.style || '', c.color || colorFor(c.name), c.active === 0 ? 0 : 1);
  return db.prepare('SELECT * FROM characters WHERE id = ?').get(r.lastInsertRowid);
}

function aiCharacters(worldId) {
  return db.prepare("SELECT * FROM characters WHERE world_id = ? AND active = 1 AND kind != 'player'").all(worldId);
}

function sample(arr, n) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function byHandle(chars) {
  const m = new Map();
  for (const c of chars) {
    m.set(c.handle.toLowerCase(), c);
    m.set(c.name.toLowerCase(), c);
  }
  return (h = '') => m.get(String(h).replace(/^@/, '').toLowerCase());
}

const randomLikes = () => Math.floor(Math.random() ** 2 * 400);

// ---------------------------------------------------------------------------
// Character generation
// ---------------------------------------------------------------------------

export async function generateCharacters(worldId, { count = 5, theme = '' } = {}) {
  const world = getWorld(worldId);
  count = Math.max(1, Math.min(15, Number(count) || 5));
  const existing = db.prepare('SELECT name FROM characters WHERE world_id = ?').all(worldId).map((c) => c.name);
  const titles = db
    .prepare('SELECT title FROM lore_entries WHERE world_id = ? AND enabled = 1 ORDER BY priority DESC LIMIT 120')
    .all(worldId)
    .map((e) => e.title);
  const lore = activateLore(worldId, `${theme}\n${titles.slice(0, 15).join('\n')}`);

  const out = await completeJSON({
    task: 'generate-users',
    maxTokens: 300 * count + 300,
    temperature: 1,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}\nYou invent believable social-media users who live in this world. They are ordinary and notable people alike: locals, fans, critics, officials, merchants, rivals. Each has a distinct voice and opinions rooted in the lore. Do not duplicate existing names.
Return ONLY JSON: {"characters":[{"name":string,"handle":string,"bio":string (profile bio, <25 words),"persona":string (personality, background, ties to the lore, 40-80 words),"style":string (how they post: tone, slang, emoji, length, 10-25 words)}]}`
      },
      {
        role: 'user',
        content: [
          lore.text && `RELEVANT LORE:\n${lore.text}`,
          titles.length && `Known lore topics: ${titles.join(', ')}`,
          existing.length && `Existing users (do not reuse): ${existing.join(', ')}`,
          `Create ${count} new users.${theme ? ` Focus: ${theme}` : ''}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ]
  });
  const list = Array.isArray(out) ? out : out.characters || [];
  return list.filter((c) => c?.name).slice(0, count).map((c) => insertCharacter(worldId, { ...c, kind: 'generated' }));
}

/** Expands a rough idea into a full character card. */
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
        content: `${worldPreamble(world)}\nFlesh out a character card for this world. Stay consistent with the lore. Return ONLY JSON: {"name":string,"handle":string,"bio":string (<25 words),"persona":string (60-150 words),"style":string (15-30 words)}`
      },
      { role: 'user', content: `${lore.text ? `RELEVANT LORE:\n${lore.text}\n\n` : ''}Name: ${name || '(invent one)'}\nIdea: ${idea || '(surprise me)'}` }
    ]
  });
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

function recentPosts(worldId, limit = 12) {
  return db
    .prepare(
      `SELECT p.id, p.content, p.parent_id, c.handle FROM posts p JOIN characters c ON c.id = p.character_id
       WHERE p.world_id = ? ORDER BY p.id DESC LIMIT ?`
    )
    .all(worldId, limit)
    .reverse();
}

/** Generates a batch of posts in ONE request (shared context = far fewer tokens than one call per post). */
export async function generateFeed(worldId, { count = 5, topic = '' } = {}) {
  const world = getWorld(worldId);
  count = Math.max(1, Math.min(20, Number(count) || 5));
  const pool = aiCharacters(worldId);
  if (!pool.length) throw httpError(400, 'No active AI characters in this world. Create or generate some first.');
  const authors = sample(pool, Math.min(pool.length, Math.max(3, Math.ceil(count * 0.8))));
  const recent = recentPosts(worldId);
  const lore = activateLore(
    worldId,
    [topic, ...authors.map((a) => `${a.name} ${a.persona}`), ...recent.slice(-6).map((p) => p.content)].join('\n')
  );

  const out = await completeJSON({
    task: 'feed',
    maxTokens: 160 * count + 200,
    temperature: 1,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}\nYou simulate the social-media feed of this world. Write posts in each user's own voice, grounded in the lore and in-world events. Vary length and mood: news, gossip, jokes, complaints, arguments, life updates. Posts can reply to recent posts by id. Never break the fourth wall.
Return ONLY JSON: {"posts":[{"handle":string,"content":string,"replyTo":number|null}]}`
      },
      {
        role: 'user',
        content: [
          lore.text && `RELEVANT LORE:\n${lore.text}`,
          `USERS WHO MAY POST:\n${authors.map((a) => characterCard(a, { brief: true })).join('\n\n')}`,
          recent.length && `RECENT FEED:\n${recent.map((p) => `#${p.id} @${p.handle}: ${clip(p.content, 200)}`).join('\n')}`,
          `Write ${count} new posts.${topic ? ` Topic / event: ${topic}` : ''}`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ]
  });

  const find = byHandle(authors);
  const validIds = new Set(recent.map((p) => p.id));
  const ins = db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content, likes) VALUES (?, ?, ?, ?, ?)');
  const created = [];
  for (const p of (Array.isArray(out) ? out : out.posts || []).slice(0, count)) {
    const author = find(p.handle) || authors[created.length % authors.length];
    if (!p.content) continue;
    const parent = validIds.has(Number(p.replyTo)) ? Number(p.replyTo) : null;
    created.push(ins.run(worldId, author.id, parent, String(p.content).trim(), randomLikes()).lastInsertRowid);
  }
  return created;
}

/** AI characters reply to a post thread, again in one batched request. */
export async function generateReplies(postId, { count = 2 } = {}) {
  const root = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!root) throw httpError(404, 'Post not found');
  const world = getWorld(root.world_id);
  const thread = db
    .prepare(
      `SELECT p.id, p.content, c.handle, c.name, c.id AS cid FROM posts p JOIN characters c ON c.id = p.character_id
       WHERE p.id = ? OR p.parent_id = ? ORDER BY p.id`
    )
    .all(postId, postId);
  const pool = aiCharacters(world.id);
  if (!pool.length) throw httpError(400, 'No active AI characters in this world.');

  // People @mentioned in the thread reply first, then a random selection (not the original author).
  const text = thread.map((t) => t.content).join('\n');
  const mentioned = pool.filter((c) => new RegExp(`@${c.handle}\\b|\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  const others = sample(pool.filter((c) => c.id !== root.character_id && !mentioned.includes(c)), count);
  const responders = [...new Set([...mentioned, ...others])].slice(0, Math.max(count, mentioned.length));
  if (!responders.length) return [];

  const lore = activateLore(world.id, `${text}\n${responders.map((r) => r.name).join(' ')}`);
  const out = await completeJSON({
    task: 'replies',
    maxTokens: 140 * responders.length + 150,
    temperature: 0.95,
    messages: [
      {
        role: 'system',
        content: `${worldPreamble(world)}\nYou write replies in a social-media thread in this world, each in the replying user's own voice and consistent with the lore. Replies are short and react to the thread (agree, argue, joke, add info).
Return ONLY JSON: {"replies":[{"handle":string,"content":string}]}`
      },
      {
        role: 'user',
        content: [
          lore.text && `RELEVANT LORE:\n${lore.text}`,
          `REPLYING USERS:\n${responders.map((r) => characterCard(r, { brief: true })).join('\n\n')}`,
          `THREAD:\n${thread.map((t) => `@${t.handle}: ${t.content}`).join('\n')}`,
          `Write one reply for each replying user (${responders.map((r) => '@' + r.handle).join(', ')}).`
        ]
          .filter(Boolean)
          .join('\n\n')
      }
    ]
  });
  const find = byHandle(responders);
  const ins = db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content, likes) VALUES (?, ?, ?, ?, ?)');
  return (Array.isArray(out) ? out : out.replies || [])
    .filter((r) => r?.content && find(r.handle))
    .map((r) => ins.run(world.id, find(r.handle).id, postId, String(r.content).trim(), randomLikes()).lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export function conversationMembers(convId) {
  return db
    .prepare('SELECT c.* FROM conversation_members m JOIN characters c ON c.id = m.character_id WHERE m.conversation_id = ?')
    .all(convId);
}

/** Picks who should talk next: someone named in the last message, otherwise whoever has been quiet longest. */
export function pickResponder(convId) {
  const members = conversationMembers(convId).filter((m) => m.kind !== 'player');
  if (!members.length) throw httpError(400, 'This conversation has no AI characters.');
  if (members.length === 1) return members[0];
  const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convId);
  if (last) {
    const named = members.find(
      (m) => m.id !== last.character_id && (last.content.toLowerCase().includes(m.name.toLowerCase().split(' ')[0]) || last.content.includes('@' + m.handle))
    );
    if (named) return named;
  }
  const lastSpoke = (m) => db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND character_id = ?').get(convId, m.id)?.id || 0;
  return members.filter((m) => !last || m.id !== last.character_id).sort((a, b) => lastSpoke(a) - lastSpoke(b))[0] || members[0];
}

function buildChatPrompt(conv, speaker) {
  const s = getSettings();
  const world = getWorld(conv.world_id);
  const members = conversationMembers(conv.id);
  const player = conv.player_id ? db.prepare('SELECT * FROM characters WHERE id = ?').get(conv.player_id) : null;
  const others = members.filter((m) => m.id !== speaker.id);
  const history = db
    .prepare(
      `SELECT m.*, c.name FROM messages m LEFT JOIN characters c ON c.id = m.character_id
       WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT ?`
    )
    .all(conv.id, conv.summarized_upto, s.recentMessages)
    .reverse();

  const scan = [
    ...history.slice(-s.scanDepth).map((m) => m.content),
    speaker.name,
    ...others.map((o) => o.name)
  ].join('\n');
  const lore = activateLore(conv.world_id, scan);

  // Stable block first (cache-friendly), dynamic lore and summary after it.
  const stable = [
    worldPreamble(world),
    `You are ${speaker.name}. Stay in character at all times.`,
    `YOUR CHARACTER:\n${characterCard(speaker)}`,
    player && `YOU ARE TALKING WITH (played by the user):\n${characterCard(player, { brief: true })}`,
    others.filter((o) => o.id !== player?.id).length &&
      `ALSO IN THIS CHAT:\n${others.filter((o) => o.id !== player?.id).map((o) => characterCard(o, { brief: true })).join('\n\n')}`,
    `This is a private message conversation on the world's social network. Write only ${speaker.name}'s next message: no name prefix, never write lines for anyone else. Match your voice; keep it conversational and reasonably short unless the moment calls for more.`
  ]
    .filter(Boolean)
    .join('\n\n');

  const dynamic = [lore.text && `RELEVANT LORE:\n${lore.text}`, conv.summary && `EARLIER IN THIS CONVERSATION:\n${conv.summary}`]
    .filter(Boolean)
    .join('\n\n');

  const messages = [{ role: 'system', content: stable }];
  if (dynamic) messages.push({ role: 'system', content: dynamic });
  for (const m of history) {
    const role = m.character_id === speaker.id ? 'assistant' : 'user';
    const content = role === 'assistant' ? m.content : `${m.name || (m.is_player ? 'User' : 'Someone')}: ${m.content}`;
    const prev = messages[messages.length - 1];
    if (prev.role === role && role === 'user') prev.content += `\n${content}`;
    else messages.push({ role, content });
  }
  if (messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: `(Continue the conversation as ${speaker.name}.)` });
  }
  return { messages, lore };
}

export async function streamReply(convId, { characterId, onToken, onMeta, signal }) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv) throw httpError(404, 'Conversation not found');
  const speaker = characterId ? db.prepare('SELECT * FROM characters WHERE id = ?').get(characterId) : pickResponder(convId);
  const { messages, lore } = buildChatPrompt(conv, speaker);
  onMeta?.({
    speaker: { id: speaker.id, name: speaker.name, handle: speaker.handle, color: speaker.color },
    lore: lore.entries.map((e) => e.title),
    promptTokens: estimateTokens(messages.map((m) => m.content).join('\n'))
  });

  const raw = await stream({ task: 'chat', messages, onToken, signal });
  const text = cleanReply(raw, [speaker, ...conversationMembers(convId)], conv.player_id);
  if (!text) throw httpError(502, 'The model returned an empty reply.');
  const r = db.prepare('INSERT INTO messages (conversation_id, character_id, is_player, content) VALUES (?, ?, 0, ?)').run(convId, speaker.id, text);
  maybeSummarize(convId).catch((e) => console.error('summary failed:', e.message));
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(r.lastInsertRowid);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strips a leading "Name:" and cuts the reply where the model starts writing lines for someone else. */
function cleanReply(text, members, playerId) {
  const player = playerId ? db.prepare('SELECT name FROM characters WHERE id = ?').get(playerId) : null;
  const names = [...new Set([...members.map((m) => m.name), player?.name, 'User', 'You'].filter(Boolean))];
  const alt = names.map(escapeRe).join('|');
  let out = text.replace(new RegExp(`^\\s*\\**(?:${alt})\\**\\s*:\\s*`, 'i'), '');
  const cut = out.search(new RegExp(`\\n\\s*\\**(?:${alt})\\**\\s*:`, 'i'));
  if (cut > 0) out = out.slice(0, cut);
  return out.trim();
}

/** Folds older messages into a rolling summary so the prompt doesn't grow forever. */
async function maybeSummarize(convId) {
  const s = getSettings();
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  const pending = db
    .prepare(
      `SELECT m.*, c.name FROM messages m LEFT JOIN characters c ON c.id = m.character_id
       WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id`
    )
    .all(convId, conv.summarized_upto);
  // Batch summaries: wait until there is a meaningful chunk to fold (fewer, cheaper calls).
  if (pending.length < s.recentMessages + 8) return;
  const fold = pending.slice(0, pending.length - s.recentMessages);
  const summary = await complete({
    task: 'chat-summary',
    maxTokens: 450,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content:
          'Update the running summary of a roleplay conversation. Keep important facts, decisions, promises, relationship changes, and emotional beats. Max 250 words, past tense, third person.'
      },
      {
        role: 'user',
        content: `CURRENT SUMMARY:\n${conv.summary || '(none)'}\n\nNEW MESSAGES:\n${fold.map((m) => `${m.name || (m.is_player ? 'User' : 'Someone')}: ${m.content}`).join('\n')}`
      }
    ]
  });
  db.prepare('UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?').run(summary.trim(), fold[fold.length - 1].id, convId);
}
