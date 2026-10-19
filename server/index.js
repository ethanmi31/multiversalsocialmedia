import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { db, getSettings, saveSettings, estimateTokens, DEFAULT_SETTINGS } from './db.js';
import {
  extractText, parseSillyTavernLorebook, insertEntries, startCompile, getJob, estimateCompile, summarizeWorld, activateLore
} from './lorebook.js';
import {
  generateCharacters, draftCharacter, generateFeed, generateReplies, streamReply, insertCharacter, conversationMembers, pickResponder
} from './engine.js';
import { listModels, httpError } from './openrouter.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.json({ limit: '50mb' }));

const api = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const id = (v) => Number(v);

// ---------------------------------------------------------------- settings
api.get('/settings', (req, res) => {
  const s = getSettings();
  res.json({ ...s, apiKey: undefined, hasApiKey: !!s.apiKey, apiKeyHint: s.apiKey ? `…${s.apiKey.slice(-4)}` : '' });
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
api.get('/models', wrap(async (req, res) => res.json(await listModels())));

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

// ---------------------------------------------------------------- worlds
const worldStats = `(SELECT COUNT(*) FROM lore_entries l WHERE l.world_id = w.id) AS loreCount,
  (SELECT COUNT(*) FROM characters c WHERE c.world_id = w.id) AS characterCount,
  (SELECT COUNT(*) FROM posts p WHERE p.world_id = w.id) AS postCount,
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
  w.summaryTokens = estimateTokens(w.summary) + estimateTokens(w.rules);
  res.json(w);
});
api.put('/worlds/:id', (req, res) => {
  const fields = ['name', 'description', 'summary', 'rules', 'instructions', 'source_text', 'source_name'];
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
api.post('/worlds/:id/document', upload.single('file'), wrap(async (req, res) => {
  if (!req.file) throw httpError(400, 'No file uploaded');
  const worldId = id(req.params.id);
  const text = await extractText(req.file);
  if (req.file.originalname.toLowerCase().endsWith('.json')) {
    const entries = parseSillyTavernLorebook(text);
    if (entries) {
      insertEntries(worldId, entries);
      return res.json({ imported: entries.length, kind: 'lorebook' });
    }
  }
  const append = req.query.append === '1';
  const w = db.prepare('SELECT source_text, source_name FROM worlds WHERE id = ?').get(worldId);
  const source = append && w.source_text ? `${w.source_text}\n\n${text}` : text;
  const name = append && w.source_name ? `${w.source_name}, ${req.file.originalname}` : req.file.originalname;
  db.prepare('UPDATE worlds SET source_text = ?, source_name = ? WHERE id = ?').run(source, name, worldId);
  res.json({ kind: 'document', chars: source.length, tokens: estimateTokens(source) });
}));

api.get('/worlds/:id/compile/estimate', wrap(async (req, res) => {
  const w = db.prepare('SELECT * FROM worlds WHERE id = ?').get(id(req.params.id));
  if (!w) throw httpError(404, 'World not found');
  res.json(await estimateCompile(w));
}));
api.post('/worlds/:id/compile', (req, res) => {
  res.json(startCompile(id(req.params.id), { mode: req.body.mode, replace: req.body.replace !== false }));
});
api.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) throw httpError(404, 'Job not found');
  res.json(job);
});
api.post('/worlds/:id/summarize', wrap(async (req, res) => res.json({ summary: await summarizeWorld(id(req.params.id)) })));

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
  db.prepare('UPDATE lore_entries SET title = ?, keys = ?, content = ?, category = ?, constant = ?, priority = ?, enabled = ?, tokens = ? WHERE id = ?').run(
    e.title, JSON.stringify(keys), e.content || '', e.category || '', e.constant ? 1 : 0, Number(e.priority) || 0, e.enabled ? 1 : 0, estimateTokens(e.content), id(req.params.id)
  );
  res.json({ ok: true });
});
api.delete('/lore/:id', (req, res) => {
  db.prepare('DELETE FROM lore_entries WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
/** Preview which entries a piece of text would trigger, and how many tokens that costs. */
api.post('/worlds/:id/lore/test', (req, res) => {
  const r = activateLore(id(req.params.id), req.body.text || '');
  res.json({ tokens: r.tokens, entries: r.entries.map((e) => ({ id: e.id, title: e.title, tokens: e.tokens, constant: !!e.constant })) });
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

// ---------------------------------------------------------------- characters
api.get('/worlds/:id/characters', (req, res) => {
  res.json(db.prepare("SELECT * FROM characters WHERE world_id = ? ORDER BY kind = 'player' DESC, kind = 'custom' DESC, name").all(id(req.params.id)));
});
api.post('/worlds/:id/characters', (req, res) => {
  if (!req.body.name?.trim()) throw httpError(400, 'Name is required');
  res.json(insertCharacter(id(req.params.id), req.body));
});
api.post('/worlds/:id/characters/generate', wrap(async (req, res) => res.json(await generateCharacters(id(req.params.id), req.body))));
api.post('/worlds/:id/characters/draft', wrap(async (req, res) => res.json(await draftCharacter(id(req.params.id), req.body))));
api.put('/characters/:id', (req, res) => {
  for (const f of ['kind', 'name', 'handle', 'bio', 'persona', 'style', 'color', 'active']) {
    if (f in req.body) db.prepare(`UPDATE characters SET ${f} = ? WHERE id = ?`).run(f === 'active' ? (req.body[f] ? 1 : 0) : String(req.body[f]), id(req.params.id));
  }
  res.json({ ok: true });
});
api.delete('/characters/:id', (req, res) => {
  db.prepare('DELETE FROM characters WHERE id = ?').run(id(req.params.id));
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
  const post = db.prepare(`${postSelect} WHERE p.id = ?`).get(id(req.params.id));
  if (!post) throw httpError(404, 'Post not found');
  const replies = db.prepare(`${postSelect} WHERE p.parent_id = ? ORDER BY p.id`).all(post.id);
  res.json({ post, replies });
});
api.post('/worlds/:id/posts', (req, res) => {
  const { characterId, content, parentId = null } = req.body;
  if (!content?.trim() || !characterId) throw httpError(400, 'Pick who is posting and write something.');
  const r = db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content) VALUES (?, ?, ?, ?)').run(id(req.params.id), characterId, parentId, content.trim());
  res.json({ id: Number(r.lastInsertRowid) });
});
api.post('/posts/:id/like', (req, res) => {
  db.prepare('UPDATE posts SET likes = likes + 1 WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.delete('/posts/:id', (req, res) => {
  db.prepare('DELETE FROM posts WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/worlds/:id/feed/generate', wrap(async (req, res) => res.json({ created: (await generateFeed(id(req.params.id), req.body)).map(Number) })));
api.post('/posts/:id/replies/generate', wrap(async (req, res) => res.json({ created: (await generateReplies(id(req.params.id), req.body)).map(Number) })));

// ---------------------------------------------------------------- conversations
api.get('/worlds/:id/conversations', (req, res) => {
  const convs = db
    .prepare(
      `SELECT v.*, (SELECT content FROM messages m WHERE m.conversation_id = v.id ORDER BY m.id DESC LIMIT 1) AS lastMessage
       FROM conversations v WHERE v.world_id = ? ORDER BY (SELECT MAX(id) FROM messages m WHERE m.conversation_id = v.id) DESC, v.id DESC`
    )
    .all(id(req.params.id));
  res.json(convs.map((c) => ({ ...c, members: conversationMembers(c.id) })));
});
api.post('/worlds/:id/conversations', (req, res) => {
  const { memberIds = [], playerId = null, title = '' } = req.body;
  if (!memberIds.length) throw httpError(400, 'Pick at least one character to talk to.');
  const r = db.prepare('INSERT INTO conversations (world_id, player_id, title) VALUES (?, ?, ?)').run(id(req.params.id), playerId, title);
  const ins = db.prepare('INSERT OR IGNORE INTO conversation_members (conversation_id, character_id) VALUES (?, ?)');
  for (const m of memberIds) ins.run(r.lastInsertRowid, m);
  res.json({ id: Number(r.lastInsertRowid) });
});
api.get('/conversations/:id', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id(req.params.id));
  if (!conv) throw httpError(404, 'Conversation not found');
  const messages = db
    .prepare('SELECT m.*, c.name, c.handle, c.color FROM messages m LEFT JOIN characters c ON c.id = m.character_id WHERE m.conversation_id = ? ORDER BY m.id')
    .all(conv.id);
  res.json({ ...conv, members: conversationMembers(conv.id), messages });
});
api.put('/conversations/:id', (req, res) => {
  if ('playerId' in req.body) db.prepare('UPDATE conversations SET player_id = ? WHERE id = ?').run(req.body.playerId || null, id(req.params.id));
  if ('title' in req.body) db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(req.body.title, id(req.params.id));
  if ('summary' in req.body) db.prepare('UPDATE conversations SET summary = ? WHERE id = ?').run(req.body.summary, id(req.params.id));
  res.json({ ok: true });
});
api.delete('/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.post('/conversations/:id/messages', (req, res) => {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id(req.params.id));
  if (!conv) throw httpError(404, 'Conversation not found');
  if (!req.body.content?.trim()) throw httpError(400, 'Message is empty');
  const r = db.prepare('INSERT INTO messages (conversation_id, character_id, is_player, content) VALUES (?, ?, 1, ?)').run(conv.id, conv.player_id, req.body.content.trim());
  res.json({ id: Number(r.lastInsertRowid) });
});
api.delete('/messages/:id', (req, res) => {
  db.prepare('DELETE FROM messages WHERE id = ?').run(id(req.params.id));
  res.json({ ok: true });
});
api.get('/conversations/:id/next', (req, res) => res.json(pickResponder(id(req.params.id))));

/** Streams the next character reply as Server-Sent Events. */
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
