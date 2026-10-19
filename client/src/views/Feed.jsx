import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Avatar, AsyncButton, timeAgo } from '../components.jsx';

export default function Feed({ worldId, notify, refreshWorlds, goto }) {
  const [posts, setPosts] = useState([]);
  const [chars, setChars] = useState([]);
  const [asId, setAsId] = useState(null);
  const [text, setText] = useState('');
  const [autoReply, setAutoReply] = useState(true);
  const [count, setCount] = useState(5);
  const [topic, setTopic] = useState('');
  const [thread, setThread] = useState(null);
  const [auto, setAuto] = useState(false);
  const busy = useRef(false);

  const load = () => api.get(`/worlds/${worldId}/posts`).then(setPosts);
  useEffect(() => {
    load();
    api.get(`/worlds/${worldId}/characters`).then((cs) => {
      setChars(cs);
      setAsId((cs.find((c) => c.kind === 'player') || cs[0])?.id ?? null);
    });
  }, [worldId]);

  async function generate() {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await api.post(`/worlds/${worldId}/feed/generate`, { count, topic });
      notify(`${r.created.length} new posts`);
      await load();
      refreshWorlds();
    } finally {
      busy.current = false;
    }
  }

  // Optional "live" mode: the world keeps posting while this page is open.
  useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => generate().catch((e) => { notify(e.message, 'error'); setAuto(false); }), 120_000);
    return () => clearInterval(t);
  }, [auto, count, topic]);

  async function submit() {
    if (!text.trim()) return;
    const { id } = await api.post(`/worlds/${worldId}/posts`, { characterId: asId, content: text });
    setText('');
    await load();
    if (autoReply) {
      api.post(`/posts/${id}/replies/generate`, { count: 2 })
        .then(load)
        .catch((e) => notify(e.message, 'error'));
    }
  }

  const personas = chars.filter((c) => c.kind === 'player');
  const postAs = personas.length ? personas : chars;

  return (
    <div className="page feed-page">
      <header className="page-head">
        <h1>Feed</h1>
      </header>

      <section className="card composer">
        {chars.length ? (
          <>
            <div className="row">
              <Avatar c={chars.find((c) => c.id === asId)} />
              <select value={asId ?? ''} onChange={(e) => setAsId(Number(e.target.value))}>
                {postAs.map((c) => <option key={c.id} value={c.id}>{c.name} (@{c.handle})</option>)}
              </select>
              {!personas.length && <span className="muted small">Tip: mark a character as "You play" to make it your persona.</span>}
            </div>
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What's happening in this world?"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }} />
            <div className="row space">
              <label className="check small"><input type="checkbox" checked={autoReply} onChange={(e) => setAutoReply(e.target.checked)} /> Let characters reply</label>
              <AsyncButton className="primary" notify={notify} onClick={submit} disabled={!text.trim()}>Post</AsyncButton>
            </div>
          </>
        ) : (
          <div className="muted">No characters yet. <a onClick={() => goto('characters')}>Create or generate some</a> to get the feed going.</div>
        )}
      </section>

      <section className="card">
        <div className="row wrap">
          <AsyncButton className="primary" notify={notify} busyLabel="Generating…" onClick={generate}>Generate activity</AsyncButton>
          <label className="inline small">Posts <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(e.target.value)} style={{ width: 60 }} /></label>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Optional event/topic, e.g. 'the king just died'" style={{ flex: 1, minWidth: 200 }} />
          <label className="check small" title="Generates a batch every 2 minutes while this page is open. Uses credits!">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Live (every 2 min)
          </label>
        </div>
      </section>

      <div className="posts">
        {posts.map((p) => <Post key={p.id} p={p} onOpen={() => setThread(p.id)} onChange={load} />)}
        {!posts.length && <div className="empty small muted">The feed is quiet. Generate some activity or post something.</div>}
      </div>

      {thread && (
        <Thread id={thread} worldId={worldId} asId={asId} notify={notify} onClose={() => { setThread(null); load(); }} />
      )}
    </div>
  );
}

function Post({ p, onOpen, onChange, compact }) {
  return (
    <article className={`post ${compact ? 'compact' : ''}`}>
      <Avatar c={p} />
      <div className="post-body">
        <div className="post-head">
          <b>{p.name}</b> <span className="muted">@{p.handle} · {timeAgo(p.created_at)}</span>
          {p.kind === 'player' && <span className="badge player">you</span>}
        </div>
        <div className="post-text">{p.content}</div>
        <div className="post-actions muted small">
          {onOpen && <button className="link" onClick={onOpen}>💬 {p.replyCount || 0}</button>}
          <button className="link" onClick={async () => { await api.post(`/posts/${p.id}/like`); onChange?.(); }}>♥ {p.likes}</button>
          <button className="link" onClick={async () => { if (confirm('Delete post?')) { await api.del(`/posts/${p.id}`); onChange?.(); } }}>🗑</button>
        </div>
      </div>
    </article>
  );
}

function Thread({ id, worldId, asId, notify, onClose }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const load = () => api.get(`/posts/${id}`).then(setData);
  useEffect(() => { load(); }, [id]);

  if (!data) return null;
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row space"><h2>Thread</h2><button className="icon" onClick={onClose}>✕</button></div>
        <Post p={data.post} onChange={load} />
        <div className="replies">
          {data.replies.map((r) => <Post key={r.id} p={r} compact onChange={load} />)}
        </div>
        <div className="row">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" style={{ flex: 1 }}
            onKeyDown={async (e) => {
              if (e.key === 'Enter' && text.trim()) {
                await api.post(`/worlds/${worldId}/posts`, { characterId: asId, content: text, parentId: id });
                setText('');
                load();
              }
            }} />
          <AsyncButton notify={notify} busyLabel="Replying…" onClick={async () => { await api.post(`/posts/${id}/replies/generate`, { count: 2 }); load(); }}>
            Get AI replies
          </AsyncButton>
        </div>
      </div>
    </div>
  );
}
