---
"@martian-engineering/lossless-claw": patch
---

Keep the assembled prompt prefix stable while the host token budget shrinks inside one long turn. assemble() now holds the effective budget steady while the host budget only drifts down and steps down once with headroom when it no longer fits, so the live-clamp / eviction boundary stops moving on every request and prefix-caching providers stop re-reading the whole prompt. Compaction pressure still uses the real host budget.
