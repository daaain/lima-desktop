---
section: Security
bump: patch
---

- **The app's window runs under a strict Content Security Policy.** It had none, so script that ever found its way into the page could have called every command the app has, and sent what it read to any server. Now only the app's own scripts run, nothing is fetched from anywhere but the app itself, and no inline or evaluated code runs.
- **A crafted file or container name can no longer break a page.** Two files whose names aren't valid UTF-8 could read alike, and the Files view stopped drawing; a guest listing the same container, image or volume twice did the same to its page. Every one is now listed. Should a VM's report still fail to draw, only its own part of the page says so, and the rest carries on.
- **A container's log shows only text.** Escape sequences other than colours (window titles, hyperlinks, clipboard writes) and other control characters are taken out; a carriage return within a line shows as a space, so nothing written before it is hidden.
- **Names from inside a VM can't pass for others.** Characters that draw nothing or turn text round, such as a right-to-left override or a zero-width space, are spelt out where container, image, volume, project, process and file names are shown, as `⟨U+202E⟩`, and a name can't reorder the text beside it.
