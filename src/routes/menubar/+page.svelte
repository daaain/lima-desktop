<script lang="ts">
  // The menu bar's popover, a window of its own: the whole computer's memory, CPU or disk now, the
  // VMs' part of it and everything else, then the same stacked over a range, and a legend that is
  // the list of VMs. What it says and draws comes from lib/menubar.ts. The backend builds the window
  // once, at ?tab=mem|cpu|disk, and from then on hides it and shows it again under the item clicked,
  // saying which tab with an event, so the page isn't loaded again. While the window is hidden it
  // fetches nothing; shown again, it fetches at once.
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { page } from '$app/state';
  import { api, type Snapshot, type Stack, type Theme } from '$lib/api';
  import { inOrder } from '$lib/inOrder';
  import {
    agoLabel, amount, chartLabel, layerAside, layerFigure, layers, ofSentence, parseTab, parseTabRange, percentFigure, rangeLabel,
    recordingPhrase, shares, stackChart, stalledTip, SHADES, STACK_POINTS, TAB_RANGES, TABS, type Tab,
  } from '$lib/menubar';
  import { followsLive, historyRefreshMs, rangeMs, type RangeKey } from '$lib/ranges';
  import { theme } from '$lib/theme.svelte';

  const HEIGHT = 130;
  const rangeKey = (t: Tab) => `menubar-range-${t}`;
  function remembered(t: Tab): RangeKey {
    try {
      return parseTabRange(t, localStorage.getItem(rangeKey(t)));
    } catch {
      return parseTabRange(t, null);
    }
  }

  let tab = $state<Tab>(parseTab(page.url.searchParams.get('tab')));
  // Shown again under another item (menubar.rs): its tab, and the theme, which Settings may have
  // changed while the popover was hidden.
  onMount(() => {
    const stop = listen<{ tab: string; theme: Theme }>('popover-shown', (e) => {
      tab = parseTab(e.payload.tab);
      theme.apply(e.payload.theme);
    });
    return () => void stop.then((f) => f(), () => {});
  });
  let over = $state<Record<Tab, RangeKey>>({ mem: remembered('mem'), cpu: remembered('cpu'), disk: remembered('disk') });
  function choose(k: RangeKey) {
    over[tab] = k;
    try {
      localStorage.setItem(rangeKey(tab), k);
    } catch {
      // Not kept: the choice holds while the popover is open.
    }
  }

  let visible = $state(typeof document === 'undefined' || document.visibilityState !== 'hidden');

  // The snapshot, at the measuring interval.
  let snapshot = $state<Snapshot | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      try {
        snapshot = await api.snapshot();
        error = null;
      } catch (e) {
        error = String(e);
      }
      if (!stopped) timer = setTimeout(tick, (snapshot?.intervalSecs ?? 1) * 1000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  // The stack over the tab's range: fetched as either is chosen, then as a new column comes due (at
  // most once a minute) while the range moves on with the clock.
  type Fetched = { tab: Tab; over: RangeKey; from: number; to: number; stack: Stack };
  let fetched = $state<Fetched | null>(null);
  let stackError = $state<{ tab: Tab; over: RangeKey; message: string } | null>(null);
  const ordered = inOrder();
  function fetchStack(t: Tab, k: RangeKey) {
    const to = Date.now();
    const from = to - rangeMs(k);
    ordered(api.hostStack(t, from, to, STACK_POINTS)).then(
      (stack) => {
        fetched = { tab: t, over: k, from, to, stack };
        stackError = null;
      },
      (e) => (stackError = { tab: t, over: k, message: String(e) }),
    );
  }
  $effect(() => {
    const t = tab;
    const k = over[t];
    if (!visible) return;
    fetchStack(t, k);
    if (!followsLive(k)) return;
    const every = setInterval(() => fetchStack(t, k), historyRefreshMs(k));
    return () => clearInterval(every);
  });

  const range = $derived(over[tab]);
  const now = $derived(shares(snapshot, tab));
  // Another tab's or range's stack isn't drawn as this one's while its own is on the way.
  const current = $derived(fetched?.tab === tab && fetched.over === range ? fetched : null);
  const stacked = $derived(layers(now, current?.stack, tab));
  let width = $state(0);
  const chart = $derived(
    current && width > 0
      ? stackChart(current.stack, stacked, { from: current.from, to: current.to, width, height: HEIGHT, total: now?.total })
      : null,
  );
  const failed = $derived(stackError?.tab === tab && stackError.over === range ? stackError.message : null);

  let lit = $state<string | null>(null);

  // The window is as tall as the page: the backend sizes it when asked.
  let root = $state<HTMLElement>();
  $effect(() => {
    if (!root) return;
    let asked = 0;
    const fit = () => {
      const h = Math.ceil(root!.getBoundingClientRect().height);
      if (h === asked) return;
      asked = h;
      api.fitPopover(h).catch(() => {});
    };
    const seen = new ResizeObserver(fit);
    seen.observe(root);
    fit();
    return () => seen.disconnect();
  });
</script>

<svelte:document onvisibilitychange={() => (visible = document.visibilityState !== 'hidden')} />

<div class="popover" class:warm={now?.hot} bind:this={root}>
  <div class="seg" role="tablist" aria-label="Resource">
    {#each TABS as t (t.key)}
      <button role="tab" aria-selected={tab === t.key} onclick={() => (tab = t.key)}>{t.label}</button>
    {/each}
  </div>

  <div role="tabpanel" aria-label={TABS.find((t) => t.key === tab)?.label}>
    <div class="top">
      <div>
        <div class="big num" class:hot={now?.hot}>{percentFigure(now)}</div>
        <p class="of">{ofSentence(tab, now)}</p>
      </div>
      <div class="ranges" role="group" aria-label="Over the last">
        {#each TAB_RANGES[tab] as k (k)}
          <button aria-pressed={range === k} onclick={() => choose(k)}>{rangeLabel(k)}</button>
        {/each}
      </div>
    </div>

    <div class="chart" bind:clientWidth={width}>
      <svg viewBox="0 0 {width || 1} {HEIGHT}" role="img" aria-label={chartLabel(tab, range)} class:lit={lit != null}>
        <defs>
          <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" style="fill: var(--track)" />
            <line x1="0" y1="0" x2="0" y2="4" style="stroke: var(--soft)" stroke-width="2" />
          </pattern>
        </defs>
        <rect class="free" width={width || 1} height={HEIGHT} />
        {#if chart}
          {#each chart.bands as b (b.name)}
            <path class="band vm shade-{b.shade}" class:hl={lit === b.name} d={b.d} data-tip={b.name} />
          {/each}
          <path class="band rest" d={chart.rest} data-tip="everything else" />
          <path class="line" d={chart.top} />
        {/if}
      </svg>
      {#if failed}
        <p class="error">The history couldn't be read: {failed}</p>
      {/if}
    </div>
    <div class="axis"><span>{agoLabel(range)}</span><span>now</span></div>

    <ul class="legend">
      {#each stacked as l, i (l.name)}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li class="row" data-vm={l.name} onmouseenter={() => (lit = l.name)} onmouseleave={() => (lit = null)}>
          <span class="sw shade-{i % SHADES}"></span>
          <span class="name serif" class:hot={l.stalled} title={l.stalled ? stalledTip(l.name) : null}>{l.name}</span>
          <span class="fig num" class:muted={l.now == null}>{layerFigure(tab, l)}</span>
          <span class="aside num">{current ? layerAside(tab, l, range) : ''}</span>
        </li>
      {/each}
      <li class="row other">
        <span class="sw hatched"></span>
        <span class="name serif">everything else</span>
        <span class="fig num">{amount(tab, now?.rest)}</span>
        <span class="aside"></span>
      </li>
      <li class="row other">
        <span class="sw free"></span>
        <span class="name serif">free</span>
        <span class="fig num">{amount(tab, now?.free)}</span>
        <span class="aside"></span>
      </li>
    </ul>
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  <footer>
    <span>{recordingPhrase(snapshot?.intervalSecs)}</span>
    <span class="buttons">
      <button onclick={() => api.openMain().catch(() => {})}>Open Lima Desktop</button>
      <button onclick={() => api.quit().catch(() => {})}>Quit</button>
    </span>
  </footer>
</div>

<style>
  /* The window is the popover: no card or shadow of its own, and it scrolls only if it must. */
  :global(html:has(.popover)) { overflow-y: auto; }
  .popover { padding: 16px; display: grid; gap: 0; }

  /* The VMs' bands: shades of the bar's colour toward the page, or of the warning's past three
     quarters. The same classes colour the legend's swatches. */
  .shade-0 { --shade: var(--bar); }
  .shade-1 { --shade: color-mix(in oklab, var(--bar) 76%, var(--bg)); }
  .shade-2 { --shade: color-mix(in oklab, var(--bar) 58%, var(--bg)); }
  .shade-3 { --shade: color-mix(in oklab, var(--bar) 44%, var(--bg)); }
  .shade-4 { --shade: color-mix(in oklab, var(--bar) 34%, var(--bg)); }
  .warm .shade-0 { --shade: var(--warn); }
  .warm .shade-1 { --shade: color-mix(in oklab, var(--warn) 76%, var(--bg)); }
  .warm .shade-2 { --shade: color-mix(in oklab, var(--warn) 58%, var(--bg)); }
  .warm .shade-3 { --shade: color-mix(in oklab, var(--warn) 44%, var(--bg)); }
  .warm .shade-4 { --shade: color-mix(in oklab, var(--warn) 34%, var(--bg)); }

  .seg { display: flex; background: var(--track); border-radius: 7px; padding: 2px; margin-bottom: 14px; }
  .seg button {
    flex: 1; height: auto; background: none; border: 0; border-radius: 5px; padding: 4px 0;
    font-weight: 500; font-size: 0.86rem; color: var(--muted);
  }
  .seg button[aria-selected='true'] { background: var(--bg); color: var(--fg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15); }

  .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
  .big { font-weight: 600; font-size: 2.4rem; line-height: 1; letter-spacing: -0.02em; }
  .big.hot { color: var(--warn); }
  .of { font-size: 0.8rem; line-height: 1.35; color: var(--muted); margin: 4px 0 0; }
  .ranges { display: flex; gap: 2px; flex: none; }
  .ranges button {
    height: auto; border: 0; padding: 2px 6px; border-radius: 999px; color: var(--muted); font-weight: 500; font-size: 0.78rem;
  }
  .ranges button[aria-pressed='true'] { background: var(--fg); color: var(--bg); }

  .chart { margin: 12px 0 2px; position: relative; }
  svg { display: block; width: 100%; height: 130px; }
  .free { fill: var(--track); }
  .band { stroke: var(--bg); stroke-width: 0.6; transition: opacity 0.15s; }
  .band.vm { fill: var(--shade); }
  .band.rest { fill: url(#hatch); }
  svg.lit .band.vm { opacity: 0.3; }
  svg.lit .band.vm.hl { opacity: 1; fill: var(--accent); }
  .line { fill: none; stroke: var(--fg); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .chart .error { position: absolute; inset: auto 0 6px; padding: 0 8px; font-size: 0.8rem; }
  .axis { display: flex; justify-content: space-between; font-size: 0.74rem; color: var(--muted); }

  /* One grid for all the rows, so their figures line up. */
  .legend { list-style: none; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; column-gap: 8px; }
  .row {
    grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: baseline;
    padding: 4px 2px; border-bottom: 1px solid var(--border); font-size: 0.86rem;
  }
  .row:last-child { border-bottom: 0; }
  .row[data-vm]:hover { background: var(--wash); }
  .sw { width: 9px; height: 9px; align-self: center; background: var(--shade); }
  .sw.hatched { background: repeating-linear-gradient(135deg, var(--soft) 0 2px, var(--track) 2px 4px); }
  .sw.free { background: var(--track); }
  .name { font-weight: 500; font-size: 1.05rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name.hot { color: var(--warn); }
  .other .name { color: var(--muted); }
  .fig { font-weight: 600; text-align: right; }
  .aside { color: var(--muted); font-size: 0.78rem; min-width: 7.5em; text-align: right; }

  footer {
    display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; padding-top: 10px;
    border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--muted);
  }
  .buttons { display: flex; gap: 6px; }
  .buttons button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .error { margin-top: 8px; }
</style>
