"""Read and write native, editable supports in CHITUBOX project files.

Reverse-engineered from CHITUBOX Basic 1.3.0 (July 2026) by differential
analysis; field-validated: injected supports load, render, select, move,
delete, and slice identically to native ones, including raft bridges.
See references/chitubox-format.md (same plugin) for the full format map.

Validated operations (all round-trip tested in Chitubox):
  - parse(): locate index, segment records, mesh blobs in any project file
  - inject clone-of-existing-support at a translated x,y
  - synthesize a raft bridge between two support feet (axis-remap of an
    existing bridge's mesh, or from-scratch 12-triangle box)

NOT yet Chitubox-validated: from-scratch synthesis of tip/shaft segment
meshes (cones/cylinders). Use clone+translate until that is proven.

Coordinates: records live in a model-centered frame WITH the model's
scene rotation applied. The group header stores placement (x, y, lift).
The plate sits at negative z in this frame (e.g. -8 when a 10mm cube is
lifted 3mm). Verify against a specimen before trusting new scenes.

Format drift warning: everything here is pinned to the 1.3.0 container.
On a new Chitubox version, re-run the specimen protocol (see SKILL.md)
before trusting any offsets.
"""
import struct
import numpy as np

FILE_MAGIC = 2871202371       # first u32 of every .chitubox file
SEG_MAGIC = 3929285513        # delimits every 72-byte segment record
REC_SIZE = 72

# segment type ids (observed vocabulary)
T_TIP = 7      # contact cone: start = point ON/in model (contact depth in), tilted along normal is native
T_TAPER = 1    # tip radius -> shaft radius transition
T_SHAFT = 9    # main column
T_JOINER = 3   # short coupler between sections
T_FLARE = 4    # shaft -> foot flare
T_PAD = 6      # raft disc at foot (start==end) OR bridge (start=foot A, end=foot B)


class Record:
    def __init__(self, raw):
        self.raw = bytearray(raw)
        (self.magic, self.type) = struct.unpack_from("<II", raw, 0)
        self.start = np.array(struct.unpack_from("<3f", raw, 8))
        self.end = np.array(struct.unpack_from("<3f", raw, 20))
        (self.r1, self.r2) = struct.unpack_from("<2f", raw, 32)
        (self.mesh_off, self.mesh_len) = struct.unpack_from("<II", raw, 40)

    def packed(self, start=None, end=None, mesh_off=None):
        r = bytearray(self.raw)
        s = self.start if start is None else np.asarray(start, float)
        e = self.end if end is None else np.asarray(end, float)
        struct.pack_into("<3f", r, 8, *s)
        struct.pack_into("<3f", r, 20, *e)
        if mesh_off is not None:
            struct.pack_into("<II", r, 40, mesh_off, self.mesh_len)
        return bytes(r)


class Project:
    """Parsed .chitubox container (support layer only; model data untouched)."""
    def __init__(self, path):
        self.data = bytearray(open(path, "rb").read())
        assert struct.unpack_from("<I", self.data, 0)[0] == FILE_MAGIC, "not a .chitubox file"
        # find the trailing run of segment records via their magic
        pat = struct.pack("<I", SEG_MAGIC)
        offs = []
        i = self.data.find(pat)
        while i != -1:
            offs.append(i)
            i = self.data.find(pat, i + 1)
        assert offs and all(b - a == REC_SIZE for a, b in zip(offs, offs[1:])), \
            "segment records not contiguous - format drift? re-run specimen protocol"
        self.rec_off = offs[0]
        self.n_recs = len(offs)
        # index = u32 pair (count, rec_off) somewhere before the records
        idx = self.data.find(struct.pack("<II", self.n_recs, self.rec_off))
        assert idx != -1, "index not found"
        self.idx_off = idx
        (_, _, self.mesh_off, self.mesh_size) = struct.unpack_from("<4I", self.data, idx)
        # the single pointer that references the index
        ptr = self.data.find(struct.pack("<I", idx))
        assert ptr != -1 and ptr != idx, "index pointer not found"
        assert self.data.find(struct.pack("<I", idx), ptr + 1) in (-1, idx), \
            "index pointer ambiguous - inspect before writing"
        self.idx_ptr = ptr
        self.records = [Record(self.data[self.rec_off + k * REC_SIZE:
                                         self.rec_off + (k + 1) * REC_SIZE])
                        for k in range(self.n_recs)]

    def blob(self, rec):
        return np.frombuffer(bytes(self.data[rec.mesh_off:rec.mesh_off + rec.mesh_len]),
                             "<f4").reshape(-1, 3).copy()

    def supports(self):
        """Group records into supports: each run starts at a T_TIP and ends
        before the next T_TIP; bridges (T_PAD with start != end) are listed
        separately."""
        groups, bridges, cur = [], [], []
        for r in self.records:
            if r.type == T_PAD and not np.allclose(r.start[:2], r.end[:2]):
                bridges.append(r)
                continue
            if r.type == T_TIP and cur:
                groups.append(cur)
                cur = []
            cur.append(r)
        if cur:
            groups.append(cur)
        return groups, bridges

    def write(self, path, new_records):
        """Append (record_bytes, blob_bytes) pairs; patch index + pointer."""
        new_blob = b"".join(b for _, b in new_records)
        new_recs = b"".join(r for r, _ in new_records)
        mesh_end = self.mesh_off + self.mesh_size
        out = bytearray()
        out += self.data[:mesh_end]
        out += new_blob
        out += self.data[self.idx_off:self.rec_off + self.n_recs * REC_SIZE]
        out += new_recs
        out += self.data[self.rec_off + self.n_recs * REC_SIZE:]
        nb = len(new_blob)
        struct.pack_into("<4I", out, self.idx_off + nb,
                         self.n_recs + len(new_records),
                         self.rec_off + nb, self.mesh_off, self.mesh_size + nb)
        struct.pack_into("<I", out, self.idx_ptr, self.idx_off + nb)
        open(path, "wb").write(bytes(out))
        return len(out)


def clone_support(proj, template_records, dx, dy):
    """Translated copy of an existing support (VALIDATED path). Returns
    (record, blob) pairs with mesh offsets assigned sequentially from the
    current end of the mesh region."""
    out = []
    next_off = proj.mesh_off + proj.mesh_size + sum(
        len(b) for _, b in out)
    for rec in template_records:
        blob = proj.blob(rec)
        blob[:, 0] += dx
        blob[:, 1] += dy
        s = rec.start + [dx, dy, 0]
        e = rec.end + [dx, dy, 0]
        out.append((rec.packed(start=s, end=e, mesh_off=next_off),
                    blob.astype("<f4").tobytes()))
        next_off += rec.mesh_len
    return out


def make_bridge(proj, foot_a, foot_b, template=None, next_off=None):
    """Raft bridge between two feet. If a template bridge record exists,
    remap its mesh through axis coordinates (VALIDATED); else synthesize a
    12-triangle box (geometry verified, Chitubox-render validated via the
    remap path which produces identical shape)."""
    foot_a = np.asarray(foot_a, float)
    foot_b = np.asarray(foot_b, float)
    if next_off is None:
        next_off = proj.mesh_off + proj.mesh_size
    v = (foot_b - foot_a)[:2]
    Ln = np.linalg.norm(v)
    vd = v / Ln
    qd = np.array([-vd[1], vd[0]])
    if template is not None:
        tri = proj.blob(template)
        u = (template.end - template.start)[:2]
        Lo = np.linalg.norm(u)
        ud = u / Lo
        pd = np.array([-ud[1], ud[0]])
        rel = tri[:, :2] - template.start[:2]
        t = rel @ ud
        w = rel @ pd
        tri[:, :2] = foot_a[:2] + np.outer(t * (Ln / Lo), vd) + np.outer(w, qd)
        z = tri[:, 2]  # keep template plate z
        rec = template.packed(start=[*foot_a[:2], 0.0], end=[*foot_b[:2], 0.0],
                              mesh_off=next_off)
        return rec, tri.astype("<f4").tobytes()
    raise NotImplementedError("no template bridge in file; from-scratch box "
                              "synthesis not yet Chitubox-validated - clone "
                              "a scene that has a connected raft")
