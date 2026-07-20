---
name: decimate-for-print
description: Reduce a dense mesh (or a whole folder of STLs) to exactly the detail a resin printer can express, using error-bounded selective decimation in Blender via the Blender MCP - protects thin features, verifies against the original surface, then exports. Use whenever a slicer (Chitubox/Lychee) is slow or choking on a huge STL, a mesh has "too many polygons/faces", files are tens of MB, or the user wants meshes "reduced", "simplified", "optimized", or "decimated" for printing - and for batch-processing minis folders. Assumes mesh is otherwise sound; for broken meshes run prep-mini first.
---

# Error-Bounded Decimation for Resin Printing

Guessed decimate ratios either waste faces or destroy detail. This skill
derives an error budget from printer physics and finds the deepest
reduction that stays inside it, with measurement - not hope - as the gate.

Script: `${CLAUDE_PLUGIN_ROOT}/scripts/decimate_pipeline.py` (read its
docstring; it documents usage modes). Requires Blender with the Blender
MCP (interactive `execute_blender_code` or headless
`execute_blender_code_for_cli` with any small host .blend).

## The physics

- LCD pixel pitch caps XY expressible detail; its own quantization error
  is +/- half a pixel. Budget: **max surface deviation = half the coarser
  pixel** (e.g. 19um pixel -> 9.5um). Pass criterion: p99 <= half pixel,
  p99.9 <= one pixel, evaluated over BOTH directions (drift of new surface
  AND detail lost from old surface).
- Z layers (25-50um) are coarser but slanted surfaces get their error
  mostly from XY placement - pixel pitch binds.
- **Everything is in printed mm.** Confirm 1 mesh unit = 1mm at final
  print size first; if the user rescales in the slicer, the budget scales
  with it. The script refuses models outside 10-300mm as scale-suspicious.

## What the script does (so you can supervise it)

1. Probes a hard decimate (ratio 0.2), builds a per-vertex error map, and
   finds "real features": verts losing >50um. QEM collapse is already
   curvature-adaptive - the only things it loses early are thin
   protrusions (tendrils, whiskers, spikes). Most small minis have none.
2. Protects features via vertex group (weight 0 = protected, 1 = free;
   yes, that direction - verified empirically) with a 0.4mm halo, capped
   at 12% of verts. The cap matters: protected faces never collapse, so
   effective ratio elsewhere = (target-protected)/(total-protected);
   uncapped protection starves the free region into mush.
3. Bisects the ratio for the deepest pass, applies, then re-verifies on
   the FULL population (every original vert + every new face center) and
   requires watertightness no worse than input.
4. Exports only on verified PASS - a written STL certifies its run.

## Operational notes

- **MCP timeouts**: client calls die around 60s; the Blender process
  keeps going. Wrap `run()` so `log` dumps to a sidecar JSON in
  `finally:`, then poll for the file. Never re-launch while a previous
  run may still be writing the same STL.
- **Batch folders**: triage first without loading anything - binary STL
  size = 84 + 50 x triangles, so the header/size gives face counts for
  free. Chitubox pain starts around 500k faces. Process one model per
  headless call.
- Typical results: small minis (13-40mm) are wildly oversampled and
  reduce 10-15x; larger pieces (50-60mm) legitimately keep more (3-7x).
  Reduction below ~40k faces rarely happens - do not force it.
- Report per-model: faces before/after, p99/p99.9/max um, watertight
  status. Flag any model whose max error is many pixels (a single feature
  took a hit - offer a targeted re-run or a visual check) and anything
  SKIPPED as scale-suspicious.
- If the user will re-print at a different size later, keep the original
  mesh somewhere (a .blend or a copy) - decimation is one-way.
