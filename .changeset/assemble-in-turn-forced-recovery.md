---
"@martian-engineering/lossless-claw": patch
---

When foreground pressure relief cannot bring a long single turn under the host budget, assemble() now runs the authoritative forced-recovery path once per pressure episode before degrading. Completed tool groups of the current turn are summarized and the prompt is reassembled, instead of falling back to a shrinking raw live clamp. Disable with LCM_ASSEMBLE_FORCED_RECOVERY=false.
