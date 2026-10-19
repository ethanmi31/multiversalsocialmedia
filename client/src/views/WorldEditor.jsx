import { useEffect, useRef, useState } from 'react';
import { api, fmtCost, fmtNum } from '../api.js';
import { AsyncButton } from '../components.jsx';

const tokens = (s = '') => Math.ceil(s.length / 4);

const INSTRUCTION_EXAMPLE = `Example:
- Make a separate entry for every named character, including minor ones. Include appearance, personality, relationships, and current status.
- Locations: one entry per city/region; include who rules it and its atmosphere.
- The "Timeline" section should become one entry per era.
- Ignore the "Author's Notes" section.
- Use nicknames and titles as keywords (e.g. "the Iron Queen" for Queen Maren).`;

const NPC_EXAMPLE = `Example:
- Mostly fans and haters of the main characters, plus a few gossip/news accounts.
- Some are variants from other universes who crossed over; say which universe in their description.
- Mix of ages; lots of chronically-online teens. Usernames should look like real handles.
- No other characters from the lore unless I add them myself.`;

export default function WorldEditor({ worldId, notify, refreshWorlds, onDeleted }) {
  const [w, setW] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [estimate, setEstimate] = useState(null);
  const [job, setJob] = useState(null);
  const [replace, setReplace] = useState(true);
  const [append, setAppend] = useState(false);
  const fileRef = useRef();

  const load = () => api.get(`/worlds/${worldId}`).then((d) => { setW(d); setDirty(false); });
  useEffect(() => { load(); }, [worldId]);

  // Poll the compile job until it finishes.
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    const t = setInterval(async () => {
      const j = await api.get(`/jobs/${job.id}`);
      setJob(j);
      if (j.status !== 'running') {
        clearInterval(t);
        load();
        refreshWorlds();
        notify(j.errors.length ? `Compiled with ${j.errors.length} error(s)` : `Lorebook compiled: ${j.added} entries`, j.errors.length ? 'error' : 'info');
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job?.id, job?.status]);

  if (!w) return <div className="muted">Loading…</div>;
  const set = (k) => (e) => { setW({ ...w, [k]: e.target.value }); setDirty(true); };

  async function save() {
    await api.put(`/worlds/${worldId}`, {
      name: w.name, description: w.description, summary: w.summary, rules: w.rules, instructions: w.instructions,
      npc_instructions: w.npc_instructions, source_text: w.source_text
    });
    setDirty(false);
    setEstimate(null);
    refreshWorlds();
    notify('Saved');
  }

  async function uploadFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api.post(`/worlds/${worldId}/document${append ? '?append=1' : ''}`, fd);
      if (r.kind === 'lorebook') notify(`Imported ${r.imported} lorebook entries`);
      else notify(`Loaded ${file.name}: ~${fmtNum(r.tokens)} tokens`);
      await load();
      refreshWorlds();
      setEstimate(null);
    } catch (err) {
      notify(err.message, 'error');
    }
    e.target.value = '';
  }

  async function compile(mode) {
    if (dirty) await save();
    if (mode === 'ai' && replace && w.loreCount && !confirm('This replaces your existing lore entries. Continue?')) return;
    setJob(await api.post(`/worlds/${worldId}/compile`, { mode, replace }));
  }

  const alwaysOn = tokens(w.summary || w.description) + tokens(w.rules);

  return (
    <div className="page">
      <header className="page-head">
        <h1>World & Lore</h1>
        <div className="row">
          {dirty && <span className="muted small">Unsaved changes</span>}
          <button className="primary" onClick={save} disabled={!dirty}>Save</button>
        </div>
      </header>

      <section className="card">
        <div className="grid2">
          <label>World name<input value={w.name} onChange={set('name')} /></label>
          <label>Short description<input value={w.description} onChange={set('description')} placeholder="One line about this universe" /></label>
        </div>
      </section>

      <section className="card">
        <h2>1. Source document</h2>
        <p className="muted small">
          Upload your full world document (.txt, .md, .docx, .pdf) — any size. It is stored locally and <b>never sent to the AI in full</b>.
          It gets compiled into a lorebook once, and only relevant entries are used per message. You can also import a SillyTavern lorebook .json directly.
        </p>
        <div className="row">
          <input ref={fileRef} type="file" accept=".txt,.md,.markdown,.docx,.pdf,.json" onChange={uploadFile} hidden />
          <button onClick={() => fileRef.current.click()}>Upload file…</button>
          <label className="check"><input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} /> Append to existing document</label>
          <span className="muted small">
            {w.source_name && <>{w.source_name} · </>}~{fmtNum(tokens(w.source_text))} tokens
          </span>
        </div>
        <details>
          <summary>View / paste document text</summary>
          <textarea className="mono" rows={14} value={w.source_text} onChange={set('source_text')} placeholder="Paste your world document here…" />
        </details>
      </section>

      <section className="card">
        <h2>2. Structuring instructions</h2>
        <p className="muted small">Tell the compiler how to organize your document into lore entries: what to split out, what to emphasize, what to skip, which nicknames to use as triggers.</p>
        <textarea rows={7} value={w.instructions} onChange={set('instructions')} placeholder={INSTRUCTION_EXAMPLE} />
      </section>

      <section className="card">
        <h2>3. Compile into lorebook</h2>
        <p className="muted small">
          <b>AI compile</b> uses your cheap <i>utility model</i> once to rewrite the document into dense, keyword-triggered entries and a short world summary.
          <b> Quick split</b> is free: it makes one entry per heading with automatic keywords.
        </p>
        <div className="row wrap">
          <AsyncButton notify={notify} onClick={async () => { if (dirty) await save(); setEstimate(await api.get(`/worlds/${worldId}/compile/estimate`)); }}>
            Estimate cost
          </AsyncButton>
          <button className="primary" disabled={job?.status === 'running' || !w.source_text} onClick={() => compile('ai').catch((e) => notify(e.message, 'error'))}>
            Compile with AI
          </button>
          <button disabled={job?.status === 'running' || !w.source_text} onClick={() => compile('quick').catch((e) => notify(e.message, 'error'))}>
            Quick split (free)
          </button>
          <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace existing entries</label>
        </div>
        {estimate && (
          <div className="callout small">
            {estimate.chunks} chunk(s) · ~{fmtNum(estimate.inputTokens)} input + ~{fmtNum(estimate.outputTokens)} output tokens on <code>{estimate.model}</code> ·
            estimated <b>{fmtCost(estimate.estimatedCost)}</b> (one time)
          </div>
        )}
        {job && (
          <div className="progress-wrap">
            <div className="progress"><div style={{ width: `${job.total ? (job.done / job.total) * 100 : 5}%` }} /></div>
            <div className="small muted">
              {job.status === 'running' ? `Compiling… ${job.done}/${job.total}` : `Finished: ${job.added} new entries`}
              {job.errors.length > 0 && <div className="error-text">{job.errors.slice(0, 5).join(' · ')}</div>}
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>4. Always-on context <span className="badge">~{alwaysOn} tokens per message</span></h2>
        <p className="muted small">Sent with every request, so keep it short. Everything else lives in the lorebook and only appears when relevant.</p>
        <label>World summary
          <textarea rows={5} value={w.summary} onChange={set('summary')} placeholder="Generated by AI compile, or write your own." />
        </label>
        <div className="row">
          <AsyncButton notify={notify} disabled={!w.loreCount && !w.source_text} onClick={async () => { const r = await api.post(`/worlds/${worldId}/summarize`); setW({ ...w, summary: r.summary }); notify('Summary regenerated'); }}>
            Regenerate summary
          </AsyncButton>
        </div>
        <label>World rules — story-specific instructions for this universe only
          <textarea rows={4} value={w.rules} onChange={set('rules')} placeholder="e.g. Magic is rare and feared. Keep a dark, gritty tone. Characters use in-world slang. No modern technology." />
        </label>
      </section>

      <section className="card">
        <h2>Random users</h2>
        <p className="muted small">How the AI should create random users for this universe — used by "Generate random users" and when new accounts join on their own. Only applies to this universe.</p>
        <textarea rows={5} value={w.npc_instructions || ''} onChange={set('npc_instructions')} placeholder={NPC_EXAMPLE} />
      </section>

      <Lorebook worldId={worldId} notify={notify} version={w.loreCount} onChange={() => { load(); refreshWorlds(); }} />

      <WorldState worldId={worldId} notify={notify} />

      <section className="card danger-zone">
        <AsyncButton notify={notify} className="danger" onClick={async () => {
          if (!confirm(`Delete "${w.name}" and everything in it?`)) return;
          await api.del(`/worlds/${worldId}`);
          onDeleted();
        }}>Delete world</AsyncButton>
      </section>
    </div>
  );
}

function Lorebook({ worldId, notify, version, onChange }) {
  const [entries, setEntries] = useState([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [testText, setTestText] = useState('');
  const [test, setTest] = useState(null);

  const load = () => api.get(`/worlds/${worldId}/lore?q=${encodeURIComponent(q)}`).then(setEntries);
  useEffect(() => { load(); }, [worldId, q, version]);

  const totalTokens = entries.reduce((a, e) => a + e.tokens, 0);

  return (
    <section className="card">
      <header className="row space">
        <h2>5. Lorebook <span className="badge">{entries.length} entries · ~{fmtNum(totalTokens)} tokens total</span></h2>
        <div className="row">
          <a className="button" href={`/api/worlds/${worldId}/lore/export`}>Export (SillyTavern)</a>
          <AsyncButton notify={notify} onClick={async () => { await api.post(`/worlds/${worldId}/lore`, { title: 'New entry' }); onChange(); }}>+ Entry</AsyncButton>
        </div>
      </header>

      <details className="tester">
        <summary>Test triggers — see what a message would inject</summary>
        <div className="row">
          <input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder="Type a message mentioning people/places…" style={{ flex: 1 }} />
          <AsyncButton notify={notify} onClick={async () => setTest(await api.post(`/worlds/${worldId}/lore/test`, { text: testText }))}>Test</AsyncButton>
        </div>
        {test && (
          <div className="small">
            {test.entries.length ? (
              <>Injects <b>{test.entries.length}</b> entries (~{test.tokens} tokens): {test.entries.map((e) => e.title + (e.constant ? ' (always)' : '')).join(', ')}</>
            ) : 'No entries triggered.'}
          </div>
        )}
      </details>

      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search entries…" />
      <div className="lore-list">
        {entries.map((e) => (
          <LoreEntry key={e.id} entry={e} open={open === e.id} onToggle={() => setOpen(open === e.id ? null : e.id)} notify={notify} onChange={() => { load(); onChange(); }} />
        ))}
        {!entries.length && <div className="muted small">No entries yet. Upload a document and compile it.</div>}
      </div>
    </section>
  );
}

function LoreEntry({ entry, open, onToggle, notify, onChange }) {
  const [e, setE] = useState(entry);
  useEffect(() => setE(entry), [entry]);
  const set = (k, v) => setE({ ...e, [k]: v });

  return (
    <div className={`lore ${e.enabled ? '' : 'disabled'}`}>
      <div className="lore-head" onClick={onToggle}>
        <b>{e.title}</b>
        {e.category && <span className="badge">{e.category}</span>}
        {e.constant && <span className="badge player">always on</span>}
        <span className="muted small lore-keys">{e.keys.join(', ')}</span>
        <span className="muted small">{e.tokens}t</span>
      </div>
      {open && (
        <div className="lore-body">
          <div className="grid2">
            <label>Title<input value={e.title} onChange={(x) => set('title', x.target.value)} /></label>
            <label>Category<input value={e.category} onChange={(x) => set('category', x.target.value)} /></label>
          </div>
          <label>Trigger keywords (comma separated)
            <input value={Array.isArray(e.keys) ? e.keys.join(', ') : e.keys} onChange={(x) => set('keys', x.target.value)} />
          </label>
          <label>Content<textarea rows={6} value={e.content} onChange={(x) => set('content', x.target.value)} /></label>
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={e.constant} onChange={(x) => set('constant', x.target.checked)} /> Always on</label>
            <label className="check"><input type="checkbox" checked={e.enabled} onChange={(x) => set('enabled', x.target.checked)} /> Enabled</label>
            <label className="inline">Priority <input type="number" min={0} max={100} value={e.priority} onChange={(x) => set('priority', x.target.value)} style={{ width: 70 }} /></label>
            <span style={{ flex: 1 }} />
            <AsyncButton notify={notify} className="danger" onClick={async () => { await api.del(`/lore/${e.id}`); onChange(); }}>Delete</AsyncButton>
            <AsyncButton notify={notify} className="primary" onClick={async () => { await api.put(`/lore/${e.id}`, e); notify('Entry saved'); onChange(); }}>Save entry</AsyncButton>
          </div>
        </div>
      )}
    </div>
  );
}

/** The hidden "back-end" state: storylines and the relationship matrix. View/edit only when you want a "system update". */
function WorldState({ worldId, notify }) {
  const [state, setState] = useState(null);
  const load = () => api.get(`/worlds/${worldId}/state`).then(setState);
  useEffect(() => { load(); }, [worldId]);
  if (!state) return null;

  return (
    <section className="card">
      <details>
        <summary><b>World state (system update)</b> — {state.storylines.filter((s) => s.status === 'active').length} active storylines, {state.relationships.length} relationships</summary>
        <p className="muted small">What the engine tracks behind the scenes so drama develops and people remember. It updates itself; edit or delete anything that went off the rails.</p>
        <div className="row space"><h2>Storylines</h2>
          <AsyncButton notify={notify} onClick={async () => { await api.post(`/worlds/${worldId}/storylines`, { title: prompt('Storyline title?') || 'New storyline' }); load(); }}>+ Storyline</AsyncButton>
        </div>
        {state.storylines.map((s) => <Storyline key={s.id} s={s} notify={notify} onChange={load} />)}
        {!state.storylines.length && <div className="muted small">Nothing yet — storylines appear as the world plays out.</div>}
        <h2 style={{ marginTop: 16 }}>Relationships</h2>
        <table>
          <tbody>
            {state.relationships.map((r) => (
              <tr key={`${r.from_id}-${r.to_id}`}>
                <td>@{r.from?.handle} → @{r.to?.handle}</td>
                <td>{r.status}</td>
                <td className={r.score < 0 ? 'error-text' : ''}>{r.score}</td>
                <td><button className="link" onClick={async () => { await api.del(`/relationships/${r.from_id}/${r.to_id}`); load(); }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!state.relationships.length && <div className="muted small">No relationships tracked yet.</div>}
      </details>
    </section>
  );
}

function Storyline({ s: initial, notify, onChange }) {
  const [s, setS] = useState(initial);
  useEffect(() => setS(initial), [initial]);
  return (
    <div className={`lore ${s.status === 'resolved' ? 'disabled' : ''}`} style={{ marginBottom: 6 }}>
      <div className="lore-body" style={{ borderTop: 'none', paddingTop: 10 }}>
        <div className="row">
          <input value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} style={{ fontWeight: 600 }} />
          <select value={s.status} onChange={(e) => setS({ ...s, status: e.target.value })} style={{ width: 120 }}>
            <option value="active">active</option>
            <option value="resolved">resolved</option>
          </select>
          <label className="inline small">heat <input type="number" min={0} max={100} value={s.heat} onChange={(e) => setS({ ...s, heat: e.target.value })} style={{ width: 64 }} /></label>
        </div>
        <textarea rows={2} value={s.summary} onChange={(e) => setS({ ...s, summary: e.target.value })} style={{ marginTop: 6 }} />
        <div className="row space small">
          <span className="muted">{s.involved.map((c) => '@' + c.handle).join(', ')}</span>
          <div className="row">
            <AsyncButton className="danger" notify={notify} onClick={async () => { await api.del(`/storylines/${s.id}`); onChange(); }}>Delete</AsyncButton>
            <AsyncButton notify={notify} onClick={async () => { await api.put(`/storylines/${s.id}`, s); notify('Saved'); onChange(); }}>Save</AsyncButton>
          </div>
        </div>
      </div>
    </div>
  );
}
