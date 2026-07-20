---
name: prep-mini
description: Full workflow to take a problematic 3D mesh (STL/OBJ/blend) and make it resin-printable in Blender via the Blender MCP - inspect, orient, union shells, repair geometry, scale to tabletop size, error-bounded decimate, and export STL. Use this whenever the user wants to "prep", "fix", "clean up", or "make printable" a mini/model, mentions non-manifold errors, slicer problems, wrong orientation/scale, multi-shell kitbashes, or asks to get a mesh ready for Chitubox/Lychee - even if they only mention one symptom, the full sweep catches the rest.
---

# Prep a Mini for Resin Printing

Take a mesh with issues and walk it through repair -> staging -> density
reduction -> export. Requires a running Blender with the Blender MCP addon
connected (interactive mode; the decimation phase can also run headless).

**Read `references/repair-playbook.md` before phases 2-4** (orientation,
shells, sweep decision rules and hard-won warnings live there).
Sizing conventions for phase 5 are in `references/sizing.md`.
Shared scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/`.

## Ask the user up front

1. **Printer + resolution**: XY pixel pitch and layer height. (Saturn 4
   Ultra 16K = 14x19 um pixels; if unknown, look up the printer model.)
   The decimation error budget = half the coarser pixel.
2. **Target size**: game-size class (see `references/sizing.md`) or explicit
   height/footprint in mm.
3. **Output destination** for the final STL.

## Core principles

- **Inspect first, never cut/scale blind.** Object list, dims, world
  bounds, shell count, defect counts before touching anything.
- **Backup before surgery**: `bak = me.copy(); bak.use_fake_user = True`.
- **Verify visually.** Dims alone cannot tell you a model is on its back.
  Screenshot after orientation changes.
- **Fix geometry at LARGE scale, decimate at PRINT scale.** Defect
  thresholds are absolute (meaningful at import scale); the error budget
  is in printed mm (meaningful only after scaling). If a model arrives
  tiny: scale up -> clean -> scale down.
- **When a repair makes things worse twice in a row, STOP and restore the
  snapshot.** Whack-a-mole spirals do not converge.

## The pipeline

### 1. Inspect
Objects, dimensions, world bounds, shells (connected components),
non-manifold/boundary edge counts, zero-face/edge counts, volume sign.
Independent counts via bmesh - toolbox panel numbers are stale until
Check All is re-run.

### 2. Orient (if needed)
Axis fixes are ROTATIONS, never raw axis swaps (swaps mirror the mesh).
Y-up import fix: rotate +90 about X. **Screenshot to verify** - see the
myconid incident in the playbook.

### 3. Union shells (only if multi-shell causes problems)
Shells: 1 is the goal. Hollowed = 2 (outer + cavity) is fine. Overlapping
kitbash solids trigger Chitubox's even-odd carve bug -> union needed.
**Voxel remesh, never exact boolean** - full rules and voxel-size math in
the playbook. Re-check shells after: remesh seals air pockets as tiny
internal bubble shells; delete all but the largest component.

### 4. Geometry sweep (converging repair loop)
`exec(open("${CLAUDE_PLUGIN_ROOT}/scripts/geometry_sweep.py").read())`
then `sweep("ObjectName")` until all counts are 0 (2-5 passes typical;
transient count bumps are normal). Collapse-based - NEVER dissolve-based
cleanup or the Toolbox "Make Manifold" button on dense meshes (they create
defects; verified repeatedly). Details and stubborn-case fixes (micro-fans)
in the playbook.

### 5. Scale + center (baked)
`scale_center_bake(name, s)` from the same script: world-space transform,
scale to target mm, XY bbox centered on origin, base resting at z=0,
`matrix_world = Identity`. Real mm baked into vertices - slicers read STL
units as mm.

### 6. Error-bounded decimation
Now that units = printed mm, run the decimation pipeline
(`${CLAUDE_PLUGIN_ROOT}/scripts/decimate_pipeline.py`). This replaces any
"remove tiny faces" cleanup: it removes ALL detail below printer
resolution (not just degenerate slivers) while measuring and protecting
real thin features. See the sibling skill `decimate-for-print` for
operation details, batch mode, and timeout handling.

### 7. Export + final verify
Per-object STL export (`bpy.ops.wm.stl_export`, selected objects only).
The pipeline verifies before export (error percentiles vs budget,
watertightness no worse than input). Render or screenshot a before/after
of the riskiest regions when the user cares about specific detail.

## Failure modes to expect

| Symptom | Likely cause | Response |
|---|---|---|
| "500k zero faces" on a small model | scale-relative threshold noise | not defects; scale up or ignore |
| paper-thin wall readings (um) | back-to-back overlapping surfaces | union/repair, not thickening |
| exact boolean implodes mesh | self-intersecting operands | voxel remesh instead |
| decimation destroys tendrils/spikes | QEM sacrifices thin features | pipeline's protection handles it |
| protected decimation turns to mush | protection starved the budget | cap protected fraction (pipeline does) |
| model "invisible" after import | parked far off-origin | center it; it is off-camera not invisible |
