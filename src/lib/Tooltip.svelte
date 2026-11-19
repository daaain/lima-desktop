<script lang="ts">
  // The tooltip, drawn once for the whole app. The browser's own `title` tooltip takes a second or
  // more to appear; this one shows after a short rest (tips.ts). Any element's `title` becomes its
  // text: on first pointing at it the attribute moves to `data-tip`, so the browser's never shows,
  // and to `aria-description`, so a screen reader still has it. A `title` set again later (the text
  // changed) is taken over the same way next time.
  // An element given a card (richTip.svelte.ts) shows it in place of its text.
  import { OWN_TIP, tooltip } from './tipState.svelte';
  import { tipText } from './richTip';
  import { richOf } from './richTip.svelte';
  import Bar from './Bar.svelte';

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
    over = el;
    tooltip.point(el, el ? textOf(el) : null, e.clientX, e.clientY);
  }

  // What the pointer is over: its card, if it has one and it's what is shown.
  let over = $state<Element | null>(null);
  const card = $derived.by(() => {
    const rich = richOf(over);
    return rich && tooltip.shown?.text === tipText(rich) ? rich : null;
  });

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

{#if tooltip.shown && place && card}
  <div class="tip card num" role="tooltip" bind:offsetWidth={width} bind:offsetHeight={height}
    style:left={`${place.left}px`} style:top={`${place.top}px`}>
    <div class="head"><span class="title">{card.title}</span>{#if card.figure}<span class="figure">{card.figure}</span>{/if}</div>
    {#if card.bar}<Bar {...card.bar} />{/if}
    <div class="rows">
      {#each card.rows as r, i (i)}
        <span class="sw {r.swatch ?? 'none'}" class:indent={r.indent}></span>
        <span class="name" class:indent={r.indent} class:flag={r.flag}>{r.name}</span>
        <span class="value" class:flag={r.flag}>{r.value ?? ''}</span>
        {#if r.sub}<span class="sub" class:indent={r.indent} class:flag={r.flag}>{r.sub}</span>{/if}
      {/each}
    </div>
    {#if card.foot}<p class="foot">{card.foot}</p>{/if}
  </div>
{:else if tooltip.shown && place}
  <div class="tip num" role="tooltip" bind:offsetWidth={width} bind:offsetHeight={height}
    style:left={`${place.left}px`} style:top={`${place.top}px`}>{tooltip.shown.text}</div>
{/if}

<style>
  .tip {
    position: fixed; z-index: 100; pointer-events: none; max-width: 24rem; white-space: pre-line;
    background: var(--fg); color: var(--bg); font-size: 0.75rem; line-height: 1.4; padding: 0.35rem 0.55rem; border-radius: 4px;
  }
  /* A card: on the page's own ground (its bar and swatches drawn as on the page), set off by a
     border and a shadow, its parts in rows. */
  .card {
    display: grid; gap: 0.5rem; width: 21rem; max-width: calc(100vw - 16px); white-space: normal;
    background: var(--bg); color: var(--fg); border: 1px solid color-mix(in srgb, var(--soft) 60%, var(--bg)); border-radius: 6px;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.16); padding: 0.65rem 0.75rem 0.6rem; font-size: 0.78rem; line-height: 1.35;
    --bar-height: 7px;
  }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.8rem; flex-wrap: wrap; }
  .title { font-family: var(--serif); font-size: 1rem; font-weight: 600; }
  .figure { color: var(--muted); white-space: nowrap; }
  .rows { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 0.25rem 0.5rem; align-items: baseline; }
  .sw { width: 9px; height: 9px; align-self: center; }
  .sw.solid { background: var(--bar); }
  .sw.soft { background: var(--soft); }
  .sw.strong { background: var(--fg); }
  .sw.hatch { background: repeating-linear-gradient(135deg, var(--bar) 0 2px, transparent 2px 4px); box-shadow: inset 0 0 0 1px var(--bar); }
  .name.indent, .sub.indent { padding-left: 0.8rem; }
  .name.indent { color: var(--muted); }
  .value { text-align: right; font-weight: 600; white-space: nowrap; }
  .sub { grid-column: 2 / -1; color: var(--muted); margin-top: -0.15rem; }
  .flag, .name.indent.flag { color: var(--warn); }
  .foot { margin: 0; color: var(--muted); border-top: 1px solid var(--border); padding-top: 0.4rem; }
</style>
