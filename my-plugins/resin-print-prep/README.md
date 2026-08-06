# resin-print-prep

Two skills for making 3D meshes resin-printable in Blender, driven through
the [Blender MCP](https://extensions.blender.org/add-ons/mcp/):

- **prep-mini** — the full fix-anything workflow: inspect → orient → union
  shells (voxel remesh, never exact boolean) → converging geometry-repair
  sweep → scale/center baked to tabletop mm → error-bounded decimation →
  verified STL export.
- **decimate-for-print** — standalone density reduction: derives an error
  budget from your printer's pixel pitch (deviation ≤ half a pixel),
  protects thin features that quadric collapse would destroy, bisects for
  the deepest passing reduction, and verifies against the full original
  surface before exporting. Batch-friendly (headless Blender per model).

New in 1.1: `scripts/hollow_drill.py` — supervised hollowing (EDT-based
hollow/solid decision, main-cavity-only, per-lobe drains, pooling audit,
vent, verified export) plus print-orientation search. Pure Python
(trimesh/scipy/scikit-image/manifold3d), no Blender required.

New in 1.3: `chitubox-support-injection` skill — write native, editable
supports (and raft bridges) directly into CHITUBOX project files via a
reverse-engineered, injection-validated format map (`chitubox_inject.py`
+ full format reference). A placement ("magic support") companion skill
is planned.

Shared machinery in `scripts/`: `decimate_pipeline.py` (also runs from the
CLI: `blender --background host.blend --python decimate_pipeline.py -- --stl model.stl`)
and `geometry_sweep.py` (repair loop + scale/center bake).

Real-world result: a 13-model minis folder went 13.3M → 1.37M triangles
(9.7×), every model verified watertight with p99 surface deviation under
half a printer pixel (9.5 µm on a Saturn 4 Ultra 16K).

Requires Blender 4.2+ with the Blender MCP add-on; numpy (bundled with
Blender). Printer defaults assume Elegoo Saturn 4 Ultra 16K (14×19 µm) —
pass your own pixel pitch.
