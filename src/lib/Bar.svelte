<script lang="ts">
  // A share of a scale, notched at quarters. Optionally a paler bar behind it (e.g. the peak), a
  // strongest part of it (e.g. a container's processes' own memory, of a figure that also counts cache)
  // and a tick (e.g. p95). Past three quarters it takes the warning colour, unless `plain`.
  import { isHot } from './almanac';

  let { pct, behind, own, tick, plain = false, quiet = false, hot, label }: {
    pct: number; behind?: number;
    /** Of `pct`, the part drawn strongest: no wider than it. */
    own?: number;
    tick?: number; plain?: boolean; quiet?: boolean;
    /** Overrides the three-quarters rule (e.g. measured against a limit that isn't the scale). */
    hot?: boolean; label?: string;
  } = $props();
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
</script>

<div class="bar" class:hot={hot ?? (!plain && isHot(pct))} class:quiet role={label ? 'img' : undefined} aria-label={label} title={label}>
  {#if behind != null}<span class="behind" style:width={`${clamp(behind)}%`}></span>{/if}
  <span class="fill" class:some={pct > 0} class:split={own != null} style:width={`${clamp(pct)}%`}></span>
  {#if own != null}<span class="own" style:width={`${clamp(Math.min(own, pct))}%`}></span>{/if}
  <span class="notch" style:left="25%"></span><span class="notch" style:left="50%"></span><span class="notch" style:left="75%"></span>
  <!-- Where the strongest part ends inside the fill, a notch like the quarters' parts it from the rest:
       in dark mode the two are close in lightness (near-white on light grey). -->
  {#if own != null && own > 0 && own < pct}<span class="notch cut" style:left={`${clamp(own)}%`}></span>{/if}
  {#if tick != null}<span class="tick" style:left={`${clamp(tick)}%`}></span>{/if}
</div>

<style>
  .bar { position: relative; height: var(--bar-height, 6px); background: var(--track); }
  .fill, .behind, .own { position: absolute; inset: 0 auto 0 0; }
  /* The width a plain percentage and the least of it a min-width, not `max(2px, n%)`: WebKit before
     October 2026 never frees a computed calc() length (bugs.webkit.org/show_bug.cgi?id=325845), and a
     transition between two computes one every frame, about 1 MB a second on the Containers view
     (styles.test.ts). */
  .fill, .own { transition: width 0.4s; }
  /* The notch where the strongest part ends moves with it, not ahead of it. */
  .notch.cut { transition: left 0.4s; }
  .fill { background: var(--bar); }
  .fill.some { min-width: 2px; }
  .behind { background: var(--soft); }
  /* The strongest part differs by lightness, not hue: the foreground's colour, the most contrast there is.
     There is no stronger warning colour, so past three quarters it is the rest that goes fainter. */
  .own { background: var(--fg); }
  .hot .fill { background: var(--warn); }
  .hot .fill.split { opacity: 0.5; }
  .hot .own { background: var(--warn); }
  .quiet .fill { background: var(--soft); }
  .notch { position: absolute; top: 0; bottom: 0; width: 1.5px; margin-left: -0.75px; background: var(--bg); }
  .tick { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--fg); }
</style>
