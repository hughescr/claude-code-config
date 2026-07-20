# Support placement design charter

## Objective (the user's, verbatim in spirit)

Minimize total model damage + removal effort, subject to every region
held within mechanical safety margins. Fixed palettes are a UI
convenience, not engineering: the record format stores arbitrary float
radii, so sizes are COMPUTED per support.

Hard requirements from the user:
1. Easy removal: pryable, not too densely packed (spacing floor;
   tip necking so supports snap at the tip, never tear the model).
2. Minimize surface marking, ESPECIALLY delicate regions. The
   decimation stage's protected-verts/error map doubles as the
   delicacy field - scars are priced by local detail.
3. Scar cost feeds ORIENTATION too: rotate delicate regions "up" in
   slicer space (away from support-facing down/side surfaces) - same
   cost function, applied one stage earlier.
4. Model-to-model struts are first-class: sometimes the model is a
   better base than the plate. Price honestly: two scars + short stiff
   member vs one scar + long slender shaft + braces.

## Mechanics framework (bottom-up MSLA)

- Dominant load = PEEL: a few kPa over each region's newly-cured area,
  arriving as TENSION in that region's supports. Gravity ~cancelled by
  buoyancy. Supports are GREEN resin: tensile ~10-25 MPa, E ~0.5-1.5
  GPa (vs ~40-60 MPa / ~2 GPa post-cure). Design green, with SF 5-10.
- Consequence: shafts almost never fail in tension. The TIP is the
  fuse: tip radius = f(carried area x peel pressure x SF), clamped to
  a removal-friendly 0.2-1.0mm. Carried area via Voronoi partition of
  down-facing surface among contacts.
- Second driver is STIFFNESS, not strength: deflection ~ L^3/r^4;
  long slender shafts whip under resin drag during lifts -> ribbing.
  Cap slenderness given free length; where the cap demands ugly-thick
  shafts, ADD BRACES instead (halving free length cuts deflection 8x)
  or split the load with another contact.
- Articulation: tip stub enters along surface normal (2-3mm), elbow,
  vertical descent. Records are polyline chains natively (type-3
  joiners); kinked+braced is native vocabulary.

## Calibration (measure, don't guess)

A real magic-supported project (469 supports) provides: realized tip
spacing 3.1mm median (Heavy 3.8) - config's 6-8mm touchtipdistance is
a MAX, not the target; bottom quarter carries ~40% of tips; brace
placement vs shaft free length is extractable and calibrates the
slenderness constant; elbow geometry is observable. Calibrate against
the corpus where the slicer was right; out-engineer it where it just
applied the palette.

## v0 -> v2 work list (priority order)

1. Clearance-envelope routing (v0 checks ray centerline only: 27/137
   shafts violated 0.6mm standoff, some clipping the model).
2. Density calibration to measured 3-4mm class-dependent spacing.
3. Load partition -> continuous tip/shaft sizing (framework above).
4. Articulated routing (normal stub + elbow + descent; kinked crevice
   escapes - v0 runs full-shaft diagonals).
5. Brace graph (neighbor shafts within cross-width; ladder spacing
   from config; slenderness-triggered).
6. Model-to-model struts with two-sided scar pricing.
7. Scar-cost field (delicacy from decimation error map + visibility)
   used in BOTH placement and orientation scoring.
8. Emission via injection (requires synthesized-mesh validation).
9. Self-verify stays mandatory: zero unsupported islands, clearance
   check, plus per-region load check against green-strength SF.
