import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, KindBadge, RichText, fmtCount, timeAgo } from '../components.jsx';

export default function Profile({ id, worldId, persona, chars, openProfile, openConversation, notify, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('posts');
  const load = () => api.get(`/characters/${id}/profile${persona ? `?as=${persona.id}` : ''}`).then(setData).catch((e) => { notify(e.message, 'error'); onClose(); });
  useEffect(() => { load(); }, [id, persona?.id]);
  if (!data) return null;
  const c = data.character;
  const isMe = c.kind === 'player';

  async function toggleFollow() {
    await api.post(`/characters/${c.id}/follow`, { personaId: persona.id, unfollow: data.isFollowing });
    load();
  }
  async function start(kind) {
    const r = await api.post(`/worlds/${worldId}/conversations`, {
      memberIds: [c.id], playerId: persona?.id ?? null, kind,
      setting: kind === 'scene' ? prompt(`Where are you meeting ${c.name}? (e.g. "their apartment, 2am")`) || '' : ''
    });
    onClose();
    openConversation(r.id, kind);
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row space"><span /><button className="icon" onClick={onClose}>✕</button></div>
        <div className="profile-head">
          <Avatar c={c} size={72} />
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0 }}>{c.name}</h2>
            <div className="muted">@{c.handle} {data.followsYou && <span className="badge">Follows you</span>}</div>
            <p><RichText text={c.bio} chars={chars} openProfile={openProfile} /></p>
            <div className="small"><b>{fmtCount(data.followers)}</b> <span className="muted">followers</span> · <b>{data.following}</b> <span className="muted">following</span></div>
          </div>
          {!isMe && persona && (
            <div className="profile-actions">
              <button className={data.isFollowing ? '' : 'primary'} onClick={toggleFollow}>{data.isFollowing ? 'Following' : 'Follow'}</button>
              <button onClick={() => start('dm')}>Message</button>
              <button onClick={() => start('scene')} title="Interact in real life, outside the app">Meet IRL</button>
            </div>
          )}
        </div>
        <div className="row" style={{ margin: '12px 0' }}>
          <button className={`chip ${tab === 'posts' ? 'active' : ''}`} onClick={() => setTab('posts')}>Posts</button>
          {!isMe && <button className={`chip ${tab === 'memory' ? 'active' : ''}`} onClick={() => setTab('memory')}>Memories ({data.memories.length})</button>}
          <KindBadge kind={c.kind} />
        </div>
        {tab === 'posts' && (
          <div>
            {data.posts.map((p) => (
              <div key={p.id} className="post compact">
                <div className="post-body">
                  <div className="muted small">{p.parent_id ? 'Replied' : 'Posted'} · {timeAgo(p.created_at)} · ♥ {fmtCount(p.likes)}</div>
                  <div className="post-text"><RichText text={p.content} chars={chars} openProfile={openProfile} /></div>
                </div>
              </div>
            ))}
            {!data.posts.length && <div className="muted small">No posts yet.</div>}
          </div>
        )}
        {tab === 'memory' && (
          <div>
            <p className="muted small">What {c.name} remembers. The AI uses this to keep continuity — delete anything that is wrong.</p>
            {data.memories.map((m) => (
              <div key={m.id} className="row memory">
                <span className="badge">{m.source}</span>
                <span style={{ flex: 1 }}>{m.content}</span>
                <button className="link" onClick={async () => { await api.del(`/memories/${m.id}`); load(); }}>✕</button>
              </div>
            ))}
            {!data.memories.length && <div className="muted small">No memories yet.</div>}
          </div>
        )}
      </div>
    </div>
  );
}
