import { useEffect, useRef, useState } from 'react';
import { streamJob } from '../api/client';
import type { Job, JobLogLine } from '../api/types';

export interface JobStreamState {
  logs: JobLogLine[];
  job: Job | null;
  /** Current pipeline stage (live). */
  stage: string | null;
  /** True once the job reaches a terminal status. */
  finished: boolean;
  /** Failure message, if the job failed. */
  errorMessage: string | null;
}

/**
 * Subscribe to a job's SSE stream. Replays backlog, then streams live updates.
 * Pass `null` to clear. Re-subscribes whenever the id changes.
 */
export function useJobStream(jobId: string | null): JobStreamState {
  const [logs, setLogs] = useState<JobLogLine[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const buf = useRef<JobLogLine[]>([]);

  useEffect(() => {
    setLogs([]);
    setJob(null);
    setStage(null);
    setFinished(false);
    setErrorMessage(null);
    buf.current = [];
    if (!jobId) return;

    // Batch log lines into one state update per animation frame for smoothness.
    let raf = 0;
    const flush = () => {
      raf = 0;
      if (buf.current.length) {
        setLogs((prev) => [...prev, ...buf.current]);
        buf.current = [];
      }
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(flush);
    };

    const stop = streamJob(jobId, {
      onLog: (line) => {
        buf.current.push(line);
        schedule();
      },
      onStatus: (j) => setJob(j),
      onStage: (s) => setStage(s),
      onServerError: (info) => setErrorMessage(info.error),
      onDone: () => {
        flush();
        setFinished(true);
      },
    });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      stop();
    };
  }, [jobId]);

  return { logs, job, stage: stage ?? job?.stage ?? null, finished, errorMessage };
}
