<script lang="ts">
  // The chevron beside what folds (a VM, a compose project): down while open, turned to point at its
  // name while folded. A drawing, not a glyph, so a heading's text is its name alone.
  let { folded }: { folded: boolean } = $props();
</script>

<svg class="mark" class:folded viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>

<style>
  .mark {
    flex: none; align-self: center; width: 0.6em; height: 0.6em;
    fill: none; stroke: var(--muted); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round;
    transition: transform 0.2s ease-out;
  }
  .folded { transform: rotate(-90deg); }
  @media (prefers-reduced-motion: reduce) { .mark { transition: none; } }
</style>
