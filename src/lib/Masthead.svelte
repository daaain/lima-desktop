<script lang="ts">
  // The masthead: the app's name, then its two levels — Lima's VMs, and the podman things inside
  // every running one (containers, images, volumes) — and the app's settings. Under it, the time
  // range every page with history follows (range.svelte.ts), where there is any.
  import { page } from '$app/state';
  import { live } from './live.svelte';
  import { bytes } from './format';
  import { containerRows } from './containers';
  import { range } from './range.svelte';
  import { RANGES } from './ranges';
  import { hasHistory, section } from './url';

  const vms = $derived(live.snapshot?.vms ?? []);
  const runningVms = $derived(vms.filter((v) => v.instance.status === 'Running').length);
  const runningContainers = $derived(containerRows(live.snapshot).filter((r) => r.c.state === 'running').length);
  const here = $derived(section(page.url.pathname));
  const current = (s: typeof here) => (s === here ? 'page' : undefined);
</script>

<header>
  <a href="/" class="brand serif">Lima Desktop</a>
  <nav aria-label="Sections">
    <a href="/" aria-current={current('vms')}>VMs</a>
    <span class="rule" aria-hidden="true"></span>
    <a href="/containers" aria-current={current('containers')} title="In every running VM">Containers</a>
    <a href="/images" aria-current={current('images')} title="In every running VM">Images</a>
    <a href="/volumes" aria-current={current('volumes')} title="In every running VM">Volumes</a>
    <span class="rule" aria-hidden="true"></span>
    <a href="/settings" aria-current={current('settings')}>Settings</a>
  </nav>
</header>
<div class="under">
  {#if live.snapshot}
    <p class="status num">
      {runningVms} of {vms.length} VMs running · {runningContainers} {runningContainers === 1 ? 'container' : 'containers'} ·
      <span title="Metrics history on disk; raw samples kept {live.snapshot.retention?.rawDays} days, minute rollups {live.snapshot.retention?.rollupDays}">history {bytes(live.snapshot.storeBytes)}</span>
    </p>
  {/if}
  {#if hasHistory(here)}
    <div class="ranges" role="group" aria-label="Time range" title="Every chart, peak and verdict in the app is over this range">
      <span class="label">over the last</span>
      {#each RANGES as r (r.key)}
        <button class:active={range.key === r.key} aria-pressed={range.key === r.key} onclick={() => range.choose(r.key)}>{r.label}</button>
      {/each}
    </div>
  {/if}
</div>

<style>
  header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 2rem; padding: 1.4rem 0 0.9rem; border-bottom: 1px solid var(--fg); }
  .brand { font-size: 1.55rem; font-weight: 600; color: var(--fg); flex: 1 1 auto; }
  .brand:hover { text-decoration: none; }
  nav { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 1.5rem; font-size: 1rem; }
  nav a { color: var(--fg); padding-bottom: 2px; }
  nav a[aria-current='page'] { font-weight: 600; border-bottom: 2px solid var(--fg); }
  nav a:hover { text-decoration: none; border-bottom: 2px solid var(--muted); }
  .rule { width: 1px; height: 0.9rem; background: var(--border); align-self: center; }
  /* As tall as the range picker on every page, so a page without it does not sit higher. */
  .under { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1.5rem; margin-top: 0.65rem; min-height: 1.9rem; }
  .status { margin: 0; font-size: 0.9rem; color: var(--muted); }
  /* The ranges stay to the right, even with no status line (before the first snapshot). */
  .ranges { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; margin-left: auto; }
  .ranges .label { margin-right: 0.2rem; }
  .ranges button { height: 1.9rem; padding: 0 0.75rem; font-size: 0.82rem; }
  @media (max-width: 640px) {
    .ranges { margin-left: 0; }
    .ranges button { padding: 0 0.55rem; }
  }
</style>
