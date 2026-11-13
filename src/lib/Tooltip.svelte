<script lang="ts">
  // The tooltip, drawn once for the whole app. The browser's own `title` tooltip takes a second or
  // more to appear; this one shows after a short rest (tips.ts). Any element's `title` becomes its
  // text: on first pointing at it the attribute moves to `data-tip`, so the browser's never shows,
  // and to `aria-description`, so a screen reader still has it. A `title` set again later (the text
  // changed) is taken over the same way next time.
  import { OWN_TIP, tooltip } from './tipState.svelte';

  function source(el: Element | null): HTMLElement | SVGElement | null {
    const found = el?.closest(`[${OWN_TIP}], [title], [data-tip]`) as HTMLElement | SVGElement | null;
    return found?.hasAttribute(OWN_TIP) ? null : found;
  }

  function textOf(el: HTMLElement | SVGElement): string {
    const title = el.getAttribute('title');
    if (title != null) {
      el.removeAttribute('title');
      el.dataset.tip = title;
      if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) el.setAttribute('aria-description', title);
    }
    return el.dataset.tip ?? '';
  }

  function move(e: PointerEvent) {
    const target = e.target as Element | null;
    if (target?.closest(`[${OWN_TIP}]`)) return; // it says what it says itself
    const el = source(target);
    tooltip.point(el, el ? textOf(el) : null, e.clientX, e.clientY);
  }

  let width = $state(0);
  let height = $state(0);
  // Beside the pointer on whichever side has the room, so it never widens or lengthens the page.
  const place = $derived.by(() => {
    const s = tooltip.shown;
    if (!s) return null;
    const left = s.x + 12 + width > window.innerWidth - 8 ? Math.max(8, s.x - 12 - width) : s.x + 12;
    const top = s.y + 16 + height > window.innerHeight - 8 ? Math.max(8, s.y - 8 - height) : s.y + 16;
    return { left, top };
  });
</script>

<svelte:document
  onpointermove={move}
  onpointerout={(e) => { if (!e.relatedTarget) tooltip.hide(); }}
  onpointerdown={() => tooltip.hide()}
  onkeydown={() => tooltip.hide()} />
<svelte:window onscroll={() => tooltip.hide()} onblur={() => tooltip.hide()} />

{#if tooltip.shown && place}
  <div class="tip num" role="tooltip" bind:offsetWidth={width} bind:offsetHeight={height}
    style:left={`${place.left}px`} style:top={`${place.top}px`}>{tooltip.shown.text}</div>
{/if}

<style>
  .tip {
    position: fixed; z-index: 100; pointer-events: none; max-width: 24rem; white-space: pre-line;
    background: var(--fg); color: var(--bg); font-size: 0.75rem; line-height: 1.4; padding: 0.35rem 0.55rem; border-radius: 4px;
  }
</style>
