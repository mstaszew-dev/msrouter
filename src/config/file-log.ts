/**
 * Size-rotated log file stream for msrouter.
 *
 * The gateway used to log to stdout only (see logger.ts), so a gateway
 * started outside `run.sh dev` left nothing durable: .run/gateway.log went
 * stale and the chain's per-entry failure detail was unrecoverable. This is
 * the file half of that gap - the python agent already had one (5MB x 3), so
 * the rotation shape matches it rather than inventing a second convention.
 *
 * Writes go through a plain fd (no stream buffer) so a size check sees the
 * bytes as they land and rotation cannot be defeated by buffering.
 */

import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';

export interface RotatingFileOptions {
  /** Rotate once the live file exceeds this many bytes. */
  maxBytes: number;
  /** How many rotated chunks to keep (msrouter.log.1 ... .N). */
  maxFiles: number;
  /** Truncate on open (default) so a restart never appends to a stale file. */
  truncate?: boolean;
}

/** One open fd plus its rotation state. */
export interface RotatingFile {
  write(chunk: string): void;
  end(): Promise<void>;
}

export function createLogFileStream(
  path: string,
  maxBytes: number,
  maxFiles: number,
  opts: Partial<RotatingFileOptions> = {},
): RotatingFile {
  const truncate = opts.truncate ?? true;
  let fd = openSync(path, truncate ? 'w' : 'a');
  let size = currentSize(path, fd);

  const rotate = (): void => {
    closeSync(fd);
    // Drop the oldest, then shift .1 -> .2 ... so .1 is always newest.
    const oldest = `${path}.${maxFiles}`;
    try {
      unlinkSync(oldest);
    } catch {
      /* absent is fine */
    }
    for (let i = maxFiles - 1; i >= 1; i--) {
      try {
        renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {
        /* absent is fine */
      }
    }
    try {
      renameSync(path, `${path}.1`);
    } catch {
      /* absent is fine */
    }
    fd = openSync(path, 'w');
    size = 0;
  };

  return {
    write(chunk: string): void {
      const buf = Buffer.from(chunk, 'utf8');
      // Rotate BEFORE writing so a chunk never straddles two files.
      if (size > 0 && size + buf.length > maxBytes) rotate();
      writeSync(fd, buf);
      size += buf.length;
    },
    end(): Promise<void> {
      return new Promise((resolve) => {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
        resolve();
      });
    },
  };
}

function currentSize(path: string, fd: number): number {
  try {
    return statSync(path).size;
  } catch {
    void fd;
    return 0;
  }
}