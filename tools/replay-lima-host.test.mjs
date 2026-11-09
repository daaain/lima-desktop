// node --test tools/   (the replay's pure parts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  scriptKind,
  sshTarget,
  rewriteRow,
  probeLooper,
  statsLooper,
} from './replay-lima-host.mjs';
import { splitBlocks } from './snapshot-format.mjs';

const src = (p) => readFileSync(new URL(`../src-tauri/src/${p}`, import.meta.url), 'utf8');

test('recognises the real probe and journal scripts, and nothing else', () => {
  assert.equal(scriptKind(src('probe.sh')), 'probe');
  const journal = src('journal.rs');
  const start = journal.indexOf('# lima-desktop OOM reader');
  assert.ok(start > 0, 'journal.rs still carries the reader header');
  assert.equal(scriptKind(journal.slice(start)), 'journal');
  assert.equal(scriptKind('echo hello\n'), null);
  assert.equal(scriptKind(''), null);
});

test('finds the VM in the app\'s ssh arguments', () => {
  const args = ['-F', '/w/lima/acme/ssh.config', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    '-T', 'lima-acme', '/bin/sh', '-s'];
  assert.equal(sshTarget(args), 'acme');
  assert.equal(sshTarget(['-F', 'lima-x.config', 'lima-vm-b', 'sh']), 'vm-b');
  assert.equal(sshTarget(['-T', 'otherhost', '/bin/sh']), null);
});

test('rewrites every path under the recorded Lima home into the workdir', () => {
  const row = JSON.stringify({
    name: 'acme', dir: '/Users/me/.lima/acme', sshConfigFile: '/Users/me/.lima/acme/ssh.config',
    config: { portForwards: [{ guestSocket: '/run/user/501/podman/podman.sock',
      hostSocket: '/Users/me/.lima/acme/sock/podman.sock' }] },
  });
  const out = JSON.parse(rewriteRow(row, '/Users/me/.lima', '/tmp/w/lima'));
  assert.equal(out.dir, '/tmp/w/lima/acme');
  assert.equal(out.sshConfigFile, '/tmp/w/lima/acme/ssh.config');
  assert.equal(out.config.portForwards[0].hostSocket, '/tmp/w/lima/acme/sock/podman.sock');
  assert.equal(out.config.portForwards[0].guestSocket, '/run/user/501/podman/podman.sock');
});

const block = (up, user, idle, psi, oom, gOom) => [
  `U ${up}`,
  `C cpu  ${user} 0 10 ${idle} 0 0 0 0 0 0`, // two spaces, as /proc/stat prints it
  'M MemTotal: 8000000',
  `P memory some total=${psi}`,
  `O ${oom}`,
  'D 100 50',
  `G ${'a'.repeat(64)} 4096 ${gOom}`,
].join('\n') + '\n.\n';

// three blocks a second apart: user +10 and idle +90 jiffies per step, one OOM kill in the middle
const PROBE = block('100.00', 1000, 9000, 500, 3, 1)
  + block('101.00', 1010, 9090, 600, 4, 2)
  + block('102.00', 1020, 9180, 700, 4, 2);

const field = (lines, prefix, i) => lines.find((l) => l.startsWith(prefix)).split(/\s+/)[i];

test('the first loop replays the probe as recorded', () => {
  const at = probeLooper(splitBlocks(PROBE));
  assert.equal(at(0).join('\n') + '\n.\n', block('100.00', 1000, 9000, 500, 3, 1));
  assert.equal(at(2).join('\n') + '\n.\n', block('102.00', 1020, 9180, 700, 4, 2));
});

test('a rewritten line keeps its spacing', () => {
  const seam = probeLooper(splitBlocks(PROBE))(3);
  assert.equal(seam.find((l) => l.startsWith('C ')), 'C cpu  1030 0 10 9270 0 0 0 0 0 0');
});

test('later loops keep cumulative counters rising by one mean step across the seam', () => {
  const at = probeLooper(splitBlocks(PROBE));
  const last = at(2);
  const seam = at(3); // loop 1, block 0
  assert.equal(field(seam, 'U ', 1), '103.00', 'uptime carries on');
  assert.equal(field(seam, 'C cpu', 2), '1030', 'user jiffies: +10 over the seam');
  assert.equal(field(seam, 'C cpu', 5), '9270', 'idle jiffies: +90 over the seam');
  assert.equal(field(seam, 'P memory', 3), 'total=800');
  assert.equal(field(last, 'C cpu', 4), '10', 'a counter that never moved stays put');
  assert.equal(field(at(3), 'C cpu', 4), '10');
  assert.equal(field(at(7), 'U ', 1), '107.00', 'loop 2, block 1');
});

test('OOM counters hold at their last value instead of replaying the kills', () => {
  const at = probeLooper(splitBlocks(PROBE));
  for (const tick of [3, 4, 5, 9]) {
    assert.equal(field(at(tick), 'O ', 1), '4', `vm oom_kill at tick ${tick}`);
    assert.equal(field(at(tick), 'G ', 3), '2', `container oom_kill at tick ${tick}`);
  }
  assert.equal(field(at(3), 'G ', 2), '4096', 'memory.peak is a reading, not a counter');
});

test('a probe needs two blocks to loop', () => {
  assert.throws(() => probeLooper(splitBlocks(block('1.00', 1, 1, 1, 0, 0))), /two blocks/);
});

const stats = (cpu, net, mem) => JSON.stringify({
  Error: null,
  Stats: [{ ContainerID: 'c1', Name: 'web', CPUNano: cpu, NetInput: net, NetOutput: 0,
    BlockInput: 0, BlockOutput: 0, MemUsage: mem, SystemNano: 1794250573632955100 }],
});

test('stats cycle per request, counters offset on later loops, gauges as recorded', () => {
  const at = statsLooper([stats(1000, 50, 7), stats(3000, 150, 9)]);
  const read = (n) => JSON.parse(at(n)).Stats[0];
  assert.deepEqual([read(0).CPUNano, read(1).CPUNano], [1000, 3000]);
  assert.equal(read(2).CPUNano, 5000, 'loop 1: +2000 per step carries on');
  assert.equal(read(3).CPUNano, 7000);
  assert.equal(read(2).NetInput, 250);
  assert.equal(read(2).MemUsage, 7, 'memory is a gauge');
  assert.ok(at(2).includes('1794250573632955100'), 'big integers keep their digits');
});

test('a container that appears mid-recording loops on its own span', () => {
  const two = JSON.stringify({ Error: null, Stats: [
    { ContainerID: 'c1', CPUNano: 10 }, { ContainerID: 'c2', CPUNano: 100 }] });
  const one = JSON.stringify({ Error: null, Stats: [{ ContainerID: 'c1', CPUNano: 0 }] });
  const at = statsLooper([one, two, two.replace('"CPUNano":100', '"CPUNano":200')]);
  const c2 = JSON.parse(at(4)).Stats.find((s) => s.ContainerID === 'c2');
  assert.equal(c2.CPUNano, 100 + 100 * 3, 'its step (100) times the loop length (3)');
});

test('a counter that resets mid-recording still never goes backwards across loops', () => {
  const at = statsLooper([stats(100, 0, 1), stats(200, 0, 1), stats(0, 0, 1), stats(50, 0, 1)]);
  const cpu = (n) => JSON.parse(at(n)).Stats[0].CPUNano;
  assert.ok(cpu(4) > cpu(3), `seam: ${cpu(3)} → ${cpu(4)}`);
  assert.ok(cpu(8) > cpu(7));
});
