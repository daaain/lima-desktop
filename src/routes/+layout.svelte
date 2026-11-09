<script lang="ts">
  import { onMount } from 'svelte';
  import { live } from '$lib/live.svelte';
  import { bytes } from '$lib/format';
  import Sidebar from '$lib/Sidebar.svelte';
  import LimaProblem from '$lib/LimaProblem.svelte';
  let { children } = $props();
  onMount(() => live.start());
</script>

<div class="app">
  <header>
    <a href="/" class="brand">Lima Desktop</a>
    <span class="spacer"></span>
    {#if live.snapshot}
      <span class="meta" title="Metrics history on disk; raw samples kept {live.snapshot.retention?.rawDays} days, minute rollups {live.snapshot.retention?.rollupDays}">
        history {bytes(live.snapshot.storeBytes)}
      </span>
    {/if}
  </header>
  {#if live.snapshot?.limaProblem}
    <LimaProblem problem={live.snapshot.limaProblem} staleVms={live.snapshot.vms.length} />
  {/if}
  {#if live.error}
    <p class="banner alert">Backend: {live.error}</p>
  {/if}
  <div class="body">
    <Sidebar />
    <main>{@render children()}</main>
  </div>
</div>

<style>
  :global(:root) {
    --bg: #f7f7f5; --panel: #ffffff; --fg: #1d1d1b; --muted: #6b6b66; --border: #e3e3de;
    --grid: #ececE8; --track: #e9e9e4; --accent: #2f6fde;
    --ok: #3a9a5b; --warn: #d39a1c; --alert: #d0453a;
    --series-1: #2f6fde; --series-2: #d0453a; --series-3: #8a57d1; --series-4: #3a9a5b;
    color-scheme: light dark;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 14px;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #161615; --panel: #1f1f1d; --fg: #ececE8; --muted: #9a9a93; --border: #33332f;
      --grid: #2b2b28; --track: #2e2e2a; --accent: #6b9cf0;
      --series-1: #6b9cf0; --series-2: #ef7a6f; --series-3: #b28ef0; --series-4: #6cc58b;
    }
  }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); }
  :global(a) { color: var(--accent); text-decoration: none; }
  :global(button) {
    font: inherit; font-size: 0.85rem; padding: 0.3rem 0.7rem; border-radius: 6px;
    border: 1px solid var(--border); background: var(--panel); color: var(--fg); cursor: pointer;
  }
  :global(button:hover:not(:disabled)) { border-color: var(--accent); }
  :global(button:disabled) { opacity: 0.45; cursor: not-allowed; }
  :global(button.danger:hover:not(:disabled)) { border-color: var(--alert); color: var(--alert); }
  :global(.panel) { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }
  :global(.badge) { font-size: 0.72rem; padding: 0.1rem 0.45rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  :global(.badge.running) { color: var(--ok); border-color: var(--ok); }
  :global(.badge.managed) { color: var(--accent); border-color: var(--accent); }
  :global(.badge.alert) { color: var(--alert); border-color: var(--alert); }
  :global(.error) { color: var(--alert); font-size: 0.8rem; overflow-wrap: anywhere; margin: 0; }
  .app { display: flex; flex-direction: column; min-height: 100vh; }
  header { display: flex; align-items: center; gap: 1rem; padding: 0.6rem 1.2rem; border-bottom: 1px solid var(--border); background: var(--panel); }
  .brand { font-weight: 700; color: var(--fg); }
  .spacer { flex: 1; }
  .meta { color: var(--muted); font-size: 0.8rem; }
  .banner { margin: 0; padding: 0.5rem 1.2rem; }
  .banner.alert { background: color-mix(in srgb, var(--alert) 12%, transparent); color: var(--alert); }
  .body { display: flex; flex: 1; min-height: 0; }
  main { padding: 1.2rem; flex: 1; min-width: 0; }
  @media (max-width: 640px) {
    .body { flex-direction: column; }
  }

  /* The list views (containers, images, volumes) share these. */
  :global(.toolbar) { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  :global(.toolbar input[type='search']) { min-width: 14rem; }
  :global(.toolbar input[type='search']), :global(.toolbar select) {
    font: inherit; font-size: 0.85rem; padding: 0.3rem 0.5rem; border-radius: 6px;
    border: 1px solid var(--border); background: var(--panel); color: var(--fg);
  }
  :global(table.list) { width: 100%; border-collapse: collapse; font-size: 0.83rem; }
  :global(table.list th) { text-align: left; color: var(--muted); font-weight: 500; padding: 0.3rem 0.5rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
  :global(table.list td) { padding: 0.35rem 0.5rem; border-bottom: 1px solid var(--border); }
  :global(table.list .n) { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  :global(table.list .muted) { color: var(--muted); font-size: 0.78rem; }
  :global(table.list .acts) { white-space: nowrap; text-align: right; }
  :global(table.list .acts button) { padding: 0.15rem 0.5rem; font-size: 0.75rem; }
  :global(table.list code) { font-size: 0.78rem; }
</style>
