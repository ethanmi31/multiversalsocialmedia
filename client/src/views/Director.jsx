import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { AsyncButton, Typing, timeAgo } from '../components.jsx';

const EXAMPLES = [
  'Lira went back home to her own universe already, stop putting her at the gas station.',
  'Wrap up the hammer storyline, it has gone on way too long.',
  'Make a huge argument break out about the leaked group chat.',
  'Have Tolan DM me asking where his hammer is.',
  'Change Masters\' bio to "drunk but reliable" and add that he hates mornings to his description.',
  'Add a rule that nobody in the PRIME universe knows about the Author.',
  'Why does everyone know about my fight with Tolan?'
];

export default function Director({ worldId, world, notify }) {
  const [state, setState] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef();

  useEffect(() => { api.get(`/worlds/${worldId}/director`).then(setState); }, [worldId]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [state?.messages.length, busy]);

  async function send(message = text) {
    if (!message.trim() || busy) return;
    setText('');
    setBusy(true);
    setState((s) => ({ ...s, messages: [...s.messages, { id: 'pending', role: 'user', content: message, actions: [] }] }));
    try {
      setState(await api.post(`/worlds/${worldId}/director`, { message }));
    } catch (e) {
      notify(e.message, 'error');
      setState(await api.get(`/worlds/${worldId}/director`));
      setText(message);
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  return (
    <div className="director">
      <div className="director-chat">
        <header className="conv-head">
          <div style={{ flex: 1 }}>
            <b>Director</b>
            <div className="muted small">Out of character. Tell the engine what to change, fix or make happen in <b>{world?.name}</b> — only this universe is affected.</div>
          </div>
          {state.messages.length > 0 && (
            <button className="link small" onClick={async () => { if (confirm('Clear the director chat? Notes stay.')) setState(await api.del(`/worlds/${worldId}/director/messages`)); }}>Clear chat</button>
          )}
        </header>
        <div className="messages">
          {!state.messages.length && (
            <div className="director-intro">
              <p className="muted">Things you can say:</p>
              {EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => setText(e)}>{e}</button>)}
            </div>
          )}
          {state.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role === 'user' ? 'mine' : ''}`}>
              <div className="bubble">
                <div className="msg-text">{m.content}</div>
                {m.actions?.length > 0 && (
                  <ul className="director-actions">{m.actions.map((a, i) => <li key={i}>✓ {a}</li>)}</ul>
                )}
              </div>
            </div>
          ))}
          {busy && <Typing label="Director is thinking" />}
          <div ref={bottom} />
        </div>
        <footer className="composer-bar">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Stop having random people show up in my real-life scenes."
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          <button className="primary" onClick={() => send()} disabled={busy || !text.trim()}>Send</button>
        </footer>
      </div>

      <aside className="director-notes">
        <h2>Notes in effect</h2>
        <p className="muted small">Standing rules added to every prompt in this universe. The director writes these when you correct it; you can edit them too.</p>
        {state.notes.map((n) => <Note key={n.id} n={n} notify={notify} onChange={setState} />)}
        {!state.notes.length && <div className="muted small">No notes yet.</div>}
        <AsyncButton notify={notify} onClick={async () => {
          const content = prompt('New standing rule for this universe:');
          if (content?.trim()) setState(await api.post(`/worlds/${worldId}/director/notes`, { content }));
        }}>+ Add note</AsyncButton>
      </aside>
    </div>
  );
}

function Note({ n, notify, onChange }) {
  const [text, setText] = useState(n.content);
  useEffect(() => setText(n.content), [n.content]);
  const save = (body) => api.put(`/director/notes/${n.id}`, body).then(onChange).catch((e) => notify(e.message, 'error'));
  return (
    <div className={`note ${n.active ? '' : 'inactive'}`}>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== n.content && save({ content: text })} />
      <div className="row space small">
        <label className="check"><input type="checkbox" checked={!!n.active} onChange={(e) => save({ active: e.target.checked })} /> On</label>
        <span className="muted">{timeAgo(n.created_at)}</span>
        <button className="link danger-text" onClick={async () => onChange(await api.del(`/director/notes/${n.id}`))}>Delete</button>
      </div>
    </div>
  );
}
