# The UI: sentences first, every number drawn

**Question:** the app shows a lot of numbers that are all fine most of the time. How should it look
so that the one that isn't fine is the first thing read, and the rest is still there to compare?

**Answer:** each page opens with a sentence that says what matters; each thing on it gets a
sentence of its own; and every number sits next to a small drawing of itself on a stated scale.
One typeface for what is said, one for what is counted, one colour for "look at this".

<img src="https://daaain.github.io/lima-desktop/overview.png" alt="The VM overview" width="720">

The pictures in this guide and the README are drawn from invented data by the UI's browser tests
(`just ui-e2e`) and published by CI
([development.md](../development.md#the-ui-in-a-browser-on-fake-data-just-ui-e2e)).

## Words

- **A page's headline is a sentence with a full stop**, worst news first: "Two VMs are past three
  quarters of their memory or disk.", "harbor needs more CPU.", "17 of 19 containers are running."
  When nothing is wrong it says so ("Every running VM has room to spare."). The sentences live in
  `src/lib/almanac.ts`, each with its tests; a sentence is never assembled in a component.
- **How full something is, is said in quarters**: less than a quarter, more than a quarter, more
  than half, more than three quarters. A sentence can't carry "34 %" honestly a second later; the
  figure beside it can.
- **Past three quarters is the one threshold** (`WARN_PCT`). The sentence, the figure, the bar and
  the history all turn at the same point, so they never disagree. Right-sizing's verdicts
  (`rightsize.ts`) are stricter and separate: they look at a window of history, and say "needs
  more" only on evidence (an OOM kill of the whole VM, stalls, a peak over 90 %).
- **Counts up to twelve are spelled at the start of a sentence** ("Five are running"), digits
  elsewhere. Names are never abbreviated; a long one is cut with an ellipsis and whole in its
  tooltip.
- **No all-caps labels.** A label is either a serif head over a column ("Memory", "CPU") or a small
  grey line under a figure saying what it is ("peak", "cores, 95th percentile").
- Units stay on the figure (`38.9 GiB of 45.8 GiB`), in the binary units the rest of the app uses.

## Type

| role | face | where |
| --- | --- | --- |
| what is said | Newsreader (variable, optical sizes), `--serif` | headlines, VM and container names, verdicts, section heads |
| what is counted | Inter (variable), `--sans`, tabular figures (`.num`) | figures, small labels, buttons, tables |

Both are bundled (`@fontsource-variable/*`): the app makes no network request for them. Sizes step
down by role, not by page: the headline (`h1.headline`, up to 4rem), column and section heads
(`h2.head`, about 2rem), names (1.7rem on the overview, 1.25rem in a list), a figure's number
(1.55–1.75rem, semibold) with its "of …" in grey beside it, labels (0.8rem). In the resize form
the three numbers are the largest thing in the sentence, because they are what is being changed.

## Colour

Tokens are in `src/routes/+layout.svelte`, light and dark (the OS's choice).

| token | for |
| --- | --- |
| `--fg`, `--muted` | text, and the rule a section starts at; secondary text |
| `--warn` | the one "look at this": past three quarters, a verdict of "needs more", an exited container's ring |
| `--alert` | something failed or was killed: errors, OOM badges |
| `--accent` | links, and the first series in a chart |
| `--bar`, `--soft`, `--track` | a bar's fill, the paler stretch behind it (a peak, an allocation), its track |
| `--wash` | the one tinted block on a page: the thing being acted on (resize, a container's detail) |

Nothing is told apart by hue alone: an exited container is a hollow ring, not a different colour
of dot; the paler stretch of a bar is lighter, not another hue. There are no boxes or shadows: a
section starts at a hairline in `--fg`, rows are separated by hairlines in `--border`.

## Drawings

Three, each a component, each with its scale said in words nearby.

- **Bar** (`Bar.svelte`): a share of a scale, notched at quarters so "past the third notch" can be
  read without the number. It can carry a paler bar behind it (a container's peak) and a tick (a
  VM's peak, or the 95th percentile of its CPU). The scale is the thing's own allocation, except
  where a note says otherwise: a container's memory is drawn against the largest container listed
  with it, its CPU against its VM's cores, a stopped VM's memory against the largest stopped VM, an image or volume against the
  largest one listed (never warning: being large isn't past anything).
- **Sketch** (`Sketch.svelte`): the last 24 hours above a bar, as about a hundred hairline columns
  on a ground that rises to the highest value reached, on the bar's scale. Hairlines that stop
  short of the ground show how far below its peak something usually sits. On hover it becomes the
  distribution instead: one hairline per percent of the scale, as tall as the time spent there,
  with a tick at the maximum. The data is the same hundred points either way (`almanac.sketch`),
  fetched per entity and refreshed once a minute (`history.svelte.ts`).
- **Capacity** (`Capacity.svelte`): one bar per resource for the whole computer, a block per VM.
  Full width is what the host has (its cores, RAM, and the filesystem Lima's instances are on,
  from the backend's `host`); a block is as wide as its VM's allocation and solid as far as the VM
  uses it, the ones past three quarters in `--warn`. Disk counts what each image really takes on
  the host, so a VM that isn't running still has a block: only as wide as its image, and quieter.
  Hovering a block names its VM and its numbers in the line above. When VMs are allocated more
  than the host has (CPUs usually are), the allocations are the scale.

The long charts on a VM's page (`Chart.svelte`, uPlot) are the only drawings with axes; each sits
under the sentence, figures and bar it explains, with the allocation as a dashed line.

## Pages

- **VMs**: the headline; the three capacity bars; then running VMs, each a row under the column
  heads Memory, CPU, Disk, Containers (a figure, a sketch, a bar, a note), with one dot per
  container; then the VMs that aren't running, with a bar for the memory each is set to. Both lists
  go by name until a column head is chosen (see **Order**, below); the count head ("Five are
  running") stands for the names, and the stopped VMs follow by what each is set to. Below 980px the
  column heads go and each cell carries its own.
- **Order**: every list under serif column heads (VMs, a VM's containers, Containers, Images,
  Volumes) is ordered by clicking a head (`SortHead.svelte`, `lib/order.ts`). A head orders its
  column the natural way first (names A to Z, amounts most first); chosen again, the other way.
  There are no arrows: the chosen head's stretch of the rule under the heads is drawn 3px (a hover
  raises the same mark in grey), and only a reversed order says which way, in small grey words at
  the column's right end on the head's baseline ("least first", "Z to A"), broken into lines where
  the column is tight (columns are at least wide enough for that). What has no value (not running, not measured) is
  last either way. Where a list is grouped by VM, ordering by name orders the groups too; otherwise
  the groups keep their own order (the most memory first, the fullest disk first). Each list opens
  as it did before it could be ordered — VMs by name, containers by memory, images and volumes with
  the unused first — and keeps the choice for next time. A live order changes as the numbers do, so
  lines glide to their new places (`motion.ts`). Where the heads are hidden on a narrow window, the
  order is chosen in words instead ("Listed by memory in use, most first", `OrderPicker.svelte`).
  The page always shows its scrollbar (disabled when there's nothing to scroll), so going from a
  short page to a long one doesn't shift everything sideways.
- **Settings**: the headline says how often each running VM is measured; the choices (1, 2, 5,
  10 s) and what a slower one costs and saves.
- **A VM**: the headline verdict; four figures (Memory, CPU, Pressure, Disk), each a verdict
  sentence, three numbers, a bar and its chart; the resize sentence; out-of-memory kills when
  there are any; its containers as lines.
- **Containers**: the headline and a dot per container; filters; then the column heads (the
  overview's serif ones, `.column-heads`, as on a VM's page, Images and Volumes) and a group per VM ("atlas runs
  twelve, all in atlas, and one has exited."), each container a line with memory and CPU drawn.
- **Images, Volumes**: the headline counts what no container uses ("Seven of 27 images aren't used
  by any container."), with a dot per image or volume (a hollow ring for unused) and a sentence on
  whose disk is past three quarters, how many unused images are dangling, and what removing the
  unused would free. Then a group per VM, the fullest disk first: its sentence ("quill holds four
  images; two aren't used."), its disk drawn against the three-quarters rule, and its clean-up
  buttons; then each image or volume as a line (`ItemLine.svelte`), the unused first, with its size
  drawn and who uses it. An image's size counts layers it shares with other images, so image sizes
  are never added up: what removing images would free comes only from `system df`, which walks
  every volume, so it runs once per VM as the app first sees it running, then on **Measure again**.
  It gives each image's own share, drawn solid inside its size, and each volume's size and users,
  which until then are a dash. One measurement serves both pages, and a VM's is taken again after
  something is removed from it. Both lists are fetched from the start and kept, so neither page
  opens blank. A line opens a detail under it, as a container's does: an image's layers (the
  config-only steps folded away; a layer opens what it added, what it deletes struck through), or a volume's files, a folder at a time, with the start of a file
  (read-only, over Lima's ssh). Details unfold and fold back, without motion when the system asks
  for less of it.

## Adding to it

A new number needs three things before it goes on a page: the sentence it changes (and a test for
that sentence), the scale it's drawn against, and what "past three quarters" would mean for it.
If the last has no answer, it is a figure with a label, not a bar. A new state worth seeing goes
into the fake fleet (`e2e-ui/fake-backend.js`) so the browser test and the README show it.
