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

-- Social graph: who follows whom (characters and player personas alike)
CREATE TABLE IF NOT EXISTS follows (
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  follower_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  followee_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (follower_id, followee_id)
);

-- Named likes (so "X liked your post" can be shown); posts.likes holds the total
CREATE TABLE IF NOT EXISTS post_likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, character_id)
);

-- Hidden world state: ongoing drama/plots, relationship matrix, per-character memories
CREATE TABLE IF NOT EXISTS storylines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  involved TEXT DEFAULT '[]',       -- JSON array of character ids
  status TEXT DEFAULT 'active',     -- active | resolved
  heat INTEGER DEFAULT 50,          -- how much attention it gets (trending)
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS relationships (
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status TEXT DEFAULT '',           -- e.g. "secretly jealous", "best friends", "blocked"
  score INTEGER DEFAULT 0,          -- -100 (hatred) .. 100 (devotion)
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (from_id, to_id)
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  character_id INTEGER NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  source TEXT DEFAULT '',           -- feed | thread | dm | scene
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  persona_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- reply | mention | follow | like | dm | event
  actor_id INTEGER REFERENCES characters(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  text TEXT DEFAULT '',
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Director: the author's out-of-character channel to the engine, per universe
CREATE TABLE IF NOT EXISTS director_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  role TEXT NOT NULL,               -- user | assistant
  content TEXT NOT NULL,
  actions TEXT DEFAULT '[]',        -- JSON list of what the director changed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS director_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  content TEXT NOT NULL,            -- a standing correction, injected into every prompt for this universe
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_char ON memories(character_id);
CREATE INDEX IF NOT EXISTS idx_story_world ON storylines(world_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_world ON notifications(world_id, read);
`);

// Columns added after the first release; ALTER existing databases in place.
function addColumn(table, column, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}
addColumn('characters', 'followers', 'INTEGER DEFAULT 0');    // baseline audience size (celebs vs. randoms)
addColumn('posts', 'reposts', 'INTEGER DEFAULT 0');
addColumn('conversations', 'kind', "TEXT DEFAULT 'dm'");      // dm | scene (in-person, off the app)
addColumn('conversations', 'setting', "TEXT DEFAULT ''");     // where a scene takes place
addColumn('conversations', 'observed_upto', 'INTEGER DEFAULT 0'); // last message turned into world-state updates
addColumn('conversations', 'unread', 'INTEGER DEFAULT 0');
addColumn('worlds', 'last_tick_at', 'TEXT');
addColumn('worlds', 'npc_instructions', "TEXT DEFAULT ''"); // how random users should be generated
addColumn('storylines', 'visibility', "TEXT DEFAULT 'public'"); // private = only the people involved know
addColumn('characters', 'real_name', "TEXT DEFAULT ''"); // who they really are; `name` is the display name on their profile

export const DEFAULT_SETTINGS = {
  apiKey: '',
  chatModel: 'deepseek/deepseek-chat',
  utilityModel: 'google/gemini-2.5-flash-lite',
  loreBudget: 1200,        // max tokens of lore injected per request
  scanDepth: 4,            // how many recent messages are scanned for lore keywords
  recentMessages: 12,      // messages sent verbatim; older ones get summarized
  maxReplyTokens: 400,
  sceneMaxTokens: 1200,    // real-life scene narration is longer than texting
  temperature: 0.9,
  compileChunkTokens: 3000, // size of document chunks sent to the compiler
  worldStateBudget: 700,   // max tokens of storylines/relationships/memories injected per request
  dmChance: 0.35,          // chance that a world tick lets characters DM you
  viewReplyChance: 0.35,   // chance that opening a thread makes new replies appear
  awayTickMinutes: 30,     // when you open the feed after this long away, the world catches up (0 = off)
  styleGuide: `You are the engine of a living, reactive social media platform set in the user's chosen universe. Maintain flawless continuity with the lore, earlier posts, DMs and real-life scenes.
- Before writing a character, match the tone, vocabulary and personality shown in their lore entries and past dialogue.
- The human controls their own persona(s). NEVER write posts, replies, DMs, actions, thoughts or dialogue for them.
- Multiversal/variant tracking: if the lore contains several variants of a character (from different universes/timelines), keep their locations, memories and relationships separate. A variant does not know another universe's timeline unless it was explicitly leaked or crossed over.
- NPCs have offline lives: they text, fight, scheme, and form group chats behind closed doors. Relationships change independently of the user.
- Introduce platform-wide events now and then (viral drama, cancellations, leaks, algorithm shifts) and show the fallout of earlier drama over time.
- Authentic internet cadence: characters type like real people online today — typos, slang, dry wit, sarcasm, lowercase, emoji where it fits. Avoid standard AI phrasing.
- Mature, unfiltered fiction (PG-13 to R): NPCs can be toxic, dramatic and chaotic. Stay narratively objective; do not moralize or censor dark themes.
- No omniscient summaries: never write "everyone started arguing". Show it with individual posts and replies from different accounts.`
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
