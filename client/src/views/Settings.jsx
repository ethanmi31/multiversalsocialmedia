import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { AsyncButton } from '../components.jsx';

const perMillion = (p) => (p * 1e6).toFixed(p * 1e6 < 1 ? 3 : 2);

const NUMBERS = [
  ['loreBudget', 'Lore budget (tokens)', 'Max lorebook tokens injected per request. The biggest lever on cost. 800–1500 is plenty for most chats.'],
  ['scanDepth', 'Keyword scan depth (messages)', 'How many recent messages are scanned for lore keywords.'],
  ['recentMessages', 'Recent messages kept verbatim', 'Older messages are folded into a rolling summary by the utility model.'],
  ['maxReplyTokens', 'DM reply length (tokens)', 'Caps the length of each DM / group chat reply.'],
  ['sceneMaxTokens', 'Real-life reply length (tokens)', 'Caps each narration in Real Life scenes. Raise it if scenes get cut off (~750 words per 1000 tokens).'],
  ['temperature', 'Temperature', 'Higher = more creative, lower = more consistent.'],
  ['compileChunkTokens', 'Compile chunk size (tokens)', 'Document chunk size for AI compile. Bigger chunks = fewer calls but the model may skip details.'],
  ['worldStateBudget', 'World-state budget (tokens)', 'Max tokens of storylines, relationships and memories injected per request.']
];

const LIVENESS = [
  ['dmChance', 'Chance of DMs per tick (0–1)', 'How likely characters are to slide into your DMs each time time passes.'],
  ['viewReplyChance', 'Chance of new replies when opening a thread (0–1)', 'Doubles if your reply there is still unanswered. 3-minute cooldown per thread.'],
  ['awayTickMinutes', 'Catch-up after being away (minutes)', 'Opening the feed after this long runs one "while you were away" tick. 0 = off.']
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

      <section className="card">
        <h2>Liveness</h2>
        <div className="grid2">
          {LIVENESS.map(([k, label, hint]) => (
            <label key={k}>{label}
              <input type="number" step={k === 'awayTickMinutes' ? 5 : 0.05} min={0} value={s[k]} onChange={set(k)} />
              <span className="muted small">{hint}</span>
            </label>
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Global style guide</h2>
        <p className="muted small">
          Engine instructions sent with every request in every universe (kept first so providers can cache it). Put story-specific rules in
          each universe's <i>World rules</i> instead, so they never leak into other universes.
        </p>
        <textarea rows={14} value={s.styleGuide} onChange={set('styleGuide')} />
        <div className="row space small">
          <span className="muted">~{Math.ceil((s.styleGuide || '').length / 4)} tokens per request</span>
          <button className="link" onClick={() => setS({ ...s, styleGuide: settings.defaultStyleGuide })}>Reset to default</button>
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
