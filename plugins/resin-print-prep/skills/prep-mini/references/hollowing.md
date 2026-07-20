# Hollowing, orientation, and drain drilling

Run by `scripts/hollow_drill.py` (STL in, STL out; pure Python, no
Blender: `pip install trimesh scipy scikit-image manifold3d
fast-simplification`). Read its docstring for the pipeline. This file
holds the reasoning and the slicer-facing lessons.

## Why supervise this instead of using the slicer

Slicer hollowing erodes blindly: where thickness varies it creates
sealed micro-pockets (resin traps), and hole placement is manual
guesswork. The voxel EDT field gives exact answers: which cavity
components are worth having, where resin pools, where the thinnest
low-detail wall is for each hole. A real treant model: 1 true cavity
(20.6ml) + 21-23 junk pockets correctly left solid; one drain would
have trapped 14ml, per-lobe drains cut it to 0.27ml.

## Decision thresholds (encoded in the script)

- Hollow only if max bulk thickness > 10mm (largest inscribed sphere,
  via 0.5mm voxel EDT) AND a 2.5mm-wall cavity saves >15ml or >25% of
  volume. Below that, print solid: drain holes cost surface and risk
  for negligible resin.
- Wall 2.5mm default (3mm for handling-heavy pieces).
- Drains 3mm dia, one per low lobe; vent 2.5mm near cavity top.
  The vent is not optional -- a sealed cavity alternates suction and
  pressure every layer and can blow out or crack.
- Orientation is decided BEFORE drilling (holes are gravity-relative).
  In the slicer, the model must then NOT be auto-rotated.

## Operational notes

- Run hollow_drill.py foreground in one shell call (~20s typical); in
  sandboxed VMs background processes are reaped between calls.
- The orientation search changes bounding dims versus the sized input
  (a 119mm-tall upright model may report 113mm tall x 107mm deep after
  a lean). Footprint scaling is unaffected -- not a sizing error.
- The pooling audit auto-adds drains (up to 3) when >0.5ml is trapped;
  the report lists them with "added_by_audit": true.

## Slicer error-detection decode (CHITUBOX "Detect Errors")

On a correctly hollowed+drilled mesh expect false positives:
- "Excess shell: 1" = the cavity's inner surface (connected through the
  drill tunnels; verify independently: 1 body).
- "Hole: 2x(number of drilled holes)" = each tunnel's two apertures.
- "Bad side: small n" = normal-estimation jitter on tiny valid seam
  triangles (verify winding consistency independently).

**Never click the slicer's auto-repair on a hollowed model** -- it may
delete the "excess shell" (the cavity: model silently becomes solid) or
patch the "holes" (seals the drains). Validate with the slice preview:
two contours in hollow regions, open drains where tunnels pierce.

## Do not "clean up" detector noise

Verified the hard way, twice: sub-pixel seam/interior slivers are
intrinsic (marching-cubes mosaic + legitimate fine detail; true
degenerates = zero) and identical whether holes are drilled by mesh
boolean or carved in voxel space. Collapse-sweeping them fragmented a
watertight 1-body mesh into 41 non-watertight pieces. Acceptance is the
verification triad -- 1 body, watertight, winding-consistent -- plus
volume match and a flood-fill proving the cavity breathes. When those
pass, detector warnings get explained, not repaired. Any future cleanup
attempt: snapshot -> gentle collapse -> re-verify -> auto-revert.

## Slice-time expectations (set them for the user)

Decimation fixes mesh HANDLING (load, repair checks, support editing).
Slice time is layers x LCD resolution x anti-aliasing, nearly
independent of triangle count: a 120mm-tall model at 50um is ~2400
16K-rasterized layers and will be slow regardless. Levers, in order:
anti-aliasing 4x->2x (invisible on organic texture), layer height
(100um on bark-like models; halves print time too), GPU slicing if the
slicer version has it, variable layers via CHITUBOX Pro height ranges.
Known support lift + baked orientation makes height ranges computable:
range boundary = model-space z + lift.
