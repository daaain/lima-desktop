<script lang="ts">
  import '@fontsource-variable/inter';
  import '@fontsource-variable/newsreader/opsz.css';
  import { onMount } from 'svelte';
  import { live } from '$lib/live.svelte';
  import Masthead from '$lib/Masthead.svelte';
  import LimaProblem from '$lib/LimaProblem.svelte';
  let { children } = $props();
  onMount(() => live.start());
</script>

<div class="app">
  <Masthead />
  {#if live.snapshot?.limaProblem}
    <LimaProblem problem={live.snapshot.limaProblem} staleVms={live.snapshot.vms.length} />
  {/if}
  {#if live.error}
    <p class="banner">Backend: {live.error}</p>
  {/if}
  <main>{@render children()}</main>
</div>

<style>
  /* The look is described in docs/design/ui.md: a serif for sentences and names, a sans for
     figures, one warning colour, hairline rules instead of boxes. */
  :global(:root) {
    --bg: #ffffff; --fg: #14171c; --muted: #5a616c; --border: #d9dce1; --wash: #f4f6f9;
    --accent: #1d4ed8; --warn: #a8430a; --alert: #b3261e; --ok: #14171c;
    --track: #e4e7ec; --bar: #4b5563; --soft: #aeb6c2; --grid: #eceef1; --panel: var(--bg);
    --series-1: #1d4ed8; --series-2: #a8430a; --series-3: #7a5fb5; --series-4: #4b5563;
    --serif: 'Newsreader Variable', Georgia, 'Times New Roman', serif;
    --sans: 'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    color-scheme: light dark;
    font-family: var(--sans);
    font-size: 14px;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #111418; --fg: #eceef1; --muted: #9da5b0; --border: #2c323a; --wash: #191d23;
      --accent: #93b4ff; --warn: #ff9a52; --alert: #ff8a80; --ok: #eceef1;
      --track: #2a3038; --bar: #b4bcc8; --soft: #5b6573; --grid: #20252b;
      --series-1: #93b4ff; --series-2: #ff9a52; --series-3: #b9a4ee; --series-4: #b4bcc8;
    }
  }
  :global(body) { margin: 0; background: var(--bg); color: var(--fg); }
  :global(a) { color: var(--accent); text-decoration: none; }
  :global(a:hover) { text-decoration: underline; }
  :global(button) {
    font: inherit; font-size: 0.9rem; height: 2.3rem; padding: 0 1rem; border-radius: 1.15rem;
    border: 1px solid var(--border); background: transparent; color: var(--fg); cursor: pointer; white-space: nowrap;
  }
  :global(button:hover:not(:disabled)) { border-color: var(--fg); }
  :global(button:disabled) { color: var(--muted); cursor: not-allowed; }
  :global(button.danger:hover:not(:disabled)) { border-color: var(--alert); color: var(--alert); }
  :global(button.active) { background: var(--fg); border-color: var(--fg); color: var(--bg); }

  /* Type: .serif for names and sentences, .num for figures, .label for the rare small label. */
  :global(.serif) { font-family: var(--serif); }
  :global(.num) { font-variant-numeric: tabular-nums; }
  :global(.label) { font-size: 0.8rem; color: var(--muted); }
  :global(.muted) { color: var(--muted); }
  :global(.hot) { color: var(--warn); }
  :global(h1.headline) {
    font-family: var(--serif); font-weight: 500; font-size: clamp(2.2rem, 4.6vw, 4rem); line-height: 1.05;
    letter-spacing: -0.02em; margin: 0; text-wrap: balance;
  }
  :global(h2.head) { font-family: var(--serif); font-weight: 500; font-size: 1.9rem; line-height: 1.15; letter-spacing: -0.01em; margin: 0; }
  :global(p.lede) { font-size: 1.15rem; line-height: 1.5; margin: 0; max-width: 46rem; }
  :global(p.note) { font-size: 0.9rem; line-height: 1.5; color: var(--muted); margin: 0; }

  /* A section starts at a rule; nothing sits in a box except the one thing being acted on. */
  :global(.panel) { border-top: 1px solid var(--fg); padding-top: 0.9rem; }
  :global(.wash) { background: var(--wash); padding: 1.6rem 2rem; }
  :global(.badge) { font-size: 0.78rem; padding: 0.1rem 0.5rem; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); white-space: nowrap; }
  :global(.badge.running) { color: var(--fg); border-color: var(--muted); }
  :global(.badge.managed) { color: var(--accent); border-color: var(--accent); }
  :global(.badge.alert) { color: var(--alert); border-color: var(--alert); }
  :global(.error) { color: var(--alert); font-size: 0.9rem; overflow-wrap: anywhere; margin: 0; }

  .app { max-width: 1184px; margin: 0 auto; padding: 0 2rem 4rem; }
  .banner { margin: 1rem 0 0; padding: 0.6rem 1rem; background: color-mix(in srgb, var(--alert) 10%, transparent); color: var(--alert); }
  main { display: grid; gap: 1.2rem; align-content: start; padding-top: 2.6rem; min-width: 0; }
  @media (max-width: 640px) {
    .app { padding: 0 1rem 3rem; }
    main { padding-top: 1.6rem; }
  }

  /* The list views (containers, images, volumes) share these. */
  :global(.toolbar) { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
  :global(.toolbar input[type='search']) { min-width: 14rem; }
  :global(.toolbar input[type='search']), :global(.toolbar select) {
    font: inherit; font-size: 0.9rem; height: 2.3rem; padding: 0 0.9rem; border-radius: 1.15rem;
    border: 1px solid var(--border); background: transparent; color: var(--fg);
  }
  :global(table.list) { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
  :global(table.list th) { text-align: left; color: var(--muted); font-weight: 400; font-size: 0.8rem; padding: 0.4rem 0.6rem 0.4rem 0; border-bottom: 1px solid var(--border); white-space: nowrap; }
  :global(table.list td) { padding: 0.5rem 0.6rem 0.5rem 0; border-bottom: 1px solid var(--border); }
  :global(table.list .n) { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  :global(table.list .muted) { color: var(--muted); font-size: 0.85rem; }
  :global(table.list .acts) { white-space: nowrap; text-align: right; padding-right: 0; }
  :global(table.list .acts button) { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  :global(table.list code) { font-size: 0.82rem; }
</style>
