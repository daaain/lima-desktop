---
section: Fixed
bump: patch
---

- **On the popover's disk chart, a deleted VM's band ends when it was deleted, and a new VM's
  begins when it was made.** Both used to run to the edges of the range, drawing everything else
  that much too small or too large. (A VM deleted and made again under the same name, as `default`
  often is, still counts as one VM throughout.)
