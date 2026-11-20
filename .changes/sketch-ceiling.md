---
section: Changed
bump: minor
---

- **Every chart above a bar reads alike, and says what it shows.** Each now shows a dashed line at its full scale, as a container's memory chart already did, so you can see how close a VM came to its limit at a glance. Pointing at any of them shows a card for the stretch of time under the pointer (a chart's hundred columns each cover a hundredth of the range, 14 minutes over 24 hours): its average and highest in that slice ("Highest in these 14 min"), the peak over the whole range ("Peak in the last 24 h": the grey behind the columns, or for a container its bar's tick), and what the dashed line is. The VM and CPU charts used to switch to how long was spent at each level instead. A compose project's charts are now as tall as its containers'.
