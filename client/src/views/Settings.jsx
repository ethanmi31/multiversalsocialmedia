import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AsyncButton } from '../components.jsx';

const perMillion = (p) => (p * 1e6).toFixed(p * 1e6 < 1 ? 3 : 2);

const NUMBERS = [
  ['loreBudget', 'Lore budget (tokens)', 'Max lorebook tokens injected per request. The biggest lever on cost. 800–1500 is plenty for most chats.'],
  ['scanDepth', 'Keyword scan depth (messages)', 'How many recent messages are scanned for lore keywords.'],
  ['recentMessages', 'Recent messages kept verbatim', 'Older messages are folded into a rolling summary by the utility model.'],
  ['maxReplyTokens', 'Max reply length (tokens)', 'Caps the length of each chat reply.'],
  ['temperature', 'Temperature', 'Higher = more creative, lower = more consistent.'],
  ['compileChunkTokens', 'Compile chunk size (tokens)', 'Document chunk size for AI compile. Bigger chunks = fewer calls but the model may skip details.']
];

export default function Settings({ settings, notify, onSaved }) {
  const [s, setS] = useState(null);
  const [models, setModels] = useState([]);

  useEffect(() => { if (settings) setS({ ...settings, apiKey: '' }); }, [settings]);
  useEffect(() => { api.get('/models').then(setModels).catch(() => {}); }, []);
  if (!s) return null;

  const set = (k) => (e) => setS({ ...s, [k]: e.target.value });
  const info = (id) => models.find((m) => m.id === id);
  const sorted = [...models].sort((a, b) => a.prompt - b.prompt);

  const ModelField = ({ k, label, hint }) => {
    const m = info(s[k]);
    return (
      <label>{label}
        <input list="models" value={s[k]} onChange={set(k)} />
        <span className="muted small">
          {hint}
          {m && <> · <b>${perMillion(m.prompt)}</b> in / <b>${perMillion(m.completion)}</b> out per 1M tokens · {Math.round(m.context / 1000)}k context</>}
          {models.length > 0 && !m && <span className="error-text"> · model not found on OpenRouter</span>}
        </span>
      </label>
    );
  };

  return (
    <div className="page">
      <header className="page-head"><h1>Settings</h1></header>

      <section className="card">
        <h2>OpenRouter</h2>
        <label>API key
          <input type="password" value={s.apiKey} onChange={set('apiKey')} placeholder={settings.hasApiKey ? `Saved (${settings.apiKeyHint}) — leave blank to keep` : 'sk-or-…'} />
          <span className="muted small">Stored locally in data/multiverse.db. Get one at openrouter.ai/keys. You can also set OPENROUTER_API_KEY.</span>
        </label>
        {ModelField({ k: 'chatModel', label: 'Chat model', hint: 'Used for live conversations (quality matters here).' })}
        {ModelField({ k: 'utilityModel', label: 'Utility model', hint: 'Used for compiling lore, generating users/posts/replies, and summaries. Pick something cheap.' })}
        <datalist id="models">
          {sorted.map((m) => <option key={m.id} value={m.id}>{`${m.name} — $${perMillion(m.prompt)}/$${perMillion(m.completion)}`}</option>)}
        </datalist>
      </section>

      <section className="card">
        <h2>Token budgets</h2>
        <div className="grid2">
          {NUMBERS.map(([k, label, hint]) => (
            <label key={k}>{label}
              <input type="number" step={k === 'temperature' ? 0.1 : 1} value={s[k]} onChange={set(k)} />
              <span className="muted small">{hint}</span>
            </label>
          ))}
        </div>
      </section>

      <div className="row">
        <AsyncButton className="primary" notify={notify} onClick={async () => { await api.put('/settings', s); notify('Settings saved'); onSaved(); }}>
          Save settings
        </AsyncButton>
      </div>
    </div>
  );
}
