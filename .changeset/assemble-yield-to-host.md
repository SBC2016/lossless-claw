---
"@martian-engineering/lossless-claw": patch
---

assemble() yields to host compaction when the host delivers the current turn separately and its history budget shrinks inside one turn: the assembled history keeps a stable size, so the prompt prefix stays unchanged and the host's overflow precheck compacts the turn promptly. Disable with LCM_ASSEMBLE_YIELD_TO_HOST=false.
