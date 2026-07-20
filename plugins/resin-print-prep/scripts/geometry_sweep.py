"""Converging geometry-repair loop for dense sculpt meshes.

Fixes true degenerates (zero-area faces, zero-length edges, non-manifold
edges) by EDGE COLLAPSE -- never dissolve. Dissolve-based cleanup
(dissolve_degenerate, the 3D-Print Toolbox "Make Manifold" button) chews
micro-triangles and punches holes on dense sculpts; collapse can never
create a border.

Run at ORIGINAL/full scale where the absolute thresholds are meaningful.
At mini scale (13-30mm) huge numbers of healthy faces sit under 1e-4 --
those are not defects, do not chase them (density is the decimation
pipeline's job, not this sweep's).

Counts can bump up mid-loop (transient bowties, e.g. 106->49->23->30->7->0).
That is normal; it converges, typically in 2-5 passes.

Usage:  exec(open(".../geometry_sweep.py").read()); hist = sweep("ObjectName")
Each history entry is (zero_faces, zero_edges, bad_edges). All-zero = clean.
"""
import bpy, bmesh, numpy as np


def sweep(name, passes=8, zero_thresh=1e-4):
    me = bpy.data.objects[name].data
    hist = []
    for _ in range(passes):
        bm = bmesh.new(); bm.from_mesh(me)
        nontri = [f for f in bm.faces if len(f.verts) > 3]
        if nontri:  # triangulating also fixes all "non-flat faces" permanently
            bmesh.ops.triangulate(bm, faces=nontri)
        zf = [f for f in bm.faces if f.calc_area() < zero_thresh]
        ze = [e for e in bm.edges if e.calc_length() < zero_thresh]
        bad = [e for e in bm.edges if len(e.link_faces) != 2]
        hist.append((len(zf), len(ze), len(bad)))
        if not zf and not ze and not bad and not nontri:
            bm.free(); break
        for e in bad:  # duplicate faces riding multi-face edges go first
            if not e.is_valid or len(e.link_faces) <= 2: continue
            seen = {}
            for f in list(e.link_faces):
                k = frozenset(v.index for v in f.verts)
                if k in seen: bm.faces.remove(f)
                else: seen[k] = f
        edges = set(e for e in ze if e.is_valid)
        for f in zf:  # collapse each sliver's shortest edge
            if f.is_valid:
                edges.add(min(f.edges, key=lambda e: e.calc_length()))
        if edges:
            # bmesh.ops.collapse is C-speed -- fine for 30k+ edges at once.
            # Never per-face Python pointmerge loops for big batches.
            bmesh.ops.collapse(bm, edges=[e for e in edges if e.is_valid], uvs=False)
        for e in bm.edges:  # remaining bad edges: midpoint pointmerge
            if not e.is_valid or len(e.link_faces) == 2: continue
            v1, v2 = e.verts
            mid = (np.array(v1.co) + np.array(v2.co)) / 2
            try: bmesh.ops.pointmerge(bm, verts=[v1, v2], merge_co=mid.tolist())
            except Exception: pass
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 3])
        bm.to_mesh(me); me.update(); bm.free()
    return hist


def scale_center_bake(name, s=1.0):
    """Scale by s, center XY bbox at origin, rest base on z=0 -- baked into
    the mesh (matrix_world = Identity) so exports carry real mm."""
    from mathutils import Matrix
    ob = bpy.data.objects[name]; me = ob.data
    n = len(me.vertices)
    co = np.empty(n * 3); me.vertices.foreach_get("co", co); co = co.reshape(-1, 3)
    M = np.array(ob.matrix_world)
    w = co @ M[:3, :3].T + M[:3, 3]   # world space handles stray transforms
    w *= s
    mn, mx = w.min(0), w.max(0)
    w += np.array([-(mn[0] + mx[0]) / 2, -(mn[1] + mx[1]) / 2, -mn[2]])
    me.vertices.foreach_set("co", w.reshape(-1)); me.update()
    ob.matrix_world = Matrix.Identity(4)
    return [round(v, 2) for v in (w.max(0) - w.min(0))]
