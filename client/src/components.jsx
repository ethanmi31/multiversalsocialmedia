import { useState } from 'react';

export function Avatar({ c, size = 40 }) {
  const name = c?.name || '?';
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, background: c?.color || '#888', fontSize: size * 0.4 }}>
      {initials}
    </div>
  );
}

export function KindBadge({ kind }) {
  const label = { player: 'You play', custom: 'Your character', generated: 'AI generated' }[kind] || kind;
  return <span className={`badge ${kind}`}>{label}</span>;
}

/** Button that shows a busy state while its async onClick runs and reports errors. */
export function AsyncButton({ onClick, children, notify, busyLabel, ...rest }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      onClick={async (e) => {
        setBusy(true);
        try { await onClick(e); } catch (err) { notify ? notify(err.message, 'error') : alert(err.message); } finally { setBusy(false); }
      }}
    >
      {busy ? busyLabel || 'Working…' : children}
    </button>
  );
}

export const timeAgo = (iso) => {
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

export const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));

/** Post/message text with clickable @handles (only for characters in the current universe) and #hashtags. */
export function RichText({ text, chars = [], openProfile, openTag }) {
  const byHandle = new Map(chars.map((c) => [c.handle.toLowerCase(), c]));
  // same tolerance as the server: "@kael" finds @kael_storm when unambiguous
  const find = (h) => {
    const key = h.toLowerCase();
    if (byHandle.has(key)) return byHandle.get(key);
    const hits = key.length >= 3 ? chars.filter((c) => c.handle.toLowerCase().startsWith(key) || c.name.toLowerCase().split(/\s+/)[0] === key) : [];
    return hits.length === 1 ? hits[0] : null;
  };
  const parts = String(text).split(/(@[A-Za-z0-9_]+|#[A-Za-z]\w{1,40})/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('#') && openTag) return <a key={i} className="mention" onClick={(e) => { e.stopPropagation(); openTag(p.slice(1)); }}>{p}</a>;
        const c = p.startsWith('@') && find(p.slice(1));
        return c ? <a key={i} className="mention" onClick={(e) => { e.stopPropagation(); openProfile?.(c.id); }}>{p}</a> : p;
      })}
    </>
  );
}

export function Typing({ label = 'Someone is typing' }) {
  return <div className="typing-ind small muted">{label}<span className="dots"><i /><i /><i /></span></div>;
}
