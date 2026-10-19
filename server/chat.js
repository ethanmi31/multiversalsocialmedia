import { db, estimateTokens, getSettings } from './db.js';
import { activateLore } from './lorebook.js';
import { complete, completeJSON, stream, httpError } from './openrouter.js';
import { characterCard, clip, escapeRe, getWorld, worldPreamble, personaBlock, realName, knownNames } from './engine.js';
import { applyUpdates, notify, notifyForPost, publicHistory, recentPostsBy, resolver, worldContext, UPDATES_SCHEMA, UPDATES_RULES } from './worldstate.js';

const join = (parts) => parts.filter(Boolean).join('\n\n');

export function conversationMembers(convId) {
  return db
    .prepare('SELECT c.* FROM conversation_members m JOIN characters c ON c.id = m.character_id WHERE m.conversation_id = ?')
    .all(convId);
}

function getConv(convId) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(convId);
  if (!conv) throw httpError(404, 'Conversation not found');
  return conv;
}

/** Finds the 1:1 DM between a persona and a character, creating it if needed. */
export function findOrCreateDm(worldId, persona, character) {
  const existing = db
    .prepare(
      `SELECT v.id FROM conversations v WHERE v.world_id = ? AND v.kind = 'dm' AND v.player_id = ?
       AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = v.id) = 1
       AND EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id = v.id AND m.character_id = ?)`
    )
    .get(worldId, persona.id, character.id);
  if (existing) return existing.id;
  const id = Number(db.prepare("INSERT INTO conversations (world_id, player_id, kind) VALUES (?, ?, 'dm')").run(worldId, persona.id).lastInsertRowid);
  db.prepare('INSERT INTO conversation_members (conversation_id, character_id) VALUES (?, ?)').run(id, character.id);
  return id;
}

/** A character slides into the human's DMs on their own. */
export function deliverDm(worldId, from, persona, content) {
  const convId = findOrCreateDm(worldId, persona, from);
  for (const part of splitBubbles(content)) {
    db.prepare('INSERT INTO messages (conversation_id, character_id, is_player, content) VALUES (?, ?, 0, ?)').run(convId, from.id, part);
  }
  db.prepare('UPDATE conversations SET unread = unread + 1 WHERE id = ?').run(convId);
  notify(worldId, { type: 'dm', personaId: persona.id, actorId: from.id, conversationId: convId, text: clip(content, 80) });
  return convId;
}

/** Real texting: a reply can be several short messages. */
function splitBubbles(text) {
  const parts = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1 || parts.length > 5 || parts.some((p) => p.length > 600)) return [text.trim()];
  return parts;
}

/** Picks who should talk next: someone named in the last message, otherwise whoever has been quiet longest. */
export function pickResponder(convId) {
  const members = conversationMembers(convId).filter((m) => m.kind !== 'player');
  if (!members.length) throw httpError(400, 'This conversation has no AI characters.');
  if (members.length === 1) return members[0];
  const last = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1').get(convId);
  if (last) {
    const named = members.find(
      (m) => m.id !== last.character_id && (knownNames(m).some((n) => new RegExp(`\\b${escapeRe(n.split(' ')[0])}\\b`, 'i').test(last.content)) || last.content.includes('@' + m.handle))
    );
    if (named) return named;
  }
  const lastSpoke = (m) => db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ? AND character_id = ?').get(convId, m.id)?.id || 0;
  return members.filter((m) => !last || m.id !== last.character_id).sort((a, b) => lastSpoke(a) - lastSpoke(b))[0] || members[0];
}

function history(conv, limit) {
  return db
    .prepare(
      `SELECT m.*, c.name FROM messages m LEFT JOIN characters c ON c.id = m.character_id
       WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT ?`
    )
    .all(conv.id, conv.summarized_upto, limit)
    .reverse();
}

const speakerName = (m) => m.name || (m.is_player ? 'User' : 'Narrator');

/** What a character knows going into a DM: shared public history, the human's recent posts, world state. */
function memoryBlock(worldId, speaker, player, others) {
  const parts = [];
  const state = worldContext(worldId, { focus: [speaker], others: [player, ...others].filter(Boolean) });
  if (state) parts.push(state);
  if (player) {
    const shared = publicHistory(worldId, speaker, player);
    if (shared.length) parts.push(`PUBLIC INTERACTIONS BETWEEN YOU AND @${player.handle}:\n${shared.map((p) => `- @${p.handle}: ${clip(p.content, 200)}`).join('\n')}`);
    const theirs = recentPostsBy(player.id, 4);
    if (theirs.length) parts.push(`@${player.handle}'S RECENT PUBLIC POSTS (you may have seen these):\n${theirs.map((p) => `- ${clip(p.content, 200)}`).join('\n')}`);
  }
  const mine = recentPostsBy(speaker.id, 3);
  if (mine.length) parts.push(`YOUR OWN RECENT POSTS:\n${mine.map((p) => `- ${clip(p.content, 160)}`).join('\n')}`);
  return parts.join('\n\n');
}

function toMessages(stable, dynamic, hist, isAssistant, label) {
  const messages = [{ role: 'system', content: stable }];
  if (dynamic) messages.push({ role: 'system', content: dynamic });
  for (const m of hist) {
    const role = isAssistant(m) ? 'assistant' : 'user';
    const content = role === 'assistant' ? m.content : label(m);
    const prev = messages[messages.length - 1];
    if (prev.role === role && role === 'user') prev.content += `\n${content}`;
    else messages.push({ role, content });
  }
  return messages;
}

function buildDmPrompt(conv, speaker) {
  const s = getSettings();
  const world = getWorld(conv.world_id);
  const members = conversationMembers(conv.id);
  const player = conv.player_id ? db.prepare('SELECT * FROM characters WHERE id = ?').get(conv.player_id) : null;
  const others = members.filter((m) => m.id !== speaker.id);
  const hist = history(conv, s.recentMessages);
  const lore = activateLore(conv.world_id, [...hist.slice(-s.scanDepth).map((m) => m.content), ...knownNames(speaker), ...others.flatMap(knownNames)].join('\n'), undefined, { boost: knownNames(speaker) });

  const stable = join([
    worldPreamble(world),
    `You are ${realName(speaker)}${realName(speaker) !== speaker.name ? `, online as "${speaker.name}" (@${speaker.handle})` : ''}. Stay in character at all times.`,
    `YOUR CHARACTER:\n${characterCard(speaker)}`,
    player && personaBlock([player]),
    others.length && `ALSO IN THIS CHAT:\n${others.map((o) => characterCard(o, { brief: true })).join('\n\n')}`,
    `This is a ${others.length ? 'group chat' : 'private DM'} on the universe's social network. Rapid-fire texting: write only ${speaker.name}'s next message(s) — you may send 1-3 short texts separated by a blank line. No name prefix. Never write anyone else's messages. You remember everything in your memories and public history below; bring it up when it fits.`
  ]);
  const dynamic = join([
    lore.text && `RELEVANT LORE:\n${lore.text}`,
    memoryBlock(conv.world_id, speaker, player, others),
    conv.summary && `EARLIER IN THIS CONVERSATION:\n${conv.summary}`
  ]);
  const messages = toMessages(stable, dynamic, hist, (m) => m.character_id === speaker.id, (m) => `${speakerName(m)}: ${m.content}`);
  if (messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: `(Continue the conversation as ${speaker.name}.)` });
  return { messages, lore };
}

/**
 * People who aren't in the scene/DM but would care about it: characters it mentions, and whoever the
 * human has been talking to lately (e.g. the person who asked them to do something).
 */
function interestedParties(conv, text, exclude) {
  const skip = new Set(exclude.map((c) => c.id));
  const pool = db.prepare("SELECT * FROM characters WHERE world_id = ? AND kind != 'player'").all(conv.world_id).filter((c) => !skip.has(c.id));
  const mentioned = pool.filter((c) =>
    [`@${c.handle}`, ...knownNames(c), ...knownNames(c).map((n) => n.split(/\s+/)[0]).filter((n) => n.length >= 3)].some((n) =>
      new RegExp(`(^|[^\\w@])${escapeRe(n)}\\b`, 'i').test(text) || (n.startsWith('@') && text.toLowerCase().includes(n.toLowerCase()))
    )
  );
  const recentContacts = conv.player_id
    ? db
        .prepare(
          `SELECT DISTINCT m.character_id AS id FROM conversation_members m JOIN conversations v ON v.id = m.conversation_id
           WHERE v.world_id = ? AND v.player_id = ? AND v.id != ? ORDER BY (SELECT MAX(id) FROM messages x WHERE x.conversation_id = v.id) DESC LIMIT 4`
        )
        .all(conv.world_id, conv.player_id, conv.id)
        .map((r) => pool.find((c) => c.id === r.id))
        .filter(Boolean)
    : [];
  return [...new Set([...mentioned, ...recentContacts])].slice(0, 6);
}

/** In-person scene off the app: one narrator voices every NPC present (or just the world, if the human is alone). */
function buildScenePrompt(conv) {
  const s = getSettings();
  const world = getWorld(conv.world_id);
  const npcs = conversationMembers(conv.id).filter((m) => m.kind !== 'player');
  const player = conv.player_id ? db.prepare('SELECT * FROM characters WHERE id = ?').get(conv.player_id) : null;
  const hist = history(conv, s.recentMessages);
  const lore = activateLore(conv.world_id, [conv.setting, ...hist.slice(-s.scanDepth).map((m) => m.content), ...npcs.flatMap(knownNames)].join('\n'), undefined, { boost: npcs.flatMap(knownNames) });
  const you = player ? player.name : 'the user\'s character';
  const others = interestedParties(conv, [conv.setting, ...hist.map((m) => m.content)].join('\n'), npcs);

  const stable = join([
    worldPreamble(world),
    `This is a REAL-LIFE, in-person scene — not on the social network.${conv.setting ? ` Setting: ${conv.setting}` : ''}`,
    npcs.length
      ? `CHARACTERS PRESENT (you play all of them):\n${npcs.map((n) => characterCard(n)).join('\n\n')}`
      : `${you} is on their own. Narrate the surroundings, events and any strangers or background people they meet. Characters they know only appear if it makes sense (${you} goes to them, calls them, or runs into them).`,
    player && personaBlock([player]),
    others.length && `PEOPLE IN ${you.toUpperCase()}'S LIFE (not present unless the story brings them in):\n${others.map((o) => characterCard(o, { brief: true })).join('\n\n')}`,
    `The user writes what ${you} does and says (actions may be in *asterisks* or plain prose). You narrate how the world${npcs.length ? ' and the characters present' : ''} react: actions, body language and dialogue, in vivid but tight prose (1-3 paragraphs), in present tense. People react truthfully to who they are, their relationships and memories — they can get angry, fight back, cry, call someone, or leave.
Things can go wrong or have complications; don't just let everything succeed.
NEVER write ${you}'s actions, dialogue, thoughts or feelings beyond what the user wrote. Stop at a point where ${you} can respond. What happens here is real and will have consequences online later.`
  ]);
  const dynamic = join([
    lore.text && `RELEVANT LORE:\n${lore.text}`,
    worldContext(conv.world_id, { focus: npcs, others: player ? [player] : [] }),
    conv.summary && `EARLIER IN THIS SCENE:\n${conv.summary}`
  ]);
  const messages = toMessages(stable, dynamic, hist, (m) => !m.is_player, (m) => (m.is_player ? `${player?.name || 'User'}: ${m.content}` : m.content));
  if (messages[messages.length - 1].role !== 'user') messages.push({ role: 'user', content: '(Continue the scene.)' });
  return { messages, lore, npcs };
}

export async function streamReply(convId, { characterId, onToken, onMeta, signal }) {
  const conv = getConv(convId);
  const scene = conv.kind === 'scene';
  let speaker = null;
  let built;
  if (scene) {
    built = buildScenePrompt(conv);
  } else {
    const members = conversationMembers(convId);
    speaker = characterId ? members.find((m) => m.id === Number(characterId)) : pickResponder(convId);
    if (!speaker || speaker.kind === 'player') throw httpError(400, 'That character is not in this conversation.');
    built = buildDmPrompt(conv, speaker);
  }
  const { messages, lore } = built;
  onMeta?.({
    speaker: speaker ? { id: speaker.id, name: speaker.name, handle: speaker.handle, color: speaker.color } : null,
    lore: lore.entries.map((e) => e.title),
    promptTokens: estimateTokens(messages.map((m) => m.content).join('\n'))
  });

  const raw = await stream({ task: scene ? 'scene' : 'chat', messages, onToken, signal, maxTokens: scene ? Math.max(getSettings().maxReplyTokens, 600) : undefined });
  const members = conversationMembers(convId);
  const text = scene ? cleanScene(raw, conv) : cleanReply(raw, members, conv.player_id);
  if (!text) throw httpError(502, 'The reply was empty after removing lines written for other people. Try regenerating.');
  const ins = db.prepare('INSERT INTO messages (conversation_id, character_id, is_player, content) VALUES (?, ?, 0, ?)');
  const ids = (scene ? [text] : splitBubbles(text)).map((part) => Number(ins.run(convId, speaker?.id ?? null, part).lastInsertRowid));

  // Background upkeep: fold old messages into memory, and let what happened ripple into the world.
  maybeSummarize(convId).catch((e) => console.error('summary failed:', e.message));
  observeConversation(convId).catch((e) => console.error('observe failed:', e.message));
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(ids[ids.length - 1]);
}

/** Strips a leading "Name:" and cuts the reply where the model starts writing lines for someone else. */
function cleanReply(text, members, playerId) {
  const player = playerId ? db.prepare('SELECT name FROM characters WHERE id = ?').get(playerId) : null;
  const names = [...new Set([...members.flatMap(knownNames), player?.name, 'User', 'You'].filter(Boolean))];
  const alt = names.map(escapeRe).join('|');
  let out = text.replace(new RegExp(`^\\s*\\**(?:${alt})\\**\\s*:\\s*`, 'i'), '');
  const cut = out.search(new RegExp(`\\n\\s*\\**(?:${alt})\\**\\s*:`, 'i'));
  if (cut > 0) out = out.slice(0, cut);
  return out.trim();
}

/** Scenes: drop a "Narrator:" label and anything written as the player's own line. */
function cleanScene(text, conv) {
  const player = conv.player_id ? db.prepare('SELECT name FROM characters WHERE id = ?').get(conv.player_id) : null;
  let out = text.replace(/^\s*\**narrator\**\s*:\s*/i, '');
  if (player) {
    const cut = out.search(new RegExp(`\\n\\s*\\**${escapeRe(player.name)}\\**\\s*:`, 'i'));
    if (cut > 0) out = out.slice(0, cut);
  }
  return out.trim();
}

/** Folds older messages into a rolling summary so the prompt doesn't grow forever. */
async function maybeSummarize(convId) {
  const s = getSettings();
  const conv = getConv(convId);
  const pending = db
    .prepare('SELECT m.*, c.name FROM messages m LEFT JOIN characters c ON c.id = m.character_id WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id')
    .all(convId, conv.summarized_upto);
  if (pending.length < s.recentMessages + 8) return; // batch summaries: fewer, cheaper calls
  const fold = pending.slice(0, pending.length - s.recentMessages);
  const summary = await complete({
    task: 'chat-summary',
    maxTokens: 450,
    temperature: 0.2,
    messages: [
      {
        role: 'system',
        content: 'Update the running summary of a roleplay conversation. Keep important facts, decisions, promises, insults, relationship changes, and emotional beats. Max 250 words, past tense, third person.'
      },
      { role: 'user', content: `CURRENT SUMMARY:\n${conv.summary || '(none)'}\n\nNEW MESSAGES:\n${fold.map((m) => `${speakerName(m)}: ${m.content}`).join('\n')}` }
    ]
  });
  db.prepare('UPDATE conversations SET summary = ?, summarized_upto = ? WHERE id = ?').run(summary.trim(), fold[fold.length - 1].id, convId);
}

const observing = new Set();

/**
 * Turns what happened in a DM or scene into world state: memories, relationship changes, drama,
 * and optionally public fallout posts (venting, vague-posting, leaking screenshots).
 * Runs every few messages, or on demand ("Let it spread").
 */
export async function observeConversation(convId, { force = false } = {}) {
  if (observing.has(convId)) return { posts: 0 };
  const conv = getConv(convId);
  const msgs = db
    .prepare('SELECT m.*, c.name, c.handle FROM messages m LEFT JOIN characters c ON c.id = m.character_id WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id')
    .all(convId, conv.observed_upto);
  if (!msgs.length || (!force && msgs.length < 6)) return { posts: 0 };
  observing.add(convId);
  try {
    const world = getWorld(conv.world_id);
    const present = conversationMembers(convId).filter((m) => m.kind !== 'player');
    const player = conv.player_id ? db.prepare('SELECT * FROM characters WHERE id = ?').get(conv.player_id) : null;
    const others = interestedParties(conv, [conv.setting, ...msgs.map((m) => m.content)].join('\n'), present);
    const npcs = [...present, ...others];
    const where = conv.kind === 'scene'
      ? `an in-person scene${conv.setting ? ` (${conv.setting})` : ''}${present.length ? '' : ` where ${player?.name || 'the human'} was on their own`}`
      : 'a private DM conversation';
    const out = await completeJSON({
      task: 'observe',
      maxTokens: 900,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `${worldPreamble(world)}
You track continuity for this universe. Read what just happened in ${where} and record the consequences.
${UPDATES_RULES}
"posts": 0-2 public posts the NPCs involved would plausibly make about it right now (venting, subtweeting, bragging, leaking screenshots) — only if in character; private people may stay quiet.
Return ONLY JSON: {"posts":[{"handle":string,"content":string}],${UPDATES_SCHEMA}}`
        },
        {
          role: 'user',
          content: join([
            present.length && `NPCs WHO WERE THERE:\n${present.map((n) => characterCard(n, { brief: true })).join('\n\n')}`,
            others.length && `OTHER PEOPLE WHO MIGHT FIND OUT OR CARE (only give them memories or posts if they would realistically know — e.g. they asked for this, were told, saw it, or heard through gossip):\n${others.map((n) => characterCard(n, { brief: true })).join('\n\n')}`,
            player && personaBlock([player]),
            worldContext(conv.world_id, { focus: npcs, others: player ? [player] : [], memoriesPer: 3 }),
            `WHAT HAPPENED:\n${msgs.map((m) => `${m.is_player ? player?.name || 'User' : m.name || 'Narrator'}: ${clip(m.content, 700)}`).join('\n')}`
          ])
        }
      ]
    });
    const find = resolver(conv.world_id);
    const npcIds = new Set(npcs.map((n) => n.id));
    let posts = 0;
    for (const p of (Array.isArray(out.posts) ? out.posts : []).slice(0, 2)) {
      const c = find(p?.handle);
      if (!c || !npcIds.has(c.id) || !p.content) continue;
      const id = Number(db.prepare('INSERT INTO posts (world_id, character_id, content, likes) VALUES (?, ?, ?, ?)').run(conv.world_id, c.id, String(p.content).trim(), Math.floor(Math.random() * 40)).lastInsertRowid);
      notifyForPost(conv.world_id, id);
      posts++;
    }
    applyUpdates(conv.world_id, out.updates, conv.kind === 'scene' ? 'scene' : 'dm');
    db.prepare('UPDATE conversations SET observed_upto = ? WHERE id = ?').run(msgs[msgs.length - 1].id, convId);
    return { posts };
  } finally {
    observing.delete(convId);
  }
}
