import { db, getSettings, tx } from './db.js';
import { completeJSON, httpError } from './openrouter.js';
import { getWorld, worldPreamble, knownNames, clip, escapeRe } from './engine.js';
import { applyUpdates, resolver, ago } from './worldstate.js';
import { addFromLore } from './canon.js';
import { createCommunity } from './communities.js';

// The Director is the author's out-of-character channel to the engine for ONE universe.
// It answers questions about what the engine is tracking, records standing corrections ("notes")
// that go into every prompt for this universe, and fixes the world state directly.
// Everything it reads or changes is scoped to that universe's world_id.

const join = (parts) => parts.filter(Boolean).join('\n\n');

export function directorState(worldId) {
  return {
    messages: db.prepare('SELECT * FROM director_messages WHERE world_id = ? ORDER BY id').all(worldId)
      .map((m) => ({ ...m, actions: JSON.parse(m.actions || '[]') })),
    notes: db.prepare('SELECT * FROM director_notes WHERE world_id = ? ORDER BY id').all(worldId)
  };
}

function snapshot(worldId, message) {
  const chars = db.prepare('SELECT * FROM characters WHERE world_id = ? ORDER BY kind, name').all(worldId);
  const handle = new Map(chars.map((c) => [c.id, `@${c.handle}`]));
  const notes = db.prepare('SELECT * FROM director_notes WHERE world_id = ? AND active = 1 ORDER BY id').all(worldId);
  const stories = db.prepare(
    "SELECT * FROM storylines WHERE world_id = ? AND (status = 'active' OR updated_at > datetime('now', '-3 days')) ORDER BY status, heat DESC LIMIT 40"
  ).all(worldId);
  const posts = db.prepare(
    'SELECT p.id, p.content, c.handle FROM posts p JOIN characters c ON c.id = p.character_id WHERE p.world_id = ? ORDER BY p.id DESC LIMIT 10'
  ).all(worldId).reverse();
  const scene = db.prepare(
    "SELECT v.setting, (SELECT content FROM messages m WHERE m.conversation_id = v.id ORDER BY m.id DESC LIMIT 1) AS last FROM conversations v WHERE v.world_id = ? AND v.kind = 'scene' ORDER BY v.id DESC LIMIT 1"
  ).get(worldId);

  // memories only for the characters the author is talking about (keeps the prompt small)
  const mentioned = chars.filter((c) =>
    [`@${c.handle}`, c.handle, ...knownNames(c)].some((n) => n && new RegExp(`(^|[^\\w])${escapeRe(n)}\\b`, 'i').test(message))
  ).slice(0, 6);
  const memories = mentioned
    .filter((c) => c.kind !== 'player')
    .map((c) => {
      const rows = db.prepare('SELECT id, content, created_at FROM memories WHERE character_id = ? ORDER BY id DESC LIMIT 20').all(c.id).reverse();
      return rows.length ? `@${c.handle}:\n${rows.map((m) => `  #${m.id} [${ago(m.created_at)}] ${m.content}`).join('\n')}` : '';
    })
    .filter(Boolean);
  const rels = mentioned.length
    ? db.prepare(`SELECT * FROM relationships WHERE world_id = ? AND (from_id IN (${mentioned.map((c) => c.id).join(',')}) OR to_id IN (${mentioned.map((c) => c.id).join(',')}))`).all(worldId)
    : [];

  return join([
    `DIRECTOR NOTES IN EFFECT:\n${notes.length ? notes.map((n) => `#${n.id}: ${n.content}`).join('\n') : '(none)'}`,
    `STORYLINES:\n${stories.length ? stories.map((s) => `#${s.id} "${s.title}" [${s.status}, ${s.visibility}, heat ${s.heat}, updated ${ago(s.updated_at)}] (${JSON.parse(s.involved || '[]').map((i) => handle.get(i)).filter(Boolean).join(', ')}): ${s.summary}`).join('\n') : '(none)'}`,
    `ACCOUNTS (handle — display name / real name — type — on platform?):\n${chars.map((c) => `@${c.handle} — ${c.name}${c.real_name && c.real_name !== c.name ? ` / ${c.real_name}` : ''} — ${c.kind}${c.kind === 'player' ? ' (the author)' : c.active ? '' : ' — INACTIVE'}`).join('\n')}`,
    posts.length && `RECENT POSTS:\n${posts.map((p) => `@${p.handle}: ${clip(p.content, 160)}`).join('\n')}`,
    scene && `LATEST REAL-LIFE SCENE (${scene.setting || 'no setting'}): ${clip(scene.last || '', 300)}`,
    memories.length && `MEMORIES OF THE ACCOUNTS MENTIONED:\n${memories.join('\n')}`,
    rels.length && `THEIR RELATIONSHIPS:\n${rels.map((r) => `${handle.get(r.from_id)} → ${handle.get(r.to_id)}: ${r.status} (${r.score})`).join('\n')}`
  ]);
}

const DIRECTOR_PROMPT = `You are the DIRECTOR of this universe's simulation: the author's out-of-character assistant. You are NOT a character and nothing you say appears on the social network.
The author uses you to fine-tune how the simulation behaves and to fix problems ("stop doing X", "Lira went home already", "drop that storyline", "why does everyone know about Y?").

You can change things with "actions":
- {"type":"add_note","text":string} — a standing rule, added to EVERY prompt for this universe from now on. Use for any lasting correction of behavior. Write it as a clear, specific instruction to the engine.
- {"type":"edit_note","id":number,"text":string} / {"type":"remove_note","id":number}
- {"type":"update_storyline","id":number,"summary"?:string,"heat"?:0-100,"status"?:"active"|"resolved","visibility"?:"public"|"private"}
- {"type":"delete_storyline","id":number}
- {"type":"add_storyline","title":string,"summary":string,"involved":[handles],"visibility":"public"|"private","heat":0-100}
- {"type":"forget","memoryIds":[numbers]} — delete outdated or wrong memories (ids from MEMORIES)
- {"type":"add_memory","handle":string,"memory":string} — e.g. to record where someone is now
- {"type":"set_relationship","from":handle,"to":handle,"status":string,"score":-100..100} / {"type":"remove_relationship","from":handle,"to":handle}
- {"type":"set_active","handle":string,"active":boolean} — take an account off the platform or bring it back
- {"type":"add_community","name":string,"description":string,"members":[handles]} — create a community (group) on the platform
- {"type":"add_characters_from_lore","request":string} — create accounts for characters from this universe's lorebook/stories, e.g. "5 characters from the stories", "all the characters", "the villains". Pass the author's wording.

Guidelines:
- Usually do both: fix the current state AND add a note so it doesn't happen again — unless the author only wants a one-off fix.
- Don't add a note that duplicates or contradicts an existing one; edit or remove the old one instead.
- If something is stuck (a character staying in a place, a storyline dragging on), update or forget the stale memories/storylines and record the new reality.
- Only reference ids and handles that appear in the state below. If the request is ambiguous, ask a short question instead of guessing (with no actions).
- Reply briefly and plainly, out of character: say what you changed. Answer questions about the state honestly.

Return ONLY JSON: {"reply":string,"actions":[...]}`;

export async function directorChat(worldId, message) {
  const world = getWorld(worldId);
  const text = String(message || '').trim();
  if (!text) throw httpError(400, 'Message is empty');
  const history = db.prepare('SELECT role, content FROM director_messages WHERE world_id = ? ORDER BY id DESC LIMIT 16').all(worldId).reverse();

  const out = await completeJSON({
    task: 'director',
    model: getSettings().chatModel,
    expect: 'actions',
    maxTokens: 1500,
    temperature: 0.3,
    messages: [
      { role: 'system', content: `${DIRECTOR_PROMPT}\n\n----- THE UNIVERSE YOU DIRECT -----\n${worldPreamble(world)}` },
      { role: 'system', content: `CURRENT STATE OF "${world.name}":\n${snapshot(worldId, text)}` },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text }
    ]
  });

  const applied = await applyActions(worldId, Array.isArray(out.actions) ? out.actions : []);
  const reply = String(out.reply || (applied.length ? 'Done.' : 'Okay.')).trim();
  tx(() => {
    db.prepare("INSERT INTO director_messages (world_id, role, content) VALUES (?, 'user', ?)").run(worldId, text);
    db.prepare("INSERT INTO director_messages (world_id, role, content, actions) VALUES (?, 'assistant', ?, ?)").run(worldId, reply, JSON.stringify(applied));
  });
  return directorState(worldId);
}

/** Applies the director's actions. Every id and handle is checked against this universe; anything else is ignored. */
async function applyActions(worldId, actions) {
  const find = resolver(worldId);
  const done = [];
  const own = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND world_id = ?`).get(Number(id), worldId);

  for (const a of actions.slice(0, 30)) {
    try {
      switch (a?.type) {
        case 'add_note': {
          if (!a.text?.trim()) break;
          db.prepare('INSERT INTO director_notes (world_id, content) VALUES (?, ?)').run(worldId, String(a.text).trim().slice(0, 600));
          done.push(`Added note: ${a.text}`);
          break;
        }
        case 'edit_note': {
          if (!own('director_notes', a.id) || !a.text?.trim()) break;
          db.prepare('UPDATE director_notes SET content = ? WHERE id = ?').run(String(a.text).trim().slice(0, 600), Number(a.id));
          done.push(`Edited note #${a.id}: ${a.text}`);
          break;
        }
        case 'remove_note': {
          const n = own('director_notes', a.id);
          if (!n) break;
          db.prepare('DELETE FROM director_notes WHERE id = ?').run(n.id);
          done.push(`Removed note: ${n.content}`);
          break;
        }
        case 'update_storyline': {
          const s = own('storylines', a.id);
          if (!s) break;
          const next = {
            summary: a.summary ?? s.summary,
            heat: a.heat != null ? Math.max(0, Math.min(100, Number(a.heat) || 0)) : s.heat,
            status: a.status === 'resolved' || a.status === 'active' ? a.status : s.status,
            visibility: a.visibility === 'private' || a.visibility === 'public' ? a.visibility : s.visibility
          };
          db.prepare('UPDATE storylines SET summary = ?, heat = ?, status = ?, visibility = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
            .run(next.summary, next.heat, next.status, next.visibility, s.id);
          done.push(next.status === 'resolved' && s.status !== 'resolved' ? `Wrapped up storyline "${s.title}"` : `Updated storyline "${s.title}"`);
          break;
        }
        case 'delete_storyline': {
          const s = own('storylines', a.id);
          if (!s) break;
          db.prepare('DELETE FROM storylines WHERE id = ?').run(s.id);
          done.push(`Deleted storyline "${s.title}"`);
          break;
        }
        case 'add_storyline': {
          if (!a.title) break;
          applyUpdates(worldId, { storylines: [{ ...a, status: 'active' }] }, 'director');
          done.push(`Started storyline "${a.title}"`);
          break;
        }
        case 'forget': {
          const ids = (Array.isArray(a.memoryIds) ? a.memoryIds : []).map(Number).filter(Boolean);
          let n = 0;
          for (const mid of ids) n += db.prepare('DELETE FROM memories WHERE id = ? AND world_id = ?').run(mid, worldId).changes;
          if (n) done.push(`Removed ${n} outdated memor${n === 1 ? 'y' : 'ies'}`);
          break;
        }
        case 'add_memory': {
          const c = find(a.handle);
          if (!c || c.kind === 'player' || !a.memory) break;
          db.prepare("INSERT INTO memories (world_id, character_id, content, source) VALUES (?, ?, ?, 'director')").run(worldId, c.id, String(a.memory).slice(0, 400));
          done.push(`@${c.handle} now remembers: ${a.memory}`);
          break;
        }
        case 'set_relationship': {
          const f = find(a.from), t = find(a.to);
          if (!f || !t) break;
          applyUpdates(worldId, { relationships: [a] }, 'director');
          done.push(`@${f.handle} → @${t.handle}: ${a.status} (${a.score})`);
          break;
        }
        case 'remove_relationship': {
          const f = find(a.from), t = find(a.to);
          if (!f || !t) break;
          db.prepare('DELETE FROM relationships WHERE world_id = ? AND from_id = ? AND to_id = ?').run(worldId, f.id, t.id);
          done.push(`Cleared how @${f.handle} feels about @${t.handle}`);
          break;
        }
        case 'add_community': {
          if (!a.name) break;
          const members = (Array.isArray(a.members) ? a.members : []).map(find).filter((c) => c && c.kind !== 'player').map((c) => c.id);
          const k = createCommunity(worldId, { name: a.name, description: a.description || '', memberIds: members });
          done.push(`Created community c/${k.slug} (${members.length} members)`);
          break;
        }
        case 'add_characters_from_lore': {
          const made = await addFromLore(worldId, a.request || 'all');
          done.push(made.length ? `Added ${made.length} character${made.length === 1 ? '' : 's'} from the lorebook: ${made.map((c) => '@' + c.handle).join(', ')}` : 'No new characters from the lorebook to add');
          break;
        }
        case 'set_active': {
          const c = find(a.handle);
          if (!c || c.kind === 'player') break;
          db.prepare('UPDATE characters SET active = ? WHERE id = ?').run(a.active ? 1 : 0, c.id);
          done.push(a.active ? `@${c.handle} is back on the platform` : `@${c.handle} is off the platform`);
          break;
        }
      }
    } catch (e) {
      console.error('director action failed:', a, e.message);
    }
  }
  return done;
}
