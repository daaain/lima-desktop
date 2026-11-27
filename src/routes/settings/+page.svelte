<script lang="ts">
  // What can be chosen about the app itself: how often each running VM is measured (the backend
  // and the polls follow at once), the theme, the menu bar's items and whether closing the window
  // leaves the app recording. settings.rs keeps them beside the history.
  import { onMount } from 'svelte';
  import {
    api, DRAWINGS, INTERVALS, THEMES, WARN_FREE_GB, WARN_PCTS, type Drawing, type MenuBar, type MenuBarItem, type Settings, type Theme,
    type Warn,
  } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { intervalPhrase } from '$lib/almanac';
  import { theme } from '$lib/theme.svelte';
  import { update } from '$lib/update.svelte';

  const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
  const DRAWING_LABELS: Record<Drawing, string> = { trace: 'Trace', bar: 'Bar', off: 'None' };
  type ItemKey = 'memory' | 'cpu' | 'disk';
  const ITEMS: { key: ItemKey; label: string }[] = [
    { key: 'memory', label: 'Memory' },
    { key: 'cpu', label: 'CPU' },
    { key: 'disk', label: 'Disk' },
  ];
  // Each worked out from the menu bar's settings as they are when it's saved, after any choice before it.
  const menuBar = (change: Partial<MenuBar> | ((m: MenuBar) => Partial<MenuBar> | null)) =>
    save((s) => {
      const c = typeof change === 'function' ? change(s.menuBar) : change;
      return c && { menuBar: { ...s.menuBar, ...c } };
    });
  const menuItem = (key: ItemKey, change: Partial<MenuBarItem>) => menuBar((m) => ({ [key]: { ...m[key], ...change } }));
  // When each item warns: memory and CPU past a percent in use, the disk with less than so many GB
  // free; or never.
  const WARN_KEYS: Record<ItemKey, keyof Warn> = { memory: 'memoryPct', cpu: 'cpuPct', disk: 'diskFreeGb' };
  const warnChoices = (key: ItemKey) =>
    key === 'disk'
      ? WARN_FREE_GB.map((gb) => ({ value: gb, label: `under ${gb} GB free` }))
      : WARN_PCTS.map((pct) => ({ value: pct, label: `past ${pct} %` }));
  const warnItem = (key: ItemKey, value: string) =>
    menuBar((m) => ({ warn: { ...m.warn, [WARN_KEYS[key]]: value === '' ? null : Number(value) } }));

  let settings = $state<Settings | null>(null);
  // A Linux panel shows an item's image alone (its title only with GNOME's AppIndicator extension),
  // so there an item is its drawing, with no figure or name to choose (menubar.rs's parts_here).
  let drawingsOnly = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const [s, platform] = await Promise.all([api.settings(), api.platform()]);
      drawingsOnly = platform === 'linux';
      settings = s;
    } catch (e) {
      error = String(e);
    }
  });

  // Choices are saved one after another, each on what the last left: each save sends the whole
  // settings, so two at once would have the second undo the first. Nothing waits disabled for a
  // save, which would take the keyboard's focus with it.
  let saved = Promise.resolve();
  /** Saves `change` after any choice before it (given as a function, worked out from the settings as
   * they are then, and nothing to save where it gives null: a choice of what's already chosen is
   * told apart then, not as it's made, when a choice before it may still be on its way); each
   * setting then takes effect where it shows. */
  function save(change: Partial<Settings> | ((s: Settings) => Partial<Settings> | null)): Promise<void> {
    return (saved = saved.then(() => store(change)));
  }
  async function store(asked: Partial<Settings> | ((s: Settings) => Partial<Settings> | null)) {
    if (!settings) return;
    error = null;
    const change = typeof asked === 'function' ? asked(settings) : asked;
    if (!change) return;
    try {
      settings = await api.setSettings({ ...settings, ...change });
      if (change.intervalSecs != null) live.poke();
      theme.apply(settings.theme);
    } catch (e) {
      error = String(e);
    }
  }
</script>

{#if !settings}
  {#if error}<p class="error">{error}</p>{:else}<p class="muted">Loading…</p>{/if}
{:else}
  <h1 class="headline">Each running VM is measured {intervalPhrase(settings.intervalSecs)}.</h1>

  <section class="panel">
    <h2 class="head">How often</h2>
    <div class="choices" role="group" aria-label="Measure each running VM every">
      {#each INTERVALS as s}
        <button class="choice num" class:active={settings.intervalSecs === s} aria-pressed={settings.intervalSecs === s}
          onclick={() => save((now) => (now.intervalSecs === s ? null : { intervalSecs: s }))}>{s} s</button>
      {/each}
    </div>
    <p class="note">
      A measurement is a short read of the VM's own counters over ssh, and of podman's figures for its containers; the
      lists and charts here update at the same pace. Less often costs each VM and this computer less, and the history
      kept is coarser to match: a spike shorter than the interval can fall between two measurements. A container's own
      peak memory is still caught, whatever the interval: the kernel keeps it.
    </p>
  </section>

  <section class="panel">
    <h2 class="head">Theme</h2>
    <div class="choices" role="group" aria-label="Theme">
      {#each THEMES as t}
        <button class="choice" class:active={settings.theme === t} aria-pressed={settings.theme === t}
          onclick={() => save((now) => (now.theme === t ? null : { theme: t }))}>{THEME_LABELS[t]}</button>
      {/each}
    </div>
    <p class="note">System is light or dark as this computer is, and follows it when it changes.</p>
  </section>

  <section class="panel">
    <h2 class="head">In the menu bar</h2>
    <div class="items">
      {#each ITEMS as item (item.key)}
        {@const chosen = settings.menuBar[item.key]}
        <div class="item">
          <span class="serif name">{item.label}</span>
          <div class="parts">
            <div class="choices" role="group" aria-label="{item.label} drawn in the menu bar as">
              {#each DRAWINGS as d}
                <button class="choice small" class:active={chosen.drawing === d} aria-pressed={chosen.drawing === d}
                  onclick={() => menuBar((m) => (m[item.key].drawing === d ? null : { [item.key]: { ...m[item.key], drawing: d } }))}>{DRAWING_LABELS[d]}</button>
              {/each}
            </div>
            {#if !drawingsOnly}
              <label class="check">
                <input type="checkbox" checked={chosen.figure} aria-label="{item.label} figure"
                  onchange={(e) => menuItem(item.key, { figure: e.currentTarget.checked })} />
                Figure
              </label>
            {/if}
            <label class="warn">
              Warn
              <select aria-label="{item.label} warns" value={String(settings.menuBar.warn[WARN_KEYS[item.key]] ?? '')}
                onchange={(e) => warnItem(item.key, e.currentTarget.value)}>
                {#each warnChoices(item.key) as c (c.value)}<option value={String(c.value)}>{c.label}</option>{/each}
                <option value="">never</option>
              </select>
            </label>
          </div>
        </div>
      {/each}
    </div>
    {#if drawingsOnly}
      <p class="note">
        Each item is the whole computer's memory, CPU or disk in use, with the VMs' part drawn pale at the bottom and
        everything else solid above it, so its top edge is the total. A trace draws it moving over time, a bar as it is
        now. Its menu opens the VMs' part over time, with the figures. An item drawn as None is left
        out, and with all three left out, the app's own icon stays in the panel as the way back in.
      </p>
    {:else}
      <label class="check">
        <input type="checkbox" checked={settings.menuBar.names} onchange={(e) => menuBar({ names: e.currentTarget.checked })} />
        Name each one (“mem”, “cpu”, “disk”)
      </label>
      <p class="note">
        Each item is the whole computer's memory, CPU or disk in use, with the VMs' part drawn pale at the bottom and
        everything else solid above it, so its top edge is the total. A trace draws it moving over time, a bar as it is
        now; the figure is the percent in use. A name goes small under the figure, or on its side beside a drawing alone.
        Clicking an item opens the VMs' part over time. An item with neither a drawing nor a figure is left out, and with
        all three left out, the app's own icon stays in the menu bar as the way back in.
      </p>
    {/if}
    <p class="note">
      An item turns the warning colour, and so does the figure in the window it opens, when memory or CPU is past the
      percent in use chosen, or when the disk has less than the space chosen left: a percent says little across disk
      sizes, as 90 % of a 1 TB disk still leaves 100 GB. The main window's warnings are each VM's own, past three
      quarters of its size.
    </p>
  </section>

  <section class="panel">
    <h2 class="head">When the window is closed</h2>
    <label class="check">
      <input type="checkbox" checked={settings.keepRunning} onchange={(e) => save({ keepRunning: e.currentTarget.checked })} />
      Keep recording, in the menu bar
    </label>
    <p class="note">
      Otherwise closing the window quits the app, and nothing is measured until it opens again. Quit (⌘Q, or Quit in
      the menu bar's popover) always stops the recording.
    </p>
  </section>

  <section class="panel">
    <h2 class="head">New versions</h2>
    <label class="check">
      <input type="checkbox" checked={settings.checkUpdates}
        onchange={(e) => save({ checkUpdates: e.currentTarget.checked }).then(() => update.refresh())} />
      Say when a new version is out
    </label>
    <p class="note">Once a day the app asks GitHub for its latest release, and when it's newer, for what it brings. It sends nothing about you or this computer.</p>
  </section>
  {#if error}<p class="error">{error}</p>{/if}
{/if}

<style>
  .panel { display: grid; gap: 0.9rem; justify-items: start; }
  .choices { display: flex; gap: 0.3rem; flex-wrap: wrap; }
  .choice { min-width: 3.4rem; }
  .items { display: grid; width: 100%; max-width: 46rem; }
  .item {
    display: flex; align-items: center; justify-content: space-between; gap: 0.6rem 1rem; flex-wrap: wrap;
    padding: 0.5rem 0; border-bottom: 1px solid var(--border);
  }
  .item .name { font-size: 1.25rem; font-weight: 500; }
  .parts { display: flex; align-items: center; gap: 0.6rem 1.4rem; flex-wrap: wrap; }
  .choice.small { height: 2rem; padding: 0 0.85rem; font-size: 0.85rem; }
  .check { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.95rem; cursor: pointer; }
  .check input { accent-color: var(--fg); width: 15px; height: 15px; margin: 0; }
  .warn { font-size: 0.95rem; }
  .warn select {
    font: inherit; color: var(--fg); background: transparent; border: 0; border-bottom: 1px solid var(--border);
    padding: 0 0.1rem; margin-left: 0.2rem; cursor: pointer;
    /* As wide as its longest choice, so each item's controls line up with the others'. */
    width: 9.5rem;
  }
  .note { max-width: 46rem; }
</style>
