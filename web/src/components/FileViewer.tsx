import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { CopyButton } from './CopyButton';

const LARGE = 256 * 1024; // warn before loading files bigger than 256 KB

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

interface Props {
  issueKey: string;
  repoId: string;
  path: string;
  size: number;
}

/** Read-only viewer for one output file (monospace, horizontal scroll). */
export function FileViewer({ issueKey, repoId, path, size }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const needsConfirm = size > LARGE && !confirmed;

  useEffect(() => {
    setContent(null);
    setError(null);
    setConfirmed(false);
  }, [path]);

  useEffect(() => {
    if (needsConfirm || content !== null) return;
    let cancelled = false;
    setLoading(true);
    api
      .file(issueKey, repoId, path)
      .then((f) => {
        if (cancelled) return;
        setContent(f.content);
        setTruncated(f.truncated);
      })
      .catch((e) => !cancelled && setError(String(e.message ?? e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [issueKey, repoId, path, needsConfirm, content]);

  return (
    <div>
      <div className="section-title" style={{ marginBottom: 8 }}>
        <div className="mono faint">
          {path} · {fmtSize(size)}
          {truncated && <span className="badge yellow" style={{ marginLeft: 8 }}>truncated</span>}
        </div>
        <CopyButton text={content} label="Copy file" />
      </div>

      {needsConfirm && (
        <div className="banner warn">
          Large file ({fmtSize(size)}).{' '}
          <button className="btn sm" onClick={() => setConfirmed(true)}>
            Load anyway
          </button>
        </div>
      )}
      {loading && (
        <div className="muted">
          <span className="spin" /> Loading…
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {content !== null && <pre className="codeblock">{content}</pre>}
    </div>
  );
}
