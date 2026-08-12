import { EventEmitter } from 'node:events';
import { Job, JobLogLine } from './types';

export interface JobEvents {
  /** A new log line was appended to a job. */
  log: (jobId: string, line: JobLogLine) => void;
  /** A job's status/fields changed (created, started, finished, ...). */
  update: (job: Job) => void;
}

/**
 * In-memory job store. Keeps the most recent N jobs and emits events so the SSE
 * endpoint can stream live logs/updates. Nothing is persisted to disk — jobs are
 * ephemeral, which is fine for a single-user local GUI.
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly order: string[] = [];
  private readonly emitter = new EventEmitter();
  private seq = 0;

  constructor(private readonly maxJobs = 100) {
    this.emitter.setMaxListeners(0);
  }

  nextId(): string {
    this.seq += 1;
    // Time-free, monotonic id (Date.now is avoided to keep things deterministic
    // in tests); uniqueness within a process is all we need.
    return `job-${this.seq.toString().padStart(4, '0')}`;
  }

  add(job: Job): Job {
    this.jobs.set(job.id, job);
    this.order.push(job.id);
    this.prune();
    this.emitter.emit('update', job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.order]
      .reverse()
      .map((id) => this.jobs.get(id))
      .filter((j): j is Job => Boolean(j));
  }

  appendLog(id: string, line: JobLogLine): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.logs.push(line);
    this.emitter.emit('log', id, line);
  }

  /** Apply a mutation and emit a single `update`. */
  patch(id: string, fn: (job: Job) => void): void {
    const job = this.jobs.get(id);
    if (!job) return;
    fn(job);
    this.emitter.emit('update', job);
  }

  onLog(fn: JobEvents['log']): () => void {
    this.emitter.on('log', fn);
    return () => this.emitter.off('log', fn);
  }

  onUpdate(fn: JobEvents['update']): () => void {
    this.emitter.on('update', fn);
    return () => this.emitter.off('update', fn);
  }

  private prune(): void {
    while (this.order.length > this.maxJobs) {
      const oldest = this.order.shift();
      if (oldest) this.jobs.delete(oldest);
    }
  }
}
