# Houdini pack — plan

Status: **planned, not implemented.** Target: Houdini 21.x, guarded down to 19/20.
The Blender pack (`src/export/blenderPack.ts`) is the working reference, and the
AGENTS.md generator both packs share already exists (`src/export/packAgentsMd.ts`).

## Goal

The same contract as the Blender pack: one zip that turns a hyperPattern drape into a
simulatable garment. Export data, not a scene file — a `.hip` is a cpio archive with no
ASCII save and no published schema, and the `hexpand`/`hcollapse` round-trip needs a
Houdini install. A `hou` script that builds the network is the only portable route, and
because it builds from scratch it also dodges the `.hipnc` / commercial-file split
entirely.

## Pack contents

```
Drape-6-houdini.zip
  cloth.obj              garment, flat layout, metres, outward-wound
  avatar.obj             body, metres (Houdini is Y-up, so no axis fix)
  seams.json             same schema as the Blender pack, format:"hyperpattern.houdini-pack"
  import_hyperpattern.py hou script: build_plan(data) -> apply(hou, plan)
  README.txt             for the person
  AGENTS.md              for an agent driving Houdini over MCP
```

## Network the script builds

```
/obj/hp_garment                                   (geo)
  cloth_file       file               cloth.obj
  body_file        file               avatar.obj
  cloth_fields     python             point attrs from seams.json: crowd, piece, pin
  vellum_cloth     vellumconstraints  constrainttype=cloth, mass=calcvarying, thickness
  gather_wrangle   attribwrangle      f@restlength *= crowd   (gathered rows only)
  stitch_prims     python             one 2-point prim per seam pair,
                                      type="stitch", restlength=gap
  constraints      merge              vellum_cloth:1 + gather_wrangle + stitch_prims
  vellum_solver    vellumsolver       in0=cloth_fields, in1=constraints, in2=body_file
```

Stitch prims are authored by hand rather than using the Stitch Points mode of
`vellumconstraints`: that mode pairs source and target *in group index order*, and
Houdini point groups do not preserve order. The export has explicit `(a, b)` pairs and a
per-pair rest gap, so authoring the prims is both deterministic and more faithful than
the Blender pack, which has to sew open boundary edges by proximity.

## Mapping

| hyperPattern        | Vellum                                                         |
| ------------------- | -------------------------------------------------------------- |
| pattern pieces      | `cloth.obj` groups (OBJ groups survive the File SOP)            |
| seam pair + gap     | constraint prim: `type="stitch"`, `restlength` = gap            |
| gather ratio        | `restlength` scaled on that row's distance constraints          |
| frozen piece        | `pingroup`, `pintype="hard"` (mass 0)                           |
| ghosted piece       | omitted, same as Blender                                        |
| avatar collider     | Vellum Solver third input, `pscale` for thickness               |
| contact grip        | `friction` + collision thickness (no direct analogue)           |
| substeps/iterations | Vellum Solver Substeps / Constraint Iterations                  |

## Phases

1. Extract `filterCloth`, `pieceRuns`, `surfaceAreaM2`, seams-JSON and zip assembly from
   `blenderPack.ts` into a shared module. `blenderPack` behaviour unchanged, tests green.
   (1–2 h)
2. `src/export/houdiniPack.ts` + tests — reuses phase 1, swaps script and README, retags
   the JSON. (1–2 h)
3. `src/export/houdiniImportPy.ts` — split into a pure `build_plan(data)` returning a
   declarative description of nodes/parms/wiring, and a thin `apply(hou, plan)`.
   `import hou` lives inside `apply`, so the pure half is testable without Houdini. (4–5 h)
4. ~~`src/export/packAgentsMd.ts`~~ — **done.** `buildHoudiniAgentsMd` and
   `buildBlenderAgentsMd` share one facts type and one prologue, so the numbers an agent
   verifies against cannot drift from `seams.json`. Wire it into the pack at phase 2.
5. Third item in the split-button popover, `exportHoudiniPack` in `StudioApp`, README
   bullet. (1–2 h)

## Verification

- `python3 -m py_compile` for syntax; `python3 -m unittest` over `build_plan` — no licence
  needed.
- Vitest over the pack builder and the AGENTS.md generator, same as the Blender pack.
- Token names checked against docs anchors and against the `vellumconstraints` dialog
  script inside the installed H20 `OPlibSop.hda`; anything 21 might rename goes through
  `set_if` — the pattern that absorbed three API breaks in the Blender script.
- **Not verifiable here:** no Houdini licence on this machine (`hython` reports "No
  licences could be found"). First contact with a licensed Houdini is still ahead.

## AGENTS.md

Drafted in `src/export/packAgentsMd.ts` (`buildHoudiniAgentsMd`). It shares the Blender
file's skeleton — what the folder is, ground-truth counts, order of operations,
verify-before-reporting, do-not list, known drift — with these Houdini-specific parts:

- **Tools.** `ping`, `create_node`, `set_parameters`, `get_parameter_schema`,
  `connect_nodes`, `create_wrangle`, `set_wrangle_code`, `cook_node`, `find_error_nodes`,
  `get_geometry_info`, `get_geometry_data`, `set_node_flags`, `layout_children`,
  `delete_node` (houdini-mcp). Tool names differ between MCP servers, so the file also
  says to read `tools/list` before assuming.
- **Order.** `ping` → check `/obj/hp_garment` does not already exist → run the script from
  the Python Shell (works in Apprentice; `hython` does not) → `find_error_nodes` must be
  empty → `cook_node` → compare counts → step frames.
- **Verify.** point count == `seams.json` `cloth.vertices`; `stitch_prims` prim count ==
  `len(seams)`; solver has all three inputs wired; `pin` group size == `len(pins)`;
  `find_error_nodes` clean.
- **Do not.** Wire the constraint stream into input 0, scale or re-axis the OBJ, weld the
  seam rows, save `.hip` from Apprentice, or rebuild the network by hand.

## Known risks

- Stitch prim authoring via a Python SOP is the least certain part; if the solver ignores
  hand-authored prims, fall back to `vellumconstraints` Stitch Points and rely on
  *Constrain to Closest Point* (the pairs are mutually closest in the flat layout).
- Hard pins plus strong bend are documented as unstable — start bend moderate.
- Vellum is not XPBD: no velocity clamp, no grip. Same garment, plausible drape,
  different numbers.
