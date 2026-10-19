import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, KindBadge, AsyncButton } from '../components.jsx';

const BLANK = { name: '', handle: '', bio: '', persona: '', style: '', kind: 'custom' };

export default function Characters({ worldId, notify, refreshWorlds, goto }) {
  const [chars, setChars] = useState([]);
  const [editing, setEditing] = useState(null);
  const [genCount, setGenCount] = useState(5);
  const [genTheme, setGenTheme] = useState('');
  const [filter, setFilter] = useState('all');

  const load = () => api.get(`/worlds/${worldId}/characters`).then(setChars);
  useEffect(() => { load(); }, [worldId]);

  async function toggleActive(c) {
    await api.put(`/characters/${c.id}`, { active: !c.active });
    load();
  }

  async function setAll(active) {
    await Promise.all(chars.filter((c) => c.kind !== 'player').map((c) => api.put(`/characters/${c.id}`, { active })));
    load();
  }

  async function message(c) {
    const player = chars.find((x) => x.kind === 'player');
    await api.post(`/worlds/${worldId}/conversations`, { memberIds: [c.id], playerId: player?.id ?? null });
    goto('chats');
  }

  const shown = chars.filter((c) => filter === 'all' || c.kind === filter);
  const activeCount = chars.filter((c) => c.active && c.kind !== 'player').length;

  return (
    <div className="page">
      <header className="page-head">
        <h1>Characters</h1>
        <button className="primary" onClick={() => setEditing({ ...BLANK })}>+ New character</button>
      </header>

      <section className="card">
        <h2>Generate users with AI</h2>
        <p className="muted small">Creates new social-media users who live in this world, based on your lorebook. Uses the cheap utility model.</p>
        <div className="row wrap">
          <label className="inline">How many <input type="number" min={1} max={15} value={genCount} onChange={(e) => setGenCount(e.target.value)} style={{ width: 70 }} /></label>
          <input value={genTheme} onChange={(e) => setGenTheme(e.target.value)} placeholder="Optional focus, e.g. 'rebels from the northern provinces'" style={{ flex: 1, minWidth: 220 }} />
          <AsyncButton className="primary" notify={notify} busyLabel="Generating…" onClick={async () => {
            const made = await api.post(`/worlds/${worldId}/characters/generate`, { count: genCount, theme: genTheme });
            notify(`Generated ${made.length} users`);
            load();
            refreshWorlds();
          }}>Generate</AsyncButton>
        </div>
      </section>

      <section className="card">
        <header className="row space wrap">
          <div className="row">
            {['all', 'player', 'custom', 'generated'].map((f) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>
                {{ all: 'All', player: 'You play', custom: 'Your characters', generated: 'AI generated' }[f]}
              </button>
            ))}
          </div>
          <div className="row small">
            <span className="muted">{activeCount} active on this world</span>
            <button className="link" onClick={() => setAll(true)}>All on</button>
            <button className="link" onClick={() => setAll(false)}>All off</button>
          </div>
        </header>
        <p className="muted small">Only <b>active</b> characters post in the feed and reply. Characters marked "You play" are your personas — you post and chat as them.</p>

        <div className="char-grid">
          {shown.map((c) => (
            <div key={c.id} className={`char-card ${c.active ? '' : 'inactive'}`}>
              <div className="row">
                <Avatar c={c} size={44} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="name">{c.name}</div>
                  <div className="muted small">@{c.handle}</div>
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
                {c.kind !== 'player' && <button onClick={() => message(c)}>Message</button>}
              </div>
            </div>
          ))}
          {!shown.length && <div className="muted small">No characters here yet.</div>}
        </div>
      </section>

      {editing && (
        <CharacterEditor
          worldId={worldId}
          initial={editing}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); refreshWorlds(); }}
        />
      )}
    </div>
  );
}

function CharacterEditor({ worldId, initial, notify, onClose, onSaved }) {
  const [c, setC] = useState(initial);
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
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{isNew ? 'New character' : `Edit ${initial.name}`}</h2>
        <div className="grid2">
          <label>Name<input value={c.name} onChange={set('name')} autoFocus /></label>
          <label>Handle<input value={c.handle} onChange={set('handle')} placeholder="auto from name" /></label>
        </div>
        <label>Type
          <select value={c.kind} onChange={set('kind')}>
            <option value="player">You play this character (persona)</option>
            <option value="custom">Your character, played by AI</option>
            <option value="generated">AI generated user</option>
          </select>
        </label>
        <label>Profile bio<input value={c.bio} onChange={set('bio')} /></label>
        <label>Personality & background<textarea rows={6} value={c.persona} onChange={set('persona')} placeholder="Who they are, what they want, history, relationships, secrets…" /></label>
        <label>Voice / posting style<textarea rows={2} value={c.style} onChange={set('style')} placeholder="e.g. Formal, long sentences, never uses emoji, quotes old proverbs." /></label>
        <div className="row space">
          <div className="row">
            <AsyncButton notify={notify} busyLabel="Drafting…" onClick={async () => {
              const d = await api.post(`/worlds/${worldId}/characters/draft`, { name: c.name, idea: [c.bio, c.persona].filter(Boolean).join('\n') });
              setC({ ...c, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v)), kind: c.kind });
            }}>✨ Draft with AI</AsyncButton>
            {!isNew && (
              <AsyncButton className="danger" notify={notify} onClick={async () => {
                if (!confirm(`Delete ${c.name}? Their posts and messages go too.`)) return;
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
