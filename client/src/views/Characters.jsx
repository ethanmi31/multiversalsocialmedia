import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, KindBadge, AsyncButton, fmtCount } from '../components.jsx';

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
      {importing && <BulkImport worldId={worldId} notify={notify} onClose={() => setImporting(false)} onDone={() => { setImporting(false); load(); }} />}
    </div>
  );
}

function CharacterEditor({ worldId, initial, notify, onClose, onSaved }) {
  const [c, setC] = useState({ ...initial, followers: initial.followers ?? '' });
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });
  const isNew = !c.id;

  async function save() {
    if (!c.name.trim()) return notify('Name is required', 'error');
    if (isNew) await api.post(`/worlds/${worldId}/characters`, c);
    else await api.put(`/characters/${c.id}`, c);
    onSaved();
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>{isNew ? 'New character' : `Edit ${initial.name}`}</h2>
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
