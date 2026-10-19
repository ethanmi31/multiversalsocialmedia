import { useEffect, useState, useCallback } from 'react';
import { api } from './api.js';
import Feed from './views/Feed.jsx';
import Chats from './views/Chats.jsx';
import Characters from './views/Characters.jsx';
import WorldEditor from './views/WorldEditor.jsx';
import Settings from './views/Settings.jsx';
import Usage from './views/Usage.jsx';

const TABS = [
  { id: 'feed', label: 'Feed', icon: '◎' },
  { id: 'chats', label: 'Messages', icon: '✉' },
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
  const [toast, setToast] = useState(null);

  const notify = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), kind === 'error' ? 7000 : 3500);
  }, []);

  const refreshWorlds = useCallback(async () => {
    const list = await api.get('/worlds');
    setWorlds(list);
    if (!list.find((w) => w.id === worldId)) setWorldId(list[0]?.id ?? null);
    return list;
  }, [worldId]);

  const refreshSettings = useCallback(() => api.get('/settings').then(setSettings), []);

  useEffect(() => { refreshWorlds(); refreshSettings(); }, []);
  useEffect(() => store('worldId', worldId), [worldId]);
  useEffect(() => store('tab', tab), [tab]);

  async function createWorld() {
    const name = prompt('Name your world / universe:');
    if (!name) return;
    const w = await api.post('/worlds', { name });
    await refreshWorlds();
    setWorldId(w.id);
    setTab('world');
  }

  const world = worlds.find((w) => w.id === worldId);
  const needsWorld = !['settings', 'usage'].includes(tab);
  const ctx = { worldId, world, notify, refreshWorlds, settings, goto: setTab };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">Multiversal</div>
        <label className="muted small">Universe</label>
        <div className="row">
          <select value={worldId ?? ''} onChange={(e) => setWorldId(Number(e.target.value))} style={{ flex: 1 }}>
            {!worlds.length && <option value="">No worlds yet</option>}
            {worlds.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <button className="icon" title="New world" onClick={createWorld}>＋</button>
        </div>
        {world && (
          <div className="muted small world-stats">
            {world.characterCount} characters · {world.loreCount} lore entries · {world.postCount} posts
          </div>
        )}
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={`nav ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
              <span className="nav-icon">{t.icon}</span> {t.label}
            </button>
          ))}
        </nav>
        {settings && !settings.hasApiKey && (
          <div className="callout small">
            Add your OpenRouter API key in <a onClick={() => setTab('settings')}>Settings</a> to use AI features.
          </div>
        )}
      </aside>

      <main className="main">
        {needsWorld && !world ? (
          <div className="empty">
            <h2>Create your first universe</h2>
            <p className="muted">Upload your world document, add your characters, and let the AI populate it with users, posts and conversations.</p>
            <button className="primary" onClick={createWorld}>Create a world</button>
          </div>
        ) : (
          <>
            {tab === 'feed' && <Feed key={worldId} {...ctx} />}
            {tab === 'chats' && <Chats key={worldId} {...ctx} />}
            {tab === 'characters' && <Characters key={worldId} {...ctx} />}
            {tab === 'world' && <WorldEditor key={worldId} {...ctx} onDeleted={() => refreshWorlds()} />}
            {tab === 'settings' && <Settings {...ctx} onSaved={refreshSettings} />}
            {tab === 'usage' && <Usage {...ctx} />}
          </>
        )}
      </main>

      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
