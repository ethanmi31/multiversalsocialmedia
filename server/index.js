import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, getSettings, saveSettings, estimateTokens, DEFAULT_SETTINGS } from './db.js';
import {
  extractText, parseSillyTavernLorebook, readPngCard, importEntries, insertEntries, startCompile, getJob, estimateCompile, summarizeWorld, activateLore
} from './lorebook.js';
import {
  generateCharacters, draftCharacter, worldTick, generateReplies, rollViewReplies, insertCharacter, uniqueHandle,
  splitCharactersFree, splitCharactersAI
} from './engine.js';
import { conversationMembers, pickResponder, streamReply, observeConversation, findOrCreateDm } from './chat.js';
import { follow, like, followerCount } from './worldstate.js';
import { listModels, httpError } from './openrouter.js';
import { directorChat, directorState } from './director.js';
import { startFromLoreJob, startLearnJob, getFromLoreJob, resetSkim } from './canon.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '50mb' }));

const api = express.Router();
const id = (v) => Number(v);

// ---------------------------------------------------------------- universe isolation guards
function character(cid, worldId) {
  const c = db.prepare('SELECT * FROM characters WHERE id = ?').get(id(cid));
  if (!c) throw httpError(404, 'Character not found');
  if (worldId != null && c.world_id !== id(worldId)) throw httpError(400, 'That character belongs to a different universe.');
  return c;
}
function post(pid, worldId) {
  const p = db.prepare('SELECT * FROM posts WHERE id = ?').get(id(pid));
  if (!p) throw httpError(404, 'Post not found');
  if (worldId != null && p.world_id !== id(worldId)) throw httpError(400, 'That post belongs to a different universe.');
  return p;
}
function conversation(cid) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id(cid));
  if (!c) throw httpError(404, 'Conversation not found');
  return c;
}

// ---------------------------------------------------------------- settings
api.get('/settings', (req, res) => {
  const s = getSettings();
  res.json({ ...s, apiKey: undefined, hasApiKey: !!s.apiKey, apiKeyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '', defaultStyleGuide: DEFAULT_SETTINGS.styleGuide });
});
api.put('/settings', (req, res) => {
  const patch = { ...req.body };
  if (!patch.apiKey) delete patch.apiKey; // empty field = keep existing key
  for (const k of Object.keys(patch)) {
    if (typeof DEFAULT_SETTINGS[k] === 'number') patch[k] = Number(patch[k]);
  }
  saveSettings(patch);
  res.json({ ok: true });
});
api.get('/models', async (req, res) => res.json(await listModels()));

api.get('/usage', (req, res) => {
  const totals = db
    .prepare('SELECT task, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt, SUM(completion_tokens) AS completion, SUM(cached_tokens) AS cached, SUM(cost) AS cost FROM usage_log GROUP BY task ORDER BY cost DESC')
    .all();
  const recent = db.prepare('SELECT * FROM usage_log ORDER BY id DESC LIMIT 50').all();
  res.json({ totals, recent });
});
api.delete('/usage', (req, res) => {
  db.prepare('DELETE FROM usage_log').run();
  res.json({ ok: true });
});

/** Extracts plain text from an uploaded file (used for dropping character descriptions in). */
api.post('/extract', upload.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  res.json({ text: await extractText(req.file) });
});

// ---------------------------------------------------------------- worlds
const worldStats = `(SELECT COUNT(*) FROM lore_entries l WHERE l.world_id = w.id) AS loreCount,
  (SELECT COUNT(*) FROM characters c WHERE c.world_id = w.id) AS characterCount,
  (SELECT COUNT(*) FROM posts p WHERE p.world_id = w.id) AS postCount,
  (SELECT COUNT(*) FROM notifications n WHERE n.world_id = w.id AND n.read = 0) AS unreadNotifications,
  (SELECT COALESCE(SUM(unread), 0) FROM conversations v WHERE v.world_id = w.id) AS unreadMessages,
  CAST((julianday('now') - julianday(COALESCE(w.last_tick_at, w.created_at))) * 1440 AS INTEGER) AS minutesSinceTick,
  length(w.source_text) AS sourceChars`;

api.get('/worlds', (req, res) => {
  res.json(db.prepare(`SELECT w.id, w.name, w.description, w.created_at, ${worldStats} FROM worlds w ORDER BY w.id DESC`).all());
});
api.post('/worlds', (req, res) => {
  const { name = 'New World', description = '' } = req.body;
  const r = db.prepare('INSERT INTO worlds (name, description) VALUES (?, ?)').run(name, description);
  res.json(db.prepare('SELECT * FROM worlds WHERE id = ?').get(r.lastInsertRowid));
});
api.get('/worlds/:id', (req, res) => {
  const w = db.prepare(`SELECT w.*, ${worldStats} FROM worlds w WHERE w.id = ?`).get(id(req.params.id));
  if (!w) throw httpError(404, 'World not found');
  w.sourceTokens = estimateTokens(w.source_text);
  res.json(w);
});
api.put('/worlds/:id', (req, res) => {
  const fields = ['name', 'description', 'summary', 'rules', 'instructions', 'npc_instructions', 'source_text', 'source_name'];
  for (const f of fields) {
    if (f in req.body) db.prepare(`UPDATE worlds SET ${f} = ? WHERE id = ?`).run(String(req.body[f] ?? ''), id(req.params.id));
  }
  res.json({ ok: true });
});
api.delete('/worlds/:id', (req, res) => {
  db.prepare('DELETE FROM worlds WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});

/** Upload a document (txt/md/docx/pdf) as the world's source, or a SillyTavern lorebook JSON to import directly. */
api.post('/worlds/:id/document', upload.single('file'), async (req, res) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  const worldId = id(req.params.id);
  const text = await extractText(req.file);
  if (req.file.originalname.toLowerCase().endsWith('.json')) {
    const entries = parseSillyTavernLorebook(text);
    if (entries) return res.json({ ...importEntries(worldId, entries), kind: 'lorebook' });
  }
  const append = req.query.append === '1';
  const w = db.prepare('SELECT source_text, source_name FROM worlds WHERE id = ?').get(worldId);
  const source = append && w.source_text ? `${w.source_text}\n\n${text}` : text;
  const name = append && w.source_name ? `${w.source_name}, ${req.file.originalname}` : req.file.originalname;
  db.prepare('UPDATE worlds SET source_text = ?, source_name = ? WHERE id = ?').run(source, name, worldId);
  res.json({ kind: 'document', chars: source.length, tokens: estimateTokens(source) });
});

api.get('/worlds/:id/compile/estimate', async (req, res) => {
  const w = db.prepare('SELECT * FROM worlds WHERE id = ?').get(id(req.params.id));
  if (!w) throw httpError(404, 'World not found');
  res.json(await estimateCompile(w));
});
api.post('/worlds/:id/compile', (req, res) => {
  res.json(startCompile(id(req.params.id), { mode: req.body.mode, replace: req.body.replace !== false }));
});
api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw httpError(404, 'Job not found');
  res.json(job);
});
api.post('/worlds/:id/summarize', async (req, res) => res.json({ summary: await summarizeWorld(id(req.params.id)) }));

// ---------------------------------------------------------------- lore entries
const parseEntry = (e) => ({ ...e, keys: JSON.parse(e.keys || '[]'), constant: !!e.constant, enabled: !!e.enabled });

api.get('/worlds/:id/lore', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(
    db
      .prepare('SELECT * FROM lore_entries WHERE world_id = ? AND (title LIKE ? OR keys LIKE ? OR content LIKE ?) ORDER BY category, title')
      .all(id(req.params.id), q, q, q)
      .map(parseEntry)
  );
});
api.post('/worlds/:id/lore', (req, res) => {
  insertEntries(id(req.params.id), [{ title: 'New entry', content: ' ', keys: [], ...req.body }]);
  res.json({ ok: true });
});
api.put('/lore/:id', (req, res) => {
  const e = req.body;
  const keys = Array.isArray(e.keys) ? e.keys : String(e.keys || '').split(',').map((k) => k.trim()).filter(Boolean);
  db.prepare('UPDATE lore_entries SET title = ?, keys = ?, content = ?, category = ?, constant = ?, priority = ?, enabled = ?, tokens = ?, is_character = NULL WHERE id = ?').run(
    e.title, JSON.stringify(keys), e.content || '', e.category || '', e.constant ? 1 : 0, Number(e.priority) || 0, e.enabled ? 1 : 0, estimateTokens(e.content), id(req.params.id)
  );
  res.json({ ok: true });
});
api.delete('/lore/:id', (req, res) => {
  db.prepare('DELETE FROM lore_entries WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/worlds/:id/lore/test', (req, res) => {
  const r = activateLore(id(req.params.id), req.body.text || '');
  res.json({ tokens: r.tokens, entries: r.entries.map((e) => ({ id: e.id, title: e.title, tokens: e.tokens, constant: !!e.constant })) });
});
/** Import one or more SillyTavern lorebooks (.json World Info, or character cards .json/.png with an embedded book). */
api.post('/worlds/:id/lore/import', upload.array('files', 50), (req, res) => {
  const wid = id(req.params.id);
  if (!req.files?.length) throw httpError(400, 'No files uploaded');
  const results = req.files.map((f) => {
    const name = f.originalname;
    const json = name.toLowerCase().endsWith('.png') ? readPngCard(f.buffer) : f.buffer.toString('utf8');
    const entries = json ? parseSillyTavernLorebook(json) : null;
    if (!entries) return { name, error: 'not a SillyTavern lorebook (or the card has no embedded lorebook)' };
    return { name, ...importEntries(wid, entries) };
  });
  res.json(results);
});
api.get('/worlds/:id/lore/export', (req, res) => {
  const entries = db.prepare('SELECT * FROM lore_entries WHERE world_id = ?').all(id(req.params.id));
  const out = { entries: {} };
  entries.forEach((e, i) => {
    out.entries[i] = { uid: i, key: JSON.parse(e.keys), keysecondary: [], comment: e.title, content: e.content, constant: !!e.constant, order: e.priority, disable: !e.enabled, group: e.category };
  });
  res.setHeader('Content-Disposition', 'attachment; filename="lorebook.json"');
  res.json(out);
});

// ---------------------------------------------------------------- world state ("system update")
api.get('/worlds/:id/state', (req, res) => {
  const wid = id(req.params.id);
  const names = new Map(db.prepare('SELECT id, name, handle FROM characters WHERE world_id = ?').all(wid).map((c) => [c.id, c]));
  const storylines = db.prepare('SELECT * FROM storylines WHERE world_id = ? ORDER BY status, heat DESC, updated_at DESC').all(wid)
    .map((s) => ({ ...s, involved: JSON.parse(s.involved || '[]').map((i) => names.get(i)).filter(Boolean) }));
  const relationships = db.prepare('SELECT * FROM relationships WHERE world_id = ? ORDER BY updated_at DESC LIMIT 200').all(wid)
    .map((r) => ({ ...r, from: names.get(r.from_id), to: names.get(r.to_id) }));
  res.json({ storylines, relationships });
});
api.put('/storylines/:id', (req, res) => {
  const { title, summary, status, heat, visibility } = req.body;
  db.prepare('UPDATE storylines SET title = ?, summary = ?, status = ?, heat = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(title, summary, status === 'resolved' ? 'resolved' : 'active', Number(heat) || 0, visibility === 'private' ? 'private' : 'public', id(req.params.id));
  res.json({ ok: true });
});
api.post('/worlds/:id/storylines', (req, res) => {
  db.prepare('INSERT INTO storylines (world_id, title, summary, heat) VALUES (?, ?, ?, ?)').run(id(req.params.id), req.body.title || 'New storyline', req.body.summary || '', Number(req.body.heat) || 60);
  res.json({ ok: true });
});
api.delete('/storylines/:id', (req, res) => {
  db.prepare('DELETE FROM storylines WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.delete('/relationships/:from/:to', (req, res) => {
  db.prepare('DELETE FROM relationships WHERE from_id = ? AND to_id = ?').run(id(req.params.from), id(req.params.to));
  res.json({ ok: true });
});
api.delete('/memories/:id', (req, res) => {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- director (out-of-character control, per universe)
api.get('/worlds/:id/director', (req, res) => res.json(directorState(id(req.params.id))));
api.post('/worlds/:id/director', async (req, res) => res.json(await directorChat(id(req.params.id), req.body.message)));
api.delete('/worlds/:id/director/messages', (req, res) => {
  db.prepare('DELETE FROM director_messages WHERE world_id = ?').run(id(req.params.id));
  res.json(directorState(id(req.params.id)));
});
api.post('/worlds/:id/director/notes', (req, res) => {
  if (!req.body.content?.trim()) throw httpError(400, 'Note is empty');
  db.prepare('INSERT INTO director_notes (world_id, content) VALUES (?, ?)').run(id(req.params.id), req.body.content.trim());
  res.json(directorState(id(req.params.id)));
});
api.put('/director/notes/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM director_notes WHERE id = ?').get(id(req.params.id));
  if (!n) throw httpError(404, 'Note not found');
  if ('content' in req.body) db.prepare('UPDATE director_notes SET content = ? WHERE id = ?').run(String(req.body.content), n.id);
  if ('active' in req.body) db.prepare('UPDATE director_notes SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, n.id);
  res.json(directorState(n.world_id));
});
api.delete('/director/notes/:id', (req, res) => {
  const n = db.prepare('SELECT * FROM director_notes WHERE id = ?').get(id(req.params.id));
  if (!n) throw httpError(404, 'Note not found');
  db.prepare('DELETE FROM director_notes WHERE id = ?').run(n.id);
  res.json(directorState(n.world_id));
});

// ---------------------------------------------------------------- characters
const CHAR_FIELDS = ['kind', 'name', 'real_name', 'handle', 'bio', 'persona', 'style', 'color', 'active', 'followers', 'knowledge'];

api.get('/worlds/:id/characters', (req, res) => {
  res.json(
    db.prepare("SELECT * FROM characters WHERE world_id = ? ORDER BY kind = 'player' DESC, kind = 'custom' DESC, name").all(id(req.params.id))
      .map((c) => ({ ...c, followerCount: followerCount(c) }))
  );
});
api.post('/worlds/:id/characters', (req, res) => {
  if (!req.body.name?.trim()) throw httpError(400, 'Name is required');
  res.json(insertCharacter(id(req.params.id), req.body));
});
api.post('/worlds/:id/characters/generate', async (req, res) => res.json(await generateCharacters(id(req.params.id), req.body)));
api.post('/worlds/:id/characters/draft', async (req, res) => res.json(await draftCharacter(id(req.params.id), req.body)));

/** Step 1 of bulk import: split pasted text into a preview list the user can edit. */
api.post('/worlds/:id/characters/split', async (req, res) => {
  const text = String(req.body.text || '');
  if (!text.trim()) throw httpError(400, 'Paste or drop some character descriptions first.');
  res.json(req.body.mode === 'ai' ? await splitCharactersAI(id(req.params.id), text) : splitCharactersFree(text));
});
/** Characters from the lorebook: skim entries, pick per the request, preview accounts (nothing created yet). */
api.post('/worlds/:id/characters/from-lore', (req, res) => {
  if (req.body.rescan) resetSkim(id(req.params.id));
  res.json(startFromLoreJob(id(req.params.id), req.body.request));
});
/** Learn what characters know and who they know from the lorebook (all characters if no ids). */
api.post('/worlds/:id/characters/learn', (req, res) => res.json(startLearnJob(id(req.params.id), req.body.ids || [])));
api.get('/worlds/:id/characters/from-lore/:job', (req, res) => {
  const job = getFromLoreJob(req.params.job);
  if (!job || job.worldId !== id(req.params.id)) throw httpError(404, 'Job not found');
  res.json(job);
});
/** Step 2: create the reviewed characters. */
api.post('/worlds/:id/characters/import', (req, res) => {
  const wid = id(req.params.id);
  const list = (req.body.characters || []).filter((c) => c?.name?.trim());
  res.json(list.map((c) => insertCharacter(wid, { ...c, persona: c.description ?? c.persona, kind: c.kind || req.body.kind || 'custom' })));
});

api.put('/characters/:id', (req, res) => {
  const c = character(req.params.id);
  for (const f of CHAR_FIELDS) {
    if (!(f in req.body)) continue;
    let v = req.body[f];
    if (f === 'active') v = v ? 1 : 0;
    else if (f === 'followers') v = Number(v) || 0;
    else if (f === 'handle') v = v ? uniqueHandle(c.world_id, v, c.id) : c.handle; // blank = keep the current handle
    else v = String(v ?? '');
    db.prepare(`UPDATE characters SET ${f} = ? WHERE id = ?`).run(v, c.id);
  }
  res.json(db.prepare('SELECT * FROM characters WHERE id = ?').get(c.id));
});
api.delete('/characters/:id', (req, res) => {
  db.prepare('DELETE FROM characters WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});

api.get('/characters/:id/profile', (req, res) => {
  const c = character(req.params.id);
  const viewer = req.query.as ? character(req.query.as, c.world_id) : null;
  const posts = db.prepare(`${postSelect} WHERE p.character_id = ? ORDER BY p.id DESC LIMIT 40`).all(c.id);
  const following = db.prepare('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?').get(c.id).n;
  const isFollowing = viewer ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(viewer.id, c.id) : false;
  const followsYou = viewer ? !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(c.id, viewer.id) : false;
  const memories = db.prepare('SELECT * FROM memories WHERE character_id = ? ORDER BY id DESC LIMIT 40').all(c.id);
  res.json({ character: c, followers: followerCount(c), following, isFollowing, followsYou, posts, memories });
});
api.post('/characters/:id/follow', (req, res) => {
  const target = character(req.params.id);
  const me = character(req.body.personaId, target.world_id);
  if (req.body.unfollow) db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(me.id, target.id);
  else follow(target.world_id, me.id, target.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- feed
const postSelect = `SELECT p.*, c.name, c.handle, c.color, c.kind,
  (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id) AS replyCount
  FROM posts p JOIN characters c ON c.id = p.character_id`;

api.get('/worlds/:id/posts', (req, res) => {
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  res.json(db.prepare(`${postSelect} WHERE p.world_id = ? AND p.parent_id IS NULL AND p.id < ? ORDER BY p.id DESC LIMIT 30`).all(id(req.params.id), before));
});
api.get('/posts/:id', (req, res) => {
  const p = db.prepare(`${postSelect} WHERE p.id = ?`).get(id(req.params.id));
  if (!p) throw httpError(404, 'Post not found');
  const replies = db.prepare(`${postSelect} WHERE p.parent_id = ? ORDER BY p.id`).all(p.id);
  res.json({ post: p, replies });
});
/** Opening a thread: should characters chime in right now? (random, with cooldown) */
api.post('/posts/:id/view', (req, res) => res.json({ generate: rollViewReplies(post(req.params.id).id) }));

api.post('/worlds/:id/posts', (req, res) => {
  const wid = id(req.params.id);
  const { characterId, content } = req.body;
  if (!content?.trim() || !characterId) throw httpError(400, 'Pick who is posting and write something.');
  character(characterId, wid);
  // replies always attach to the thread root
  const parent = req.body.parentId ? post(req.body.parentId, wid) : null;
  const r = db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content) VALUES (?, ?, ?, ?)').run(wid, characterId, parent ? parent.parent_id || parent.id : null, content.trim());
  res.json({ id: Number(r.lastInsertRowid) });
});
api.post('/posts/:id/like', (req, res) => {
  const p = post(req.params.id);
  if (req.body.personaId) like(p.world_id, p, character(req.body.personaId, p.world_id));
  else db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(p.id);
  res.json({ ok: true });
});
api.delete('/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/worlds/:id/tick', async (req, res) => res.json(await worldTick(id(req.params.id), req.body)));
api.post('/posts/:id/replies/generate', async (req, res) => res.json({ created: await generateReplies(post(req.params.id).id, req.body) }));

// ---------------------------------------------------------------- notifications
api.get('/worlds/:id/notifications', (req, res) => {
  res.json(
    db.prepare(
      `SELECT n.*, a.name AS actorName, a.handle AS actorHandle, a.color AS actorColor, p.content AS postContent, pe.handle AS personaHandle
       FROM notifications n LEFT JOIN characters a ON a.id = n.actor_id LEFT JOIN posts p ON p.id = n.post_id LEFT JOIN characters pe ON pe.id = n.persona_id
       WHERE n.world_id = ? ORDER BY n.id DESC LIMIT 100`
    ).all(id(req.params.id))
  );
});
api.post('/worlds/:id/notifications/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE world_id = ?').run(id(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- conversations (DMs and real-life scenes)
api.get('/worlds/:id/conversations', (req, res) => {
  const convs = db
    .prepare(
      `SELECT v.*, (SELECT content FROM messages m WHERE m.conversation_id = v.id ORDER BY m.id DESC LIMIT 1) AS lastMessage
       FROM conversations v WHERE v.world_id = ? AND v.kind = ?
       ORDER BY COALESCE((SELECT MAX(id) FROM messages m WHERE m.conversation_id = v.id), 0) DESC, v.id DESC`
    )
    .all(id(req.params.id), req.query.kind === 'scene' ? 'scene' : 'dm');
  res.json(convs.map((c) => ({ ...c, members: conversationMembers(c.id) })));
});
api.post('/worlds/:id/conversations', (req, res) => {
  const wid = id(req.params.id);
  const { memberIds = [], playerId = null, title = '', kind = 'dm', setting = '' } = req.body;
  if (!memberIds.length && kind !== 'scene') throw httpError(400, 'Pick at least one character.'); // scenes can be solo
  memberIds.forEach((m) => character(m, wid));
  if (playerId) character(playerId, wid);
  // a 1:1 DM with the same person reopens the existing thread instead of starting over
  if (kind !== 'scene' && memberIds.length === 1 && playerId) {
    return res.json({ id: findOrCreateDm(wid, character(playerId), character(memberIds[0])) });
  }
  const r = db.prepare('INSERT INTO conversations (world_id, player_id, title, kind, setting) VALUES (?, ?, ?, ?, ?)')
    .run(wid, playerId, title, kind === 'scene' ? 'scene' : 'dm', setting);
  const ins = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, character_id) VALUES (?, ?)');
  for (const m of memberIds) ins.run(r.lastInsertRowid, m);
  res.json({ id: Number(r.lastInsertRowid) });
});
api.get('/conversations/:id', (req, res) => {
  const conv = conversation(req.params.id);
  db.prepare('UPDATE conversations SET unread = 0 WHERE id = ?').run(conv.id);
  const messages = db
    .prepare('SELECT m.*, c.name, c.handle, c.color FROM messages m LEFT JOIN characters c ON c.id = m.character_id WHERE m.conversation_id = ? ORDER BY m.id')
    .all(conv.id);
  res.json({ ...conv, members: conversationMembers(conv.id), messages });
});
api.put('/conversations/:id', (req, res) => {
  const conv = conversation(req.params.id);
  if ('playerId' in req.body) {
    if (req.body.playerId) character(req.body.playerId, conv.world_id);
    db.prepare('UPDATE conversations SET player_id = ? WHERE id = ?').run(req.body.playerId || null, conv.id);
  }
  for (const f of ['title', 'summary', 'setting']) {
    if (f in req.body) db.prepare(`UPDATE conversations SET ${f} = ? WHERE id = ?`).run(String(req.body[f] ?? ''), conv.id);
  }
  res.json({ ok: true });
});
api.delete('/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/conversations/:id/messages', (req, res) => {
  const conv = conversation(req.params.id);
  if (!req.body.content?.trim()) throw httpError(400, 'Message is empty');
  const r = db.prepare('INSERT INTO messages (conversation_id, character_id, is_player, content) VALUES (?, ?, 1, ?)').run(conv.id, conv.player_id, req.body.content.trim());
  res.json({ id: Number(r.lastInsertRowid) });
});
api.delete('/messages/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
/** Someone joins a scene or group chat already in progress. */
api.post('/conversations/:id/members', (req, res) => {
  const conv = conversation(req.params.id);
  const c = character(req.body.characterId, conv.world_id);
  if (c.kind === 'player') throw httpError(400, 'Your personas take part as you, not as members.');
  db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, character_id) VALUES (?, ?)').run(conv.id, c.id);
  res.json({ ok: true });
});
api.get('/conversations/:id/next', (req, res) => res.json(pickResponder(id(req.params.id))));
/** "Let it spread": push what happened in this DM/scene into the world right now. */
api.post('/conversations/:id/observe', async (req, res) => res.json(await observeConversation(conversation(req.params.id).id, { force: true })));

/** Streams the next reply as Server-Sent Events. */
api.post('/conversations/:id/reply', async (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const message = await streamReply(id(req.params.id), {
      characterId: req.body.characterId,
      signal: ac.signal,
      onMeta: (m) => send('meta', m),
      onToken: (t) => send('token', t)
    });
    send('done', message);
  } catch (e) {
    if (!ac.signal.aborted) send('error', { message: e.message });
  }
  res.end();
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err.status >= 500 || !err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// ---------------------------------------------------------------- client
const port = Number(process.env.PORT) || 5173;
if (process.argv.includes('--dev')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const dist = path.resolve('client/dist');
  if (!fs.existsSync(dist)) {
    console.error('client/dist not found. Run "npm run build" first, or use "npm run dev".');
    process.exit(1);
  }
  app.use(express.static(dist));
  app.get('/{*splat}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(port, () => console.log(`Multiversal Social Media running at http://localhost:${port}`));
