# Tabletop sizing conventions (mm, resin)

Defaults for D&D-style minis; confirm with the user, especially for
creatures that read larger/smaller than their game size.

| Size | Rule of thumb | Examples |
|---|---|---|
| Tiny | 13mm tall; fits 1/2" (12.7mm) base | familiars |
| Small | ~22mm biped; 1" base | small humanoids |
| Medium | 30mm tall humanoids; footprint-driven for long quadrupeds (30mm tall raptor) or legspan ~30mm (spider, slight base overhang OK) | zombies, skeletons |
| Large | 2" (50.8mm) base is the anchor: squat creatures fill the base (toad 50mm footprint); tall ones ~54mm high | horses, toads |

Bake scale into the mesh (see `scale_center_bake` in
`scripts/geometry_sweep.py`): slicers read STL units as mm, and object
transforms do not survive export. Center XY on origin, base at z=0 -
models parked hundreds of mm off-origin read as "my import is invisible".
