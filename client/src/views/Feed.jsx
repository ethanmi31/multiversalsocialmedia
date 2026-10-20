import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Avatar, AsyncButton, RichText, Typing, fmtCount, timeAgo } from '../components.jsx';

const loadView = (worldId) => {
  try { return JSON.parse(localStorage.getItem(`feedView:${worldId}`)) || { type: 'home' }; } catch { return { type: 'home' }; }
};

export default function Feed(baseProps) {
  const { worldId, world, notify, refreshWorlds, goto, persona, chars, settings } = baseProps;
  const [view, setView] = useState(() => loadView(worldId)); // home | explore | community {id} | tag {tag}
  const [explore, setExplore] = useState({ hashtags: [], communities: [] });
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

  const loadExplore = () => api.get(`/worlds/${worldId}/explore${persona ? `?as=${persona.id}` : ''}`).then((x) => { setExplore(x); return x; });
  const [hasMore, setHasMore] = useState(false);
  const feedQuery = (before) => {
    const q = new URLSearchParams();
    if (view.type === 'community') q.set('community', view.id);
    if (view.type === 'tag') q.set('tag', view.tag);
    if (view.type === 'search') q.set('q', view.q);
    if (persona) q.set('as', persona.id);
    if (before) q.set('before', before);
    return `/worlds/${worldId}/posts?${q}`;
  };
  async function loadOlder() {
    const older = await api.get(feedQuery(posts[posts.length - 1]?.id));
    setPosts((cur) => [...cur, ...older.filter((p) => !cur.some((c) => c.id === p.id))]);
    setHasMore(older.length >= 30);
  }
  const load = async () => {
    if (view.type !== 'explore') {
      const list = await api.get(feedQuery()).catch(() => { setView({ type: 'home' }); return []; });
      setPosts(list);
      setHasMore(list.length >= 30);
    }
    loadExplore();
    const st = await api.get(`/worlds/${worldId}/state`);
    setTrending(st.storylines.filter((s) => s.status === 'active' && s.visibility !== 'private').slice(0, 5));
  };
  useEffect(() => {
    try { localStorage.setItem(`feedView:${worldId}`, JSON.stringify(view)); } catch {}
    load();
  }, [worldId, view.type, view.id, view.tag, view.q, persona?.id]);

  const community = view.type === 'community' ? explore.communities.find((c) => c.id === view.id) : null;
  const joined = explore.communities.filter((c) => c.joined);
  const props = {
    ...baseProps,
    openTag: (tag) => { setThread(null); setView({ type: 'tag', tag }); },
    search: (q) => q.trim() && setView({ type: 'search', q: q.trim() }),
    openCommunity: (cid) => { setThread(null); setView({ type: 'community', id: cid }); }
  };

  const hasAi = chars.some((c) => c.kind !== 'player' && c.active);

  async function tick(label = 'The world is moving…', body = { count, topic, communityId: community?.id }) {
    if (busy.current) return;
    busy.current = true;
    setTicking(label);
    try {
      const r = await api.post(`/worlds/${worldId}/tick`, body);
      notify(`${r.created.length} new posts${r.dms ? ` · ${r.dms} new DM${r.dms > 1 ? 's' : ''}` : ''}${r.community ? ` · a new community formed: c/${r.community.slug}` : ''}`);
      await load();
      refreshWorlds();
      baseProps.refreshChars();
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
  }, [auto, count, topic, community?.id]);

  async function withTyping(postId, fn) {
    setTypingOn((s) => new Set(s).add(postId));
    try { await fn(); } catch (e) { notify(e.message, 'error'); } finally {
      setTypingOn((s) => { const n = new Set(s); n.delete(postId); return n; });
      load();
    }
  }

  async function submit() {
    if (!text.trim() || !persona) return;
    const { id } = await api.post(`/worlds/${worldId}/posts`, { characterId: persona.id, content: text, communityId: community?.id });
    setText('');
    await load();
    if (autoReply && hasAi) withTyping(id, () => api.post(`/posts/${id}/replies/generate`, {}));
  }

  return (
    <div className="page feed-page">
      <header className="page-head"><h1>{community ? community.name : view.type === 'tag' ? `#${view.tag}` : view.type === 'search' ? `Search: ${view.q}` : view.type === 'explore' ? 'Explore' : 'Feed'}</h1></header>

      <nav className="feed-tabs">
        <button className={`chip ${view.type === 'home' ? 'active' : ''}`} onClick={() => setView({ type: 'home' })}>Home</button>
        <button className={`chip ${view.type === 'explore' ? 'active' : ''}`} onClick={() => setView({ type: 'explore' })}># Explore</button>
        {joined.map((c) => (
          <button key={c.id} className={`chip ${view.type === 'community' && view.id === c.id ? 'active' : ''}`} onClick={() => setView({ type: 'community', id: c.id })}>c/{c.slug}</button>
        ))}
        {view.type === 'tag' && <button className="chip active">#{view.tag}</button>}
        {view.type === 'search' && <button className="chip active">🔍 {view.q}</button>}
        {community && !community.joined && <button className="chip active">c/{community.slug}</button>}
      </nav>

      {view.type === 'explore' && <Explore {...props} explore={explore} reload={loadExplore} />}

      {community && (
        <section className="card community-head">
          <div className="row space wrap">
            <div>
              <div className="muted small">c/{community.slug} · {community.members} members · {community.posts} posts</div>
              <p style={{ margin: '4px 0 0' }}>{community.description}</p>
            </div>
            {persona && (
              <AsyncButton className={community.joined ? '' : 'primary'} notify={notify} onClick={async () => {
                await api.post(`/communities/${community.id}/join`, { personaId: persona.id, leave: !!community.joined });
                loadExplore();
              }}>{community.joined ? 'Joined ✓' : 'Join'}</AsyncButton>
            )}
          </div>
        </section>
      )}

      {view.type !== 'explore' && <>
      {view.type === 'home' && trending.length > 0 && (
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
            <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={community ? `Post in c/${community.slug}…` : "What's happening?"}
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
          <button className="primary" disabled={!!ticking} onClick={() => tick()}>{ticking ? 'Working…' : community ? 'Let time pass here' : 'Let time pass'}</button>
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
        {hasMore && <AsyncButton className="load-more" notify={notify} onClick={loadOlder}>Load older posts</AsyncButton>}
        {!posts.length && <div className="empty small muted">{view.type === 'tag' ? `No posts with #${view.tag} yet.` : view.type === 'search' ? `Nothing found for "${view.q}".` : community ? 'Nothing posted here yet.' : 'The feed is quiet. Let some time pass or post something.'}</div>}
      </div>
      </>}

      {thread && <Thread id={thread} {...props} onClose={() => { setThread(null); load(); }} />}
    </div>
  );
}

export function Post({ p, onOpen, onChange, onReply, compact, typing, persona, chars, openProfile, openTag, openCommunity, notify, worldId }) {
  const [editing, setEditing] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const mine = p.kind === 'player';
  return (
    <>
    <article className={`post ${compact ? 'compact' : ''}`} onClick={onOpen} style={{ cursor: onOpen ? 'pointer' : 'default' }}>
      <div onClick={(e) => { e.stopPropagation(); openProfile(p.character_id); }} style={{ cursor: 'pointer' }}><Avatar c={p} /></div>
      <div className="post-body">
        <div className="post-head">
          <b className="clickable" onClick={(e) => { e.stopPropagation(); openProfile(p.character_id); }}>{p.name}</b>{' '}
          <span className="muted">@{p.handle} · {timeAgo(p.created_at)}</span>
          {p.kind === 'player' && <span className="badge player">you</span>}
        </div>
        {p.communitySlug && !compact && openCommunity && (
          <a className="community-chip" onClick={(e) => { e.stopPropagation(); openCommunity(p.community_id); }}>c/{p.communitySlug}</a>
        )}
        {editing != null ? (
          <div className="row" onClick={(e) => e.stopPropagation()} style={{ margin: '4px 0' }}>
            <textarea rows={2} value={editing} onChange={(e) => setEditing(e.target.value)} autoFocus />
            <div className="stack-col">
              <AsyncButton className="primary" notify={notify} onClick={async () => { await api.put(`/posts/${p.id}`, { content: editing }); setEditing(null); onChange?.(); }}>Save</AsyncButton>
              <button onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="post-text"><RichText text={p.content} chars={chars} openProfile={openProfile} openTag={openTag} />{p.edited ? <span className="muted small"> (edited)</span> : null}</div>
        )}
        {p.quoteContent != null && (
          <div className="quote-card" onClick={(e) => { e.stopPropagation(); openProfile(p.quoteCharacterId); }}>
            <div className="row small"><Avatar c={{ name: p.quoteName, color: p.quoteColor, avatar: p.quoteAvatar }} size={18} /><b>{p.quoteName}</b><span className="muted">@{p.quoteHandle}</span></div>
            <div className="small"><RichText text={p.quoteContent} chars={chars} openProfile={openProfile} openTag={openTag} /></div>
          </div>
        )}
        {p.quote_id && p.quoteContent == null && <div className="quote-card muted small">This post was deleted.</div>}
        <div className="post-actions muted small" onClick={(e) => e.stopPropagation()}>
          {onOpen && <button className="link" onClick={onOpen}>💬 {p.replyCount || 0}</button>}
          {onReply && <button className="link" onClick={() => onReply(p)}>↩ reply</button>}
          <span className="stat">🔁 {fmtCount(p.reposts)}</span>
          <button onClick={async () => {
            if (!persona) return notify('Create a persona to like posts.', 'error');
            try { await api.post(`/posts/${p.id}/like`, { personaId: persona.id }); onChange?.(); } catch (e) { notify(e.message, 'error'); }
          }} className={`link ${p.likedByMe ? 'liked' : ''}`} title={p.likedByMe ? 'Unlike' : 'Like'}>{p.likedByMe ? '♥' : '♡'} {fmtCount(p.likes)}</button>
          {!compact && persona && <button className="link" title="Quote this post" onClick={() => setQuoting(true)}>❝ quote</button>}
          {mine && <button className="link" title="Edit" onClick={() => setEditing(p.content)}>✎</button>}
          <button className="link" onClick={async () => { if (confirm('Delete post?')) { await api.del(`/posts/${p.id}`); onChange?.(); } }}>🗑</button>
        </div>
        {typing && <Typing label="People are replying" />}
      </div>
    </article>
    {quoting && <QuoteComposer p={p} persona={persona} worldId={worldId} notify={notify} onClose={() => setQuoting(false)} onPosted={() => { setQuoting(false); onChange?.(); }} />}
    </>
  );
}

function QuoteComposer({ p, persona, worldId, notify, onClose, onPosted }) {
  const [text, setText] = useState('');
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Quote post</h2>
        <div className="row"><Avatar c={persona} size={30} /><b>{persona.name}</b></div>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Add your take…" autoFocus style={{ margin: '10px 0' }} />
        <div className="quote-card small"><b>{p.name}</b> <span className="muted">@{p.handle}</span><div>{p.content}</div></div>
        <div className="row space" style={{ marginTop: 12 }}>
          <button onClick={onClose}>Cancel</button>
          <AsyncButton className="primary" notify={notify} disabled={!text.trim()} onClick={async () => {
            const { id } = await api.post(`/worlds/${worldId}/posts`, { characterId: persona.id, content: text, quoteId: p.id });
            onPosted();
            // people react to a quote like any post
            api.post(`/posts/${id}/replies/generate`, {}).then(onPosted).catch(() => {});
          }}>Post</AsyncButton>
        </div>
      </div>
    </div>
  );
}

function Thread(props) {
  const { id, worldId, persona, notify, onClose } = props;
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const input = useRef();
  const load = () => api.get(`/posts/${id}${persona ? `?as=${persona.id}` : ''}`).then(setData);

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

function Explore({ worldId, persona, notify, explore, reload, openTag, openCommunity, search }) {
  const [q, setQ] = useState('');
  async function create() {
    const name = prompt('Community name (e.g. "Snowdin", "PRIME Powered Ones"):');
    if (!name?.trim()) return;
    const description = prompt('What is it about? (optional)') || '';
    const k = await api.post(`/worlds/${worldId}/communities`, { name, description, personaId: persona?.id });
    await reload();
    openCommunity(k.id);
  }
  return (
    <>
      <section className="card">
        <div className="row">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search posts, people or @handles…" style={{ flex: 1 }}
            onKeyDown={(e) => { if (e.key === 'Enter') search(q); }} />
          <button onClick={() => search(q)} disabled={!q.trim()}>Search</button>
        </div>
      </section>
      <section className="card">
        <h2>Trending hashtags</h2>
        <div className="trending">
          {explore.hashtags.map((h) => (
            <button key={h.tag} className="trend clickable" onClick={() => openTag(h.tag)}>#{h.tag} <span className="muted small">{h.posts}</span></button>
          ))}
          {!explore.hashtags.length && <span className="muted small">No hashtags yet — they appear as people use them.</span>}
        </div>
      </section>
      <section className="card">
        <div className="row space"><h2>Communities</h2><AsyncButton notify={notify} onClick={create}>+ Create community</AsyncButton></div>
        <p className="muted small">Groups that form as the world plays out (people from one universe, a town, a fandom…). Join one to get its tab on the feed.</p>
        <div className="community-list">
          {explore.communities.map((c) => (
            <div key={c.id} className="community-row" onClick={() => openCommunity(c.id)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <b>{c.name}</b> <span className="muted small">c/{c.slug} · {c.members} members · {c.posts} posts</span>
                <div className="muted small ellipsis">{c.description}</div>
              </div>
              {persona && (
                <AsyncButton className={c.joined ? '' : 'primary'} notify={notify} onClick={async (e) => {
                  e.stopPropagation();
                  await api.post(`/communities/${c.id}/join`, { personaId: persona.id, leave: !!c.joined });
                  reload();
                }}>{c.joined ? 'Joined ✓' : 'Join'}</AsyncButton>
              )}
            </div>
          ))}
          {!explore.communities.length && <div className="muted small">No communities yet. They start forming once there's enough going on — or create one.</div>}
        </div>
      </section>
    </>
  );
}
