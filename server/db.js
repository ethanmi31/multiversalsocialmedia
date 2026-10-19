import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(dataDir, 'multiverse.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS worlds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  summary TEXT DEFAULT '',          -- short always-on overview (kept small to save tokens)
  rules TEXT DEFAULT '',            -- always-on roleplay / tone instructions
  instructions TEXT DEFAULT '',     -- how the AI should structure the source document into lore
  source_text TEXT DEFAULT '',      -- the full uploaded document (never sent to the model wholesale)
  source_name TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lore_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  keys TEXT DEFAULT '[]',           -- JSON array of trigger keywords
  content TEXT DEFAULT '',
  category TEXT DEFAULT '',
  constant INTEGER DEFAULT 0,       -- always injected, regardless of keywords
  priority INTEGER DEFAULT 50,      -- higher wins when the token budget is tight
  enabled INTEGER DEFAULT 1,
  tokens INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS characters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'custom', -- 'player' (you play them), 'custom' (you made, AI plays), 'generated' (AI made)
  name TEXT NOT NULL,
  handle TEXT DEFAULT '',
  bio TEXT DEFAULT '',
  persona TEXT DEFAULT '',          -- personality, background, goals
  style TEXT DEFAULT '',            -- how they write / talk
  color TEXT DEFAULT '',
  active INTEGER DEFAULT 1,         -- whether they are "on" the world right now
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  character_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  likes INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  player_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  title TEXT DEFAULT '',
  summary TEXT DEFAULT '',          -- rolling summary of older messages
  summarized_upto INTEGER DEFAULT 0,-- last message id folded into the summary
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, character_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  character_id INTEGER REFERENCES characters(id) ON DELETE SET NULL,
  is_player INTEGER DEFAULT 0,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT,
  model TEXT,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cached_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lore_world ON lore_entries(world_id);
CREATE INDEX IF NOT EXISTS idx_chars_world ON characters(world_id);
CREATE INDEX IF NOT EXISTS idx_posts_world ON posts(world_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
`);

export const DEFAULT_SETTINGS = {
  apiKey: '',
  chatModel: 'deepseek/deepseek-chat',
  utilityModel: 'google/gemini-2.5-flash-lite',
  loreBudget: 1200,        // max tokens of lore injected per request
  scanDepth: 4,            // how many recent messages are scanned for lore keywords
  recentMessages: 12,      // messages sent verbatim; older ones get summarized
  maxReplyTokens: 400,
  temperature: 0.9,
  compileChunkTokens: 3000 // size of document chunks sent to the compiler
};

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    try { s[key] = JSON.parse(value); } catch { s[key] = value; }
  }
  if (!s.apiKey && process.env.OPENROUTER_API_KEY) s.apiKey = process.env.OPENROUTER_API_KEY;
  return s;
}

export function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    stmt.run(k, JSON.stringify(v));
  }
}

export const estimateTokens = (text = '') => Math.ceil(String(text).length / 4);

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
