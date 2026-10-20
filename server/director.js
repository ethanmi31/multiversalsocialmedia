import { db, getSettings, tx } from './db.js';
import { completeJSON, httpError } from './openrouter.js';
import { getWorld, worldPreamble, knownNames, clip, escapeRe, insertCharacter, uniqueHandle, worldTick } from './engine.js';
import { applyUpdates, resolver, ago, follow, notifyForPost } from './worldstate.js';
import { addFromLore, learnFromLore } from './canon.js';
import { createCommunity, findCommunity, join as joinCommunity, listCommunities } from './communities.js';

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
    `SELECT p.id, p.content, p.parent_id, c.handle, k.slug FROM posts p JOIN characters c ON c.id = p.character_id
     LEFT JOIN communities k ON k.id = p.community_id WHERE p.world_id = ? ORDER BY p.id DESC LIMIT 20`
  ).all(worldId).reverse();
  // posts the author refers to by number ("delete post 12") even if they're older
  const asked = [...message.matchAll(/\bpost\s*#?(\d+)/gi)].map((m) => Number(m[1])).filter((n) => !posts.some((p) => p.id === n));
  const extraPosts = asked.length
    ? db.prepare(`SELECT p.id, p.content, p.parent_id, c.handle FROM posts p JOIN characters c ON c.id = p.character_id WHERE p.world_id = ? AND p.id IN (${asked.slice(0, 10).join(',')})`).all(worldId)
    : [];
  const world = getWorld(worldId);
  const communities = listCommunities(worldId);
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

  const profiles = mentioned.map((c) => `@${c.handle} (${c.kind}${c.active ? '' : ', inactive'}) — display name "${c.name}"${c.real_name ? `, real name ${c.real_name}` : ''}, bio "${clip(c.bio || '', 120)}"
  description: ${clip(c.persona || '(none)', 700)}
  knowledge: ${clip(c.knowledge || '(none)', 500)}`);

  return join([
    `UNIVERSE SETTINGS:\n- summary: ${clip(world.summary || '(none)', 600)}\n- world rules: ${clip(world.rules || '(none)', 800)}\n- random-user instructions: ${clip(world.npc_instructions || '(none)', 400)}`,
    `DIRECTOR NOTES IN EFFECT:\n${notes.length ? notes.map((n) => `#${n.id}: ${n.content}`).join('\n') : '(none)'}`,
    `STORYLINES:\n${stories.length ? stories.map((s) => `#${s.id} "${s.title}" [${s.status}, ${s.visibility}, heat ${s.heat}, updated ${ago(s.updated_at)}] (${JSON.parse(s.involved || '[]').map((i) => handle.get(i)).filter(Boolean).join(', ')}): ${s.summary}`).join('\n') : '(none)'}`,
    `ACCOUNTS (handle — display name / real name — type — on platform?):\n${chars.map((c) => `@${c.handle} — ${c.name}${c.real_name && c.real_name !== c.name ? ` / ${c.real_name}` : ''} — ${c.kind}${c.kind === 'player' ? ' (the author)' : c.active ? '' : ' — INACTIVE'}`).join('\n')}`,
    communities.length && `COMMUNITIES:\n${communities.map((k) => `c/${k.slug} "${k.name}" (${k.members} members): ${clip(k.description, 100)}`).join('\n')}`,
    posts.length && `RECENT POSTS:\n${[...extraPosts, ...posts].map((p) => `[post ${p.id}]${p.parent_id ? ` (reply on post ${p.parent_id})` : ''}${p.slug ? ` in c/${p.slug}` : ''} @${p.handle}: ${clip(p.content, 160)}`).join('\n')}`,
    profiles.length && `PROFILES OF THE ACCOUNTS MENTIONED:\n${profiles.join('\n')}`,
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
- {"type":"learn_from_lore","handles":[handles]} — re-read the lorebook for what these characters know and who they know (empty list = everyone)

Characters:
- {"type":"create_character","name":string (display name),"handle":string,"real_name"?:string,"bio":string,"description":string,"kind"?:"custom"|"generated","followers"?:number}
- {"type":"edit_character","handle":string, any of: "name","new_handle","real_name","bio","description" (replaces),"append_description","knowledge" (replaces),"append_knowledge","followers"}
- {"type":"set_follow","from":handle,"to":handle,"follow":boolean}

Making things happen:
- {"type":"make_post","handle":string,"content":string,"reply_to"?:post number,"community"?:slug} — someone posts or replies right now
- {"type":"send_dm","from":handle,"to"?:handle of one of the author's accounts,"content":string} — someone DMs the author's account
- {"type":"trigger_event","topic":string,"count"?:1-12,"community"?:slug} — time passes with this event happening (several people post/react). Takes a moment and costs a normal "let time pass".
- {"type":"delete_posts","postIds":[post numbers]} — removes posts (and their replies)

Platform and universe:
- {"type":"edit_community","slug":string,"name"?:string,"description"?:string} / {"type":"delete_community","slug":string}
- {"type":"update_world", any of: "summary" (replaces),"rules" (replaces),"append_rules","npc_instructions" (replaces),"append_npc_instructions"} — the universe's always-on context. Prefer appending; only replace when asked.

Guidelines:
- Usually do both: fix the current state AND add a note so it doesn't happen again — unless the author only wants a one-off fix.
- Don't add a note that duplicates or contradicts an existing one; edit or remove the old one instead.
- If something is stuck (a character staying in a place, a storyline dragging on), update or forget the stale memories/storylines and record the new reality.
- Only reference ids and handles that appear in the state below. If the request is ambiguous, ask a short question instead of guessing (with no actions).
- Destructive or large changes (deleting several posts, replacing a description or the world rules, deleting a community) only when the author clearly asked for them; otherwise describe what you would do and ask.
- Never post, DM or act as the author's accounts unless the author explicitly tells you to.
- Reply briefly and plainly, out of character: say what you changed. Answer questions about the state honestly.

Return ONLY JSON: {"reply":string,"actions":[...]}`;

export async function directorChat(worldId, message) {
  const world = getWorld(worldId);
  const text = String(message || '').trim();
  if (!text) throw httpError(400, 'Message is empty');
  const history = db.prepare('SELECT role, content, actions FROM director_messages WHERE world_id = ? ORDER BY id DESC LIMIT 16').all(worldId).reverse()
    // the model needs to know what it already changed ("undo that", "do the same for Lira")
    .map((m) => {
      const acts = JSON.parse(m.actions || '[]');
      return { role: m.role, content: acts.length ? `${m.content}\n[Changes made: ${acts.join('; ')}]` : m.content };
    });

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
  let find = resolver(worldId); // rebuilt after create_character so new accounts can act right away
  const done = [];
  const own = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ? AND world_id = ?`).get(Number(id), worldId);

  for (const a of actions.slice(0, 40)) {
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
        case 'learn_from_lore': {
          const ids = (Array.isArray(a.handles) ? a.handles : []).map(find).filter(Boolean).map((c) => c.id);
          const r = await learnFromLore(worldId, ids);
          done.push(`Re-learned what ${r.learned} character(s) know from the lore`);
          break;
        }
        case 'create_character': {
          if (!a.name?.trim()) break;
          const c = insertCharacter(worldId, { ...a, persona: a.description || '', kind: a.kind === 'generated' ? 'generated' : 'custom' });
          find = resolver(worldId);
          done.push(`Created @${c.handle} (${c.name})`);
          break;
        }
        case 'edit_character': {
          const c = find(a.handle);
          if (!c) break;
          const set = {};
          if (a.name) set.name = String(a.name);
          if (a.new_handle) set.handle = uniqueHandle(worldId, a.new_handle, c.id);
          if (a.real_name != null) set.real_name = String(a.real_name);
          if (a.bio != null) set.bio = String(a.bio);
          if (a.description != null) set.persona = String(a.description);
          if (a.append_description) set.persona = `${set.persona ?? c.persona ?? ''}\n${a.append_description}`.trim();
          if (a.knowledge != null) set.knowledge = String(a.knowledge);
          if (a.append_knowledge) set.knowledge = `${set.knowledge ?? c.knowledge ?? ''}\n${a.append_knowledge}`.trim();
          if (a.followers != null && Number.isFinite(Number(a.followers))) set.followers = Math.max(0, Math.round(Number(a.followers)));
          const keys = Object.keys(set);
          if (!keys.length) break;
          db.prepare(`UPDATE characters SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]), c.id);
          done.push(`Updated @${set.handle || c.handle}: ${keys.map((k) => (k === 'persona' ? 'description' : k)).join(', ')}`);
          break;
        }
        case 'set_follow': {
          const f = find(a.from), t = find(a.to);
          if (!f || !t || f.id === t.id) break;
          if (a.follow === false) db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(f.id, t.id);
          else follow(worldId, f.id, t.id);
          done.push(`@${f.handle} ${a.follow === false ? 'unfollowed' : 'follows'} @${t.handle}`);
          break;
        }
        case 'make_post': {
          const c = find(a.handle);
          if (!c || !a.content?.trim()) break;
          const parent = a.reply_to ? db.prepare('SELECT id, parent_id, community_id FROM posts WHERE id = ? AND world_id = ?').get(Number(a.reply_to), worldId) : null;
          if (a.reply_to && !parent) break;
          const rootId = parent ? parent.parent_id || parent.id : null;
          const community = parent ? db.prepare('SELECT community_id FROM posts WHERE id = ?').get(rootId).community_id : a.community ? findCommunity(worldId, a.community)?.id ?? null : null;
          if (community) joinCommunity(community, c.id);
          const id = Number(db.prepare('INSERT INTO posts (world_id, character_id, parent_id, content, community_id, likes) VALUES (?, ?, ?, ?, ?, ?)')
            .run(worldId, c.id, rootId, String(a.content).trim(), community, rootId ? 0 : Math.floor(Math.random() * 30)).lastInsertRowid);
          notifyForPost(worldId, id);
          done.push(rootId ? `@${c.handle} replied on post ${rootId}` : `@${c.handle} posted (post ${id})`);
          break;
        }
        case 'send_dm': {
          const from = find(a.from);
          const personas = db.prepare("SELECT * FROM characters WHERE world_id = ? AND kind = 'player' ORDER BY id").all(worldId);
          const to = a.to ? personas.find((p) => p.id === find(a.to)?.id) : personas[0];
          if (!from || from.kind === 'player' || !to || !a.content?.trim()) break;
          const { deliverDm } = await import('./chat.js');
          deliverDm(worldId, from, to, String(a.content).trim());
          done.push(`@${from.handle} sent @${to.handle} a DM`);
          break;
        }
        case 'trigger_event': {
          if (!a.topic) break;
          const community = a.community ? findCommunity(worldId, a.community) : null;
          const r = await worldTick(worldId, { topic: String(a.topic), count: Math.max(1, Math.min(12, Number(a.count) || 6)), communityId: community?.id ?? null });
          done.push(`Time passed with "${a.topic}": ${r.created.length} new posts${r.dms ? `, ${r.dms} DM(s)` : ''}`);
          break;
        }
        case 'delete_posts': {
          const ids = (Array.isArray(a.postIds) ? a.postIds : []).map(Number).filter(Boolean);
          let n = 0;
          for (const pid of ids) n += db.prepare('DELETE FROM posts WHERE id = ? AND world_id = ?').run(pid, worldId).changes;
          if (n) done.push(`Deleted ${n} post${n === 1 ? '' : 's'}`);
          break;
        }
        case 'edit_community': {
          const k = findCommunity(worldId, a.slug);
          if (!k) break;
          if (a.name) db.prepare('UPDATE communities SET name = ? WHERE id = ?').run(String(a.name), k.id);
          if (a.description != null) db.prepare('UPDATE communities SET description = ? WHERE id = ?').run(String(a.description), k.id);
          done.push(`Updated community c/${k.slug}`);
          break;
        }
        case 'delete_community': {
          const k = findCommunity(worldId, a.slug);
          if (!k) break;
          db.prepare('DELETE FROM communities WHERE id = ?').run(k.id);
          done.push(`Deleted community c/${k.slug} and its posts`);
          break;
        }
        case 'update_world': {
          const w = getWorld(worldId);
          const changed = [];
          const put = (col, value, label) => { db.prepare(`UPDATE worlds SET ${col} = ? WHERE id = ?`).run(value, worldId); changed.push(label); };
          if (a.summary != null) put('summary', String(a.summary), 'summary');
          if (a.rules != null) put('rules', String(a.rules), 'world rules');
          if (a.append_rules) put('rules', `${a.rules ?? w.rules ?? ''}\n${a.append_rules}`.trim(), 'world rules');
          if (a.npc_instructions != null) put('npc_instructions', String(a.npc_instructions), 'random-user instructions');
          if (a.append_npc_instructions) put('npc_instructions', `${a.npc_instructions ?? w.npc_instructions ?? ''}\n${a.append_npc_instructions}`.trim(), 'random-user instructions');
          if (changed.length) done.push(`Updated the universe's ${[...new Set(changed)].join(' and ')}`);
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
