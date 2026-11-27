<script lang="ts">
  // The menu bar's popover, a window of its own: the whole computer's memory, CPU or disk now, the
  // VMs' part of it and everything else, then the same stacked over a range, and a legend that is
  // the list of VMs, each with its busiest containers under it, and under everything else the busiest
  // apps. What it says and draws comes from lib/menubar.ts. The backend builds the window
  // once, at ?tab=mem|cpu|disk, and from then on hides it and shows it again under the item clicked,
  // saying which tab with an event, so the page isn't loaded again. While the window is hidden it
  // fetches nothing; shown again, it fetches at once.
  import { onMount } from 'svelte';
  import { listen } from '@tauri-apps/api/event';
  import { page } from '$app/state';
  import { distinctKeys } from '$lib/keys';
  import { api, type Snapshot, type Stack, type Theme, type TopApps, type Warn } from '$lib/api';
  import { inOrder } from '$lib/inOrder';
  import { onTabKey } from '$lib/tabKeys';
  import {
    agoLabel, allocatedAside, allocatedTip, amount, appTip, APPS_PENDING, chartLabel, containersByVm, containerTip, insideAside, insideTip, layerAside, layerFigure, layers, listsTop, ofSentence,
    parseTab, parseTabRange, percentFigure, rangeLabel, recordingPhrase, reportedFigure, reportedTip, shares, sizeTip, stackChart, stackRefreshMs, stalledTip, topApps,
    topContainers, SHADES, STACK_POINTS, TAB_RANGES, TABS, TOP_N, WIRED, type Tab,
  } from '$lib/menubar';
  import { followsLive, rangeMs, type AnyRangeKey } from '$lib/ranges';
  import { theme } from '$lib/theme.svelte';
  import UpdateNotice from '$lib/UpdateNotice.svelte';
  import { update } from '$lib/update.svelte';

  const HEIGHT = 130;
  const rangeKey = (t: Tab) => `menubar-range-${t}`;
  function remembered(t: Tab): AnyRangeKey {
    try {
      return parseTabRange(t, localStorage.getItem(rangeKey(t)));
    } catch {
      return parseTabRange(t, null);
    }
  }

  let tab = $state<Tab>(parseTab(page.url.searchParams.get('tab')));
  // When the figure warns, as the menu bar's items do: read from Settings as the page opens, and
  // again each time it's shown.
  let warn = $state<Warn | null>(null);
  const readWarn = () => api.settings().then((s) => (warn = s.menuBar.warn), () => {});
  // Shown again under another item (menubar.rs): its tab, and the theme, warnings and whether to
  // tell of updates, which Settings may have changed while the popover was hidden.
  onMount(() => {
    readWarn();
    const stop = listen<{ tab: string; theme: Theme }>('popover-shown', (e) => {
      tab = parseTab(e.payload.tab);
      theme.apply(e.payload.theme);
      readWarn();
      update.refresh();
    });
    return () => void stop.then((f) => f(), () => {});
  });
  let over = $state<Record<Tab, AnyRangeKey>>({ mem: remembered('mem'), cpu: remembered('cpu'), disk: remembered('disk') });
  function choose(k: AnyRangeKey) {
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

  // The stack over the tab's range: fetched as either is chosen, then as each new column comes due
  // (but not more often than the computer is measured) while the range moves on with the clock.
  type Fetched = { tab: Tab; over: AnyRangeKey; from: number; to: number; stack: Stack };
  let fetched = $state<Fetched | null>(null);
  let stackError = $state<{ tab: Tab; over: AnyRangeKey; message: string } | null>(null);
  const ordered = inOrder();
  // Only a change of interval starts the timer again, not every snapshot.
  const intervalSecs = $derived(snapshot?.intervalSecs);
  function fetchStack(t: Tab, k: AnyRangeKey) {
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
    const every = setInterval(() => fetchStack(t, k), stackRefreshMs(k, intervalSecs));
    return () => clearInterval(every);
  });

  // The busiest apps, for memory and CPU: measured only while the popover is shown, at the
  // measuring interval, as the backend samples them only when asked.
  let apps = $state<{ tab: Tab; top: TopApps } | null>(null);
  let appsError = $state<{ tab: Tab; message: string } | null>(null);
  const appsInOrder = inOrder();
  $effect(() => {
    const t = tab;
    if (!visible || !listsTop(t)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const tick = async () => {
      try {
        apps = { tab: t, top: await appsInOrder(api.topApps(t, TOP_N)) };
        appsError = null;
      } catch (e) {
        appsError = { tab: t, message: String(e) };
      }
      if (!stopped) timer = setTimeout(tick, (intervalSecs ?? 1) * 1000);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  const range = $derived(over[tab]);
  const now = $derived(shares(snapshot, tab, warn));
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
  // Another tab's apps aren't listed as this one's while its own are on the way.
  const appsNow = $derived(apps?.tab === tab ? apps.top : null);
  const appsFailed = $derived(appsError?.tab === tab ? appsError.message : null);
  const containersUnder = $derived(containersByVm(topContainers(snapshot, tab)));

  // What's pointed at, in the chart or the legend, is drawn forward in both: a VM ("vm:" and its
  // name, as a VM could be called "wired"), wired memory or everything else.
  let lit = $state<string | null>(null);
  const vmLit = (name: string) => `vm:${name}`;
  const point = (e: PointerEvent) => (lit = (e.target as Element).closest('[data-lit]')?.getAttribute('data-lit') ?? null);

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

<!-- Beside a memory figure, Activity Monitor's for the same, where it differs. -->
{#snippet reported(now: number | null, of: number | null | undefined)}
  {@const r = reportedFigure(tab, now, of)}
  {#if r}<span class="reported" title={reportedTip(of!)}>{r}</span>{/if}
{/snippet}

<svelte:document onvisibilitychange={() => (visible = document.visibilityState !== 'hidden')} />

<div class="popover" class:warm={now?.hot} bind:this={root}>
  <div class="seg" role="tablist" aria-label="Resource"
    onkeydown={(e) => onTabKey(e, TABS.map((t) => t.key), tab, (k) => (tab = k))}>
    {#each TABS as t (t.key)}
      <button role="tab" id="tab-{t.key}" aria-selected={tab === t.key} aria-controls="panel" tabindex={tab === t.key ? 0 : -1}
        onclick={() => (tab = t.key)}>{t.label}</button>
    {/each}
  </div>

  <div role="tabpanel" id="panel" aria-labelledby="tab-{tab}">
    <div class="top">
      <div class="big num" class:hot={now?.hot}>{percentFigure(now)}</div>
      <div class="ranges" role="group" aria-label="Over the last">
        {#each TAB_RANGES[tab] as k (k)}
          <button aria-pressed={range === k} onclick={() => choose(k)}>{rangeLabel(k)}</button>
        {/each}
      </div>
      <p class="of">{ofSentence(tab, now)}</p>
    </div>

    <div class="chart" bind:clientWidth={width}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <svg viewBox="0 0 {width || 1} {HEIGHT}" role="img" aria-label={chartLabel(tab, range, chart?.wired != null)} class:lit={lit != null}
        onpointermove={point} onpointerleave={() => (lit = null)}>
        <defs>
          <pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" style="fill: var(--track)" />
            <line x1="0" y1="0" x2="0" y2="4" style="stroke: var(--soft)" stroke-width="2" />
          </pattern>
          <pattern id="cross" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" style="fill: var(--track)" />
            <path d="M0,0V4M0,0H4" style="stroke: var(--soft)" stroke-width="2" />
          </pattern>
          <pattern id="hatch-lit" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="4" height="4" style="fill: var(--track)" />
            <line x1="0" y1="0" x2="0" y2="4" style="stroke: var(--accent)" stroke-width="2" />
          </pattern>
        </defs>
        <rect class="free" width={width || 1} height={HEIGHT} />
        {#if chart}
          {#each chart.bands as b (b.name)}
            <path class="band vm shade-{b.shade}" class:hl={lit === vmLit(b.name)} d={b.d} data-tip={b.name} data-lit={vmLit(b.name)} />
          {/each}
          {#if chart.wired}
            <path class="band wired" class:hl={lit === 'wired'} d={chart.wired} data-tip="{WIRED.name}: {WIRED.aside}" data-lit="wired" />
          {/if}
          <path class="band rest" class:hl={lit === 'rest'} d={chart.rest} data-tip="everything else" data-lit="rest" />
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
        <li class="row" class:hl={lit === vmLit(l.name)} data-vm={l.name} onmouseenter={() => (lit = vmLit(l.name))} onmouseleave={() => (lit = null)}>
          <span class="sw shade-{i % SHADES}"></span>
          <span class="part">
            <span class="name serif" class:hot={l.stalled} title={l.stalled ? stalledTip(l.name) : l.name}>{l.name}</span>
            <span class="fig num" class:muted={l.now == null} title={sizeTip(tab, l)}>{layerFigure(tab, l)}{@render reported(l.now, l.reported)}</span>
          </span>
          <span class="aside num" title={sizeTip(tab, l)}>{current ? layerAside(tab, l, range) : ''}</span>
        </li>
        {#if listsTop(tab)}
          {@const under = containersUnder.get(l.name) ?? []}
          {@const underKeys = distinctKeys(under, (c) => c.id)}
          {@const allocated = allocatedAside(tab, l, under.length)}
          {@const inside = insideAside(tab, l, under.length)}
          {#snippet vmAside(j: number)}
            <!-- Under the VM's peak, on the lines its containers leave spare: its allocation, then what its guest needs. -->
            {#if j === 0 && allocated}
              <span class="aside num" data-allocated={l.name} title={allocatedTip(tab, l)}>{allocated}</span>
            {:else if j === 1 && inside}
              <span class="aside num" data-inside={l.name} title={insideTip(l)}>{inside}</span>
            {:else}
              <span class="aside num"></span>
            {/if}
          {/snippet}
          {#each under as c, j (underKeys[j])}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li class="row sub" class:hl={lit === vmLit(l.name)} data-container={c.name} data-in={l.name} title={containerTip(tab, c)}
              onmouseenter={() => (lit = vmLit(l.name))} onmouseleave={() => (lit = null)}>
              <span></span>
              <span class="part"><bdi class="name serif">{c.name}</bdi><span class="fig num">{amount(tab, c.now)}</span></span>
              {@render vmAside(j)}
            </li>
          {/each}
          {#if under.length === 1 && inside}
            <!-- One container leaves one line spare, which the allocation takes: what the guest needs gets its own. -->
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li class="row sub" class:hl={lit === vmLit(l.name)} data-in={l.name}
              onmouseenter={() => (lit = vmLit(l.name))} onmouseleave={() => (lit = null)}>
              <span></span>
              <span class="part"></span>
              {@render vmAside(1)}
            </li>
          {/if}
        {/if}
      {/each}
      {#if tab === 'mem' && now?.wired != null}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <li class="row other" class:hl={lit === 'wired'} data-part="wired" onmouseenter={() => (lit = 'wired')} onmouseleave={() => (lit = null)}>
          <span class="sw wired"></span>
          <span class="part"><span class="name serif" title={WIRED.tip}>{WIRED.name}</span><span class="fig num">{amount(tab, now.wired)}</span></span>
          <span class="aside">{WIRED.aside}</span>
        </li>
      {/if}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <li class="row other" class:hl={lit === 'rest'} data-part="rest" onmouseenter={() => (lit = 'rest')} onmouseleave={() => (lit = null)}>
        <span class="sw hatched"></span>
        <span class="part"><span class="name serif">everything else</span><span class="fig num">{amount(tab, now?.rest)}</span></span>
        <span class="aside"></span>
      </li>
      {#if listsTop(tab)}
        {#if appsNow?.pending || (!appsNow && appsFailed)}
          <li class="row sub" class:hl={lit === 'rest'} data-apps={appsFailed ? 'failed' : 'pending'} title={appsFailed}>
            <span></span>
            <span class="part"><span class="name serif">{appsFailed ? "the busiest apps couldn't be read" : APPS_PENDING}</span></span>
            <span class="aside"></span>
          </li>
        {/if}
        {#each topApps(tab, appsNow) as a (a.name)}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <li class="row sub" class:hl={lit === 'rest'} data-app={a.name} title={appTip(a)}
            onmouseenter={() => (lit = 'rest')} onmouseleave={() => (lit = null)}>
            <span></span>
            <span class="part"><span class="name serif">{a.name}</span><span class="fig num">{amount(tab, a.value)}{@render reported(a.value, a.reported)}</span></span>
            <span class="aside"></span>
          </li>
        {/each}
      {/if}
      <li class="row other">
        <span class="sw free"></span>
        <span class="part"><span class="name serif">free</span><span class="fig num">{amount(tab, now?.free)}</span></span>
        <span class="aside"></span>
      </li>
    </ul>
  </div>

  {#if error}<p class="error">{error}</p>{/if}

  <div class="newer"><UpdateNotice popover={true} /></div>

  <footer>
    <span>{recordingPhrase(snapshot?.intervalSecs)}</span>
    <span class="buttons">
      <button onclick={() => api.openMain().catch(() => {})}>Open Lima Desktop</button>
      <button onclick={() => api.quit().catch(() => {})}>Quit</button>
    </span>
  </footer>
</div>

<style>
  /* The window is the popover: no card or shadow of its own, and it scrolls only if it must, without
     a scrollbar. It's sized to the page (fitPopover), but a moment after the page grows (another tab,
     or its figures arriving), and a scrollbar would flash up in between. */
  :global(html:has(.popover)) { overflow-y: auto; scrollbar-width: none; }
  :global(html:has(.popover)::-webkit-scrollbar) { display: none; }
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

  /* The figure and the ranges side by side, what the figure is of under both, across the popover. */
  .top { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 10px; }
  .big { font-weight: 600; font-size: 2.4rem; line-height: 1; letter-spacing: -0.02em; }
  .big.hot { color: var(--warn); }
  .of { grid-column: 1 / -1; font-size: 0.8rem; line-height: 1.35; color: var(--muted); margin: 4px 0 0; }
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
  /* Wired memory is part of what isn't the VMs: everything else's hatch, crossed, not a VM's shade. */
  .band.wired { fill: url(#cross); }
  .band.rest { fill: url(#hatch); }
  /* What's pointed at comes forward in the accent colour, the rest of the stack recedes. */
  svg.lit .band { opacity: 0.3; }
  svg.lit .band.hl { opacity: 1; }
  .band.vm.hl, .band.wired.hl { fill: var(--accent); }
  .band.rest.hl { fill: url(#hatch-lit); }
  .line { fill: none; stroke: var(--fg); stroke-width: 1; vector-effect: non-scaling-stroke; pointer-events: none; }
  .chart .error { position: absolute; inset: auto 0 6px; padding: 0 8px; font-size: 0.8rem; }
  .axis { display: flex; justify-content: space-between; font-size: 0.74rem; color: var(--muted); }

  /* One grid for all the rows, so their figures line up. */
  .legend { list-style: none; margin: 10px 0 0; padding: 0; display: grid; grid-template-columns: 10px minmax(0, 1fr) auto auto; column-gap: 8px; }
  .row {
    grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: baseline;
    padding: 4px 2px; border-bottom: 1px solid var(--border); font-size: 0.86rem;
  }
  .row:last-child { border-bottom: 0; }
  .row.hl { background: var(--wash); }
  /* The busiest containers under their VM and apps under everything else: parts of the row above,
     so indented, smaller and grey, with no rule between them and it. */
  .row:has(+ .sub), .sub { border-bottom-color: transparent; }
  .sub:has(+ .row:not(.sub)) { border-bottom-color: var(--border); }
  .sub { padding-top: 1px; padding-bottom: 2px; font-size: 0.78rem; color: var(--muted); }
  .sub .name { font-size: 0.92rem; font-weight: 400; padding-left: 10px; color: var(--muted); }
  .sub .fig { font-weight: 400; }
  /* A name may run on into the figures' column as far as its own figure, still at the column's
     right edge, so longer names ("everything else", "Visual Studio Code") fit. */
  .part { grid-column: 2 / 4; display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .part .name { flex: 1; }
  .sw { width: 9px; height: 9px; align-self: center; background: var(--shade); }
  .sw.wired {
    background:
      repeating-linear-gradient(135deg, var(--soft) 0 2px, transparent 2px 4px),
      repeating-linear-gradient(45deg, var(--soft) 0 2px, var(--track) 2px 4px);
  }
  .sw.hatched { background: repeating-linear-gradient(135deg, var(--soft) 0 2px, var(--track) 2px 4px); }
  .sw.free { background: var(--track); }
  .name { font-weight: 500; font-size: 1.05rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name.hot { color: var(--warn); }
  .other .name { color: var(--muted); }
  .fig { font-weight: 600; text-align: right; }
  /* Memory as Activity Monitor says it, small after the figure. */
  .reported { margin-left: 0.3em; font-size: 0.78rem; font-weight: 400; color: var(--muted); }
  .aside { color: var(--muted); font-size: 0.78rem; min-width: 7.5em; text-align: right; }

  footer {
    display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; padding-top: 10px;
    border-top: 1px solid var(--border); font-size: 0.8rem; color: var(--muted);
  }
  /* A newer version, when one is out: its own line above the footer; nothing at all otherwise. */
  .newer { margin-top: 10px; font-size: 0.85rem; }
  .newer:empty { display: none; }
  .buttons { display: flex; gap: 6px; }
  .buttons button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .error { margin-top: 8px; }
</style>
