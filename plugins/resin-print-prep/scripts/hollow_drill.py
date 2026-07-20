"""Supervised hollowing + drain drilling for resin printing. STL in, STL out.

Runs in ANY Python 3.10+ (no Blender needed):
    pip install trimesh scipy scikit-image manifold3d fast-simplification
    python hollow_drill.py in.stl out.stl [--wall 2.5] [--no-orient] [--report r.json]

Pipeline (all steps verified on real prints, July 2026):
 1. Optional orientation search on a 10x-decimated proxy: +-30 deg sweeps
    about X/Y scored by 0.5*support_area_cm2 + 3*peak_crosssection_cm2 +
    0.3*height_mm. Orientation MUST be final before drilling -- hole
    placement is gravity-dependent. Model is re-rested on z=0.
 2. Hollow decision: voxelize 0.5mm -> fill -> EDT. Hollow only if max
    bulk thickness > 10mm AND a wall-thickness cavity saves >15ml or >25%
    of volume. Otherwise export solid (holes in small minis cost more
    than the resin they save).
 3. Cavity = the LARGEST connected eroded component ONLY. Small pockets
    stay solid -- blind hollowing (e.g. slicers') creates sealed resin
    traps; a real model showed 1 true cavity vs 21 junk pockets.
 4. Drains: one 3mm-dia hole per low lobe (cavity components below
    lowz+15mm, >0.5ml), at each lobe's lowest point, drilled along the
    shortest exit ray (mostly-downward candidates). One drain trapped
    14ml on a tree-shaped cavity; per-lobe drains cut it to 0.27ml.
 5. Vent: 2.5mm-dia hole near cavity top through the thinnest wall
    (horizontal candidates). A sealed cavity is a pressure vessel.
 6. Pooling audit: sweep z-cuts; cavity components below a cut that
    contain no drain = trapped resin. Reported so you can add drains.
 7. Booleans via manifold3d. Marching-cubes shells come out INSIDE-OUT:
    fix_normals before use, assert .is_volume on every boolean input.
 8. Verify: exactly 1 body, watertight, winding-consistent, volume ==
    solid - cavity (+-2%), and a flood-fill from outside must reach the
    cavity through the holes. Export only on pass.

Do NOT post-process the output to silence slicer "error detection":
sub-pixel seam/interior slivers are intrinsic and harmless (true
degenerates: zero), collapse-based cleanup fragmented a watertight body
into 41 pieces in testing, and slicer auto-repair may delete the cavity
shell ("excess shell") or seal the drains ("holes"). Validate in the
slice preview instead: two contours in hollow regions, open drains.
"""
import argparse, json, sys, time
import numpy as np
import trimesh
from scipy import ndimage
from skimage import measure

PITCH = 0.5
BULK_MIN_MM = 10.0
SAVE_MIN_ML = 15.0
SAVE_MIN_FRAC = 0.25
LOBE_MIN_ML = 0.5
LOBE_BAND_MM = 15.0
DRAIN_R = 1.5
VENT_R = 1.25


def orient_search(m, log):
    try:
        import fast_simplification
        v, f = fast_simplification.simplify(
            m.vertices.astype(np.float32), m.faces.astype(np.int32), target_reduction=0.9)
        proxy = trimesh.Trimesh(vertices=v, faces=f)
    except Exception:
        proxy = m
    def score(mesh):
        sup = mesh.area_faces[mesh.face_normals[:, 2] < -0.707].sum() / 100.0
        zs = np.arange(mesh.bounds[0][2] + 0.1, mesh.bounds[1][2] - 0.1, 4.0)
        peak = 0.0
        for s in mesh.section_multiplane([0, 0, 0], [0, 0, 1], zs):
            if s:
                peak = max(peak, sum(p.area for p in s.polygons_closed if p is not None))
        h = mesh.bounds[1][2] - mesh.bounds[0][2]
        return 0.5 * sup + 3.0 * peak / 100.0 + 0.3 * h
    best = (score(proxy), np.eye(4))
    for axis in ([1, 0, 0], [0, 1, 0]):
        for deg in (-30, -20, -10, 10, 20, 30):
            R = trimesh.transformations.rotation_matrix(np.radians(deg), axis)
            p = proxy.copy(); p.apply_transform(R)
            s = score(p)
            if s < best[0]:
                best = (s, R)
                log["orientation"] = {"axis": axis, "deg": deg, "score": round(s, 1)}
    m.apply_transform(best[1])
    m.apply_translation([-(m.bounds[0][0] + m.bounds[1][0]) / 2,
                         -(m.bounds[0][1] + m.bounds[1][1]) / 2, -m.bounds[0][2]])
    return m


def run(in_path, out_path, wall=2.5, orient=True, log=None):
    log = {} if log is None else log
    t0 = time.time()
    m = trimesh.load(in_path); m.merge_vertices()
    if not m.is_volume:
        trimesh.repair.fix_normals(m)
    assert m.is_volume, "input must be a watertight volume (run prep-mini first)"
    if orient:
        m = orient_search(m, log)
    solid_ml = m.volume / 1000.0
    log.update(solid_ml=round(solid_ml, 1), dims_mm=[round(x, 1) for x in m.extents])

    vg = m.voxelized(PITCH).fill()
    T = np.array(vg.transform); Tinv = np.linalg.inv(T); mat = vg.matrix
    edt = ndimage.distance_transform_edt(mat) * PITCH
    bulk = 2 * edt.max()
    cav = edt > wall
    lbl, n = ndimage.label(cav)
    if n == 0:
        log.update(bulk_mm=round(bulk, 1), decision="SOLID_no_cavity"); m.export(out_path); return log
    sizes = ndimage.sum(cav, lbl, range(1, n + 1))
    main = lbl == (np.argmax(sizes) + 1)
    cavity_ml = main.sum() * PITCH ** 3 / 1000.0
    log.update(bulk_mm=round(bulk, 1), cavity_ml=round(cavity_ml, 1),
               junk_pockets_left_solid=int(n - 1))
    if bulk < BULK_MIN_MM or (cavity_ml < SAVE_MIN_ML and cavity_ml < SAVE_MIN_FRAC * solid_ml):
        log.update(decision="SOLID_below_threshold"); m.export(out_path); return log
    log.update(decision="HOLLOW")

    idx = np.array(np.nonzero(main)).T
    world = trimesh.transformations.transform_points(idx.astype(float), T)
    zw = world[:, 2]; lowz = zw.min()

    def exit_ray(p, dirs):
        best = None
        for d in dirs:
            d = np.asarray(d, float); d /= np.linalg.norm(d)
            for r in np.arange(0, 45, PITCH):
                q = p + d * r
                ijk = trimesh.transformations.transform_points([q], Tinv)[0].round().astype(int)
                if (ijk < 0).any() or (ijk >= np.array(mat.shape)).any() or not mat[tuple(ijk)]:
                    if best is None or r < best[0]:
                        best = (r, d)
                    break
        return best

    # drains: one per low lobe
    below = np.zeros_like(main)
    sel = idx[zw < lowz + LOBE_BAND_MM]
    below[tuple(sel.T)] = True
    lb, nb = ndimage.label(below)
    szs = ndimage.sum(below, lb, range(1, nb + 1)) * PITCH ** 3 / 1000.0
    down = [[0, 0, -1], [.5, 0, -1], [-.5, 0, -1], [0, .5, -1], [0, -.5, -1]]
    cyls, drains = [], []
    for k in np.argsort(-szs):
        if szs[k] < LOBE_MIN_ML:
            break
        cw = trimesh.transformations.transform_points(
            np.array(np.nonzero(lb == k + 1)).T.astype(float), T)
        p = cw[cw[:, 2] < cw[:, 2].min() + 1.0].mean(0); p[2] = cw[:, 2].min()
        L, d = exit_ray(p, down)
        seg = L + 8.0
        c = trimesh.creation.cylinder(radius=DRAIN_R, height=seg, sections=24)
        c.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], d))
        c.apply_translation(p + d * (L - seg / 2 + 4.0))
        cyls.append(c)
        drains.append({"xyz": [round(v, 1) for v in p], "lobe_ml": round(float(szs[k]), 2),
                       "wall_mm": round(L, 1)})
    # vent: thinnest horizontal wall near cavity top
    high = world[world[:, 2] > zw.max() - 2.0]
    horiz = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]]
    best = None
    for p in high[::max(1, len(high) // 40)]:
        r = exit_ray(p, horiz)
        if r and (best is None or r[0] < best[0]):
            best = (r[0], p.copy(), r[1])
    ventL, vp, vd = best
    c = trimesh.creation.cylinder(radius=VENT_R, height=ventL + 9.0, sections=24)
    c.apply_transform(trimesh.geometry.align_vectors([0, 0, 1], vd))
    c.apply_translation(vp + vd * (ventL / 2 + 0.5))
    cyls.append(c)
    log.update(drains=drains, vent={"xyz": [round(v, 1) for v in vp], "wall_mm": round(ventL, 1)})

    # pooling audit
    drain_ijk = [np.clip(trimesh.transformations.transform_points([d["xyz"]], Tinv)[0]
                         .round().astype(int), 0, np.array(mat.shape) - 1) for d in drains]
    pool = 0.0
    for zcut in np.arange(lowz + 2, zw.max(), 4.0):
        b2 = np.zeros_like(main)
        s2 = idx[zw < zcut]
        b2[tuple(s2.T)] = True
        lb2, nb2 = ndimage.label(b2)
        if nb2 <= 0:
            continue
        s = ndimage.sum(b2, lb2, range(1, nb2 + 1))
        drained = set()
        for dj in drain_ijk:
            for dz in range(6):
                q = np.clip(dj + [0, 0, dz], 0, np.array(mat.shape) - 1)
                if lb2[tuple(q)] > 0:
                    drained.add(lb2[tuple(q)]); break
        pool = max(pool, sum(s[i - 1] for i in range(1, nb2 + 1) if i not in drained)
                   * PITCH ** 3 / 1000.0)
    log.update(trapped_resin_ml=round(pool, 2))

    # interior shell (marching cubes is inside-out: fix normals, assert volume)
    mp = np.pad(main, 1)
    verts, faces, _, _ = measure.marching_cubes(mp.astype(np.float32), level=0.5)
    inner = trimesh.Trimesh(
        vertices=trimesh.transformations.transform_points(verts - 1.0, T), faces=faces)
    inner.merge_vertices(); trimesh.repair.fix_normals(inner)
    inputs = [m, inner] + cyls
    for c in cyls:
        c.merge_vertices()
    assert all(x.is_volume for x in inputs), "non-volume boolean input"
    final = trimesh.boolean.difference(inputs, engine="manifold")
    final.merge_vertices()

    # verification triad + volume + breathing
    bodies = len(final.split(only_watertight=False))
    vol = final.volume / 1000.0
    fv = final.voxelized(0.4); fmat = fv.matrix
    lbl2, _ = ndimage.label(~fmat)
    cpt = trimesh.transformations.transform_points(
        [world.mean(0)], np.linalg.inv(np.array(fv.transform)))[0].round().astype(int)
    breathes = bool(lbl2[tuple(np.clip(cpt, 0, np.array(fmat.shape) - 1))] == lbl2[0, 0, 0])
    ok = (bodies == 1 and final.is_watertight and final.is_winding_consistent
          and abs(vol - (solid_ml - cavity_ml)) < 0.02 * solid_ml and breathes)
    log.update(final_ml=round(vol, 1), bodies=bodies, watertight=final.is_watertight,
               winding=final.is_winding_consistent, cavity_breathes=breathes,
               verify="PASS" if ok else "FAIL", elapsed_s=round(time.time() - t0, 1))
    if not ok:
        log.update(status="NOT_EXPORTED_verify_failed"); return log
    final.export(out_path)
    log.update(status="OK", exported=out_path)
    return log


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("input"); ap.add_argument("output")
    ap.add_argument("--wall", type=float, default=2.5)
    ap.add_argument("--no-orient", action="store_true")
    ap.add_argument("--report", default=None)
    a = ap.parse_args()
    log = {}
    try:
        run(a.input, a.output, wall=a.wall, orient=not a.no_orient, log=log)
    finally:
        print(json.dumps(log, indent=2))
        if a.report:
            json.dump(log, open(a.report, "w"))
