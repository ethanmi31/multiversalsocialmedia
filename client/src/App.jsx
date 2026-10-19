import { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import { Avatar } from './components.jsx';
import Feed from './views/Feed.jsx';
import Chats from './views/Chats.jsx';
import Characters from './views/Characters.jsx';
import WorldEditor from './views/WorldEditor.jsx';
import Settings from './views/Settings.jsx';
import Usage from './views/Usage.jsx';
import Notifications from './views/Notifications.jsx';
import Profile from './views/Profile.jsx';

const TABS = [
  { id: 'feed', label: 'Feed', icon: '◎' },
  { id: 'notifications', label: 'Notifications', icon: '♪', badge: 'unreadNotifications' },
  { id: 'chats', label: 'Messages', icon: '✉', badge: 'unreadMessages' },
  { id: 'scenes', label: 'Real Life', icon: '☖' },
  { id: 'characters', label: 'Characters', icon: '☺' },
  { id: 'world', label: 'World & Lore', icon: '✦' },
  { id: 'usage', label: 'Usage', icon: '$' },
  { id: 'settings', label: 'Settings', icon: '⚙' }
];

const load = (k, d) => {
  try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
};
const store = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};

export default function App() {
  const [worlds, setWorlds] = useState([]);
  const [worldId, setWorldId] = useState(load('worldId', null));
  const [tab, setTab] = useState(load('tab', 'feed'));
  const [settings, setSettings] = useState(null);
  const [chars, setChars] = useState([]);
  const [personaId, setPersonaId] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const [openConv, setOpenConv] = useState(null);
  const [toast, setToast] = useState(null);

  const notify = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), kind === 'error' ? 7000 : 3500);
  }, []);

  const refreshWorlds = useCallback(async () => {
    const list = await api.get('/worlds');
    setWorlds(list);
    setWorldId((cur) => (list.find((w) => w.id === cur) ? cur : list[0]?.id ?? null));
    return list;
  }, []);

  const refreshChars = useCallback(async () => {
    if (!worldId) return setChars([]);
    const list = await api.get(`/worlds/${worldId}/characters`);
    setChars(list);
    // personas are per universe: never carry one over from another world
    const saved = load(`persona:${worldId}`, null);
    const ps = list.filter((c) => c.kind === 'player');
    setPersonaId(ps.find((p) => p.id === saved)?.id ?? ps[0]?.id ?? null);
  }, [worldId]);

  const refreshSettings = useCallback(() => api.get('/settings').then(setSettings), []);

  useEffect(() => { refreshWorlds(); refreshSettings(); }, []);
  useEffect(() => { store('worldId', worldId); refreshChars(); setProfileId(null); setOpenConv(null); }, [worldId]);
  useEffect(() => store('tab', tab), [tab]);
  useEffect(() => { if (worldId && personaId) store(`persona:${worldId}`, personaId); }, [personaId]);
  // keep unread badges fresh (local DB query, no AI cost)
  useEffect(() => {
    const t = setInterval(refreshWorlds, 15000);
    return () => clearInterval(t);
  }, []);

  async function createWorld() {
    const name = prompt('Name your world / universe:');
    if (!name) return;
    const w = await api.post('/worlds', { name });
    await refreshWorlds();
    setWorldId(w.id);
    setTab('world');
  }

  const world = worlds.find((w) => w.id === worldId);
  const persona = chars.find((c) => c.id === personaId) || null;
  const personas = chars.filter((c) => c.kind === 'player');
  const needsWorld = !['settings', 'usage'].includes(tab);
  const ctx = {
    worldId, world, notify, refreshWorlds, settings, chars, refreshChars, persona, personas,
    goto: setTab,
    openProfile: setProfileId,
    openConversation: (id, kind = 'dm') => { setOpenConv(id); setTab(kind === 'scene' ? 'scenes' : 'chats'); }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Multiversal</div>
        <label className="muted small">Universe</label>
        <div className="row">
          <select value={worldId ?? ''} onChange={(e) => setWorldId(Number(e.target.value))} style={{ flex: 1 }}>
            {!worlds.length && <option value="">No worlds yet</option>}
            {worlds.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <button className="icon" title="New world" onClick={createWorld}>＋</button>
        </div>
        {world && (
          <>
            <label className="muted small" style={{ marginTop: 8 }}>You are</label>
            {personas.length ? (
              <div className="row persona-pick">
                <Avatar c={persona} size={28} />
                <select value={personaId ?? ''} onChange={(e) => setPersonaId(Number(e.target.value))}>
                  {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            ) : (
              <div className="small muted">No persona yet — <a onClick={() => setTab('characters')}>create one</a> (type "You play").</div>
            )}
          </>
        )}
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={`nav ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span> {t.label}
              {t.badge && world?.[t.badge] > 0 && <span className="count">{world[t.badge]}</span>}
            </button>
          ))}
        </nav>
        {world && <div className="muted small world-stats">{world.characterCount} characters · {world.loreCount} lore · {world.postCount} posts</div>}
        {settings && !settings.hasApiKey && (
          <div className="callout small">Add your OpenRouter API key in <a onClick={() => setTab('settings')}>Settings</a> to use AI features.</div>
        )}
      </aside>

      <main className="main">
        {needsWorld && !world ? (
          <div className="empty">
            <h2>Create your first universe</h2>
            <p className="muted">Upload your world document, add your characters, and let the AI populate it with users, posts and drama.</p>
            <button className="primary" onClick={createWorld}>Create a world</button>
          </div>
        ) : (
          <>
            {tab === 'feed' && <Feed key={worldId} {...ctx} />}
            {tab === 'notifications' && <Notifications key={worldId} {...ctx} />}
            {tab === 'chats' && <Chats key={`dm${worldId}`} kind="dm" initialId={openConv} {...ctx} />}
            {tab === 'scenes' && <Chats key={`scene${worldId}`} kind="scene" initialId={openConv} {...ctx} />}
            {tab === 'characters' && <Characters key={worldId} {...ctx} />}
            {tab === 'world' && <WorldEditor key={worldId} {...ctx} onDeleted={() => refreshWorlds()} />}
            {tab === 'settings' && <Settings {...ctx} onSaved={refreshSettings} />}
            {tab === 'usage' && <Usage {...ctx} />}
          </>
        )}
      </main>

      {profileId && <Profile key={profileId} id={profileId} {...ctx} onClose={() => setProfileId(null)} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
