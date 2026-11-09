import { describe, expect, it } from 'vitest';
import type { LimaProblem } from './api';
import { limaAdvice } from './lima';

const problem = (o: Partial<LimaProblem> = {}): LimaProblem => ({
  kind: 'notInstalled',
  message: 'limactl not found (looked on PATH and in the usual install locations)',
  searched: ['/usr/bin', '/opt/homebrew/bin'],
  os: 'macos',
  ...o,
});

describe('advice when Lima is missing or broken', () => {
  it('not installed on macOS: Homebrew, and where it looked', () => {
    const a = limaAdvice(problem());
    expect(a.headline).toBe("Lima isn't installed, or Lima Desktop can't find it");
    expect(a.steps[0]).toEqual({ text: 'Install it with Homebrew:', command: 'brew install lima' });
    expect(a.searched).toEqual(['/usr/bin', '/opt/homebrew/bin']);
  });

  it('not installed on Linux: the distribution or the release, not Homebrew', () => {
    const a = limaAdvice(problem({ os: 'linux' }));
    expect(a.steps.some((s) => s.command === 'brew install lima')).toBe(false);
    expect(a.steps[0].text).toContain("your distribution's package");
    expect(a.link).toBe('https://lima-vm.io/docs/installation/');
  });

  it('failing: the error, and how to see all of it', () => {
    const a = limaAdvice(problem({ kind: 'failed', message: '`limactl list` failed: permission denied', searched: [] }));
    expect(a.headline).toBe("Lima isn't working");
    expect(a.detail).toBe('`limactl list` failed: permission denied');
    expect(a.steps).toContainEqual({ text: 'Run it in a terminal to see the whole error:', command: 'limactl list' });
    expect(a.searched).toEqual([]);
  });

  it('not answering: what can cause a hang', () => {
    const a = limaAdvice(problem({ kind: 'notAnswering', message: "`limactl list` didn't answer within 30 s", searched: [] }));
    expect(a.headline).toBe("Lima isn't answering");
    expect(a.detail).toContain('30 s');
    expect(a.steps.map((s) => s.text).join(' ')).toContain('hangs there too');
  });

  it('anything else: the message as it came', () => {
    const a = limaAdvice(problem({ kind: 'other', message: 'Permission denied (os error 13)', searched: [] }));
    expect(a.headline).toBe("Lima Desktop can't read Lima");
    expect(a.detail).toBe('Permission denied (os error 13)');
  });
});
