# Accessibility

The audit for [#28](https://github.com/daaain/lima-desktop/issues/28), the starting point for its fixes: each one updates this page as it lands. How it was done: every page walked by keyboard in headless Chromium against the fake backend (overview, Containers with a line opened, a VM page, Images, Volumes, Settings, the popover's three tabs), recording each Tab stop's role, name and focus ring, plus an aria snapshot per page; a read of every component for pointer-only behaviour, ARIA use and `svelte-ignore a11y_*`; and the contrast of every chart and bar mark from the two palettes in `+layout.svelte`, light and dark. Not yet done: VoiceOver in the app's own WKWebView (checklist at the end). Run against the code as of #30; #31–#37 changed little UI apart from the log view.

## Already good

- A focus ring on every stop on every page, light and dark; nothing resets `outline`.
- No unnamed or off-screen stops. Range buttons, sort heads, folds and Settings' groups are labelled and state their state (`aria-pressed`, `aria-expanded`).
- Container, image and volume lines open with Enter and Space; focus stays.
- The full-window log is a native modal dialog: focus starts in its search, stays inside, Escape closes it.
- Reduced motion honoured by `motion.ts` everywhere it's used.
- The capacity bars' `aria-label` lists every VM's block.

## Findings, by theme

### 1. Rows are buttons with buttons inside (major, maybe blocker under VoiceOver)

`ContainerLine.svelte:34` and `ItemLine.svelte:40` are `role=button` divs that hold Stop/Restart/Remove buttons, bars and charts. A button's children are presentational, so the line's name is all of its text run together (300+ characters, ending "Stop Restart"), the bars' card text is lost inside it, and VoiceOver may not reach the inner buttons as buttons. **Fixed:** each action is named for what it acts on after its own word ("Stop harbor"), and a line has `aria-controls` while its detail is open.

This bears on the chart question: if a row opens into its detail, the opener should be a real `<button aria-expanded aria-controls>` (the name, as `ProjectHead` does), and the row a plain container around it.

### 2. Focus lost to `<body>` (major)

**Fixed** for each case below, by focus events alone, nothing watching the page: a button busy with what it was pressed for is `aria-disabled` and ignores presses, not disabled, so it keeps the focus; Stop and Start (and a container's Restart and Remove) are one button each whose word follows the state, so nothing is swapped from under the focus; Settings saves choices one after another instead of disabling every control while one is saved; a VM's buttons drawn afresh in the overview's other list take the focus over (`handOver.ts`); Containers' lines and the overview's running VMs keep their order while the keyboard is in them (`heldOrder.ts`: where the focus is, is looked at every poll and as it moves, as WebKit says nothing when a control is taken out with it), as a keyed list moves a line by taking it out, focus and all; `opener.ts` gives the focus back to the line that opened what was closed; and Files puts it on what each step opened. Still lost: an image's or volume's line once its Remove has removed it, a line that a filter takes away, and a VM's Start while it can't be started (neither running nor stopped, or managed by another tool), which is `disabled` and drops the focus as its VM comes to that (see the disabled buttons' reasons, below).

- Pressing a control that disables itself while it works: VM and container Stop/Start (`VmActions`, `ContainerActions`), every Settings control (`disabled={saving}`), Images/Volumes Refresh and Measure.
- Closing something: a container's detail ✕ (`ContainerDetail.svelte:66`), an image's layers ✕ (`ImageLayers.svelte:58`), the full-window log (`LogView.svelte:83-103`, its opener was unmounted).
- Every step in Files (`Files.svelte:76-122`): after a folder opens, Tab jumps past the new list.

### 3. Hover-only readouts (the issue's own list), confirmed

| What | Where | Keyboard | Screen reader |
| --- | --- | --- | --- |
| Column card of charts above a bar | `Sketch.svelte:70`, `MemoryShare.svelte:53`; 15 on the overview, 46 on Containers | can't reach | label only ("up to N % of the scale"), card never described |
| uPlot cursor and legend | `Chart.svelte`; VM page, container detail | can't reach; legend shows latest reading | legend read as a table (latest only); canvas has no text alternative; the legend's click-to-hide series is pointer-only |
| Capacity block → VM named above | `Capacity.svelte:37-40` | can't reach | fine (all in the label) |
| Popover row ↔ band highlight | `menubar/+page.svelte:209-315` | can't reach | rows are readable text; band names only in `data-tip` |
| Every `title` and rich card | `Tooltip.svelte` | never shown on focus (0 of ~70 stops) | mostly via `aria-description` |

### 4. Tooltip text that's lost or out of reach

- **Fixed:** an element with both `aria-label` and `title` loses the title for screen readers once hovered: `textOf` moves it to `data-tip` and only copies it to `aria-description` when there's no label (`Tooltip.svelte:23`). Hit: the log search's syntax help and icon buttons (`LogView.svelte:113-140`), `UpdateNotice.svelte:27`, the range picker's explanation (`Masthead.svelte:46`).
- Disabled buttons say why only in `title`, and a disabled button can't take focus: "Stop it first" (`VmActions`), "Stop the VM to resize it" (`Sizing.svelte:122`), "In use — remove its containers first" (20× on Images), prune buttons.
- Hover-only text on things that can't take focus: status dots' names, Pressure (PSI), a container's full name and start time, image/volume names and mountpoints, the OOM badge, Activity Monitor's figure and the asides in the popover, log timestamps, truncated build steps.
- WCAG 1.4.13: dismissable and persistent pass; _hoverable_ fails (the tip has `pointer-events: none` and follows the pointer), which matters under a magnifier for a 21rem card.

### 5. Widgets that don't behave as their role says

- **Fixed:** container detail's Metrics/Logs/Inspect showed the selected one by a class only; the popover's tablist had no arrow keys or roving tabindex, no `aria-controls`, and its panel wasn't labelled by its tab. Both are tablists now (`tabKeys.ts`).
- **Fixed:** the VM page's OOM table rows were `<tr onclick>` with no keyboard route; the container's name is a button now.
- **Fixed:** scroll boxes without `tabindex` can't be scrolled by keyboard in WebKit: the log, inspect output and Files' viewer are named regions in the Tab order now.
- Minor: single-choice groups use `aria-pressed` (radio would fit); SortHead's `aria-pressed` reverses rather than releases; "Show 3 config steps" has no expanded state; searches labelled only by placeholder (**fixed**); no skip link past 12 masthead stops; sticky heads cover a focused row on Shift+Tab (16 of 86 on Containers at 600 px); Escape doesn't close a container's detail; VM `<article>`s unnamed.
- `svelte-ignore a11y_no_noninteractive_element_interactions` in the popover (7×) hides exactly this issue's problem; the rest are justified.

### 6. Non-text contrast (WCAG 1.4.11, 3:1), where nothing else carries it

| Mark | Light | Dark |
| --- | --- | --- |
| Sketch ground (the range's peak) vs page | 1.12 | 1.17 |
| Bar track (the scale) vs page; notches on empty track | 1.24 | 1.39 |
| Bar `.behind` (peak) and `.quiet` fill vs track | 1.65 | 2.25 |
| Bar hot `.others` vs hot `.inside` | 2.65 | 2.89 |
| MemoryShare VM area vs page; hot container vs VM area | 2.04; 2.96 | 3.13 ✓; 2.81 |
| Capacity block vs track/gaps; stopped VM's fill vs block | 1.34; 1.24 | 1.63; 1.39 |
| Popover: adjacent VM shades; wired vs everything else; last VM vs hatch | 1.2–1.8; 1.14; 1.16 | 1.3–1.7; 1.19; 1.15 |
| Popover legend swatches (pale shades, free) vs page: the only key from row to band (also 1.4.1) | 1.2–2.0 | 1.4–2.0 |
| uPlot min–max band vs page (min/max shown nowhere else) | 1.3 | 1.4 |
| uPlot series told apart by hue alone (VM page) | 1.1–1.3 | 1.1 |

Passing: every line, fill and dashed full-scale line against its ground; text throughout.

## Proposed order of work

1. **Small, independent fixes** (**done**, but for the focus cases still open under 2): the `aria-description` bug; focus kept or returned (disabled-while-working → `aria-disabled` or keep focus; close → back to the opener; Files steps); detail tabs' selected state; popover tabs' arrow keys; OOM rows reachable; scroll boxes focusable; searches labelled; action buttons name their target.
2. **Rows as disclosures:** the line's opener a real button, actions outside it. Unblocks the chart decision below.
3. **Tooltips on `:focus-visible`,** anchored to the element, Escape to dismiss; disabled reasons said where a keyboard reaches them.
4. **Charts:** summaries in the label on lines and headings; the keyboard convention (focusable, arrows between columns, Home/End, card shown and read through a polite live region) where the full chart is: the VM page and a container's detail (uPlot), and Sketch/MemoryShare wherever they have no detail behind them (project heading).
5. **Hover-linked highlights:** capacity blocks and popover rows ↔ bands get a focus equivalent.
6. **Contrast:** the failing marks above, light and dark.
7. **Keyboard browser tests** with each step, beside the pointer ones in `e2e-ui/ui.test.mjs`.

## VoiceOver checklist (on the Mac, in the app itself)

First turn on System Settings → Keyboard → Keyboard navigation: in WKWebView, Tab skips buttons and links without it. Try each with it off too, and note what Tab still reaches.

1. **Containers:** VO+Right through a line. Is it one long button? Can you reach Stop/Restart as buttons on their own? What does it say for the memory bar (is the card read)?
2. Open a line with VO+Space. Is "expanded" announced? Close it with ✕: where does VoiceOver land?
3. **Overview:** a VM's Memory chart. Is the label read? Anything about the columns? The capacity bar: is every VM read?
4. Hover-only text: on the Pressure line and a status dot, does VoiceOver read the `aria-description` (WebKit's support for it is the question)? Then hover the log search with the mouse and ask again: is its help gone?
5. Press Stop on a VM: is "Stopping…" announced, and where's the VO cursor after?
6. **VM page:** the uPlot charts. Is the legend read as a table? Is there anything for the chart itself?
7. **Images:** a disabled Remove. Is the reason ("In use…") read?
8. **Popover** (from the menu bar): tabs announced as tabs, "1 of 3"? Are the rows read with their figures? The chart?
9. **Settings:** toggle a checkbox. Does focus stay?
10. **Log view:** Full window, then Escape. Where are you?
