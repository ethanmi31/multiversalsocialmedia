import { db, tx, estimateTokens } from './db.js';
import { applyUpdates } from './worldstate.js';
import { completeJSON, httpError } from './openrouter.js';
import { getWorld, insertCharacter, makeHandle, npcRules, ACCOUNT_FIELDS, clip, knownNames } from './engine.js';

// Adds characters from this universe's lorebook as accounts ("add 5 characters from the stories").
// 1. Skim: classify which entries describe a character, from titles + a short snippet only (cached per entry).
// 2. Pick: choose the ones matching the author's request.
// 3. Create: write display names / handles / bios; the entry itself becomes the description, verbatim.

const CHARACTER_CATEGORY = /\b(characters?|people|persons?|npcs?|cast|individuals?)\b/i;
const OTHER_CATEGORY = /\b(locations?|places?|items?|objects?|factions?|organi[sz]ations?|groups?|events?|history|timeline|rules?|concepts?|lore|magic|systems?|species|races?|world)\b/i;

/** Classifies every not-yet-skimmed entry of this universe. Returns how many entries needed the AI. */
async function skim(worldId, job = {}) {
  const pending = db.prepare('SELECT id, title, category, content FROM lore_entries WHERE world_id = ? AND is_character IS NULL').all(worldId);
  const mark = db.prepare('UPDATE lore_entries SET is_character = ?, character_name = ? WHERE id = ?');

  // free pass: the category already says what it is
  const unknown = [];
  tx(() => {
    for (const e of pending) {
      if (CHARACTER_CATEGORY.test(e.category)) mark.run(1, e.title, e.id);
      else if (e.category && OTHER_CATEGORY.test(e.category)) mark.run(0, '', e.id);
      else unknown.push(e);
    }
  });
  if (!unknown.length) return 0;

  // small batches answer fast and fail cheaply; a failed batch stays unskimmed and is retried next time
  const batches = [];
  for (let i = 0; i < unknown.length; i += 50) batches.push(unknown.slice(i, i + 50));
  Object.assign(job, { phase: 'skimming', done: 0, total: batches.length });
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const index = next++;
      const batch = batches[index];
      try {
        const out = await completeJSON({
          task: 'skim-characters',
          expect: 'characters',
          maxTokens: 40 * batch.length + 300,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content: `You skim lorebook entries. Decide which entries are mainly about ONE specific individual character (a person or being who could have a social-media account), as opposed to places, groups, items, events, species or concepts.
For each character entry, give its id and the character's name as the lore names them. Many characters exist as several variants across universes with the same base name: ALWAYS include the variant/universe label when the entry (or its title/group) shows one, e.g. "Portal Ethan", "Prime Lucas", "Ethan (UTDR Noir)" — never just "Ethan" if a label is available.
Return ONLY JSON: {"characters":[{"id":number,"name":string}]} — entries you leave out are treated as not characters.`
            },
            { role: 'user', content: batch.map((e) => `#${e.id} ${e.title}${e.category ? ` [${e.category}]` : ''}: ${clip(e.content.replace(/\s+/g, ' '), 160)}`).join('\n') }
          ]
        });
        const found = new Map(out.characters.filter((c) => c && Number(c.id)).map((c) => [Number(c.id), String(c.name || '').trim()]));
        tx(() => {
          for (const e of batch) mark.run(found.has(e.id) ? 1 : 0, found.get(e.id) || '', e.id);
        });
      } catch (e) {
        job.errors?.push(`Skim batch ${index + 1}: ${e.message}`);
      }
      job.done = (job.done || 0) + 1;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return unknown.length;
}

/** Character entries that don't have an account yet. */
function candidates(worldId) {
  const existing = db.prepare('SELECT name, real_name, lore_entry_id FROM characters WHERE world_id = ?').all(worldId);
  const linked = new Set(existing.map((c) => c.lore_entry_id).filter(Boolean));
  // Characters added from the lorebook are matched by their entry; several variants can share a name
  // (every universe has an Ethan), so names only rule out entries for characters you created by hand.
  const names = new Set(existing.filter((c) => !c.lore_entry_id).flatMap(knownNames).map((n) => n.toLowerCase()));
  return db
    .prepare('SELECT * FROM lore_entries WHERE world_id = ? AND is_character = 1 AND enabled = 1 ORDER BY priority DESC, id')
    .all(worldId)
    .map((e) => ({ ...e, character_name: e.character_name || e.title }))
    .filter((e) => !linked.has(e.id) && !names.has(e.character_name.toLowerCase()) && !names.has(e.title.toLowerCase()));
}

const WANTS_ALL = /^\s*(please\s+)?(add\s+)?(all|every(one|body)?)(\s+(of\s+)?the)?(\s+characters?)?(\s+(from|in)\s+(the|this|these|my)\s+(universe|stories|story|lorebooks?|lore|world))?\s*[.!]*\s*$/i;

/** Picks the candidates matching the author's request. */
async function pick(worldId, request, pool) {
  const req = String(request || '').trim();
  if (!req || WANTS_ALL.test(req)) return pool;
  const world = getWorld(worldId);
  const out = await completeJSON({
    task: 'pick-characters',
    expect: 'ids',
    maxTokens: 20 * pool.length + 300,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `The author of the universe "${world.name}" wants to add characters from their lorebook to its social network. Choose the characters that match their request. If they ask for a number, return exactly that many (or all if there are fewer); prefer important characters unless told otherwise. If they ask for all, return all.
Return ONLY JSON: {"ids":[numbers]}`
      },
      { role: 'user', content: `REQUEST: ${req}\n\nAVAILABLE CHARACTERS:\n${pool.map((e) => `#${e.id} ${e.character_name}: ${clip(e.content.replace(/\s+/g, ' '), 120)}`).join('\n')}` }
    ]
  });
  const ids = new Set(out.ids.map(Number));
  return pool.filter((e) => ids.has(e.id));
}

/** Writes account details for the chosen characters, 10 at a time. Descriptions are the lore entries themselves. */
async function draftAccounts(worldId, entries, job = {}) {
  const world = getWorld(worldId);
  const rules = npcRules(world);
  const results = [];
  Object.assign(job, { phase: 'drafting', done: 0, total: entries.length });
  for (let i = 0; i < entries.length; i += 10) {
    const batch = entries.slice(i, i + 10);
    let drafted = new Map();
    try {
      const out = await completeJSON({
        task: 'import-characters',
        expect: 'characters',
        maxTokens: 160 * batch.length + 300,
        temperature: 0.8,
        messages: [
          {
            role: 'system',
            content: `These characters from the universe "${world.name}" are joining its social network. Create each one's account so it fits who they are.
${ACCOUNT_FIELDS}
${rules ? `${rules}\n(Apply the author's naming/format rules for accounts; ignore anything about which kinds of people to invent.)` : ''}
"realName" is the character's name as given. "bio" is their own profile bio (<25 words), in their voice. "followers": realistic for how famous they are in-universe.
Return ONLY JSON: {"characters":[{"id":number,"name":string,"handle":string,"realName":string,"bio":string,"followers":number}]}`
          },
          { role: 'user', content: batch.map((e) => `#${e.id} ${e.character_name}:\n${clip(e.content, 700)}`).join('\n\n') }
        ]
      });
      drafted = new Map(out.characters.filter((c) => c && Number(c.id)).map((c) => [Number(c.id), c]));
    } catch (e) {
      console.error('drafting accounts failed, using plain names:', e.message);
      job.errors?.push(`Writing accounts: ${e.message} (used their plain names instead)`);
    }
    for (const e of batch) {
      const d = drafted.get(e.id) || {};
      results.push({
        lore_entry_id: e.id,
        name: d.name || e.character_name,
        handle: makeHandle(d.handle || e.character_name),
        real_name: d.realName || e.character_name,
        bio: d.bio || '',
        followers: Number(d.followers) || '',
        description: e.content
      });
    }
    job.done = results.length;
  }
  return results;
}

/** Returns account previews for the request (nothing is created yet). `job` receives progress. */
export async function previewFromLore(worldId, request, job = {}) {
  if (!db.prepare('SELECT 1 FROM lore_entries WHERE world_id = ?').get(worldId)) {
    throw httpError(400, 'This universe has no lorebook entries yet. Import a lorebook first.');
  }
  const skimmed = await skim(worldId, job);
  const pool = candidates(worldId);
  const total = db.prepare('SELECT COUNT(*) AS n FROM lore_entries WHERE world_id = ? AND is_character = 1').get(worldId).n;
  const unskimmed = db.prepare('SELECT COUNT(*) AS n FROM lore_entries WHERE world_id = ? AND is_character IS NULL').get(worldId).n;
  if (!pool.length) return { previews: [], skimmed, unskimmed, totalCharacters: total, available: 0 };
  Object.assign(job, { phase: 'picking', done: 0, total: 1 });
  const chosen = await pick(worldId, request, pool);
  return { previews: await draftAccounts(worldId, chosen, job), skimmed, unskimmed, totalCharacters: total, available: pool.length };
}

// ---------------------------------------------------------------------------
// Knowledge: what each character knows and who they know, gathered from every entry about them
// ---------------------------------------------------------------------------

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (text, re) => (text.match(re) || []).length;

/** "Portal Ethan" -> { base: ['Portal', 'Ethan'], label: 'Portal' }; "Ethan (UTDR Noir)" -> { base: ['Ethan'], label: 'UTDR Noir' } */
function nameParts(name) {
  const paren = name.match(/^(.*?)\s*[([](.+?)[)\]]\s*$/);
  const core = (paren ? paren[1] : name).trim();
  const words = core.split(/\s+/).filter((w) => w.length >= 3);
  return { base: [words[0], words[words.length - 1]].filter(Boolean), label: paren ? paren[2] : words.length > 1 ? words.slice(0, -1).join(' ') : '' };
}

/** Lore entries about this character, most relevant first, within a token budget. */
function entriesAbout(worldId, c, budget = 6000) {
  const own = c.lore_entry_id ? db.prepare('SELECT * FROM lore_entries WHERE id = ? AND world_id = ?').get(c.lore_entry_id, worldId) : null;
  const full = [...new Set([...knownNames(c), own?.character_name, own?.title].filter((n) => n && n.trim().length >= 3))];
  const parts = full.map(nameParts);
  const fullRe = full.map((n) => new RegExp(`\\b${esc(n)}\\b`, 'gi'));
  const baseRe = [...new Set(parts.flatMap((p) => p.base))].map((b) => new RegExp(`\\b${esc(b)}\\b`, 'gi'));
  const labelRe = [...new Set(parts.map((p) => p.label).filter((l) => l.length >= 3))].map((l) => new RegExp(`\\b${esc(l)}\\b`, 'i'));

  const scored = [];
  for (const e of db.prepare('SELECT * FROM lore_entries WHERE world_id = ? AND enabled = 1').all(worldId)) {
    if (own && e.id === own.id) continue;
    const hay = `${e.title}\n${e.keys}\n${e.content}`;
    const fullHits = fullRe.reduce((a, re) => a + count(hay, re), 0);
    const baseHits = Math.min(3, baseRe.reduce((a, re) => a + count(hay, re), 0));
    if (!fullHits && !baseHits) continue;
    const label = labelRe.some((re) => re.test(hay)) ? 2 : 0;
    const titled = fullRe.some((re) => { re.lastIndex = 0; return re.test(`${e.title} ${e.keys}`); }) ? 5 : 0;
    fullRe.forEach((re) => (re.lastIndex = 0));
    scored.push({ e, score: titled + fullHits * 3 + baseHits + label });
  }
  scored.sort((a, b) => b.score - a.score || b.e.priority - a.e.priority);
  const picked = own ? [own] : [];
  let used = own ? estimateTokens(own.content) : 0;
  for (const { e } of scored) {
    const t = estimateTokens(e.content);
    if (used + t > budget) continue;
    picked.push(e);
    used += t;
  }
  return picked;
}

async function learnOne(worldId, c, accounts) {
  const world = getWorld(worldId);
  const entries = entriesAbout(worldId, c);
  if (!entries.length && !c.persona) return false;
  const who = c.real_name || c.name;
  const out = await completeJSON({
    task: 'learn-knowledge',
    expect: 'relationships',
    maxTokens: 1500,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: `You build the long-term knowledge of ONE character on the social network of the universe "${world.name}", from lorebook excerpts.
Many characters exist as several variants across universes with the same name. Some excerpts may be about OTHER variants: only use what applies to THIS character — but DO include other variants and people this character has actually met, fought beside, or knows about (crossovers count).
"knowledge": bullet points, max ~180 words, written as facts they know: which universe/variant they are and what they know about their place in the multiverse; the major events they lived through; the important people in their life and how they know them; secrets they know.
"relationships": one item per person on the ACCOUNTS list this character knows — "status" = how they know them and how they feel (short), "score" -100 (hatred) to 100 (devotion). Only use handles from the ACCOUNTS list; never the character themself.
Return ONLY JSON: {"knowledge":string,"relationships":[{"handle":string,"status":string,"score":number}]}`
      },
      {
        role: 'user',
        content: [
          `THE CHARACTER: ${c.name} (@${c.handle})${who !== c.name ? `, real name ${who}` : ''}${c.bio ? ` — bio: ${c.bio}` : ''}\n${clip(c.persona || '', 1500)}`,
          `ACCOUNTS ON THE PLATFORM:\n${accounts.filter((a) => a.id !== c.id).map((a) => `@${a.handle} — ${a.real_name || a.name}${a.bio ? ` — ${clip(a.bio, 60)}` : ''}`).join('\n')}`,
          `LORE EXCERPTS:\n${entries.map((e) => `[${e.title}]\n${e.content}`).join('\n\n')}`
        ].join('\n\n')
      }
    ]
  });
  db.prepare('UPDATE characters SET knowledge = ? WHERE id = ?').run(String(out.knowledge || '').trim(), c.id);
  applyUpdates(worldId, { relationships: out.relationships.filter((r) => r?.handle).map((r) => ({ ...r, from: c.handle, to: r.handle })) }, 'lore');
  return true;
}

/** Learns knowledge + relationships for the given characters (all characters if ids is empty). */
export async function learnFromLore(worldId, ids = [], job = {}) {
  const accounts = db.prepare('SELECT id, name, real_name, handle, bio FROM characters WHERE world_id = ?').all(worldId);
  const wanted = new Set(ids.map(Number));
  const targets = db.prepare('SELECT * FROM characters WHERE world_id = ?').all(worldId).filter((c) => !wanted.size || wanted.has(c.id));
  Object.assign(job, { phase: 'learning', done: 0, total: targets.length });
  let next = 0;
  let learned = 0;
  const worker = async () => {
    while (next < targets.length) {
      const c = targets[next++];
      try {
        if (await learnOne(worldId, c, accounts)) learned++;
      } catch (e) {
        job.errors?.push(`@${c.handle}: ${e.message}`);
      }
      job.done++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { learned, total: targets.length };
}

// Background jobs, so big lorebooks show progress instead of one long silent request.
const jobs = new Map();
let jobSeq = 0;

function startJob(worldId, run) {
  const job = { id: ++jobSeq, worldId, status: 'running', phase: 'starting', done: 0, total: 0, errors: [], result: null };
  jobs.set(job.id, job);
  run(job)
    .then((result) => Object.assign(job, { status: 'done', result }))
    .catch((e) => Object.assign(job, { status: 'error', errors: [...job.errors, e.message] }));
  return job;
}

export const startFromLoreJob = (worldId, request) => startJob(worldId, (job) => previewFromLore(worldId, request, job));
export const startLearnJob = (worldId, ids) => startJob(worldId, (job) => learnFromLore(worldId, ids, job));

export function getFromLoreJob(id) {
  return jobs.get(Number(id)) || null;
}

/** Used by the Director: preview and create in one go. */
export async function addFromLore(worldId, request, kind = 'custom') {
  const { previews } = await previewFromLore(worldId, request);
  const made = previews.map((p) => insertCharacter(worldId, { ...p, persona: p.description, kind }));
  if (made.length) await learnFromLore(worldId, made.map((c) => c.id));
  return made;
}

/** Forget skim results so every entry is re-checked (e.g. after a big lorebook change). */
export function resetSkim(worldId) {
  db.prepare('UPDATE lore_entries SET is_character = NULL WHERE world_id = ?').run(worldId);
}
