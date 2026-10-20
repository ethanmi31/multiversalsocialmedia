import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Avatar, timeAgo } from '../components.jsx';

const VERB = {
  reply: 'replied to your post',
  mention: 'mentioned you',
  follow: 'followed you',
  like: 'liked your post',
  quote: 'quoted your post',
  dm: 'sent you a message',
  event: ''
};
const ICON = { reply: '💬', mention: '@', follow: '➕', like: '♥', dm: '✉', event: '🔥', quote: '❝' };

export default function Notifications({ worldId, refreshWorlds, openProfile, openConversation, personas }) {
  const [items, setItems] = useState([]);
  const multi = personas.length > 1;

  useEffect(() => {
    api.get(`/worlds/${worldId}/notifications`).then((list) => {
      setItems(list);
      api.post(`/worlds/${worldId}/notifications/read`).then(refreshWorlds);
    });
  }, [worldId]);

  return (
    <div className="page feed-page">
      <header className="page-head"><h1>Notifications</h1></header>
      <div className="card notif-list">
        {items.map((n) => (
          <div key={n.id} className={`notif ${n.read ? '' : 'unread'}`}
            onClick={() => (n.type === 'dm' && n.conversation_id ? openConversation(n.conversation_id) : n.actor_id && openProfile(n.actor_id))}>
            <span className="notif-icon">{ICON[n.type]}</span>
            {n.actor_id && <Avatar c={{ name: n.actorName, color: n.actorColor, avatar: n.actorAvatar }} size={30} />}
            <div className="notif-body">
              <div>
                {n.actor_id && <b>{n.actorName}</b>} {n.text && !n.actor_id ? n.text : VERB[n.type]}
                {multi && n.personaHandle && <span className="muted small"> · @{n.personaHandle}</span>}
                <span className="muted small"> · {timeAgo(n.created_at)}</span>
              </div>
              {(n.type === 'dm' ? n.text : n.postContent) && <div className="muted small ellipsis">{n.type === 'dm' ? n.text : n.postContent}</div>}
            </div>
          </div>
        ))}
        {!items.length && <div className="muted small">Nothing yet. Post something and see who notices.</div>}
      </div>
    </div>
  );
}
