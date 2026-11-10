<script lang="ts">
  // The masthead: the app's name, then its two levels — Lima's VMs, and the podman things inside
  // every running one (containers, images, volumes).
  import { page } from '$app/state';
  import { live } from './live.svelte';
  import { bytes } from './format';
  import { containerRows } from './containers';

  const vms = $derived(live.snapshot?.vms ?? []);
  const runningVms = $derived(vms.filter((v) => v.instance.status === 'Running').length);
  const runningContainers = $derived(containerRows(live.snapshot).filter((r) => r.c.state === 'running').length);
  const path = $derived(page.url.pathname);
  const vmsActive = $derived(path === '/' || path.startsWith('/vm/'));
  const current = (active: boolean) => (active ? 'page' : undefined);
</script>

<header>
  <a href="/" class="brand serif">Lima Desktop</a>
  <nav aria-label="Sections">
    <a href="/" aria-current={current(vmsActive)}>VMs</a>
    <span class="rule" aria-hidden="true"></span>
    <a href="/containers" aria-current={current(path === '/containers')} title="In every running VM">Containers</a>
    <a href="/images" aria-current={current(path === '/images')} title="In every running VM">Images</a>
    <a href="/volumes" aria-current={current(path === '/volumes')} title="In every running VM">Volumes</a>
  </nav>
</header>
{#if live.snapshot}
  <p class="status num">
    {runningVms} of {vms.length} VMs running · {runningContainers} {runningContainers === 1 ? 'container' : 'containers'} ·
    <span title="Metrics history on disk; raw samples kept {live.snapshot.retention?.rawDays} days, minute rollups {live.snapshot.retention?.rollupDays}">history {bytes(live.snapshot.storeBytes)}</span>
  </p>
{/if}

<style>
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 2rem; padding: 1.4rem 0 0.9rem; border-bottom: 1px solid var(--fg); }
  .brand { font-size: 1.55rem; font-weight: 600; color: var(--fg); flex: 1 1 auto; }
  .brand:hover { text-decoration: none; }
  nav { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 1.5rem; font-size: 1rem; }
  nav a { color: var(--fg); padding-bottom: 2px; }
  nav a[aria-current='page'] { font-weight: 600; border-bottom: 2px solid var(--fg); }
  nav a:hover { text-decoration: none; border-bottom: 2px solid var(--muted); }
  .rule { width: 1px; height: 0.9rem; background: var(--border); align-self: center; }
  .status { margin: 0.65rem 0 0; font-size: 0.9rem; color: var(--muted); }
</style>
