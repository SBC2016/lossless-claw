---
"@martian-engineering/lossless-claw": patch
---

assemble() keeps the full history while it fits the host budget when the host delivers the current turn separately, instead of stepping the stable budget down and evicting history that the next yield-to-host request restores. Avoids a second full prompt re-read after each host compaction.
