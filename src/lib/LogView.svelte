<script lang="ts">
  // A container's log: searched by its words, filtered by level, stream and time, and opened in a
  // window of its own to read at length. Fetched when it opens and when the time or how many lines
  // changes, never on the live snapshot's tick, which would move it under the reader.
  import { tick } from 'svelte';
  import { api } from './api';
  import { inOrder } from './inOrder';
  import {
    fetchedSentence, filterLog, LEVELS, logCounts, logLines, logTime, pieces, shownSentence, tokenize,
    type Level, type LogLine, type Stream, type Token,
  } from './logs';
  import { RANGES, rangeMs, theLast, type RangeKey } from './ranges';

  let { vm, id, name, image }: { vm: string; id: string; name: string; image: string } = $props();

  /** How many of the newest lines to ask for, and the steps up when there may be more. */
  const TAILS = [500, 5000, 20000];
  /** At most this many lines are drawn: the newest of those the filter leaves. */
  const DRAWN = 2000;

  let lines = $state<LogLine[] | null>(null);
  // Each line's words, split when a query first needs them.
  let tokens: Token[][] = [];
  const tokensOf = (n: number) => (tokens[n] ??= tokenize(lines![n].text));
  let fetched = $state<{ tail: number; since: number | null; over: RangeKey | null } | null>(null);
  let error = $state<string | null>(null);

  let query = $state('');
  let levels = $state(new Set<Level | 'none'>());
  let streams = $state(new Set<Stream>());
  let over = $state<RangeKey | null>(null);
  let tail = $state(TAILS[0]);
  let asked = $state(0);
  let full = $state(false);

  let logBox = $state<HTMLElement>();
  let search = $state<HTMLInputElement>();
  let dialog = $state<HTMLDialogElement>();

  const logInOrder = inOrder();
  $effect(() => {
    void asked;
    const want = { tail, over, since: over ? Date.now() - rangeMs(over) : null };
    error = null;
    logInOrder(api.containerLogs(vm, id, want.tail, want.since)).then(
      (raw) => {
        tokens = [];
        lines = logLines(raw);
        fetched = want;
      },
      (e) => (error = String(e)),
    );
  });

  const counts = $derived(lines ? logCounts(lines) : null);
  const shown = $derived(lines ? filterLog(lines, tokensOf, { query, levels, streams, since: fetched?.since ?? null }) : []);
  const drawn = $derived(shown.length > DRAWN ? shown.slice(-DRAWN) : shown);
  const filtering = $derived(query.trim() !== '' || levels.size > 0 || streams.size > 0);
  // Level chips only when some line says one; stream chips only when both streams wrote some.
  const levelChips = $derived(counts && counts.levels.none < lines!.length ? LEVELS.filter((l) => counts.levels[l.key] > 0) : []);
  const streamChips = $derived(counts && counts.streams.stdout && counts.streams.stderr ? (['stdout', 'stderr'] as const) : []);
  const more = $derived(lines && fetched && lines.length >= fetched.tail ? TAILS.find((t) => t > fetched!.tail) : undefined);

  // The newest lines are what's wanted: start at the end, and go back to it as the filter changes.
  $effect(() => {
    void shown;
    tick().then(() => logBox && (logBox.scrollTop = logBox.scrollHeight));
  });

  function toggle<T>(set: Set<T>, key: T): Set<T> {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  }

  // Moving between the detail and the full window keeps the line read at the top of the box.
  function topLine(): string | null {
    if (!logBox || logBox.scrollTop + logBox.clientHeight >= logBox.scrollHeight - 2) return null;
    const top = logBox.scrollTop;
    for (const el of logBox.querySelectorAll<HTMLElement>('.ln')) if (el.offsetTop + el.offsetHeight > top) return el.dataset.n!;
    return null;
  }
  async function move(to: boolean) {
    const n = topLine();
    full = to;
    await tick();
    if (to) {
      dialog?.showModal();
      search?.focus();
    }
    if (!logBox) return;
    const el = n != null ? logBox.querySelector<HTMLElement>(`.ln[data-n="${n}"]`) : null;
    logBox.scrollTop = el ? el.offsetTop : logBox.scrollHeight;
  }

  function keys(e: KeyboardEvent) {
    // Escape leaves the full window, the search too (where an engine would first clear the field).
    if (e.key === 'Escape' && full) {
      e.preventDefault();
      dialog?.close();
    } else if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
      e.preventDefault();
      search?.focus();
      search?.select();
    }
  }

  const stamp = (l: LogLine) => [l.at != null ? new Date(l.at).toISOString() : null, l.stream].filter(Boolean).join(' · ') || undefined;
</script>

{#snippet viewer()}
  <div class="bar">
    <input type="search" placeholder="Search the log" aria-label="Search the log" bind:value={query} bind:this={search}
      title={'Every word must be in a line; the last may be the start of one. "a phrase" for words in order, -word to leave lines out.'} />
    <select aria-label="Time" value={over ?? ''} onchange={(e) => (over = (e.currentTarget.value || null) as RangeKey | null)}>
      <option value="">any time</option>
      {#each RANGES as r}<option value={r.key}>last {r.label}</option>{/each}
    </select>
    {#if levelChips.length}
      <span class="chips" role="group" aria-label="Level">
        {#each levelChips as l}
          <button class="chip" class:active={levels.has(l.key)} aria-pressed={levels.has(l.key)} data-level={l.key}
            onclick={() => (levels = toggle(levels, l.key))}>{l.label} <span class="num">{counts!.levels[l.key].toLocaleString('en-GB')}</span></button>
        {/each}
      </span>
    {/if}
    {#if streamChips.length}
      <span class="chips" role="group" aria-label="Stream">
        {#each streamChips as s}
          <button class="chip" class:active={streams.has(s)} aria-pressed={streams.has(s)}
            onclick={() => (streams = toggle(streams, s))}>{s} <span class="num">{counts!.streams[s].toLocaleString('en-GB')}</span></button>
        {/each}
      </span>
    {/if}
    <span class="spacer"></span>
    <button class="icon" onclick={() => asked++} aria-label="Fetch again" title="Fetch the log again">↻</button>
    {#if full}
      <button class="icon" onclick={() => dialog?.close()} aria-label="Close the full window" title="Back to the detail (Esc)">✕</button>
    {:else}
      <button class="icon" onclick={() => move(true)} aria-label="Full window" title="Read the log in a full window">⤢</button>
    {/if}
  </div>
  {#if error}<p class="error">{error}</p>{/if}
  {#if lines && fetched}
    <p class="note num">
      {fetchedSentence(lines.length, fetched.tail, fetched.over && theLast(fetched.over))}
      {#if more}<button class="more" onclick={() => (tail = more!)}>Fetch up to {more.toLocaleString('en-GB')}</button>{/if}
      {#if filtering}<span class="shown">{shownSentence(shown.length, lines.length, drawn.length)}</span>{/if}
    </p>
  {/if}
  <div class="log" class:full bind:this={logBox}>
    {#if lines == null}…{/if}
    {#each drawn as s (s.n)}
      {#if s.day}<div class="day">{s.day}</div>{/if}
      <div class="ln" data-n={s.n} data-level={s.line.level}><span class="t" title={stamp(s.line)}>{s.line.at != null ? logTime(s.line.at) : ''}</span><span class="x">{#each pieces(s.line.text, s.marks) as p}{#if p.mark}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}</span></div>
    {/each}
  </div>
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="logs" onkeydown={keys}>
  {#if !full}{@render viewer()}{/if}
</div>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<dialog bind:this={dialog} class="window" aria-label={`${name}'s log`} onclose={() => move(false)} onkeydown={keys}>
  {#if full}
    <div class="head">
      <h3 class="serif">{name}</h3>
      <span class="muted">{image}</span>
    </div>
    {@render viewer()}
  {/if}
</dialog>

<style>
  .logs { display: grid; gap: 0.5rem; }
  .bar { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .bar input, .bar select {
    font: inherit; font-size: 0.85rem; height: 1.9rem; padding: 0 0.8rem; border-radius: 0.95rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  }
  .bar input { flex: 1 1 14rem; min-width: 10rem; max-width: 26rem; }
  .chips { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .bar button { height: 1.9rem; padding: 0 0.8rem; font-size: 0.82rem; }
  .bar button.icon { width: 1.9rem; padding: 0; }
  .chip .num { color: var(--muted); margin-left: 0.15rem; }
  .chip.active .num { color: inherit; opacity: 0.75; }
  .chip[data-level='error']:not(.active) { color: var(--alert); }
  .chip[data-level='warn']:not(.active) { color: var(--warn); }
  .spacer { flex: 1; }
  .note { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; font-size: 0.8rem; }
  .shown { color: var(--fg); }
  .more { height: auto; padding: 0; border: 0; border-radius: 0; font-size: inherit; color: var(--accent); background: none; }
  .more:hover:not(:disabled) { text-decoration: underline; }

  .log {
    position: relative; max-height: 26rem; overflow: auto; overscroll-behavior: contain; background: var(--bg); padding: 0.75rem 0.75rem 0.75rem 0.4rem;
    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 0.8rem; line-height: 1.45;
  }
  .log.full { max-height: none; min-height: 0; }
  /* The time in its own column, so a wrapped line hangs clear of it; a line's level as a rule beside it. */
  .ln { display: grid; grid-template-columns: 4.6rem minmax(0, 1fr); column-gap: 0.6rem; padding-left: 0.35rem; border-left: 2px solid transparent; }
  .ln[data-level='error'] { border-left-color: var(--alert); }
  .ln[data-level='warn'] { border-left-color: var(--warn); }
  .ln[data-level='debug'] .x { color: var(--muted); }
  .x { white-space: pre-wrap; overflow-wrap: anywhere; }
  .t { color: var(--muted); font-variant-numeric: tabular-nums; }
  mark { background: color-mix(in srgb, var(--accent) 22%, transparent); color: inherit; border-radius: 2px; }
  .day { font-family: var(--sans); font-size: 0.78rem; color: var(--muted); padding: 0.5rem 0 0.2rem 0.35rem; }
  .day:first-child { padding-top: 0; }

  /* The full window: the whole of the app's, the log filling what the bar and note leave. */
  dialog.window {
    width: 100vw; height: 100vh; max-width: none; max-height: none; margin: 0; border: 0; box-sizing: border-box;
    padding: 1.4rem 2rem; background: var(--wash); color: var(--fg);
  }
  dialog.window[open] { display: flex; flex-direction: column; gap: 0.6rem; }
  .log.full { flex: 1; }
  dialog.window::backdrop { background: var(--bg); }
  .head { display: flex; align-items: baseline; gap: 0.6rem; flex-wrap: wrap; }
  .head h3 { margin: 0; font-size: 1.5rem; font-weight: 600; }
  .muted { color: var(--muted); font-size: 0.8rem; }
  :global(html:has(dialog.window[open])) { overflow: hidden; }
  @media (max-width: 640px) { dialog.window { padding: 1rem; } }
</style>
