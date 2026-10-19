import { useEffect, useState } from 'react';
import { api, fmtCost, fmtNum } from '../api.js';

const TASKS = {
  chat: 'Chat replies', compile: 'Lore compile', summary: 'World summary', 'chat-summary': 'Chat memory',
  tick: 'World ticks (feed, DMs, drama)', scene: 'Real-life scenes', observe: 'Continuity tracking', 'import-characters': 'Character import',
  feed: 'Feed posts', replies: 'Post replies', 'generate-users': 'Generate users', 'draft-character': 'Draft character'
};

export default function Usage() {
  const [u, setU] = useState(null);
  const load = () => api.get('/usage').then(setU);
  useEffect(() => { load(); }, []);
  if (!u) return null;
  const total = u.totals.reduce((a, t) => a + (t.cost || 0), 0);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Usage</h1>
        <button onClick={async () => { if (confirm('Clear usage history?')) { await api.del('/usage'); load(); } }}>Reset</button>
      </header>
      <section className="card">
        <div className="big-number">{fmtCost(total)}</div>
        <div className="muted small">total spent, as reported by OpenRouter</div>
        <table>
          <thead><tr><th>Task</th><th>Calls</th><th>Input</th><th>Cached</th><th>Output</th><th>Cost</th></tr></thead>
          <tbody>
            {u.totals.map((t) => (
              <tr key={t.task}>
                <td>{TASKS[t.task] || t.task}</td><td>{t.calls}</td><td>{fmtNum(t.prompt)}</td><td>{fmtNum(t.cached)}</td><td>{fmtNum(t.completion)}</td><td>{fmtCost(t.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h2>Recent calls</h2>
        <table>
          <thead><tr><th>When</th><th>Task</th><th>Model</th><th>In</th><th>Out</th><th>Cost</th></tr></thead>
          <tbody>
            {u.recent.map((r) => (
              <tr key={r.id}>
                <td className="small">{r.created_at}</td><td>{TASKS[r.task] || r.task}</td><td className="small">{r.model}</td>
                <td>{fmtNum(r.prompt_tokens)}</td><td>{fmtNum(r.completion_tokens)}</td><td>{fmtCost(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
