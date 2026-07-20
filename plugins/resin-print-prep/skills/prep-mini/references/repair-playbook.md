# Repair Playbook - decision rules and hard-won lessons

Battle-tested on a real minis project (July 2026, Blender 5.2, Saturn 4
Ultra 16K). These rules exist because the obvious approach failed.

## Orientation

Axis fixes are ROTATIONS, never raw axis swaps - swaps mirror the mesh.
Y-up import fix: rotate +90 about X: `(x,y,z) -> (x,-z,y)`.
**Always verify with a viewport screenshot after.** Models end up on their
back or upside-down and dims alone cannot tell you (the myconid incident:
it was upright all along; a "fix" would have broken it).

## Zero-faces are scale-relative - don't chase phantoms

The 3D-Print Toolbox flags faces < 1e-4 (absolute, mesh units). At mini
scale (13-30mm) a huge fraction of *healthy* faces sit under that - a
13mm model showed "500k zero faces" that were nothing. True degenerates
are area < 1e-8. Clean at full/original scale where the threshold means
something. Sub-printable-but-healthy density is the decimation pipeline's
job, not the sweep's.

## NEVER dissolve-based cleanup on dense meshes

`dissolve_degenerate` and the Toolbox **"Make Manifold" button CREATE
defects** on dense sculpts - they chew micro-triangles and punch holes
(verified repeatedly: turned a 0-defect mesh into 45+, once deleted an
entire collar). **Edge-collapse instead** - collapse can never create a
border. If checks read 0 there is nothing for Make Manifold to do; warn
the user off the button.

## Shells

"Shells: N" = connected closed surfaces. 1 = watertight solid (ideal).
Hollowed model = 2 (outer + cavity), fine. Overlapping-solid kitbashes
read N and Chitubox's even-odd fill rule can carve voids where shells
overlap (the "hollow bow" bug) -> union needed.

### Union: voxel remesh, NOT exact boolean

Exact boolean on self-intersecting sculpt operands can catastrophically
implode (observed: 1.4M verts -> 2,871). Use `object.voxel_remesh`
(OpenVDB flood-fill union - robust, always manifold):

- Voxel size math: output tris ~= 2 x surface_mm^2 / voxel^2. Pick voxel
  ~= printer pixel *at final print scale* (e.g. 0.15mm at 156mm working
  size = 12.5um after shrink to 13mm -> zero printed loss). 0.05mm is
  never needed; it just 18x's the file.
- `use_remesh_preserve_volume=True`, adaptivity 0.
- Afterward: **check shells again** - remesh seals trapped air pockets as
  tiny internal cavity shells (8-vert bubbles). Delete all but the largest
  component. Density cleanup comes later from the decimation phase.

## Thin faces / sharp edges / overhangs = slicer concerns

Thin-face counts at threshold 0.001 are noise; set the threshold to the
real minimum feature (0.3-0.6mm for resin). Paper-thin readings (um)
usually mean overlapping back-to-back surfaces, not real walls. Overhangs
-> supports/orientation in the slicer. Don't "fix" these in the mesh.

## Hollowness check

Ray-parity through the body via BVHTree: 2 crossings = solid single skin,
4 = hollow. Positive `bm.calc_volume(signed=True)` confirms consistent
outward normals.

## The sweep loop (see scripts/geometry_sweep.py)

Passes until zero-faces / zero-edges / bad-edges all read 0 (2-5 passes).
Counts bump transiently mid-loop (bowties: 106->49->23->30->7->0) - normal,
it converges. Stubborn micro-fans (4 sliver triangles sharing one edge):
delete the fan's central VERTS and fan-fill the small hole - face-level
whack-a-mole recreates them.

## Blender MCP operational quirks

- Long ops (voxel remesh, big merges) outlive the MCP timeout but keep
  running in Blender - poll with a tiny script after sleeping. Prefer
  C-speed batch ops (`bmesh.ops.collapse` on thousands of edges at once)
  over per-element Python loops.
- Screenshot tool intermittently truncates ("Unterminated string") - retry
  with `size_limit_in_bytes` 200-250KB.
- `ob.dimensions` reads stale after direct vertex writes - recompute from
  vertex data or `view_layer.update()` first.
- Toolbox panel results are STALE until Check All re-runs
  (`bpy.ops.mesh.print3d_check_all()` with a context override).
- Verify claims with independent counts (bmesh link_faces; union-find
  shells via numpy on edge arrays - Python BFS is too slow above ~500k
  verts).
- Batch intake: import many STLs, process all scene objects, space along X
  with object.location (display only), screenshot the whole lineup once to
  verify orientation, zero each location at export.

## Surgery lessons (contributing factors, not root causes)

- Open welded strips are non-manifold by construction. Winning pattern for
  attaching parts (the collar): delete the internal cut-cap, weld a skirt
  to every rim vertex (2 faces per rim edge), cap the hem inside the body -
  identical look, fully watertight, one continuous shell.
- Cutting parts (heads): bisect the *connected component* only (union-find
  above the plane) so wings/accessories crossing the plane are untouched;
  tilted planes follow chins better than flat ones; fill caps with
  `holes_fill`; check for tiny disconnected fragments (whiskers/teeth).
- Two failed repair attempts in a row = restore the snapshot. The
  843-defect cap-deletion spiral only ended by reverting.
