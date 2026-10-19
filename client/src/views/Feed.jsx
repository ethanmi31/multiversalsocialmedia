import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Avatar, AsyncButton, RichText, Typing, fmtCount, timeAgo } from '../components.jsx';

export default function Feed(props) {
  const { worldId, world, notify, refreshWorlds, goto, persona, chars, settings } = props;
  const [posts, setPosts] = useState([]);
  const [trending, setTrending] = useState([]);
  const [text, setText] = useState('');
  const [autoReply, setAutoReply] = useState(true);
  const [count, setCount] = useState(5);
  const [topic, setTopic] = useState('');
  const [thread, setThread] = useState(null);
  const [auto, setAuto] = useState(false);
  const [ticking, setTicking] = useState('');
  const [typingOn, setTypingOn] = useState(new Set());
  const busy = useRef(false);
  const caughtUp = useRef(false);

  const load = async () => {
    setPosts(await api.get(`/worlds/${worldId}/posts`));
    const st = await api.get(`/worlds/${worldId}/state`);
    setTrending(st.storylines.filter((s) => s.status === 'active' && s.visibility !== 'private').slice(0, 5));
  };
  useEffect(() => { load(); }, [worldId]);

  const hasAi = chars.some((c) => c.kind !== 'player' && c.active);

  async function tick(label = 'The world is moving…', body = { count, topic }) {
    if (busy.current) return;
    busy.current = true;
    setTicking(label);
    try {
      const r = await api.post(`/worlds/${worldId}/tick`, body);
      notify(`${r.created.length} new posts${r.dms ? ` · ${r.dms} new DM${r.dms > 1 ? 's' : ''}` : ''}`);
      await load();
      refreshWorlds();
      props.refreshChars();
    } catch (e) {
      notify(e.message, 'error');
      setAuto(false);
    } finally {
      busy.current = false;
      setTicking('');
    }
  }

  // Coming back after a while: the world kept going without you.
  useEffect(() => {
    if (caughtUp.current || !settings || !world || !hasAi || !settings.hasApiKey) return;
    caughtUp.current = true;
    const mins = Number(settings.awayTickMinutes);
    if (mins > 0 && world.minutesSinceTick >= mins) tick('While you were away…', { count: Math.min(8, 3 + Math.floor(world.minutesSinceTick / 120)) });
  }, [settings, world?.id, hasAi]);

  // Optional live mode: the world keeps posting while this page is open.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => tick('New activity…'), 120_000);
    return () => clearInterval(t);
  }, [auto, count, topic]);

  async function withTyping(postId, fn) {
    setTypingOn((s) => new Set(s).add(postId));
    try { await fn(); } catch (e) { notify(e.message, 'error'); } finally {
      setTypingOn((s) => { const n = new Set(s); n.delete(postId); return n; });
      load();
    }
  }

  async function submit() {
    if (!text.trim() || !persona) return;
    const { id } = await api.post(`/worlds/${worldId}/posts`, { characterId: persona.id, content: text });
    setText('');
    await load();
    if (autoReply && hasAi) withTyping(id, () => api.post(`/posts/${id}/replies/generate`, {}));
  }

  return (
    <div className="page feed-page">
      <header className="page-head"><h1>Feed</h1></header>

      {trending.length > 0 && (
        <div className="trending">
          <span className="muted small">Trending</span>
          {trending.map((t) => <span key={t.id} className="trend" title={t.summary}>#{t.title.replace(/\s+/g, '')}</span>)}
        </div>
      )}

      <section className="card composer">
        {persona ? (
          <>
            <div className="row">
              <Avatar c={persona} />
              <div><b>{persona.name}</b> <span className="muted small">@{persona.handle}</span></div>
            </div>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What's happening?"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
            <div className="row space">
              <label className="check small"><input type="checkbox" checked={autoReply} onChange={(e) => setAutoReply(e.target.checked)} /> People can reply</label>
              <AsyncButton className="primary" notify={notify} onClick={submit} disabled={!text.trim()}>Post</AsyncButton>
            </div>
          </>
        ) : (
          <div className="muted">To post, <a onClick={() => goto('characters')}>create your persona</a> (a character with type "You play").</div>
        )}
      </section>

      <section className="card">
        <div className="row wrap">
          <button className="primary" disabled={!!ticking} onClick={() => tick()}>{ticking ? 'Working…' : 'Let time pass'}</button>
          <label className="inline small">Posts <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 60 }} /></label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Optional event, e.g. 'someone leaked the group chat'" style={{ flex: 1, minWidth: 200 }} />
          <label className="check small" title="A new batch every 2 minutes while this page is open. Uses credits!">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Live
          </label>
        </div>
        {!hasAi && <div className="small muted" style={{ marginTop: 8 }}>No active AI characters yet — <a onClick={() => goto('characters')}>add or generate some</a>.</div>}
      </section>

      {ticking && <Typing label={ticking} />}

      <div className="posts">
        {posts.map((p) => (
          <Post key={p.id} p={p} {...props} onOpen={() => setThread(p.id)} onChange={load} typing={typingOn.has(p.id)} />
        ))}
        {!posts.length && <div className="empty small muted">The feed is quiet. Let some time pass or post something.</div>}
      </div>

      {thread && <Thread id={thread} {...props} onClose={() => { setThread(null); load(); }} />}
    </div>
  );
}

export function Post({ p, onOpen, onChange, onReply, compact, typing, persona, chars, openProfile, notify }) {
  return (
    <article className={`post ${compact ? 'compact' : ''}`} onClick={onOpen} style={{ cursor: onOpen ? 'pointer' : 'default' }}>
      <div onClick={(e) => { e.stopPropagation(); openProfile(p.character_id); }} style={{ cursor: 'pointer' }}><Avatar c={p} /></div>
      <div className="post-body">
        <div className="post-head">
          <b className="clickable" onClick={(e) => { e.stopPropagation(); openProfile(p.character_id); }}>{p.name}</b>{' '}
          <span className="muted">@{p.handle} · {timeAgo(p.created_at)}</span>
          {p.kind === 'player' && <span className="badge player">you</span>}
        </div>
        <div className="post-text"><RichText text={p.content} chars={chars} openProfile={openProfile} /></div>
        <div className="post-actions muted small" onClick={(e) => e.stopPropagation()}>
          {onOpen && <button className="link" onClick={onOpen}>💬 {p.replyCount || 0}</button>}
          {onReply && <button className="link" onClick={() => onReply(p)}>↩ reply</button>}
          <span className="stat">🔁 {fmtCount(p.reposts)}</span>
          <button className="link" onClick={async () => {
            try { await api.post(`/posts/${p.id}/like`, { personaId: persona?.id }); onChange?.(); } catch (e) { notify(e.message, 'error'); }
          }}>♥ {fmtCount(p.likes)}</button>
          <button className="link" onClick={async () => { if (confirm('Delete post?')) { await api.del(`/posts/${p.id}`); onChange?.(); } }}>🗑</button>
        </div>
        {typing && <Typing label="People are replying" />}
      </div>
    </article>
  );
}

function Thread(props) {
  const { id, worldId, persona, notify, onClose } = props;
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const input = useRef();
  const load = () => api.get(`/posts/${id}`).then(setData);

  async function generate(body) {
    setTyping(true);
    try { await api.post(`/posts/${id}/replies/generate`, body); } catch (e) { notify(e.message, 'error'); } finally { setTyping(false); load(); }
  }

  useEffect(() => {
    load();
    // Sometimes, just looking at a thread, people are already typing...
    api.post(`/posts/${id}/view`).then((r) => r.generate && generate({})).catch(() => {});
  }, [id]);

  async function send() {
    if (!text.trim() || !persona) return;
    const r = await api.post(`/worlds/${worldId}/posts`, { characterId: persona.id, content: text, parentId: id });
    setText('');
    await load();
    generate({ humanReplyId: r.id });
  }

  if (!data) return null;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row space"><h2>Thread</h2><button className="icon" onClick={onClose}>✕</button></div>
        <Post p={data.post} {...props} onChange={load} onReply={() => input.current?.focus()} />
        <div className="replies">
          {data.replies.map((r) => (
            <Post key={r.id} p={r} {...props} compact onChange={load}
              onReply={(x) => { setText(`@${x.handle} `); input.current?.focus(); }} />
          ))}
          {typing && <Typing label="People are replying" />}
        </div>
        {persona ? (
          <div className="row">
            <Avatar c={persona} size={30} />
            <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply as ${persona.name}…`} style={{ flex: 1 }}
              onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
            <button className="primary" onClick={send} disabled={!text.trim()}>Reply</button>
            <button disabled={typing} title="Let more people chime in" onClick={() => generate({})}>More replies</button>
          </div>
        ) : (
          <div className="muted small">Create a persona to reply.</div>
        )}
      </div>
    </div>
  );
}
