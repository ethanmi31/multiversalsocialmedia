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
