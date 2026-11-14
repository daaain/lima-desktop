<script lang="ts">
  // What can be chosen about the app itself: how often each running VM is measured (the backend
  // and the polls follow at once), the theme, the menu bar's items and whether closing the window
  // leaves the app recording. settings.rs keeps them beside the history.
  import { onMount } from 'svelte';
  import { api, DRAWINGS, INTERVALS, THEMES, type Drawing, type MenuBar, type MenuBarItem, type Settings, type Theme } from '$lib/api';
  import { live } from '$lib/live.svelte';
  import { intervalPhrase } from '$lib/almanac';
  import { theme } from '$lib/theme.svelte';

  const THEME_LABELS: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };
  const DRAWING_LABELS: Record<Drawing, string> = { trace: 'Trace', bar: 'Bar', off: 'None' };
  type ItemKey = 'memory' | 'cpu' | 'disk';
  const ITEMS: { key: ItemKey; label: string }[] = [
    { key: 'memory', label: 'Memory' },
    { key: 'cpu', label: 'CPU' },
    { key: 'disk', label: 'Disk' },
  ];
  const menuBar = (change: Partial<MenuBar>) => save({ menuBar: { ...settings!.menuBar, ...change } });
  const menuItem = (key: ItemKey, change: Partial<MenuBarItem>) => menuBar({ [key]: { ...settings!.menuBar[key], ...change } });

  let settings = $state<Settings | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      settings = await api.settings();
    } catch (e) {
      error = String(e);
    }
  });

  /** Saves `change`; each setting then takes effect where it shows. */
  async function save(change: Partial<Settings>) {
    if (!settings || saving) return;
    saving = true;
    error = null;
    try {
      settings = await api.setSettings({ ...settings, ...change });
      if (change.intervalSecs != null) live.poke();
      theme.apply(settings.theme);
    } catch (e) {
      error = String(e);
    } finally {
      saving = false;
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
          disabled={saving} onclick={() => settings!.intervalSecs !== s && save({ intervalSecs: s })}>{s} s</button>
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
          disabled={saving} onclick={() => settings!.theme !== t && save({ theme: t })}>{THEME_LABELS[t]}</button>
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
                  disabled={saving} onclick={() => chosen.drawing !== d && menuItem(item.key, { drawing: d })}>{DRAWING_LABELS[d]}</button>
              {/each}
            </div>
            <label class="check">
              <input type="checkbox" checked={chosen.figure} disabled={saving} aria-label="{item.label} figure"
                onchange={(e) => menuItem(item.key, { figure: e.currentTarget.checked })} />
              Figure
            </label>
          </div>
        </div>
      {/each}
    </div>
    <label class="check">
      <input type="checkbox" checked={settings.menuBar.names} disabled={saving} onchange={(e) => menuBar({ names: e.currentTarget.checked })} />
      Name each one (“mem”, “cpu”, “disk”)
    </label>
    <p class="note">
      Each item is the whole computer's memory, CPU or disk in use, with the VMs' part drawn solid and everything else
      pale. A trace draws it moving over time, a bar as it is now; the figure is the percent in use. A name goes small
      under the figure, or on its side beside a drawing alone. Clicking an item opens the VMs' part over time. An item
      with neither a drawing nor a figure is left out, and with all three left out, the app's own icon stays in the menu
      bar as the way back in.
    </p>
  </section>

  <section class="panel">
    <h2 class="head">When the window is closed</h2>
    <label class="check">
      <input type="checkbox" checked={settings.keepRunning} disabled={saving} onchange={(e) => save({ keepRunning: e.currentTarget.checked })} />
      Keep recording, in the menu bar
    </label>
    <p class="note">
      Otherwise closing the window quits the app, and nothing is measured until it opens again. Quit (⌘Q, or Quit in
      the menu bar's popover) always stops the recording.
    </p>
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
  .note { max-width: 46rem; }
</style>
