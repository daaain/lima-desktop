<script lang="ts">
  // A card's rows (richTip.ts): a swatch of how the bar draws each part, its name and figure, a line
  // on what it is; a part of the row above indented, one worth a look in the warning colour. In a
  // tooltip's card, and on a VM's page under its bars, where there's room to show them as they are.
  // A hairline between rows, so each figure reads with its own name and line: an indented row's from
  // its indent, so the parts of a row stay under it.
  import type { TipRow } from './richTip';

  let { rows }: { rows: TipRow[] } = $props();
</script>

<div class="rows num">
  {#each rows as r, i (i)}
    <div class="row" class:indent={r.indent}>
      <span class="sw {r.swatch ?? 'none'}"></span>
      <span class="name" class:flag={r.flag}>{r.name}</span>
      <span class="value" class:flag={r.flag}>{r.value ?? ''}</span>
      {#if r.sub}<span class="sub" class:flag={r.flag}>{r.sub}</span>{/if}
    </div>
  {/each}
</div>

<style>
  .rows { display: grid; }
  .row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 0.1rem 0.5rem; align-items: baseline; padding: 0.3rem 0; }
  .row + .row { border-top: 1px solid var(--border); }
  .row.indent { margin-left: 2.1rem; grid-template-columns: minmax(0, 1fr) auto; }
  .row.indent .sw { display: none; }
  .sw { width: 9px; height: 9px; align-self: center; }
  .sw.solid { background: var(--bar); }
  .sw.soft { background: var(--soft); }
  .sw.strong { background: var(--fg); }
  .sw.hatch { background: repeating-linear-gradient(135deg, var(--bar) 0 2px, transparent 2px 4px); box-shadow: inset 0 0 0 1px var(--bar); }
  .indent .name { color: var(--muted); }
  .value { text-align: right; font-weight: 600; white-space: nowrap; }
  .sub { grid-column: 2 / -1; color: var(--muted); }
  .indent .sub { grid-column: 1 / -1; }
  .flag, .indent .name.flag { color: var(--warn); }
</style>
