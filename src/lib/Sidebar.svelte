<script lang="ts">
  // Two levels, kept apart: Lima's VMs, and the podman things inside every running one.
  import { page } from '$app/state';
  import { live } from './live.svelte';
  import { containerRows } from './containers';

  const vms = $derived(live.snapshot?.vms ?? []);
  const runningVms = $derived(vms.filter((v) => v.instance.status === 'Running').length);
  const runningContainers = $derived(containerRows(live.snapshot).filter((r) => r.c.state === 'running').length);
  const path = $derived(page.url.pathname);
  const vmsActive = $derived(path === '/' || path.startsWith('/vm/'));
</script>

<nav aria-label="Sections">
  <h2>Lima</h2>
  <a href="/" class:active={vmsActive} aria-current={vmsActive ? 'page' : undefined}>
    VMs
    {#if live.snapshot}<span class="count" title="running / all">{runningVms}/{vms.length}</span>{/if}
  </a>

  <h2>Podman <span class="scope">· all running VMs</span></h2>
  <a href="/containers" class:active={path === '/containers'} aria-current={path === '/containers' ? 'page' : undefined}>
    Containers
    {#if live.snapshot}<span class="count" title="running">{runningContainers}</span>{/if}
  </a>
  <a href="/images" class:active={path === '/images'} aria-current={path === '/images' ? 'page' : undefined}>Images</a>
  <a href="/volumes" class:active={path === '/volumes'} aria-current={path === '/volumes' ? 'page' : undefined}>Volumes</a>
</nav>

<style>
  nav {
    display: flex; flex-direction: column; gap: 0.15rem; width: 12rem; flex-shrink: 0;
    padding: 1rem 0.6rem; border-right: 1px solid var(--border); background: var(--panel);
  }
  h2 {
    margin: 0.9rem 0.5rem 0.3rem; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--muted);
  }
  h2:first-child { margin-top: 0; }
  .scope { text-transform: none; letter-spacing: 0; font-weight: 400; }
  a {
    display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;
    padding: 0.35rem 0.5rem; border-radius: 6px; color: var(--fg); font-size: 0.9rem;
  }
  a:hover { background: color-mix(in srgb, var(--accent) 7%, transparent); }
  a.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-weight: 600; }
  .count { font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 400; }
  @media (max-width: 640px) {
    nav { width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; border-right: 0; border-bottom: 1px solid var(--border); padding: 0.5rem; }
    h2 { margin: 0 0.3rem; }
  }
</style>
