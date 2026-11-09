// What to tell someone when Lima itself is missing or broken (not one VM): what's wrong, and
// the next thing to try, for the OS they're on.
import type { LimaProblem } from './api';

export interface Step {
  text: string;
  /** A command to run in a terminal, shown copyable. */
  command?: string;
}

export interface LimaAdvice {
  headline: string;
  /** The error as Lima Desktop got it, when it says more than the headline. */
  detail?: string;
  steps: Step[];
  /** Where `limactl` was looked for (not installed only). */
  searched: string[];
  link?: string;
}

const INSTALL_DOCS = 'https://lima-vm.io/docs/installation/';

function installSteps(os: string): Step[] {
  if (os === 'macos') {
    return [
      { text: 'Install it with Homebrew:', command: 'brew install lima' },
      { text: 'Installed another way? Lima Desktop looks for limactl in the places below.' },
    ];
  }
  return [
    { text: "Install it from your distribution's package if that's recent, or from Lima's release." },
    { text: 'Installed already? Lima Desktop looks for limactl in the places below.' },
  ];
}

export function limaAdvice(p: LimaProblem): LimaAdvice {
  switch (p.kind) {
    case 'notInstalled':
      return {
        headline: "Lima isn't installed, or Lima Desktop can't find it",
        steps: installSteps(p.os),
        searched: p.searched,
        link: INSTALL_DOCS,
      };
    case 'failed':
      return {
        headline: "Lima isn't working",
        detail: p.message,
        steps: [{ text: 'Run it in a terminal to see the whole error:', command: 'limactl list' }],
        searched: [],
      };
    case 'notAnswering':
      return {
        headline: "Lima isn't answering",
        detail: p.message,
        steps: [
          {
            text: "A VM stuck mid-start or a lock in Lima's home (~/.lima) can do this. Check whether it hangs there too:",
            command: 'limactl list',
          },
        ],
        searched: [],
      };
    default:
      return { headline: "Lima Desktop can't read Lima", detail: p.message, steps: [], searched: [] };
  }
}
