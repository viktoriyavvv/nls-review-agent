/* Minimal dependency-free leveled logger. */

let verbose = false;

export function setVerbose(value: boolean): void {
  verbose = value;
}

export const logger = {
  info(msg: string): void {
    console.log(`[info]  ${msg}`);
  },
  step(msg: string): void {
    console.log(`[step]  ${msg}`);
  },
  /** Marks a pipeline stage transition (parsed by the GUI job runner). */
  stage(name: string): void {
    console.log(`[stage] ${name}`);
  },
  success(msg: string): void {
    console.log(`[ok]    ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`[warn]  ${msg}`);
  },
  error(msg: string): void {
    console.error(`[error] ${msg}`);
  },
  debug(msg: string): void {
    if (verbose) console.log(`[debug] ${msg}`);
  },
};
