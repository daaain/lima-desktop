// The layout of a snapshot directory (written by src-tauri/examples/snapshot.rs), shared by the
// replay and the anonymiser. Keep in step with that recorder.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const MANIFEST = 'manifest.json';
export const LIST = 'limactl-list.jsonl';
export const MARKER = 'managed-by.json';
export const PROBE = 'probe.txt';
export const JOURNAL = 'journal.out';
export const STATS = 'stats.jsonl';

/** What a `limactl list` row keeps (shared with the recorder): `rowFields`, and of `config` only
 * socket port-forwards (their `portForwardFields`) and the marker. */
export const ROW = JSON.parse(readFileSync(new URL('./snapshot-row.json', import.meta.url), 'utf8'));

/** libpod GETs recorded once (path under `/v4.0.0/libpod` → file in `vms/<vm>/libpod/`). */
export const LIBPOD_ONCE = {
  '/containers/json?all=true': 'containers.json',
  '/images/json?all=true': 'images.json',
  '/volumes/json': 'volumes.json',
  '/system/df': 'system-df.json',
};
/** Recorded once a second, one body per line of `STATS`. */
export const LIBPOD_STATS = '/containers/stats?stream=false';

export const vmDir = (snapshot, vm) => join(snapshot, 'vms', vm);
export const libpodDir = (snapshot, vm) => join(vmDir(snapshot, vm), 'libpod');

/** JSON.parse that keeps integers beyond 2^53 (podman's `SystemNano`) digit for digit. */
export function parseJson(text) {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && /^-?\d+$/.test(context?.source ?? '')
      ? JSON.rawJSON(context.source)
      : value,
  );
}

/** The probe's output as blocks of lines, each without its `.` terminator. */
export function splitBlocks(text) {
  const blocks = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (line === '.') {
      blocks.push(cur);
      cur = [];
    } else if (line !== '') {
      cur.push(line);
    }
  }
  return blocks;
}

export const joinBlocks = (blocks) => blocks.map((b) => [...b, '.'].join('\n') + '\n').join('');

/** Non-empty lines (the list and stats files are one JSON document per line). */
export const jsonLines = (text) => text.split('\n').filter((l) => l.trim() !== '');
