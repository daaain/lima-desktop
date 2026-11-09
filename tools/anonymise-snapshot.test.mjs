// node --test tools/   (the anonymiser, on a tiny synthetic snapshot)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { anonymise, findSurvivors } from './anonymise-snapshot.mjs';

const ID1 = 'f'.repeat(8) + '0123456789abcdef'.repeat(3) + 'a'.repeat(8); // a container
const ID2 = 'e'.repeat(64);
const IMG1 = '1a'.repeat(32);
const IMG2 = '2b'.repeat(32);
const POD = '3c'.repeat(32);
const DIGEST = '4d'.repeat(32);
const BOOT = '5e'.repeat(16);

const SECRETS = ['alice', '/Users/alice', 'bob', '/home/bob.guest', 'secretproj', 'other-vm', 'acme', 'acme-web-1', 'acme-corp',
  'acme-pod', 'acme_pgdata', 'ghcr.io/acme-corp/web', 'hunter2', 's3cr3t-label', '51234', 'webdb'];

function write(path, text) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
}

const probeBlock = (up, user) => `U ${up}\nC cpu  ${user} 0 10 900 0 0 0 0 0 0\nM MemTotal: 8000\n` +
  `P memory some total=${user * 3}\nO 0\nD 100 50\nG ${ID1} 4096 0\n.\n`;

function syntheticSnapshot() {
  const s = mkdtempSync(join(tmpdir(), 'snap-'));
  const vm = join(s, 'vms', 'secretproj');
  write(join(s, 'manifest.json'), JSON.stringify({
    format: 1, recordedAt: 1794250869337, recordedAtUtc: '2026-11-09T19:01:09Z', seconds: 3,
    limaVersion: '2.1.3',
    host: { user: 'alice', home: '/Users/alice', limaHome: '/Users/alice/.lima',
      guestUsers: [{ name: 'bob', home: '/home/bob.guest' }] },
    vms: [
      { name: 'secretproj', status: 'Running', podman: true, journal: { exit: 0, stderr: '' },
        libpodErrors: {}, probeBlocks: 3, statsSamples: 3 },
      { name: 'other-vm', status: 'Stopped' },
    ],
  }));
  const rows = [
    { name: 'secretproj', hostname: 'lima-secretproj', status: 'Running', dir: '/Users/alice/.lima/secretproj',
      vmType: 'vz', arch: 'aarch64', cpus: 4, memory: 8589934592, disk: 107374182400,
      message: 'run podman system connection add lima-secretproj …', sshLocalPort: 51234,
      sshConfigFile: '/Users/alice/.lima/secretproj/ssh.config', hostAgentPID: 4242, driverPID: 4242,
      protected: false, limaVersion: '2.1.3', LimaHome: '/Users/alice/.lima',
      IdentityFile: '/Users/alice/.lima/_config/user', network: [{ macAddress: '52:55:55:12:34:56' }],
      config: {
        provision: [{ mode: 'system', script: 'export TOKEN=hunter2' }],
        mounts: [{ location: '/Users/alice/work/secretproj' }],
        portForwards: [
          { guestSocket: '/run/user/501/podman/podman.sock', hostSocket: '/Users/alice/.lima/secretproj/sock/podman.sock' },
          { guestPort: 8080, hostPort: 8080 },
        ],
      } },
    { name: 'other-vm', status: 'Stopped', dir: '/Users/alice/.lima/other-vm', cpus: 2, memory: 4294967296,
      sshConfigFile: '/Users/alice/.lima/other-vm/ssh.config', LimaHome: '/Users/alice/.lima', config: {} },
  ];
  write(join(s, 'limactl-list.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write(join(s, 'vms', 'other-vm', 'managed-by.json'), JSON.stringify({
    version: 1, instance: 'other-vm', manager: 'foldyard', group: 'acme-corp',
    url: 'https://github.com/acme-corp/x', locked: ['delete'], hint: "Created for acme-corp's 'other-vm'",
  }));
  write(join(vm, 'probe.txt'), probeBlock('100.00', 1000) + probeBlock('101.00', 1010) + probeBlock('102.00', 1020));
  write(join(vm, 'journal.out'), JSON.stringify({
    __CURSOR: `s=${BOOT};i=1;b=${BOOT}`, __REALTIME_TIMESTAMP: '1794229820051112', _BOOT_ID: BOOT,
    MESSAGE: `oom-kill:constraint=CONSTRAINT_MEMCG,oom_memcg=/user.slice/user-501.slice/user@501.service/user.slice/libpod-${ID1}.scope,task=python3,pid=1234,uid=501`,
  }) + '\n');
  const libpod = join(vm, 'libpod');
  write(join(libpod, 'containers.json'), JSON.stringify([
    { Id: ID1, Names: ['acme-web-1'], Image: 'ghcr.io/acme-corp/web:1.2', ImageID: IMG1, State: 'running',
      Status: 'Up 2 minutes', Created: '2026-11-08T20:44:53Z', PodName: '', Pod: '',
      Labels: { 'com.docker.compose.project': 'acme', 'com.docker.compose.service': 'webdb', 'com.acme.secret': 's3cr3t-label' },
      Networks: ['acme_default'], Ports: [{ host_port: 8080 }] },
    { Id: ID2, Names: ['db'], Image: 'docker.io/library/postgres:16', ImageID: IMG2, State: 'exited',
      Labels: null, PodName: 'acme-pod', Pod: POD },
  ]));
  const stat = (cpu) => JSON.stringify({ Error: null, Stats: [{ ContainerID: ID1, Name: 'acme-web-1',
    CPUNano: cpu, MemUsage: 7, SystemNano: 1794250573632955100 }] });
  write(join(libpod, 'stats.jsonl'), [stat(1000), stat(2000), stat(3000)].join('\n') + '\n');
  write(join(libpod, 'images.json'), JSON.stringify([
    { Id: IMG1, RepoTags: ['ghcr.io/acme-corp/web:1.2'], RepoDigests: [`ghcr.io/acme-corp/web@sha256:${DIGEST}`],
      Names: ['ghcr.io/acme-corp/web:1.2'], History: ['ghcr.io/acme-corp/web:1.2'], Size: 1234,
      Labels: { 'org.opencontainers.image.source': 'https://github.com/acme-corp/web' }, Containers: 1 },
    { Id: IMG2, RepoTags: ['docker.io/library/postgres:16'], Size: 99, Labels: null, Containers: 1 },
  ]));
  write(join(libpod, 'version.json'), JSON.stringify({
    Version: '5.8.9', ApiVersion: '1.44', MinAPIVersion: '1.24', GitCommit: 'deadbeef', Built: 1, OsArch: 'linux/arm64' }));
  write(join(libpod, 'volumes.json'), JSON.stringify([
    { Name: 'acme_pgdata', Driver: 'local',
      Mountpoint: '/home/bob.guest/.local/share/containers/storage/volumes/acme_pgdata/_data',
      Labels: { 'com.docker.compose.project': 'acme', 'com.docker.compose.volume': 'pgdata' },
      Options: { device: '/Users/alice/secret' }, MountCount: 0 },
  ]));
  write(join(libpod, 'system-df.json'), JSON.stringify({
    Images: [{ Repository: 'ghcr.io/acme-corp/web', Tag: '1.2', ImageID: IMG1, Size: 1234 }],
    Containers: [{ ContainerID: ID1, Image: IMG1, Names: 'acme-web-1', Size: 5 }],
    Volumes: [{ VolumeName: 'acme_pgdata', Size: 77 }],
  }));
  return s;
}

function run(opts = {}) {
  const out = join(mkdtempSync(join(tmpdir(), 'fixture-')), 'out');
  anonymise(syntheticSnapshot(), out, { ...opts, quiet: true });
  const read = (p) => readFileSync(join(out, p), 'utf8');
  const json = (p) => JSON.parse(read(p));
  return { out, read, json };
}

function allText(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${join(e.parentPath, e.name)}\n${readFileSync(join(e.parentPath, e.name), 'utf8')}`)
    .join('\n');
}

test('VMs get neutral names, in list order, everywhere', () => {
  const { out, read, json } = run();
  assert.deepEqual(readdirSync(join(out, 'vms')).sort(), ['vm-a', 'vm-b']);
  const [a, b] = read('limactl-list.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(a.name, 'vm-a');
  assert.equal(a.hostname, 'lima-vm-a');
  assert.equal(a.dir, '/Users/user/.lima/vm-a');
  assert.equal(a.sshConfigFile, '/Users/user/.lima/vm-a/ssh.config');
  assert.equal(a.config.portForwards[0].hostSocket, '/Users/user/.lima/vm-a/sock/podman.sock');
  assert.equal(b.name, 'vm-b');
  assert.deepEqual(json('manifest.json').vms.map((v) => v.name), ['vm-a', 'vm-b']);
  const { guestUsers, ...host } = json('manifest.json').host;
  assert.deepEqual(host, { user: 'user', home: '/Users/user', limaHome: '/Users/user/.lima' });
  assert.equal(guestUsers.length, 1);
  assert.match(guestUsers[0].name, /^user\d+$/, 'numbered after the host user(s)');
  assert.equal(guestUsers[0].home, '/home/user.guest');
});

test('a list row keeps only what the app reads, and its numbers', () => {
  const { read } = run();
  const a = JSON.parse(read('limactl-list.jsonl').split('\n')[0]);
  for (const gone of ['message', 'IdentityFile', 'network']) assert.ok(!(gone in a), gone);
  assert.deepEqual(Object.keys(a.config), ['portForwards']);
  assert.equal(a.config.portForwards.length, 1, 'only socket forwards');
  assert.equal(a.sshLocalPort, 60022, 'ssh port replaced');
  assert.deepEqual([a.cpus, a.memory, a.disk, a.hostAgentPID], [4, 8589934592, 107374182400, 4242]);
});

test('containers: names, compose labels and pods mapped; other labels and fields dropped', () => {
  const { json } = run();
  const [web, db] = json('vms/vm-a/libpod/containers.json');
  assert.deepEqual(web.Names, ['container-1']);
  assert.deepEqual(web.Labels, { 'com.docker.compose.project': 'project-1', 'com.docker.compose.service': 'service-1' });
  assert.ok(!('Networks' in web) && !('Ports' in web));
  assert.equal(web.Image, 'registry.example/image-1:1.2', 'a private image, its tag kept');
  assert.equal(db.Image, 'docker.io/library/postgres:16', 'an official image as it is');
  assert.deepEqual(db.Names, ['container-2']);
  assert.equal(db.PodName, 'pod-1');
});

test('ids are hashed the same way in every file', () => {
  const { json, read } = run();
  const [web, db] = json('vms/vm-a/libpod/containers.json');
  assert.match(web.Id, /^[0-9a-f]{64}$/);
  assert.notEqual(web.Id, ID1);
  assert.notEqual(db.Pod, POD);
  const stats = read('vms/vm-a/libpod/stats.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(stats[0].Stats[0].ContainerID, web.Id);
  assert.equal(stats[0].Stats[0].Name, 'container-1');
  assert.ok(read('vms/vm-a/probe.txt').includes(`G ${web.Id} 4096 0`));
  assert.ok(read('vms/vm-a/journal.out').includes(`libpod-${web.Id}.scope`));
  assert.equal(json('vms/vm-a/libpod/system-df.json').Containers[0].ContainerID, web.Id);
  const [img] = json('vms/vm-a/libpod/images.json');
  assert.equal(web.ImageID, img.Id);
  assert.match(img.RepoDigests[0], /^registry\.example\/image-1@sha256:[0-9a-f]{64}$/);
  assert.ok(!img.RepoDigests[0].includes(DIGEST));
  assert.equal(img.Labels, null, 'image labels dropped');
});

test('the journal keeps its times and loses its cursor; the boot id is hashed', () => {
  const { read } = run();
  const entry = JSON.parse(read('vms/vm-a/journal.out').trim());
  assert.deepEqual(Object.keys(entry).sort(), ['MESSAGE', '_BOOT_ID', '__REALTIME_TIMESTAMP']);
  assert.equal(entry.__REALTIME_TIMESTAMP, '1794229820051112');
  assert.match(entry._BOOT_ID, /^[0-9a-f]{32}$/);
  assert.notEqual(entry._BOOT_ID, BOOT);
});

test('volumes: names, the guest home and compose project mapped; options dropped', () => {
  const { json } = run();
  const [v] = json('vms/vm-a/libpod/volumes.json');
  assert.equal(v.Name, 'volume-1');
  assert.equal(v.Mountpoint, '/home/user.guest/.local/share/containers/storage/volumes/volume-1/_data');
  assert.deepEqual(v.Labels, { 'com.docker.compose.project': 'project-1' });
  assert.ok(!('Options' in v));
  assert.equal(json('vms/vm-a/libpod/system-df.json').Volumes[0].VolumeName, 'volume-1');
});

test("podman's version is kept, and only its version numbers", () => {
  const { json } = run();
  assert.deepEqual(json('vms/vm-a/libpod/version.json'), { Version: '5.8.9', ApiVersion: '1.44', MinAPIVersion: '1.24' });
});

test('the marker keeps its locks, loses who and where', () => {
  const { json } = run();
  const m = json('vms/vm-b/managed-by.json');
  assert.equal(m.instance, 'vm-b');
  assert.deepEqual(m.locked, ['delete']);
  assert.equal(m.manager, 'foldyard');
  assert.match(m.group, /^project-\d$/);
  assert.equal(m.url, 'https://manager.example/');
});

test('numbers and timing are kept', () => {
  const { read } = run();
  const probe = read('vms/vm-a/probe.txt');
  assert.equal(probe.replaceAll(/G \S+/g, 'G x'),
    (probeBlock('100.00', 1000) + probeBlock('101.00', 1010) + probeBlock('102.00', 1020)).replaceAll(/G \S+/g, 'G x'));
  const stats = read('vms/vm-a/libpod/stats.jsonl');
  assert.ok(stats.includes('"CPUNano":2000'));
  assert.ok(stats.includes('1794250573632955100'), 'big integers digit for digit');
});

test('nothing sensitive survives anywhere', () => {
  const { out } = run();
  const text = allText(out);
  for (const s of SECRETS) assert.ok(!text.includes(s), `'${s}' survived`);
  for (const id of [ID1, ID2, IMG1, IMG2, POD, DIGEST, BOOT, ID1.slice(0, 12)]) {
    assert.ok(!text.includes(id), `id ${id} survived`);
  }
});

test('the safety net finds a planted original and names it', () => {
  const { out } = run();
  writeFileSync(join(out, 'vms', 'vm-a', 'probe.txt'), `left behind: secretproj and ${ID1} and /Users/alice/x\n`);
  const found = findSurvivors(out, { plain: ['/Users/alice'], bounded: ['secretproj'], ids: new Set([ID1]) });
  assert.deepEqual(found.sort(), ['/Users/alice', ID1, 'secretproj'].sort());
  writeFileSync(join(out, 'vms', 'vm-a', 'probe.txt'), 'docker.io/library/secretproj:1 is public\n');
  assert.deepEqual(findSurvivors(out, { plain: [], bounded: ['secretproj'], ids: new Set() }), [],
    'an official image ref is kept on purpose');
});

test('ids differ between runs (a fresh salt each time), names don\'t', () => {
  const one = run().json('vms/vm-a/libpod/containers.json');
  const two = run().json('vms/vm-a/libpod/containers.json');
  assert.notEqual(one[0].Id, two[0].Id);
  assert.deepEqual(one[0].Names, two[0].Names);
});

test('--seconds keeps only the first samples', () => {
  const { read, json } = run({ seconds: 2 });
  assert.equal(read('vms/vm-a/probe.txt').split('\n').filter((l) => l === '.').length, 2);
  assert.equal(read('vms/vm-a/libpod/stats.jsonl').trim().split('\n').length, 2);
  assert.equal(json('manifest.json').seconds, 2);
});

test('refuses to overwrite a directory that isn\'t a snapshot', () => {
  const out = mkdtempSync(join(tmpdir(), 'not-a-fixture-'));
  writeFileSync(join(out, 'precious.txt'), 'x');
  assert.throws(() => anonymise(syntheticSnapshot(), out, { quiet: true }), /isn't a snapshot/);
  assert.ok(existsSync(join(out, 'precious.txt')));
});

test('a user name glued into another word fails the run and leaves nothing behind', () => {
  const snap = syntheticSnapshot();
  const images = join(snap, 'vms', 'secretproj', 'libpod', 'images.json');
  writeFileSync(images, readFileSync(images, 'utf8').replace('web:1.2"]', 'web:alicedev"]'));
  const out = join(mkdtempSync(join(tmpdir(), 'fixture-')), 'out');
  assert.throws(() => anonymise(snap, out, { quiet: true }), /SAFETY NET.*"alice"/);
  assert.ok(!existsSync(out), 'no half-anonymised output to commit by mistake');
});
