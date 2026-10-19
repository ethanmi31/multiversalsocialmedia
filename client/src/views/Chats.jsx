import { useEffect, useRef, useState } from 'react';
import { api, streamPost } from '../api.js';
import { Avatar, AsyncButton, RichText, Typing } from '../components.jsx';

const COPY = {
  dm: { title: 'Messages', empty: 'Start a DM or group chat with one or more characters.', start: 'New message', placeholder: 'Message…' },
  scene: {
    title: 'Real Life',
    empty: 'Interact with characters in person, outside the app. Go to their house, confront them, hang out — what happens here ripples back into the feed.',
    start: 'New scene',
    placeholder: 'What do you do or say? e.g. *I drive to his place and bang on the door* "OPEN UP"'
  }
};

export default function Chats(props) {
  const { worldId, kind, initialId, chars, refreshWorlds } = props;
  const [convs, setConvs] = useState([]);
  const [activeId, setActiveId] = useState(initialId ?? null);
  const [creating, setCreating] = useState(false);
  const copy = COPY[kind];

  const load = async () => {
    const list = await api.get(`/worlds/${worldId}/conversations?kind=${kind}`);
    setConvs(list);
    setActiveId((cur) => (list.find((c) => c.id === cur) ? cur : list[0]?.id ?? null));
    refreshWorlds();
  };
  useEffect(() => { load(); }, [worldId, kind]);
  useEffect(() => { if (initialId) setActiveId(initialId); }, [initialId]);

  return (
    <div className="chats">
      <aside className="conv-list">
        <div className="row space">
          <h2>{copy.title}</h2>
          <button className="icon" title={copy.start} onClick={() => setCreating(true)}>＋</button>
        </div>
        {convs.map((c) => (
          <button key={c.id} className={`conv ${c.id === activeId ? 'active' : ''} ${c.unread ? 'has-unread' : ''}`} onClick={() => setActiveId(c.id)}>
            <div className="stack">{c.members.slice(0, 3).map((m) => <Avatar key={m.id} c={m} size={30} />)}</div>
            <div className="conv-text">
              <b>{c.title || c.members.map((m) => m.name).join(', ')}</b>
              <div className="muted small ellipsis">{kind === 'scene' && c.setting ? `📍 ${c.setting}` : c.lastMessage || 'Nothing yet'}</div>
            </div>
            {c.unread > 0 && <span className="count">{c.unread}</span>}
          </button>
        ))}
        {!convs.length && <div className="muted small">{copy.empty}</div>}
      </aside>

      {activeId ? (
        <Conversation key={activeId} id={activeId} {...props} onChange={load} onDeleted={() => { setActiveId(null); load(); }} />
      ) : (
        <div className="empty">
          <p className="muted">{copy.empty}</p>
          <button className="primary" onClick={() => setCreating(true)}>{copy.start}</button>
        </div>
      )}

      {creating && (
        <NewConversation {...props} chars={chars} onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await load(); setActiveId(id); }} />
      )}
    </div>
  );
}

function NewConversation({ worldId, kind, chars, persona, notify, onClose, onCreated }) {
  const ai = chars.filter((c) => c.kind !== 'player');
  const [members, setMembers] = useState([]);
  const [setting, setSetting] = useState('');
  const [q, setQ] = useState('');
  const toggle = (id) => setMembers(members.includes(id) ? members.filter((m) => m !== id) : [...members, id]);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{COPY[kind].start}</h2>
        <p className="muted small">You are <b>{persona ? persona.name : 'yourself (no persona)'}</b>. Switch persona in the sidebar.</p>
        {kind === 'scene' && (
          <label>Where / when
            <input value={setting} onChange={(e) => setSetting(e.target.value)} placeholder="e.g. Outside Tolan's house, late at night" />
          </label>
        )}
        <label>{kind === 'scene' ? 'Who is there' : 'To (one for a DM, several for a group chat)'}</label>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search characters…" />
        <div className="pick-list">
          {ai.filter((c) => `${c.name} ${c.handle}`.toLowerCase().includes(q.toLowerCase())).map((c) => (
            <label key={c.id} className={`pick ${members.includes(c.id) ? 'on' : ''}`}>
              <input type="checkbox" checked={members.includes(c.id)} onChange={() => toggle(c.id)} />
              <Avatar c={c} size={28} /> {c.name} <span className="muted small">@{c.handle}</span>
            </label>
          ))}
        </div>
        <div className="row space">
          <button onClick={onClose}>Cancel</button>
          <AsyncButton className="primary" notify={notify} disabled={!members.length} onClick={async () => {
            const r = await api.post(`/worlds/${worldId}/conversations`, { memberIds: members, playerId: persona?.id ?? null, kind, setting });
            onCreated(r.id);
          }}>Start</AsyncButton>
        </div>
      </div>
    </div>
  );
}

const stripPrefix = (text, members) => {
  const m = text.match(/^\s*\**([^:\n*]{1,40})\**\s*:\s*/);
  return m && [...members.map((x) => x.name.toLowerCase()), 'narrator'].includes(m[1].trim().toLowerCase()) ? text.slice(m[0].length) : text;
};

function Conversation({ id, kind, chars, notify, onChange, onDeleted, openProfile, openConversation, worldId }) {
  const [conv, setConv] = useState(null);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(null); // { speaker, text }
  const [meta, setMeta] = useState(null);
  const [nextSpeaker, setNextSpeaker] = useState('');
  const [showMemory, setShowMemory] = useState(false);
  const abort = useRef(null);
  const bottom = useRef();
  const scene = kind === 'scene';

  const load = () => api.get(`/conversations/${id}`).then(setConv);
  useEffect(() => { load().then(onChange); return () => abort.current?.abort(); }, [id]);
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
    const msgs = conv.messages;
    const last = msgs[msgs.length - 1];
    if (!last || last.is_player) return;
    // a reply may have been split into several bubbles: remove the whole run
    const run = [];
    for (let i = msgs.length - 1; i >= 0 && !msgs[i].is_player && msgs[i].character_id === last.character_id; i--) run.push(msgs[i].id);
    for (const mid of run) await api.del(`/messages/${mid}`);
    await load();
    reply(last.character_id);
  }

  async function meetIrl() {
    const setting = prompt('Where are you meeting? (e.g. "her apartment, right after that DM")');
    if (setting === null) return;
    const r = await api.post(`/worlds/${worldId}/conversations`, { memberIds: conv.members.map((m) => m.id), playerId: conv.player_id, kind: 'scene', setting });
    openConversation(r.id, 'scene');
  }

  if (!conv) return <div className="conv-main" />;
  const group = conv.members.length > 1;
  const player = chars.find((c) => c.id === conv.player_id);

  return (
    <div className="conv-main">
      <header className="conv-head">
        <div className="stack">{conv.members.slice(0, 4).map((m) => <span key={m.id} onClick={() => openProfile(m.id)} className="clickable"><Avatar c={m} size={34} /></span>)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <b>{conv.title || conv.members.map((m) => m.name).join(', ')}</b>
          <div className="muted small ellipsis">
            {scene && conv.setting && <>📍 {conv.setting} · </>}
            You are {player ? player.name : 'yourself'}
            {meta && <> · ~{meta.promptTokens} tokens · lore: {meta.lore.length ? meta.lore.join(', ') : 'none'}</>}
          </div>
        </div>
        {!scene && <button className="link small" onClick={meetIrl} title="Take this offline">Meet IRL</button>}
        <AsyncButton className="link small" notify={notify} busyLabel="Spreading…" title="Make what happened here affect the world now (memories, drama, posts)"
          onClick={async () => { const r = await api.post(`/conversations/${id}/observe`); notify(r.posts ? `Word got out: ${r.posts} new post(s)` : 'The world will remember this.'); }}>
          Let it spread
        </AsyncButton>
        <button className="link small" onClick={() => setShowMemory(!showMemory)}>Memory</button>
        <button className="link small danger-text" onClick={async () => { if (confirm('Delete this conversation?')) { await api.del(`/conversations/${id}`); onDeleted(); } }}>Delete</button>
      </header>

      {showMemory && (
        <div className="callout small">
          <b>Rolling summary</b> — older messages are compressed into this to keep prompts small. You can edit it.
          <textarea rows={4} defaultValue={conv.summary} onBlur={(e) => api.put(`/conversations/${id}`, { summary: e.target.value })} placeholder="Nothing summarized yet." />
        </div>
      )}

      <div className={`messages ${scene ? 'scene' : ''}`}>
        {conv.messages.map((m) => (
          <Message key={m.id} m={m} mine={!!m.is_player} group={group} player={player} scene={scene} chars={chars} openProfile={openProfile}
            onDelete={async () => { await api.del(`/messages/${m.id}`); load(); }} />
        ))}
        {streaming && (streaming.text
          ? <Message m={{ ...(streaming.speaker || {}), content: stripPrefix(streaming.text, conv.members) }} group={group} scene={scene} chars={chars} />
          : <Typing label={scene ? 'Something is happening' : `${streaming.speaker?.name || 'Someone'} is typing`} />)}
        <div ref={bottom} />
      </div>

      <footer className="composer-bar">
        {group && !scene && (
          <select value={nextSpeaker} onChange={(e) => setNextSpeaker(e.target.value)} title="Who replies next">
            <option value="">Auto reply</option>
            {conv.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        <textarea rows={scene ? 2 : 1} value={text} onChange={(e) => setText(e.target.value)} placeholder={COPY[kind].placeholder}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        {streaming ? (
          <button onClick={() => abort.current?.abort()}>Stop</button>
        ) : (
          <>
            <button className="primary" onClick={send} disabled={!text.trim()}>Send</button>
            <button title={scene ? 'Continue the scene without acting' : 'Let a character speak without you'} onClick={() => reply(nextSpeaker)}>▶</button>
            <button title="Regenerate last reply" onClick={regenerate}>↻</button>
          </>
        )}
      </footer>
    </div>
  );
}

function Message({ m, mine, group, player, scene, typing, chars, openProfile, onDelete }) {
  if (scene && !mine) {
    return (
      <div className="narration">
        <div className="msg-text"><RichText text={m.content} chars={chars} openProfile={openProfile} /></div>
        {onDelete && <button className="link small msg-del" onClick={onDelete} title="Delete">✕</button>}
      </div>
    );
  }
  const who = mine ? player || { name: 'You', color: '#555' } : m;
  return (
    <div className={`msg ${mine ? 'mine' : ''} ${typing ? 'typing' : ''} ${scene ? 'scene-action' : ''}`}>
      {!mine && <Avatar c={who} size={30} />}
      <div className="bubble">
        {group && !mine && <div className="small bold" style={{ color: who.color }}>{who.name}</div>}
        <div className="msg-text"><RichText text={m.content} chars={chars} openProfile={openProfile} /></div>
      </div>
      {onDelete && <button className="link small msg-del" onClick={onDelete} title="Delete">✕</button>}
    </div>
  );
}
