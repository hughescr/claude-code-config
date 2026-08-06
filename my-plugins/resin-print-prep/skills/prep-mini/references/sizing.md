# Tabletop sizing conventions (mm, resin)

Defaults for D&D-style minis; confirm with the user, especially for
creatures that read larger/smaller than their game size.

| Size | Rule of thumb | Examples |
|---|---|---|
| Tiny | 13mm tall; fits 1/2" (12.7mm) base | familiars |
| Small | ~22mm biped; 1" base | small humanoids |
| Medium | 30mm tall humanoids; footprint-driven for long quadrupeds (30mm tall raptor) or legspan ~30mm (spider, slight base overhang OK) | zombies, skeletons |
| Large | 2" (50.8mm) base is the anchor: squat creatures fill the base (toad 50mm footprint); tall ones ~54mm high | horses, toads |
| Huge | 3" (76.2mm) base standard; footprint fills the base | giants, treants |
| Gargantuan | 4" (101.6mm) base | dragons |

Conventions vary by table -- some groups run Huge on ~100mm rounds.
Confirm the user's base size rather than assuming the standard.

**Models without an integrated base disc** (standing on feet/roots):
"fits an N-mm base" means the ground-contact footprint's LONG AXIS spans
the base diameter rim-to-rim; canopy/limbs overhanging the base is normal
and fine. State the interpretation in your report so the user can adjust.

Bake scale into the mesh (see `scale_center_bake` in
`scripts/geometry_sweep.py`): slicers read STL units as mm, and object
transforms do not survive export. Center XY on origin, base at z=0 -
models parked hundreds of mm off-origin read as "my import is invisible".
