---
section: Security
bump: patch
---

- **A container can no longer join one of your compose projects by its image's labels.** Podman copies an image's labels into every container made from it, so an image could name itself part of your `shop` project and add its memory and CPU to the project's totals and history. A container now counts as part of a project only when Docker Compose or podman-compose made it: both put a config hash on each container they create, and the app checks that the hash didn't come from the image. A container run by hand from an image a compose project built, and Docker Compose's lifecycle-hook containers, are now listed on their own rather than in the project.
