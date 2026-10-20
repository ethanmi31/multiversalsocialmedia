import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, KindBadge, AsyncButton, fmtCount } from '../components.jsx';

/** Polls a background job until it finishes, reporting progress. */
async function runJob(worldId, start, onProgress) {
  let job = await start;
  onProgress(job);
  while (job.status === 'running') {
    await new Promise((r) => setTimeout(r, 1200));
    job = await api.get(`/worlds/${worldId}/characters/from-lore/${job.id}`);
    onProgress(job);
  }
  onProgress(null);
  if (job.status === 'error') throw new Error(job.errors[job.errors.length - 1] || 'Something went wrong');
  return job;
}

const PHASES = {
  starting: () => 'Starting…',
  skimming: (j) => `Skimming the lorebook for characters… batch ${j.done} / ${j.total}`,
  picking: () => 'Picking the characters you asked for…',
  drafting: (j) => `Writing their accounts… ${j.done} / ${j.total}`,
  learning: (j) => `Reading the lore to learn who they know… ${j.done} / ${j.total} characters`
};

function JobProgress({ job }) {
  if (!job) return null;
  return (
    <div className="progress-wrap">
      <div className="progress"><div style={{ width: `${job.total ? Math.max(4, (job.done / job.total) * 100) : 4}%` }} /></div>
      <div className="small muted">
        {(PHASES[job.phase] || PHASES.starting)(job)}
        {job.errors.length > 0 && <span className="error-text"> · {job.errors.length} problem(s), continuing</span>}
      </div>
    </div>
  );
}

const BLANK = { name: '', real_name: '', handle: '', bio: '', persona: '', kind: 'custom', followers: '' };
const KIND_LABEL = { all: 'All', player: 'You play', custom: 'Your characters', generated: 'AI generated' };

/** Reads a dropped file as text (server extracts .docx/.pdf). */
async function fileToText(file) {
  if (/\.(txt|md|markdown|json)$/i.test(file.name)) return file.text();
  const fd = new FormData();
  fd.append('file', file);
  return (await api.post('/extract', fd)).text;
}

/** Textarea that also accepts a dropped file. */
function DropText({ value, onChange, notify, rows = 8, placeholder }) {
  const [over, setOver] = useState(false);
  return (
    <textarea rows={rows} value={value} placeholder={placeholder} className={over ? 'drop-over' : ''}
      onChange={(e) => onChange(e.target.value)}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setOver(false);
        const file = e.dataTransfer.files[0];
        if (!file) return;
        try { onChange((value ? value + '\n\n' : '') + (await fileToText(file))); } catch (err) { notify(err.message, 'error'); }
      }} />
  );
}

export default function Characters({ worldId, world, notify, refreshWorlds, refreshChars, openProfile, goto }) {
  const [chars, setChars] = useState([]);
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);
  const [loreRequest, setLoreRequest] = useState('');
  const [lorePreview, setLorePreview] = useState(null);
  const [loreJob, setLoreJob] = useState(null);

  const [learnJob, setLearnJob] = useState(null);

  async function learn(ids = []) {
    const job = await runJob(worldId, api.post(`/worlds/${worldId}/characters/learn`, { ids }), setLearnJob);
    notify(`Learned what ${job.result.learned} character(s) know and who they know` + (job.errors.length ? ` · problems: ${job.errors.slice(0, 2).join(' · ')}` : ''), job.errors.length ? 'error' : 'info');
    load();
  }

  async function findFromLore(rescan = false) {
    const job = await runJob(worldId, api.post(`/worlds/${worldId}/characters/from-lore`, { request: loreRequest, rescan }), setLoreJob);
    const r = job.result;
    if (job.errors.length) notify(`Finished with problems: ${job.errors.slice(0, 2).join(' · ')}${r.unskimmed ? ` — ${r.unskimmed} entries couldn't be checked yet; run it again to retry them.` : ''}`, 'error');
    if (!r.previews.length) {
      if (!job.errors.length) notify(r.totalCharacters ? `All ${r.totalCharacters} characters in the lorebook are already on the platform.` : 'No characters found in the lorebook.');
      return;
    }
    setLorePreview(r);
  }
  const [genCount, setGenCount] = useState(5);
  const [genTheme, setGenTheme] = useState('');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');

  const load = async () => {
    setChars(await api.get(`/worlds/${worldId}/characters`));
    refreshChars();
    refreshWorlds();
  };
  useEffect(() => { load(); }, [worldId]);

  async function toggleActive(c) {
    await api.put(`/characters/${c.id}`, { active: !c.active });
    load();
  }
  async function setAll(active) {
    await Promise.all(chars.filter((c) => c.kind !== 'player').map((c) => api.put(`/characters/${c.id}`, { active })));
    load();
  }

  const shown = chars.filter((c) => (filter === 'all' || c.kind === filter) && `${c.name} ${c.handle}`.toLowerCase().includes(q.toLowerCase()));
  const activeCount = chars.filter((c) => c.active && c.kind !== 'player').length;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Characters</h1>
        <div className="row">
          <button onClick={() => setImporting(true)}>Bulk import…</button>
          <button className="primary" onClick={() => setEditing({ ...BLANK })}>+ New character</button>
        </div>
      </header>

      <section className="card">
        <h2>Add characters from your lorebook</h2>
        <p className="muted small">
          Say who you want, in your own words. It skims your lorebook entries (just titles and the first lines, cheap, and remembered for next time) to find the characters,
          then their entries become their descriptions. Characters already on the platform are skipped. You review everything before it's added.
        </p>
        <div className="row wrap">
          <input value={loreRequest} onChange={(e) => setLoreRequest(e.target.value)} style={{ flex: 1, minWidth: 260 }}
            placeholder="e.g. add 5 characters from the stories · add all the characters · add the villains"
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.nextSibling?.click(); }} />
          <AsyncButton className="primary" notify={notify} busyLabel="Working…" onClick={() => findFromLore()}>Find characters</AsyncButton>
        </div>
        <div className="small" style={{ marginTop: 6 }}>
          <AsyncButton className="link" notify={notify} title="Forget which entries are characters and check the whole lorebook again (use after big lorebook changes)"
            onClick={() => findFromLore(true)}>Re-skim the whole lorebook</AsyncButton>
        </div>
        <JobProgress job={loreJob} />
        <JobProgress job={learnJob} />
      </section>

      <section className="card">
        <h2>Who knows who</h2>
        <p className="muted small">
          Reads every lorebook entry about each character (cheap utility model) to learn what they know — their universe, the events they lived through,
          the people they've met — and their relationships with the other accounts. This is always part of the character, so it doesn't depend on keywords.
          It runs automatically for characters added from the lorebook; run it again after adding characters so everyone knows each other.
        </p>
        <AsyncButton notify={notify} busyLabel="Learning…" disabled={!!learnJob} onClick={() => learn()}>Learn from lore for all characters</AsyncButton>
      </section>

      <section className="card">
        <h2>Generate random users</h2>
        <p className="muted small">
          Creates new accounts who live in this universe, based on your lorebook
          {world?.npc_instructions ? <> and <b>your random-user instructions</b></> : <> — set <a onClick={() => goto('world')}>random-user instructions</a> in World & Lore to control what kind of people appear</>}.
        </p>
        <div className="row wrap">
          <label className="inline">How many <input type="number" min={1} max={15} value={genCount} onChange={(e) => setGenCount(e.target.value)} style={{ width: 70 }} /></label>
          <input value={genTheme} onChange={(e) => setGenTheme(e.target.value)} placeholder="Optional focus for this batch" style={{ flex: 1, minWidth: 220 }} />
          <AsyncButton className="primary" notify={notify} busyLabel="Generating…" onClick={async () => {
            const made = await api.post(`/worlds/${worldId}/characters/generate`, { count: genCount, theme: genTheme });
            notify(`Generated ${made.length} users`);
            load();
          }}>Generate</AsyncButton>
        </div>
      </section>

      <section className="card">
        <header className="row space wrap">
          <div className="row wrap">
            {Object.keys(KIND_LABEL).map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{KIND_LABEL[f]}</button>
            ))}
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" style={{ width: 160 }} />
          </div>
          <div className="row small">
            <span className="muted">{activeCount} active</span>
            <button className="link" onClick={() => setAll(true)}>All on</button>
            <button className="link" onClick={() => setAll(false)}>All off</button>
          </div>
        </header>
        <p className="muted small">Only <b>active</b> characters are on the platform right now (posting, replying, DMing). "You play" characters are your personas — the AI never writes for them.</p>

        <div className="char-grid">
          {shown.map((c) => (
            <div key={c.id} className={`char-card ${c.active ? '' : 'inactive'}`}>
              <div className="row">
                <span className="clickable" onClick={() => openProfile(c.id)}><Avatar c={c} size={44} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name clickable" onClick={() => openProfile(c.id)}>{c.name}</div>
                  <div className="muted small">@{c.handle} · {fmtCount(c.followerCount)} followers</div>
                  {c.real_name && c.real_name !== c.name && <div className="muted small ellipsis">{c.real_name}</div>}
                </div>
                {c.kind !== 'player' && (
                  <label className="switch" title="Active on this world">
                    <input type="checkbox" checked={!!c.active} onChange={() => toggleActive(c)} />
                    <span />
                  </label>
                )}
              </div>
              <KindBadge kind={c.kind} />
              <p className="small">{c.bio}</p>
              <div className="row">
                <button onClick={() => setEditing(c)}>Edit</button>
                <button onClick={() => openProfile(c.id)}>Profile</button>
              </div>
            </div>
          ))}
          {!shown.length && <div className="muted small">No characters here yet.</div>}
        </div>
      </section>

      {editing && (
        <CharacterEditor worldId={worldId} initial={editing} notify={notify} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {lorePreview && (
        <FromLorePreview worldId={worldId} data={lorePreview} notify={notify} onClose={() => setLorePreview(null)}
          onDone={(made) => { setLorePreview(null); setLoreRequest(''); load(); if (made.length) learn(made.map((c) => c.id)).catch((e) => notify(e.message, 'error')); }} />
      )}
      {importing && <BulkImport worldId={worldId} notify={notify} onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
    </div>
  );
}

function CharacterEditor({ worldId, initial, notify, onClose, onSaved }) {
  const [c, setC] = useState({ ...initial, followers: initial.followers ?? '' });
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const isNew = !c.id;

  const [picture, setPicture] = useState(null); // file chosen before a new character exists
  async function save() {
    if (!c.name.trim()) return notify('Name is required', 'error');
    const saved = isNew ? await api.post(`/worlds/${worldId}/characters`, c) : await api.put(`/characters/${c.id}`, c);
    if (picture) await uploadAvatar(saved.id, picture);
    onSaved();
  }
  async function uploadAvatar(cid, file) {
    const fd = new FormData();
    fd.append('file', file);
    return api.post(`/characters/${cid}/avatar`, fd);
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>{isNew ? 'New character' : `Edit ${initial.name}`}</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          <Avatar c={{ ...c, avatar: picture ? null : c.avatar }} size={56} />
          {picture && <span className="small muted">{picture.name} (saved with the character)</span>}
          <label className="button" style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>
            {c.avatar || picture ? 'Change picture' : 'Add picture'}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={async (e) => {
              const file = e.target.files[0];
              e.target.value = '';
              if (!file) return;
              if (isNew) return setPicture(file);
              try { const r = await uploadAvatar(c.id, file); setC({ ...c, avatar: r.avatar }); } catch (err) { notify(err.message, 'error'); }
            }} />
          </label>
          {c.avatar && !isNew && <button className="link" onClick={async () => { await api.del(`/characters/${c.id}/avatar`); setC({ ...c, avatar: '' }); }}>Remove</button>}
        </div>
        <div className="grid2">
          <label>Display name (username)<input value={c.name} onChange={set('name')} autoFocus placeholder="What shows on their profile" /></label>
          <label>@handle<input value={c.handle} onChange={set('handle')} placeholder="auto from display name" /></label>
        </div>
        <label>Real name <span className="muted">(optional — who they really are; helps the AI find their lore)</span>
          <input value={c.real_name || ''} onChange={set('real_name')} placeholder="Leave empty if it's the same as the display name" />
        </label>
        <label>Profile bio<input value={c.bio} onChange={set('bio')} placeholder="What their profile says" /></label>
        <label>Description
          <DropText value={c.persona} onChange={(v) => setC({ ...c, persona: v })} notify={notify} rows={12}
            placeholder="Paste or drop your character description here — personality, history, relationships, how they talk, anything. Any format." />
          <span className="muted small">~{Math.ceil((c.persona || '').length / 4)} tokens. Sent in full in DMs and scenes, shortened in feed batches.</span>
        </label>
        <label>What they know <span className="muted">(from the lore — always part of them; edit freely)</span>
          <textarea rows={5} value={c.knowledge || ''} onChange={set('knowledge')} placeholder="Filled in by “Learn from lore”, or write it yourself: their universe, people they know, events they lived through." />
        </label>
        {c.style && (
          <label>Voice notes (from older versions)<input value={c.style} onChange={set('style')} /></label>
        )}
        <div className="grid2">
          <label>Type
            <select value={c.kind} onChange={set('kind')}>
              <option value="player">You play this character (persona)</option>
              <option value="custom">Your character, played by AI</option>
              <option value="generated">AI generated user</option>
            </select>
          </label>
          <label>Follower count<input type="number" min={0} value={c.followers} onChange={set('followers')} placeholder="random if empty" /></label>
        </div>
        <div className="row space">
          <div className="row">
            <AsyncButton notify={notify} busyLabel="Drafting…" title="Expand a rough idea into a description" onClick={async () => {
              const d = await api.post(`/worlds/${worldId}/characters/draft`, { name: c.name, idea: [c.bio, c.persona].filter(Boolean).join('\n') });
              setC({ ...c, name: c.name || d.name, real_name: c.real_name || d.realName || '', handle: c.handle || d.handle, bio: c.bio || d.bio, persona: d.description || c.persona });
            }}>✨ Draft with AI</AsyncButton>
            {!isNew && (
              <AsyncButton className="danger" notify={notify} onClick={async () => {
                if (!confirm(`Delete ${c.name}? Their posts go too.`)) return;
                await api.del(`/characters/${c.id}`);
                onSaved();
              }}>Delete</AsyncButton>
            )}
          </div>
          <div className="row">
            <button onClick={onClose}>Cancel</button>
            <AsyncButton className="primary" notify={notify} onClick={save}>Save</AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function FromLorePreview({ worldId, data, notify, onClose, onDone }) {
  const [list, setList] = useState(data.previews);
  const [kind, setKind] = useState('custom');
  const [open, setOpen] = useState(null);
  const edit = (i, k, v) => setList(list.map((c, j) => (j === i ? { ...c, [k]: v } : c)));
  const chosen = list.filter((c) => !c.skip);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Characters from your lorebook</h2>
        <p className="muted small">
          Picked {list.length} of {data.available} available ({data.totalCharacters} characters found in the lorebook{data.skimmed ? `, ${data.skimmed} entries skimmed just now` : ''}).
          Edit anything, untick ones you don't want.
        </p>
        <div className="import-list">
          {list.map((c, i) => (
            <div key={c.lore_entry_id} className={`import-row ${c.skip ? 'inactive' : ''}`}>
              <div className="row">
                <input type="checkbox" checked={!c.skip} onChange={(e) => edit(i, 'skip', !e.target.checked)} />
                <input value={c.name} onChange={(e) => edit(i, 'name', e.target.value)} placeholder="Display name" title="Display name (username)" />
                <input value={c.handle} onChange={(e) => edit(i, 'handle', e.target.value)} placeholder="handle" style={{ maxWidth: 150 }} title="@handle" />
                <button className="link" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'hide' : 'details'}</button>
              </div>
              <input value={c.bio} onChange={(e) => edit(i, 'bio', e.target.value)} placeholder="Profile bio" />
              {open === i && (
                <>
                  <input value={c.real_name} onChange={(e) => edit(i, 'real_name', e.target.value)} placeholder="Real name" />
                  <textarea rows={8} value={c.description} onChange={(e) => edit(i, 'description', e.target.value)} />
                </>
              )}
            </div>
          ))}
        </div>
        <div className="row space">
          <button onClick={onClose}>Cancel</button>
          <div className="row">
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="custom">Add as: your characters (AI plays them)</option>
              <option value="player">Add as: your personas (you play them)</option>
              <option value="generated">Add as: background users</option>
            </select>
            <AsyncButton className="primary" notify={notify} disabled={!chosen.length} onClick={async () => {
              const made = await api.post(`/worlds/${worldId}/characters/import`, { characters: chosen, kind });
              notify(`Added ${made.length} characters — now learning who they know…`);
              onDone(made);
            }}>Add {chosen.length}</AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}

function BulkImport({ worldId, notify, onClose, onDone }) {
  const [text, setText] = useState('');
  const [list, setList] = useState(null);
  const [kind, setKind] = useState('custom');
  const [open, setOpen] = useState(null);
  const edit = (i, k, v) => setList(list.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Bulk import characters</h2>
        {!list ? (
          <>
            <p className="muted small">
              Paste or drop a file with all your character descriptions. Separate characters with headings (<code># Name</code>), <code>Name:</code> lines, or <code>---</code>.
              Descriptions are kept exactly as written; you can review names, handles and bios before importing.
            </p>
            <DropText value={text} onChange={setText} notify={notify} rows={14} placeholder="# Character One&#10;Description…&#10;&#10;# Character Two&#10;Description…" />
            <div className="row space">
              <button onClick={onClose}>Cancel</button>
              <div className="row">
                <AsyncButton notify={notify} disabled={!text.trim()} onClick={async () => setList(await api.post(`/worlds/${worldId}/characters/split`, { text, mode: 'free' }))}>
                  Split by headings (free)
                </AsyncButton>
                <AsyncButton className="primary" notify={notify} busyLabel="Reading…" disabled={!text.trim()} title="Cheap: the AI only finds where each character starts and writes handles/bios"
                  onClick={async () => setList(await api.post(`/worlds/${worldId}/characters/split`, { text, mode: 'ai' }))}>
                  Split with AI + suggest handles/bios
                </AsyncButton>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">Found {list.length} characters. Edit anything, untick ones you don't want.</p>
            <div className="import-list">
              {list.map((c, i) => (
                <div key={i} className={`import-row ${c.skip ? 'inactive' : ''}`}>
                  <div className="row">
                    <input type="checkbox" checked={!c.skip} onChange={(e) => edit(i, 'skip', !e.target.checked)} />
                    <input value={c.name} onChange={(e) => edit(i, 'name', e.target.value)} placeholder="Display name" />
                    <input value={c.handle} onChange={(e) => edit(i, 'handle', e.target.value)} placeholder="handle" style={{ maxWidth: 160 }} />
                    <button className="link" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'hide' : 'description'}</button>
                  </div>
                  <input value={c.bio} onChange={(e) => edit(i, 'bio', e.target.value)} placeholder="Profile bio" />
                  {open === i && <textarea rows={8} value={c.description} onChange={(e) => edit(i, 'description', e.target.value)} />}
                </div>
              ))}
            </div>
            <div className="row space">
              <button onClick={() => setList(null)}>Back</button>
              <div className="row">
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="custom">Import as: your characters (AI plays them)</option>
                  <option value="player">Import as: your personas (you play them)</option>
                  <option value="generated">Import as: background users</option>
                </select>
                <AsyncButton className="primary" notify={notify} onClick={async () => {
                  const made = await api.post(`/worlds/${worldId}/characters/import`, { characters: list.filter((c) => !c.skip), kind });
                  notify(`Imported ${made.length} characters`);
                  onDone();
                }}>Import {list.filter((c) => !c.skip).length}</AsyncButton>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
