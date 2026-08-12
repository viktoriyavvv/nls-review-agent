import { useEffect, useRef } from 'react';
import type { JobLogLine } from '../api/types';

const LEVEL_TAG: Record<string, string> = {
  info: 'info',
  step: 'step',
  ok: 'ok',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
  claude: 'claude',
  raw: '',
};

/** Terminal-like, auto-scrolling log viewer with an optional live stage banner. */
export function LogPanel({
  lines,
  height,
  stage,
}: {
  lines: JobLogLine[];
  height?: number;
  stage?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Track whether the user is scrolled to the bottom; only auto-scroll if so.
  function onScroll() {
    const el = ref.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    if (stick.current && ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines]);

  return (
    <>
      {stage && (
        <div className="stage-banner">
          <span className="spin" /> Stage: <b>{stage}</b>
        </div>
      )}
      <div
        className="logpanel"
        ref={ref}
        onScroll={onScroll}
        style={height ? { height } : undefined}
      >
        {lines.length === 0 && <div className="faint">No output yet.</div>}
        {lines.map((l, i) => (
          <div className={`logline log-${l.level}`} key={i}>
            <span className="lvl">{LEVEL_TAG[l.level] ?? ''}</span>
            <span className="txt">{l.text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
