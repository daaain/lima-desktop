---
section: Added
bump: minor
---

- **Containers are grouped by compose project**, on the Containers page and on each VM's page. Containers in no project come first; each project then gets a heading with its name, how many of its containers are running and exited, and what its running containers use between them now. Sorting orders the projects by their totals, and the containers within each.
- **A compose project has a history of its own**: its containers' use added up moment by moment, including containers removed and recreated in the range, so its peak is the most they used at once rather than the sum of each one's peak. Up to 6 hours this is exact; over longer ranges it's built from per-minute figures, so only peaks within the same minute add up.
