# Magic-support configuration (user's exported .cfgx, CHITUBOX 1.3.0)

Chitubox exports its full support configuration as PLAIN JSON (.cfgx) --
ask the user to export theirs (it lives alongside printer config;
example name: "<printer>_magicsupportconfig_all_00.cfgx"). Everything a
placement algorithm needs to mimic the user's tuned setup is in there.

## Structure

- `support[]`: named support profiles (Light/Middle/Heavy/Ultralight),
  each with top_support (tip), middle_support (shaft), bottom_support
  (foot), raft_support, and support_general_para (placement behavior).
- `magic[]`: magic-support recipes = ordered multi-pass flows, each pass
  naming a support profile + `autosupportmodel` + `autosupporttype`.

## Reference profile ("Better Support", field-proven by the user)

Four-pass cascade, mergesupport=true, cross_bracing=true:
1. Heavy, model=1 type=2
2. Middle, model=2 type=2
3. Middle, model=0 type=5
4. Light,  model=0 type=5

Interpretation (UNVERIFIED enums -- calibrate against a real supported
project): passes go coarse->fine; type 5 likely = small-pillar /
model-adsorbed supports, type 2 = full platform pillars; model may
select target surface class or remaining-area mode.

## Key parameters (this user's values; diameters, mm, degrees)

| param | Light | Middle | Heavy |
|---|---|---|---|
| tip contact dia / depth | 0.3 / 0.1 | 0.5 / 0.2 | 0.8 / 0.3 |
| tip cone dia up->down / length | 0.2->0.6 / 2.0 | 0.4->1.2 / 2.0 | 0.6->1.5 / 3.0 |
| shaft dia | 0.6 | 1.2 | 1.5 |
| foot dia / thickness | 10 / 0.8 | 12 / 1.0 | 12 / 1.0 |
| contact spacing (touchtipdistance) | 6.0 | 8.0 | 8.0 |
| cross-brace dia / spacing z / xy | 0.5 / 4 / 15 | 0.8 / 2 / 30 | 0.8 / 2 / 30 |

Shared: density 50%, autosupportangle 45 deg, hidden angle 45,
margin from edge 0.5, spacing from model 0.6, adsorption radius 8,
model-bottom density 100%, max connect angle 70, small-pillar max
length 3. Heavy adds generateBidirectionalCrossStructure=true.

Cross-check vs binary records: config stores DIAMETERS, records store
RADII (config Heavy tip 0.8 -> record r 0.4; shaft 1.5 -> 0.75; contact
depth 0.3 appears as the type-1 record's trailing float). Consistent.

## Open questions

- lift height: printerinfo.zliftheightinsupportmode = 3.0 but each
  profile's support_general_para says 5.0; the spike scene used 3.0.
  Resolve empirically per scene from the placement triple.
- autosupportmodel / autosupporttype enum meanings.
- raft: profile raft params (grid etc.) vs the observed simple pad+
  bridge records ("connected" mat) -- observed wins for injection.
