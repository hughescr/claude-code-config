"""Error-bounded selective decimation for resin 3D printing.

Reduces mesh density to what the printer can physically express, protecting
thin features (tendrils, spikes) that quadric-collapse sacrifices early.

The error budget is derived from printer physics: geometry may deviate from
the original surface by at most half the coarser XY pixel (the LCD's own
quantization error is +/- half a pixel, so finer deviation is invisible).
Criterion: p99 of two-sided deviation <= half pixel, p99.9 <= one pixel.

IMPORTANT: mesh units must equal printed mm (final print scale). The budget
is meaningless if the model gets rescaled in the slicer afterward.

Use from Blender MCP (interactive or execute_blender_code_for_cli):
    exec(open(".../decimate_pipeline.py").read())
    log = {}
    run("/path/model.stl", log, pixel_um=19.0)      # overwrite in place
    run("/path/model.stl", log, out_path="/path/out.stl")  # write elsewhere

Or headless CLI:
    blender --background host.blend --python decimate_pipeline.py -- \
        --stl "/path/model.stl" [--pixel-um 19] [--out "/path/out.stl"]

MCP timeout note: client calls may time out around 60s but the Blender
process keeps running. Have the caller write `log` to a sidecar JSON in a
`finally:` block and poll for it. Export only happens after verification
passes, so a written STL certifies a passed run.
"""
import bpy, bmesh, numpy as np, time, os
from mathutils.bvhtree import BVHTree
from mathutils import Vector, kdtree

DEFAULT_PIXEL_UM = 19.0   # coarser XY pixel axis, microns (Saturn 4 Ultra 16K: 14x19)
SEED_ERR = 0.050          # mm; verts losing more than this at probe ratio are "real features"
HALO = 0.4                # mm; protection radius around feature seeds
PROT_CAP = 0.12           # max protected fraction of verts (starvation guard, see below)
RATIO_LO, RATIO_HI = 0.05, 0.50


def _bvh_and_stats(me):
    bm = bmesh.new(); bm.from_mesh(me)
    nonman = sum(1 for e in bm.edges if not e.is_manifold)
    bound = sum(1 for e in bm.edges if e.is_boundary)
    bvh = BVHTree.FromBMesh(bm); bm.free()
    return bvh, nonman, bound


def run(stl_path, log, pixel_um=DEFAULT_PIXEL_UM, out_path=None,
        min_dim_mm=10, max_dim_mm=300, obj=None):
    """Decimate one STL (or an already-loaded object) with full verification.

    Results accumulate in `log` (dict) as the run progresses, so a caller
    that dumps `log` in a finally: block preserves partial state on timeout.
    """
    tol = pixel_um / 2000.0      # half pixel, mm
    tol999 = pixel_um / 1000.0   # one pixel, mm
    t0 = time.time()

    if obj is None:
        bpy.ops.wm.read_homefile(use_empty=True)
        bpy.ops.wm.stl_import(filepath=stl_path)
        obj = bpy.context.selected_objects[0]
    me = obj.data
    nf0, nv0 = len(me.polygons), len(me.vertices)
    dims = list(obj.dimensions)
    log.update(faces_before=nf0, verts=nv0, dims_mm=[round(x, 1) for x in dims],
               tol_um=round(tol * 1000, 1))
    # Scale sanity: a "13mm" model that reads 500 units is probably not at
    # print scale -- refuse to guess rather than silently ruin it.
    if max(dims) > max_dim_mm or max(dims) < min_dim_mm:
        log.update(status="SKIPPED_scale_suspicious"); return

    obvh, nonman0, bound0 = _bvh_and_stats(me)
    log.update(nonmanifold_before=nonman0, boundary_before=bound0)

    co = np.empty(nv0 * 3); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    rng = np.random.default_rng(42)
    samp = co[rng.choice(nv0, size=min(120000, nv0), replace=False)]

    mod = obj.modifiers.new("dec", 'DECIMATE'); mod.decimate_type = 'COLLAPSE'

    def eval_obj():
        dg = bpy.context.evaluated_depsgraph_get(); dg.update()
        return obj.evaluated_get(dg)

    def probe(ratio, max_fwd=150000):
        """Two-sided sampled error at a candidate ratio.
        Forward (decimated face centers -> original surface) catches drift;
        backward (original verts -> decimated surface) catches LOST detail.
        One-sided measurement misses flattened bumps entirely."""
        mod.ratio = ratio
        ev = eval_obj(); me_ev = ev.to_mesh()
        nf = len(me_ev.polygons)
        centers = np.empty(nf * 3); me_ev.polygons.foreach_get("center", centers)
        centers = centers.reshape(-1, 3)
        if nf > max_fwd:
            centers = centers[np.random.default_rng(1).choice(nf, size=max_fwd, replace=False)]
        fwd = np.empty(len(centers)); fn = obvh.find_nearest
        for i, c in enumerate(centers): fwd[i] = fn(Vector(c))[3]
        bm2 = bmesh.new(); bm2.from_mesh(me_ev)
        dbvh = BVHTree.FromBMesh(bm2); bm2.free()
        bwd = np.empty(len(samp)); fn2 = dbvh.find_nearest
        for i, c in enumerate(samp): bwd[i] = fn2(Vector(c))[3]
        ev.to_mesh_clear()
        a = np.concatenate([fwd, bwd])
        return nf, float(np.percentile(a, 99)), float(np.percentile(a, 99.9)), dbvh

    # --- error map at an aggressive ratio -> find real features to protect ---
    # QEM collapse is already curvature-adaptive; the only geometry it loses
    # early is thin protrusions (tendrils, spikes, whiskers). Find them by
    # measuring what a hard decimate destroys.
    mod.ratio = 0.2
    ev = eval_obj(); me_ev = ev.to_mesh()
    bm2 = bmesh.new(); bm2.from_mesh(me_ev)
    dbvh = BVHTree.FromBMesh(bm2); bm2.free(); ev.to_mesh_clear()
    errmap = np.empty(nv0); fn2 = dbvh.find_nearest
    for i in range(nv0): errmap[i] = fn2(Vector(co[i]))[3]

    # Protection budget arithmetic (the classic failure mode): protected faces
    # never collapse, so effective ratio on the rest is
    # (target - protected)/(total - protected). If protection swallows too
    # much of the mesh, the free region gets starved into mush. Cap the
    # protected fraction; shrink halo / raise seed bar until it fits.
    seed_thr, halo = SEED_ERR, HALO
    kd = kdtree.KDTree(nv0)
    for i in range(nv0): kd.insert(Vector(co[i]), i)
    kd.balance()
    for _ in range(3):
        seeds = np.nonzero(errmap > seed_thr)[0]
        w = np.ones(nv0)
        for i in seeds:
            for (_, j, _) in kd.find_range(Vector(co[i]), halo):
                w[j] = 0.0
        frac = (w == 0).sum() / nv0
        if frac <= PROT_CAP: break
        seed_thr *= 2; halo *= 0.6
    log.update(n_seeds=int(len(seeds)), protected_frac=round(float(frac), 3))

    # Decimate vertex-group semantics (verified empirically): weight 1 =
    # decimated MORE, weight 0 = protected.
    obj.vertex_groups.new(name="decimate_freedom")
    bm = bmesh.new(); bm.from_mesh(me)
    dl = bm.verts.layers.deform.new(); bm.verts.ensure_lookup_table()
    for i, v in enumerate(bm.verts): v[dl][0] = float(w[i])
    bm.to_mesh(me); bm.free()
    mod.vertex_group = "decimate_freedom"; mod.vertex_group_factor = 10.0

    # --- bisect for the lowest ratio that stays inside the error budget ---
    lo, hi = RATIO_LO, RATIO_HI
    best = None
    nf, p99, p999, _ = probe(hi)
    if p99 <= tol and p999 <= tol999:
        best = (hi, nf, p99, p999)
    else:
        log.update(status="FAIL_even_at_%.2f" % hi, p99_um=round(p99 * 1000, 1)); return
    for _ in range(5):
        mid = (lo + hi) / 2
        nf, p99, p999, _ = probe(mid)
        if p99 <= tol and p999 <= tol999: hi = mid; best = (mid, nf, p99, p999)
        else: lo = mid
    ratio, nf, p99, p999 = best
    mod.ratio = ratio
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier="dec")

    # --- full-population verification (every original vert, every new face) ---
    me = obj.data
    nf1 = len(me.polygons)
    dbvh, nonman1, bound1 = _bvh_and_stats(me)
    d = np.empty(nv0); fn2 = dbvh.find_nearest
    for i in range(nv0): d[i] = fn2(Vector(co[i]))[3]
    centers = np.empty(nf1 * 3); me.polygons.foreach_get("center", centers)
    centers = centers.reshape(-1, 3)
    f = np.empty(nf1); fno = obvh.find_nearest
    for i in range(nf1): f[i] = fno(Vector(centers[i]))[3]
    a = np.concatenate([d, f])
    v99, v999, vmax = (float(np.percentile(a, 99)), float(np.percentile(a, 99.9)),
                       float(a.max()))
    ok = (v99 <= tol * 1.1 and v999 <= tol999 * 1.1
          and nonman1 <= nonman0 and bound1 <= bound0)
    log.update(ratio=round(ratio, 3), faces_after=nf1,
               p99_um=round(v99 * 1000, 2), p999_um=round(v999 * 1000, 2),
               max_um=round(vmax * 1000, 1),
               nonmanifold_after=nonman1, boundary_after=bound1,
               verify="PASS" if ok else "FAIL")
    if not ok:
        log.update(status="NOT_EXPORTED_verify_failed"); return
    dest = out_path or stl_path
    for o in bpy.context.view_layer.objects: o.select_set(o is obj)
    bpy.ops.wm.stl_export(filepath=dest, export_selected_objects=True)
    log.update(status="OK", exported=dest, elapsed_s=round(time.time() - t0, 1))


if __name__ == "__main__":
    import sys, json, argparse
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--stl", required=True)
    ap.add_argument("--pixel-um", type=float, default=DEFAULT_PIXEL_UM)
    ap.add_argument("--out", default=None)
    ap.add_argument("--log-json", default=None)
    args = ap.parse_args(argv)
    log = {}
    try:
        run(args.stl, log, pixel_um=args.pixel_um, out_path=args.out)
    finally:
        print(json.dumps(log, indent=2))
        if args.log_json:
            with open(args.log_json, "w") as fh:
                json.dump(log, fh)
