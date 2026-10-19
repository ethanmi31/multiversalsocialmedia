import { useEffect, useRef, useState } from 'react';
import { api, streamPost } from '../api.js';
import { Avatar, AsyncButton } from '../components.jsx';

export default function Chats({ worldId, notify }) {
  const [convs, setConvs] = useState([]);
  const [chars, setChars] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    const list = await api.get(`/worlds/${worldId}/conversations`);
    setConvs(list);
    if (!list.find((c) => c.id === activeId)) setActiveId(list[0]?.id ?? null);
  };
  useEffect(() => {
    load();
    api.get(`/worlds/${worldId}/characters`).then(setChars);
  }, [worldId]);

  return (
    <div className="chats">
      <aside className="conv-list">
        <div className="row space">
          <h2>Messages</h2>
          <button className="icon" title="New conversation" onClick={() => setCreating(true)}>＋</button>
        </div>
        {convs.map((c) => (
          <button key={c.id} className={`conv ${c.id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.id)}>
            <div className="stack">{c.members.slice(0, 3).map((m) => <Avatar key={m.id} c={m} size={30} />)}</div>
            <div className="conv-text">
              <b>{c.title || c.members.map((m) => m.name).join(', ')}</b>
              <div className="muted small ellipsis">{c.lastMessage || 'No messages yet'}</div>
            </div>
          </button>
        ))}
        {!convs.length && <div className="muted small">No conversations yet.</div>}
      </aside>

      {activeId ? (
        <Conversation key={activeId} id={activeId} chars={chars} notify={notify} onChange={load} onDeleted={() => { setActiveId(null); load(); }} />
      ) : (
        <div className="empty">
          <p className="muted">Start a conversation with one or more characters.</p>
          <button className="primary" onClick={() => setCreating(true)}>New conversation</button>
        </div>
      )}

      {creating && (
        <NewConversation
          worldId={worldId}
          chars={chars}
          notify={notify}
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await load(); setActiveId(id); }}
        />
      )}
    </div>
  );
}

function NewConversation({ worldId, chars, notify, onClose, onCreated }) {
  const ai = chars.filter((c) => c.kind !== 'player');
  const personas = chars.filter((c) => c.kind === 'player');
  const [members, setMembers] = useState([]);
  const [playerId, setPlayerId] = useState(personas[0]?.id ?? '');
  const [q, setQ] = useState('');
  const toggle = (id) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : [...members, id]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New conversation</h2>
        <label>You are
          <select value={playerId} onChange={(e) => setPlayerId(e.target.value)}>
            <option value="">Yourself (no persona)</option>
            {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Talk to (pick one for a DM, several for a group chat)</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search characters…" />
        <div className="pick-list">
          {ai.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).map((c) => (
            <label key={c.id} className={`pick ${members.includes(c.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={members.includes(c.id)} onChange={() => toggle(c.id)} />
              <Avatar c={c} size={28} /> {c.name} <span className="muted small">@{c.handle}</span>
            </label>
          ))}
        </div>
        <div className="row space">
          <button onClick={onClose}>Cancel</button>
          <AsyncButton className="primary" notify={notify} disabled={!members.length} onClick={async () => {
            const r = await api.post(`/worlds/${worldId}/conversations`, { memberIds: members, playerId: playerId ? Number(playerId) : null });
            onCreated(r.id);
          }}>Start</AsyncButton>
        </div>
      </div>
    </div>
  );
}

function Conversation({ id, chars, notify, onChange, onDeleted }) {
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(null); // { speaker, text }
  const [meta, setMeta] = useState(null);
  const [nextSpeaker, setNextSpeaker] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const abort = useRef(null);
  const bottom = useRef();

  const load = () => api.get(`/conversations/${id}`).then(setConv);
  useEffect(() => { load(); return () => abort.current?.abort(); }, [id]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: 'smooth' }); }, [conv?.messages.length, streaming?.text]);

  async function reply(characterId) {
    const ac = new AbortController();
    abort.current = ac;
    setStreaming({ speaker: null, text: '' });
    try {
      await streamPost(`/conversations/${id}/reply`, { characterId: characterId || undefined }, {
        meta: (m) => { setMeta(m); setStreaming({ speaker: m.speaker, text: '' }); },
        token: (t) => setStreaming((s) => ({ ...s, text: s.text + t })),
        error: (e) => notify(e.message, 'error')
      }, ac.signal);
    } catch (e) {
      if (e.name !== 'AbortError') notify(e.message, 'error');
    } finally {
      setStreaming(null);
      await load();
      onChange();
    }
  }

  async function send() {
    const content = text.trim();
    if (!content || streaming) return;
    setText('');
    await api.post(`/conversations/${id}/messages`, { content });
    await load();
    await reply(nextSpeaker);
  }

  async function regenerate() {
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.is_player) return;
    await api.del(`/messages/${last.id}`);
    await load();
    reply(last.character_id);
  }

  if (!conv) return <div className="conv-main" />;
  const group = conv.members.length > 1;
  const player = chars.find((c) => c.id === conv.player_id);

  return (
    <div className="conv-main">
      <header className="conv-head">
        <div className="stack">{conv.members.slice(0, 4).map((m) => <Avatar key={m.id} c={m} size={34} />)}</div>
        <div style={{ flex: 1 }}>
          <b>{conv.title || conv.members.map((m) => m.name).join(', ')}</b>
          <div className="muted small">
            You are {player ? player.name : 'yourself'}
            {meta && <> · last prompt ~{meta.promptTokens} tokens · lore: {meta.lore.length ? meta.lore.join(', ') : 'none'}</>}
          </div>
        </div>
        <button className="link small" onClick={() => setShowSummary(!showSummary)}>Memory</button>
        <button className="link small danger-text" onClick={async () => { if (confirm('Delete this conversation?')) { await api.del(`/conversations/${id}`); onDeleted(); } }}>Delete</button>
      </header>

      {showSummary && (
        <div className="callout small">
          <b>Rolling summary</b> — older messages are compressed into this to keep prompts small. You can edit it.
          <textarea rows={4} defaultValue={conv.summary} onBlur={(e) => api.put(`/conversations/${id}`, { summary: e.target.value })} placeholder="Nothing summarized yet." />
        </div>
      )}

      <div className="messages">
        {conv.messages.map((m) => (
          <Message key={m.id} m={m} mine={!!m.is_player} group={group} player={player}
            onDelete={async () => { await api.del(`/messages/${m.id}`); load(); }} />
        ))}
        {streaming && (
          <Message m={{ ...streaming.speaker, content: stripPrefix(streaming.text, conv.members) || '…' }} group={group} typing />
        )}
        <div ref={bottom} />
      </div>

      <footer className="composer-bar">
        {group && (
          <select value={nextSpeaker} onChange={(e) => setNextSpeaker(e.target.value)} title="Who replies next">
            <option value="">Auto reply</option>
            {conv.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <textarea rows={1} value={text} onChange={(e) => setText(e.target.value)} placeholder="Message…"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {streaming ? (
          <button onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <>
            <button className="primary" onClick={send} disabled={!text.trim()}>Send</button>
            <button title="Let a character speak without you" onClick={() => reply(nextSpeaker)}>▶</button>
            <button title="Regenerate last reply" onClick={regenerate}>↻</button>
          </>
        )}
      </footer>
    </div>
  );
}

const stripPrefix = (text, members) => {
  const m = text.match(/^\s*\**([^:\n*]{1,40})\**\s*:\s*/);
  return m && members.some((x) => x.name.toLowerCase() === m[1].trim().toLowerCase()) ? text.slice(m[0].length) : text;
};

function Message({ m, mine, group, player, typing, onDelete }) {
  const who = mine ? player || { name: 'You', color: '#555' } : m;
  return (
    <div className={`msg ${mine ? 'mine' : ''} ${typing ? 'typing' : ''}`}>
      {!mine && <Avatar c={who} size={30} />}
      <div className="bubble">
        {group && !mine && <div className="small bold" style={{ color: who.color }}>{who.name}</div>}
        <div className="msg-text">{m.content}</div>
      </div>
      {onDelete && <button className="link small msg-del" onClick={onDelete} title="Delete">✕</button>}
    </div>
  );
}
