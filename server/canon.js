import { db, tx } from './db.js';
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
For each character entry, give its id and the character's name as the lore names them (include a variant/universe label if the entry is about a specific variant).
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
  const names = new Set(existing.flatMap(knownNames).map((n) => n.toLowerCase()));
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

// Background jobs, so a big lorebook shows progress instead of one long silent request.
const jobs = new Map();
let jobSeq = 0;

export function startFromLoreJob(worldId, request) {
  const job = { id: ++jobSeq, worldId, status: 'running', phase: 'starting', done: 0, total: 0, errors: [], result: null };
  jobs.set(job.id, job);
  previewFromLore(worldId, request, job)
    .then((result) => Object.assign(job, { status: 'done', result }))
    .catch((e) => Object.assign(job, { status: 'error', errors: [...job.errors, e.message] }));
  return job;
}

export function getFromLoreJob(id) {
  return jobs.get(Number(id)) || null;
}

/** Used by the Director: preview and create in one go. */
export async function addFromLore(worldId, request, kind = 'custom') {
  const { previews } = await previewFromLore(worldId, request);
  return previews.map((p) => insertCharacter(worldId, { ...p, persona: p.description, kind }));
}

/** Forget skim results so every entry is re-checked (e.g. after a big lorebook change). */
export function resetSkim(worldId) {
  db.prepare('UPDATE lore_entries SET is_character = NULL WHERE world_id = ?').run(worldId);
}
