<script lang="ts">
  // A share of a scale, notched at quarters. Optionally a paler bar behind it (e.g. the peak) and
  // a tick (e.g. p95). Past three quarters it takes the warning colour, unless `plain`.
  import { isHot } from './almanac';

  let { pct, behind, tick, plain = false, quiet = false, hot, label }: {
    pct: number; behind?: number; tick?: number; plain?: boolean; quiet?: boolean;
    /** Overrides the three-quarters rule (e.g. measured against a limit that isn't the scale). */
    hot?: boolean; label?: string;
  } = $props();
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
</script>

<div class="bar" class:hot={hot ?? (!plain && isHot(pct))} class:quiet role={label ? 'img' : undefined} aria-label={label} title={label}>
  {#if behind != null}<span class="behind" style:width={`${clamp(behind)}%`}></span>{/if}
  <span class="fill" class:some={pct > 0} style:width={`${clamp(pct)}%`}></span>
  <span class="notch" style:left="25%"></span><span class="notch" style:left="50%"></span><span class="notch" style:left="75%"></span>
  {#if tick != null}<span class="tick" style:left={`${clamp(tick)}%`}></span>{/if}
</div>

<style>
  .bar { position: relative; height: var(--bar-height, 6px); background: var(--track); }
  .fill, .behind { position: absolute; inset: 0 auto 0 0; }
  /* The width a plain percentage and the least of it a min-width, not `max(2px, n%)`: WebKit keeps
     every transition between two max()es it has run, about 1 MB a second on the Containers view
     (`just ui-leak`, docs/development.md). */
  .fill { background: var(--bar); transition: width 0.4s; }
  .fill.some { min-width: 2px; }
  .behind { background: var(--soft); }
  .hot .fill { background: var(--warn); }
  .quiet .fill { background: var(--soft); }
  .notch { position: absolute; top: 0; bottom: 0; width: 1.5px; margin-left: -0.75px; background: var(--bg); }
  .tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--fg); }
</style>
