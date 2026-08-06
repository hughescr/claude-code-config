---
name: support-placement
description: "DRAFT (design phase): compute resin-print supports algorithmically - engineered sizing from cured-resin mechanics instead of fixed palettes, scar-cost-aware placement, articulated/braced routing - emitting natively editable Chitubox supports via the chitubox-support-injection skill. Use when generating supports outside a slicer, when designing/iterating this generator, or when reasoning about support mechanics (peel loads, green-state resin, slenderness/bracing)."
---

# Support Placement (design phase)

Prototype: `${CLAUDE_PLUGIN_ROOT}/scripts/support_gen_proto.py` (v0:
islands/density/routing/self-verify; correct but unengineered).
Full design charter and mechanics framework:
`references/design.md`. Emission goes through the sibling skill
`chitubox-support-injection` - never ship supports as bare STL; the
review artifact is a .chitubox the user opens normally.
