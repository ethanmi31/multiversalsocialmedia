import { db, tx } from './db.js';
import { httpError } from './openrouter.js';

// Export a whole universe to one JSON file, and import it back as a new universe.
// Rows are copied as they are; on import every id is re-numbered and every reference re-pointed,
// so an imported copy never collides with (or overwrites) anything already in the database.

const FORMAT = 'multiversal-universe';
const VERSION = 1;

/**
 * Tables in dependency order. `refs` maps a column to the table its ids point at; `optional` refs may be
 * dropped (set to null) if their target is missing, any other missing ref skips the row. `json` columns
 * hold JSON arrays of ids. Child tables without world_id are selected through their parent.
 */
const TABLES = [
  { name: 'characters', refs: {} },
  { name: 'lore_entries', refs: {} },
  { name: 'communities', refs: { creator_id: 'characters' }, optional: ['creator_id'] },
  { name: 'posts', refs: { character_id: 'characters', parent_id: 'posts', community_id: 'communities' }, optional: ['community_id'] },
  { name: 'post_likes', via: 'SELECT l.* FROM post_likes l JOIN posts p ON p.id = l.post_id WHERE p.world_id = ?', refs: { post_id: 'posts', character_id: 'characters' } },
  { name: 'community_members', via: 'SELECT m.* FROM community_members m JOIN communities c ON c.id = m.community_id WHERE c.world_id = ?', refs: { community_id: 'communities', character_id: 'characters' } },
  { name: 'follows', refs: { follower_id: 'characters', followee_id: 'characters' } },
  { name: 'conversations', refs: { player_id: 'characters' }, optional: ['player_id'] },
  { name: 'conversation_members', via: 'SELECT m.* FROM conversation_members m JOIN conversations v ON v.id = m.conversation_id WHERE v.world_id = ?', refs: { conversation_id: 'conversations', character_id: 'characters' } },
  { name: 'messages', via: 'SELECT m.* FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.world_id = ?', refs: { conversation_id: 'conversations', character_id: 'characters' }, optional: ['character_id'] },
  { name: 'storylines', refs: {}, json: { involved: 'characters' } },
  { name: 'relationships', refs: { from_id: 'characters', to_id: 'characters' } },
  { name: 'memories', refs: { character_id: 'characters' } },
  { name: 'notifications', refs: { persona_id: 'characters', actor_id: 'characters', post_id: 'posts', conversation_id: 'conversations' }, optional: ['persona_id', 'actor_id', 'post_id', 'conversation_id'] },
  { name: 'director_notes', refs: {} },
  { name: 'director_messages', refs: {} }
];

export function exportUniverse(worldId) {
  const world = db.prepare('SELECT * FROM worlds WHERE id = ?').get(worldId);
  if (!world) throw httpError(404, 'World not found');
  const tables = {};
  for (const t of TABLES) {
    tables[t.name] = db.prepare(t.via || `SELECT * FROM ${t.name} WHERE world_id = ? ORDER BY ${t.name === 'relationships' || t.name === 'follows' ? 'rowid' : 'id'}`).all(worldId);
  }
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), world, tables };
}

const columnsOf = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

export function importUniverse(data) {
  if (data?.format !== FORMAT || !data.world || !data.tables) throw httpError(400, "That file isn't a Multiversal universe backup.");
  const maps = Object.fromEntries(TABLES.map((t) => [t.name, new Map()]));

  return tx(() => {
    const worldCols = columnsOf('worlds').filter((c) => c !== 'id' && c in data.world);
    const w = { ...data.world, name: `${data.world.name} (imported)` };
    const newWorldId = Number(
      db.prepare(`INSERT INTO worlds (${worldCols.join(', ')}) VALUES (${worldCols.map(() => '?').join(', ')})`).run(...worldCols.map((c) => w[c] ?? null)).lastInsertRowid
    );

    for (const t of TABLES) {
      const rows = data.tables[t.name] || [];
      const cols = columnsOf(t.name);
      const hasId = cols.includes('id');
      // posts reference other posts (replies -> their thread), so insert parents first
      const ordered = t.name === 'posts' ? [...rows].sort((a, b) => a.id - b.id) : rows;
      for (const row of ordered) {
        const values = {};
        let skip = false;
        for (const c of cols) {
          if (c === 'id' || !(c in row)) continue;
          let v = row[c];
          if (c === 'world_id') v = newWorldId;
          else if (t.refs[c] && v != null) {
            v = maps[t.refs[c]].get(v);
            // a reference to something that wasn't exported: drop optional links, skip rows that need them
            if (v == null && !t.optional?.includes(c)) skip = true;
          } else if (t.json?.[c]) {
            v = JSON.stringify((JSON.parse(v || '[]') || []).map((x) => maps[t.json[c]].get(x)).filter(Boolean));
          }
          values[c] = v ?? null;
        }
        if (skip) continue;
        const keys = Object.keys(values);
        const r = db.prepare(`INSERT OR IGNORE INTO ${t.name} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => values[k]));
        if (hasId && r.changes) maps[t.name].set(row.id, Number(r.lastInsertRowid));
      }
    }

    // links that point "forward" in the order above
    const loreIds = maps.lore_entries;
    for (const [oldId, newId] of maps.characters) {
      const c = data.tables.characters.find((x) => x.id === oldId);
      if (c?.lore_entry_id) db.prepare('UPDATE characters SET lore_entry_id = ? WHERE id = ?').run(loreIds.get(c.lore_entry_id) ?? null, newId);
    }
    for (const v of data.tables.conversations || []) {
      const newId = maps.conversations.get(v.id);
      if (!newId) continue;
      const msg = (mid) => (mid ? maps.messages.get(mid) ?? 0 : 0);
      // summary/continuity markers point at message ids; keep the nearest imported one
      const nearest = (mid) => {
        if (!mid) return 0;
        const prior = (data.tables.messages || []).filter((m) => m.conversation_id === v.id && m.id <= mid).map((m) => msg(m.id)).filter(Boolean);
        return prior.length ? Math.max(...prior) : 0;
      };
      db.prepare('UPDATE conversations SET summarized_upto = ?, observed_upto = ? WHERE id = ?').run(nearest(v.summarized_upto), nearest(v.observed_upto), newId);
    }
    return db.prepare('SELECT * FROM worlds WHERE id = ?').get(newWorldId);
  });
}
