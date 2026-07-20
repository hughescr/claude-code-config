# .chitubox project format (CHITUBOX Basic 1.3.0) - support layer

Reverse-engineered July 2026 via differential specimens; injection
field-validated in Chitubox (load/render/select/move/delete/slice).
All integers little-endian. Byte offsets from file start unless noted.

## Container layout (observed)

```
[header]
[settings blob]            420 bytes (an empty project is exactly this + header)
[model section]            mesh, transform, name (":<filename>" string)
[support group header]     label string, placement, pointers, preset names
[support mesh blobs]       raw triangle soup, per segment
[index]                    16 bytes: n_records, records_off, mesh_off, mesh_size
[gap]                      zeros
[segment records]          n x 72 bytes, contiguous
[footer]                   20 bytes (unmapped; preserved verbatim)
```

## Header

| off | type | meaning |
|---|---|---|
| 0 | u32 | file magic 0xAB231243 (2871202371) |
| 4 | u32 | model count |
| 8 | u32 | model-section-related offset |
| 12 | u32 | settings blob size (420) |
| 16 | u32 | 412 (settings-related) |
| 20 | u32 | support-section-related offset |

## Support group header

Near the model name string ("<name> #1" or plain "<name>"). Contains:
- a float triple = model PLACEMENT: (x, y, lift). Verified: lift value
  matches plate distance seen in record coordinates.
- u32 pointer to the index (this is the ONE reference that must be
  patched when the index moves; locate it by searching for the index
  offset as u32 - it has been unique in every specimen).
- u32 432 = 6 x 72 = one support's record bytes (informational).
- preset-name table: u32 strlen + chars (e.g. "Heavy", "Light") when
  supports were added with named presets.
- per-support tables with repeating u64-ish entries (UNMAPPED - values
  like 260 x5 + 7680 per support; cloning ignores them and injected
  supports still work; may relate to UI/undo).

## Segment records (72 bytes each)

A support = a chain of segment records. Delimiter/self-check: every
record starts with magic 3929285513 (0xEA33F809... use the decimal).

| off | type | field |
|---|---|---|
| 0 | u32 | record magic 3929285513 |
| 4 | u32 | segment type (below) |
| 8 | f32 x3 | start xyz |
| 20 | f32 x3 | end xyz |
| 32 | f32 | radius 1 (at start / primary) |
| 36 | f32 | radius 2 (at end / secondary) |
| 40 | u32 | mesh blob offset (ABSOLUTE file offset) |
| 44 | u32 | mesh blob length (bytes) |
| 48 | f32/u32 x6 | trailing fields: mostly zero; type-1 carries 0.3 (contact depth); type-6 carries flags (bridge connectivity, 4.0) |

### Segment type vocabulary (observed)

| id | role | example params (user's "better support" profile) |
|---|---|---|
| 7 | tip cone (contact) | r 0.4 (Heavy) / 0.1 (Light); start = contact point 0.3mm INSIDE surface; tilted along surface normal is native |
| 1 | taper tip->shaft | r 0.3 -> 0.75 |
| 9 | shaft | r 0.721-0.75 |
| 3 | joiner | short coupler |
| 4 | base flare | r 0.75 -> 1.1 |
| 6 | pad OR bridge | pad: start==end, r 2.2 / 0.2 (radius/height). bridge: start=foot A, end=foot B, 2.2 wide x 0.2 thick box at plate z |

A minimal support = [7,1,9,4,3,6-pad]. A connected raft = pads plus
type-6 bridges pairwise between feet (spanning-tree style). Branching
supports exist (extra 9/3 chains; encoding partially mapped only).

## Mesh blobs

Raw float32 triangle soup: 12 floats (3 vertices) per triangle, NO
normals, NO counts. Record's (offset, length) locates each segment's
cached mesh. Chitubox renders/slices from these; the parametric record
drives editing. Blob region is contiguous; index.mesh_size covers it.

## Index

16 bytes: `u32 n_records, u32 records_off, u32 mesh_off, u32 mesh_size`.
Located immediately after the mesh region. Found generically by
searching for the (n_records, records_off) pair once records are
census'd via their magic.

## Coordinate frame (critical)

Record coordinates are model-centered WITH scene rotation applied:
a rotated model's supports have rotated coordinates; the placement
triple carries (x, y, lift) translation. Plate z in record frame is
negative (cube 10mm tall, lifted 3mm -> plate at z=-8). Always verify
frame against a known support before computing placements.

## Injection recipe (validated)

1. Census records by magic (expect uniform 72-byte stride at EOF).
2. Find index by (count, rec_off) pair; find the single u32 pointing at
   the index.
3. Append new mesh blobs at end of mesh region; index/gap/records/footer
   shift by that amount; append new records after existing ones.
4. Patch: index (count += n, records_off += nb, mesh_size += nb) and the
   index pointer (+= nb). NOTHING else - all other offsets observed to
   be stable/relative or pointing before the insertion point.
5. Acceptance: file loads; support count right; new supports fully
   editable; slices. (A reproduction test exists: the library rebuilt a
   hand-validated injection byte-for-byte.)

## Known unknowns

- per-support tables in group header (260/7680 patterns)
- 20-byte footer
- branch attachment encoding (F specimen has them; not fully mapped)
- rotation storage location in model section (frame effect confirmed,
  bytes not pinpointed)
- from-scratch tip/shaft mesh synthesis not yet Chitubox-validated
- format is version-pinned: 1.3.0. Re-verify on upgrade.

## Real-scale specimen: magic-supported 100mm miniature (calibration corpus)

56MB project, parser clean: 5,860 records = 469 supports + 261 raft
bridges. Extended type vocabulary beyond the minimal set: type 2
(x167, short 0.2->0.6 taper) and type 8 (x130, ~0.5mm coupler) compose
the small-pillar/model-adsorbed supports; type 12 (x7) unmapped; the
2,985 type-3 joiners likely include the cross-brace lattice. Pass
attribution via tip radius works: r0.4=Heavy(198), r0.25=Middle full
pillar(9), r0.15+r0.1 = the two small-pillar passes (130+132).

REALIZED density (the user's accepted standard, "Better Support"
4-pass): tip nearest-neighbor median 3.1mm overall; Heavy pass 3.8mm
(p10 2.6, p90 8.1); small-pillar passes ~5.2mm. Bottom quarter of the
model carries 40% of all tips. NOTE: config touchtipdistance (6-8mm)
is NOT the realized spacing -- treat it as a max, calibrate from real
projects, not config.

## Edit-behavior findings (injected supports under Chitubox editing)

Field-tested: injected supports (cloned AND fully synthesized meshes,
off-palette sizes) are selectable/movable/deletable like natives.
Nuances discovered when the user MOVES an injected support's base:
- its raft BRIDGE (connected-mat link) regenerates/follows correctly --
  bridge topology is read from the records themselves;
- its own raft PAD vanishes -- per-support pad ownership lives in the
  editor's registry (likely the unmapped per-support group-header
  tables), and injected supports are not in it.
Mitigations: emit raft last and let Chitubox own mat bookkeeping after
any manual edit; or map the registry via a save-after-editing-an-
injected-support specimen diff (the editor normalizes the file with its
own bookkeeping around alien records - a Rosetta stone, not yet done).
Synthesized-mesh validation is COMPLETE: from-scratch frustum soup with
computed (non-palette) radii renders, edits, and behaves natively.
