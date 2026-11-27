---
section: Added
bump: minor
---

- **A container's log can be paged back with Fetch earlier, so search and the filters reach older lines.** Each click fetches as many lines again from before the oldest one shown, and puts them in front without repeating any, even lines that share a timestamp and read alike. The note says how far back the log now reaches ("The newest 1,496 lines, from 14:05 to now; there may be more."). The view keeps at most 100,000 lines, or 32 MiB of text, and says when it's full.
- **The log's note no longer says "All" when older lines were left out.** A fetch over 8 MiB keeps only its newest lines, and the note now says so ("The newest 3,410 lines; earlier ones were too much to fetch at once."). A line longer than 16 KiB, which is cut, is marked "cut at 16 KiB", so its closing "…" isn't taken for the container's own text.
