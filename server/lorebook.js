import { db, estimateTokens, getSettings, tx } from './db.js';
import { completeJSON, complete, modelPrice, httpError } from './openrouter.js';

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

export async function extractText(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.docx')) {
    const mammoth = (await import('mammoth')).default;
    return (await mammoth.extractRawText({ buffer: file.buffer })).value;
  }
  if (name.endsWith('.pdf')) {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: file.buffer });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy?.();
    }
  }
  return file.buffer.toString('utf8');
}

/**
 * Parses SillyTavern lorebooks into our entry shape. Accepts:
 * - World Info exports: {"entries": {"0": {key, keysecondary, comment, content, constant, order, disable, ...}}}
 * - Character cards with an embedded book: {"data": {"character_book": {"entries": [...]}}} (V2/V3)
 * - Plain arrays of entries
 * Returns null if the JSON is not a lorebook.
 */
export function parseSillyTavernLorebook(text) {
  let json;
  try { json = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  const book = json?.data?.character_book || json?.character_book || json;
  const raw = Array.isArray(book) ? book : book?.entries;
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw) ? raw : Object.values(raw);
  const keyList = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((k) => String(k).trim()).filter(Boolean);
  const entries = list
    .filter((e) => e && typeof e === 'object' && (e.content || e.key || e.keys))
    .map((e) => {
      const keys = [...keyList(e.key ?? e.keys), ...keyList(e.keysecondary ?? e.secondary_keys)];
      return {
        title: String(e.comment || e.name || keys[0] || 'Entry').slice(0, 200),
        keys,
        content: String(e.content || ''),
        category: String(e.group || e.extensions?.group || ''),
        constant: !!e.constant,
        priority: clampPriority(e.order ?? e.insertion_order ?? e.priority ?? 50),
        enabled: e.disable === true || e.enabled === false ? 0 : 1
      };
    })
    .filter((e) => e.content.trim());
  return entries.length || list.length === 0 ? entries : null;
}

/** Character card PNGs carry their JSON (and any embedded lorebook) base64-encoded in a tEXt chunk. */
export function readPngCard(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8;
  while (off + 8 < buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('latin1', off + 4, off + 8);
    if (type === 'tEXt') {
      const data = buffer.subarray(off + 8, off + 8 + len);
      const sep = data.indexOf(0);
      const keyword = data.toString('latin1', 0, sep);
      if (keyword === 'ccv3' || keyword === 'chara') {
        try { return JSON.parse(Buffer.from(data.toString('latin1', sep + 1), 'base64').toString('utf8')); } catch {}
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

/** Imports parsed entries, skipping ones already in this universe (same title and content). */
export function importEntries(worldId, entries) {
  const existing = new Set(
    db.prepare('SELECT title, content FROM lore_entries WHERE world_id = ?').all(worldId).map((e) => `${e.title.toLowerCase()}\u0000${e.content.trim()}`)
  );
  const fresh = entries.filter((e) => !existing.has(`${e.title.toLowerCase()}\u0000${e.content.trim()}`));
  insertEntries(worldId, fresh);
  return { imported: fresh.length, skipped: entries.length - fresh.length };
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function isHeading(line) {
  const t = line.trim();
  if (!t || t.length > 80) return false;
  if (/^#{1,6}\s+/.test(t)) return true;
  if (/^(chapter|part|section|book)\s+[\w.]+/i.test(t)) return true;
  // ALL CAPS lines are a common heading style in pasted docs
  return /^[A-Z][A-Z0-9 '’:,\-]{3,60}$/.test(t);
}

/** Splits a document into titled sections based on headings. */
export function splitSections(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sections = [];
  let current = { title: 'Introduction', body: [] };
  for (const line of lines) {
    if (isHeading(line)) {
      if (current.body.join('').trim()) sections.push(current);
      current = { title: line.replace(/^#+\s*/, '').trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.body.join('').trim()) sections.push(current);
  return sections.map((s) => ({ title: s.title, text: s.body.join('\n').trim() }));
}

/** Splits text into pieces no larger than maxTokens, preferring paragraph boundaries. */
function splitBySize(text, maxTokens) {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n\s*\n/);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if (p.length > maxChars) {
      if (buf) { out.push(buf); buf = ''; }
      for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars));
      continue;
    }
    if ((buf + '\n\n' + p).length > maxChars && buf) {
      out.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Packs sections into chunks of roughly maxTokens for the AI compiler, keeping headings attached. */
export function chunkDocument(text, maxTokens) {
  const chunks = [];
  let buf = '';
  for (const s of splitSections(text)) {
    for (const piece of splitBySize(s.text, maxTokens)) {
      const block = `## ${s.title}\n${piece}`;
      if (buf && estimateTokens(buf + block) > maxTokens) {
        chunks.push(buf);
        buf = block;
      } else {
        buf = buf ? `${buf}\n\n${block}` : block;
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ---------------------------------------------------------------------------
// Free (no-AI) compile: one entry per section, keyed by heading + proper nouns
// ---------------------------------------------------------------------------

const STOP = new Set(
  'the a an and or of to in on at for with from by is are was were be this that these those it its as into over under about after before their there they them his her he she we you i introduction chapter part section book'.split(' ')
);

function properNouns(text, limit) {
  const counts = new Map();
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g)) {
    const w = m[1];
    if (STOP.has(w.toLowerCase())) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

export function quickCompile(text) {
  const entries = [];
  for (const s of splitSections(text)) {
    const pieces = splitBySize(s.text, 450);
    pieces.forEach((piece, i) => {
      const titleWords = s.title.split(/[^\p{L}\p{N}'’-]+/u).filter((w) => w.length > 3 && !STOP.has(w.toLowerCase()));
      const keys = [...new Set([s.title, ...titleWords, ...properNouns(piece, 4)])].slice(0, 8);
      entries.push({
        title: pieces.length > 1 ? `${s.title} (${i + 1}/${pieces.length})` : s.title,
        keys,
        content: piece,
        category: '',
        constant: false,
        priority: 50
      });
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// AI compile: a cheap model restructures each chunk into dense lorebook entries
// ---------------------------------------------------------------------------

const COMPILER_PROMPT = `You are a lorebook compiler for an AI roleplay/social-media engine.
The engine does NOT send the source document to the model. Instead it injects individual lorebook entries
only when one of their trigger keywords appears in the recent conversation. Your job is to convert the
source material into such entries.

Return ONLY a JSON object: {"entries":[{"title":string,"category":string,"keys":string[],"content":string,"priority":number,"constant":boolean}]}

Default rules (the user's instructions below override these):
- One entry per distinct subject (character, place, faction, item, event, concept, rule).
- "content": dense, factual, third person, self-contained (name the subject in the first sentence). Usually 40-150 words. Keep details that matter for roleplay: appearance, personality, relationships, history, abilities, current status. Drop filler prose.
- For characters, also keep 1-3 short VERBATIM example lines of their dialogue from the source (in quotes) that show how they talk — these are used to match their voice.
- "keys": 2-6 specific triggers: names, nicknames, titles, distinctive terms. Never generic words like "the", "city", "war" alone.
- "category": e.g. Character, Location, Faction, Item, Event, Concept, Rule.
- "priority": 0-100. Higher for core subjects.
- "constant": true ONLY for a few core world facts needed in nearly every scene. Almost always false.
- Do not invent facts that are not in the source.`;

function compilerMessages(chunk, index, total, instructions) {
  let system = COMPILER_PROMPT;
  if (instructions?.trim()) system += `\n\nUSER'S STRUCTURING INSTRUCTIONS (follow these first):\n${instructions.trim()}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Source chunk ${index + 1} of ${total}:\n\n${chunk}` }
  ];
}

export async function estimateCompile(world) {
  const s = getSettings();
  const chunks = chunkDocument(world.source_text || '', s.compileChunkTokens);
  const overhead = estimateTokens(COMPILER_PROMPT + (world.instructions || '')) + 30;
  const inputTokens = estimateTokens(world.source_text || '') + chunks.length * overhead;
  const outputTokens = Math.round(estimateTokens(world.source_text || '') * 0.6) + 1500; // + summary
  const price = await modelPrice(s.utilityModel);
  return {
    model: s.utilityModel,
    chunks: chunks.length,
    documentTokens: estimateTokens(world.source_text || ''),
    inputTokens,
    outputTokens,
    estimatedCost: price ? inputTokens * price.prompt + outputTokens * price.completion : null
  };
}

const jobs = new Map();
let jobSeq = 0;

export function getJob(id) {
  return jobs.get(Number(id)) || null;
}

/** Runs the AI compile in the background. Returns a job id that the client polls. */
export function startCompile(worldId, { mode = 'ai', replace = true } = {}) {
  const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId);
  if (!world) throw httpError(404, 'World not found');
  if (!world.source_text?.trim()) throw httpError(400, 'Upload or paste a document first.');

  const job = { id: ++jobSeq, worldId, mode, status: 'running', done: 0, total: 0, added: 0, errors: [] };
  jobs.set(job.id, job);

  (async () => {
    try {
      if (replace) db.prepare('DELETE FROM lore_entries WHERE world_id = ?').run(worldId);

      if (mode === 'quick') {
        const entries = quickCompile(world.source_text);
        job.total = 1;
        insertEntries(worldId, entries);
        job.added = entries.length;
        job.done = 1;
      } else {
        const s = getSettings();
        const chunks = chunkDocument(world.source_text, s.compileChunkTokens);
        job.total = chunks.length + 1; // + summary step
        let next = 0;
        const worker = async () => {
          while (next < chunks.length) {
            const i = next++;
            try {
              const out = await completeJSON({
                task: 'compile',
                messages: compilerMessages(chunks[i], i, chunks.length, world.instructions),
                maxTokens: Math.min(8000, Math.round(s.compileChunkTokens * 1.2) + 500),
                temperature: 0.2
              });
              const entries = Array.isArray(out) ? out : out.entries || [];
              job.added += mergeEntries(worldId, entries);
            } catch (e) {
              job.errors.push(`Chunk ${i + 1}: ${e.message}`);
            }
            job.done++;
          }
        };
        await Promise.all([worker(), worker(), worker()]);
        await summarizeWorld(worldId).catch((e) => job.errors.push(`Summary: ${e.message}`));
        job.done++;
      }
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.errors.push(e.message);
    }
  })();

  return job;
}

function clampPriority(p) {
  const n = Number(p);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 50;
}

function normalizeEntry(e) {
  const keys = (Array.isArray(e.keys) ? e.keys : String(e.keys || '').split(','))
    .map((k) => String(k).trim())
    .filter(Boolean);
  return {
    title: String(e.title || keys[0] || 'Untitled').trim().slice(0, 200),
    keys: [...new Set(keys)],
    content: String(e.content || '').trim(),
    category: String(e.category || '').trim(),
    constant: e.constant ? 1 : 0,
    priority: clampPriority(e.priority),
    enabled: e.enabled === 0 || e.enabled === false ? 0 : 1
  };
}

export function insertEntries(worldId, entries) {
  const stmt = db.prepare(
    'INSERT INTO lore_entries (world_id, title, keys, content, category, constant, priority, enabled, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  tx(() => {
    for (const raw of entries) {
      const e = normalizeEntry(raw);
      if (!e.content) continue;
      stmt.run(worldId, e.title, JSON.stringify(e.keys), e.content, e.category, e.constant, e.priority, e.enabled, estimateTokens(e.content));
    }
  });
}

/** Inserts entries, merging into an existing entry with the same title (chunks often split one subject). */
function mergeEntries(worldId, entries) {
  let added = 0;
  tx(() => {
    for (const raw of entries) {
      const e = normalizeEntry(raw);
      if (!e.content) continue;
      const existing = db
        .prepare('SELECT * FROM lore_entries WHERE world_id = ? AND lower(title) = lower(?)')
        .get(worldId, e.title);
      if (existing) {
        const keys = [...new Set([...JSON.parse(existing.keys || '[]'), ...e.keys])];
        const content = existing.content.includes(e.content) ? existing.content : `${existing.content}\n${e.content}`;
        db.prepare('UPDATE lore_entries SET keys = ?, content = ?, priority = MAX(priority, ?), constant = MAX(constant, ?), tokens = ? WHERE id = ?')
          .run(JSON.stringify(keys), content, e.priority, e.constant, estimateTokens(content), existing.id);
      } else {
        db.prepare(
          'INSERT INTO lore_entries (world_id, title, keys, content, category, constant, priority, enabled, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
        ).run(worldId, e.title, JSON.stringify(e.keys), e.content, e.category, e.constant, e.priority, estimateTokens(e.content));
        added++;
      }
    }
  });
  return added;
}

/** Writes a short always-on overview of the world from its lorebook (not the raw document). */
export async function summarizeWorld(worldId) {
  const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId);
  const entries = db
    .prepare('SELECT title, category, content, priority FROM lore_entries WHERE world_id = ? AND enabled = 1 ORDER BY constant DESC, priority DESC')
    .all(worldId);
  let digest = '';
  for (const e of entries) {
    const line = `- [${e.category || 'Lore'}] ${e.title}: ${e.content.slice(0, 300)}\n`;
    if (estimateTokens(digest + line) > 6000) break;
    digest += line;
  }
  if (!digest) digest = (world.source_text || '').slice(0, 24000);
  if (!digest.trim() && !world.description?.trim()) throw httpError(400, 'Nothing to summarize yet: import lorebook entries (or upload a document) first.');
  const summary = await complete({
    task: 'summary',
    maxTokens: 800,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content:
          'Write a compact overview (max 200 words) of this fictional world for use as always-on context in roleplay: setting, era/tech/magic level, tone, major factions and conflicts. No lists of minor characters. Plain prose.' +
          (world.instructions ? `\nThe author's notes about the material:\n${world.instructions}` : '')
      },
      { role: 'user', content: `World: ${world.name}\n${world.description || ''}\n\nLorebook digest:\n${digest}` }
    ]
  });
  db.prepare('UPDATE worlds SET summary = ? WHERE id = ?').run(summary.trim(), worldId);
  return summary.trim();
}

// ---------------------------------------------------------------------------
// Activation: pick only the entries relevant to the current scene
// ---------------------------------------------------------------------------

const regexCache = new Map();

function keyRegex(key) {
  let re = regexCache.get(key);
  if (!re) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // word boundaries only make sense when the key starts/ends with a word character
    const pre = /^\w/.test(key) ? '\\b' : '';
    const post = /\w$/.test(key) ? '\\b' : '';
    re = new RegExp(`${pre}${escaped}${post}`, 'i');
    if (regexCache.size > 5000) regexCache.clear();
    regexCache.set(key, re);
  }
  return re;
}

/**
 * Scans text for lorebook keywords and returns the entries that fit within the token budget.
 * Constant entries go first, then by priority, then by how many keys matched.
 */
export function activateLore(worldId, scanText, budget = getSettings().loreBudget, { recursive = true, exclude = [], boost = [] } = {}) {
  const all = db.prepare('SELECT * FROM lore_entries WHERE world_id = ? AND enabled = 1').all(worldId);
  const excluded = new Set(exclude.map((t) => t.toLowerCase()));
  const hits = new Map();

  const scan = (text, depth) => {
    for (const e of all) {
      if (hits.has(e.id) || excluded.has(e.title.toLowerCase())) continue;
      if (e.constant && depth === 0) { hits.set(e.id, { e, score: 1000 }); continue; }
      const keys = JSON.parse(e.keys || '[]');
      const matched = keys.filter((k) => k && keyRegex(k).test(text)).length;
      if (matched) hits.set(e.id, { e, score: matched, depth });
    }
  };

  scan(scanText, 0);
  if (recursive) {
    // one level of recursion: entries mentioned inside activated entries (e.g. a character's hometown)
    const firstPass = [...hits.values()].filter((h) => !h.e.constant).map((h) => h.e.content).join('\n');
    if (firstPass) scan(firstPass, 1);
  }

  // boosted entries (e.g. the speaking character's own) are kept first when the budget is tight
  const boostText = boost.join('\n');
  const boosted = (e) => (boostText && JSON.parse(e.keys || '[]').some((k) => k && keyRegex(k).test(boostText)) ? 1 : 0);
  for (const h of hits.values()) h.boost = boosted(h.e);
  const ranked = [...hits.values()].sort(
    (a, b) => b.e.constant - a.e.constant || b.boost - a.boost || (a.depth || 0) - (b.depth || 0) || b.e.priority - a.e.priority || b.score - a.score
  );
  const chosen = [];
  let tokens = 0;
  for (const { e } of ranked) {
    const t = e.tokens || estimateTokens(e.content);
    if (tokens + t > budget) continue;
    chosen.push(e);
    tokens += t;
  }
  return {
    entries: chosen,
    tokens,
    text: chosen.map((e) => `[${e.title}]\n${e.content}`).join('\n\n')
  };
}
