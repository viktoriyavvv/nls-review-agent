import type { JobStatus } from '../api/types';

type Color = 'green' | 'yellow' | 'red' | 'blue' | 'gray';

function verdictColor(v: string): Color {
  switch (v.toUpperCase()) {
    case 'APPROVE':
      return 'green';
    case 'HOLD':
      return 'yellow';
    case 'DECLINE':
      return 'red';
    case 'STOP':
      return 'red';
    default:
      return 'gray';
  }
}

export function VerdictBadge({ verdict }: { verdict?: string | null }) {
  if (!verdict) return <span className="badge gray">—</span>;
  return <span className={`badge ${verdictColor(verdict)}`}>{verdict.toUpperCase()}</span>;
}

const STATUS_COLOR: Record<JobStatus, Color> = {
  queued: 'gray',
  running: 'blue',
  success: 'green',
  failed: 'red',
  cancelled: 'gray',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const cls = STATUS_COLOR[status];
  return (
    <span className={`badge ${cls} ${status === 'running' ? 'pulse' : ''}`}>
      {status === 'running' && <span className="spin" />}
      {status}
    </span>
  );
}

export function BoolBadge({ value, yes = 'yes', no = 'no' }: { value: boolean; yes?: string; no?: string }) {
  return <span className={`badge ${value ? 'green' : 'gray'}`}>{value ? yes : no}</span>;
}
