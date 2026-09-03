import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTENT_DIR, LOCK_FILE_NAME, type Catalogue } from './catalogue.js';

// The lock records, per remedy, the version and the content hash last committed. A
// content change without a version bump is an error; a bump without re-locking is an
// error; so every change to a remedy shows up as a version step in git history, next to
// the diff that caused it. That is the audit trail.

export interface LockEntry {
  version: number;
  hash: string;
}

export interface LockFile {
  entries: Record<string, LockEntry>;
}

export const LOCK_FILE = join(CONTENT_DIR, LOCK_FILE_NAME);

export function buildLock(catalogue: Catalogue): LockFile {
  const entries: Record<string, LockEntry> = {};
  for (const id of catalogue.ids()) {
    const entry = catalogue.get(id);
    if (entry) entries[id] = { version: entry.remedy.version, hash: entry.hash };
  }
  return { entries };
}

export function readLock(path: string = LOCK_FILE): LockFile {
  return JSON.parse(readFileSync(path, 'utf8')) as LockFile;
}

export const RELOCK = 'run `pnpm -F @gc/remedies lock` and commit the lock with the change';

export function verifyLock(catalogue: Catalogue, lock: LockFile): string[] {
  const issues: string[] = [];
  const locked = new Set(Object.keys(lock.entries));

  for (const id of catalogue.ids()) {
    const entry = catalogue.get(id);
    if (!entry) continue;
    const was = lock.entries[id];
    const { version } = entry.remedy;
    if (!was) {
      issues.push(`${id}: new remedy, not in the lock — ${RELOCK}`);
      continue;
    }
    locked.delete(id);
    const changed = was.hash !== entry.hash;
    if (version < was.version) {
      issues.push(`${id}: version went backwards (${was.version} → ${version})`);
    } else if (version === was.version && changed) {
      issues.push(`${id}: content changed without a version bump (still ${version})`);
    } else if (version > was.version && !changed) {
      issues.push(`${id}: version bumped to ${version} without a content change`);
    } else if (version > was.version && changed) {
      issues.push(`${id}: changed to version ${version} — ${RELOCK}`);
    }
  }

  for (const id of [...locked].sort()) {
    issues.push(`${id}: removed from the catalogue but still in the lock — ${RELOCK}`);
  }

  return issues;
}
