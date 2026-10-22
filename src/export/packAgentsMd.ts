/**
 * The `AGENTS.md` that travels inside an export pack.
 *
 * A pack is handed to someone else's agent — one driving Blender or Houdini over
 * MCP — and that agent has no idea what a hyperPattern drape is. The `README.txt`
 * next to it is written for the person reading the folder; this file is written
 * for the agent operating the scene: the exact counts it should see, the order to
 * do things in, the checks that prove the build worked, and the handful of steps
 * that look helpful and quietly destroy a garment (merging seam rows, applying the
 * cloth solver, importing a second copy over the first).
 *
 * The facts come from the pack itself, never from the live scene, so the numbers
 * an agent verifies against are the numbers that were written to disk.
 */

/** What both packs can state about the data they shipped. */
export type PackAgentsFacts = {
  scene: { project: string; drape: string; pattern: string; mesh: string };
  cloth: { vertices: number; triangles: number };
  /** 0 when the drape has no avatar: the body is then absent from the pack. */
  bodyTriangles: number;
  seams: { total: number; gathered: number };
  pins: number;
  pieces: number;
  collider: { distanceMetres: number };
  fabric: { vertexMassKg: number; sewingForceMax: number; friction: number; quality: number };
  substeps: number;
};

/** Object names the Blender script creates; it renames on every import. */
const BLENDER_CLOTH = 'hyperpattern_cloth';
const BLENDER_BODY = 'hyperpattern_body';
const BLENDER_GATHER = 'hyperpattern_gather';
const BLENDER_PINS = 'hyperpattern_pins';

/** Root node the Houdini script builds. */
const HOUDINI_ROOT = '/obj/hp_garment';

function mm(metres: number): string {
  return `${(metres * 1000).toFixed(1)} mm`;
}

function tris(count: number): string {
  return `${count.toLocaleString('en-US')} triangle${count === 1 ? '' : 's'}`;
}

function massLabel(kgPerVertex: number): string {
  const grams = kgPerVertex * 1000;
  return grams >= 1 ? `${grams.toFixed(1)} g` : `${(grams * 1000).toFixed(0)} mg`;
}

/** The front matter both targets share: what this is and what is in it. */
function prologue(facts: PackAgentsFacts, app: string): string {
  const body = facts.bodyTriangles
    ? `${tris(facts.bodyTriangles)} from \`avatar.obj\` (the collider)`
    : 'none — this drape was exported without an avatar';
  const gathered = facts.seams.gathered
    ? `${facts.seams.gathered} of them gathered`
    : 'none gathered';

  return `# Building this garment in ${app}

This folder is an export from **hyperPattern** (garment pattern drafting and cloth
simulation). \`${facts.scene.drape}\` from project "${facts.scene.project}".

Read this before touching the scene. \`import_hyperpattern.py\` already builds the whole
setup; your job is to run it, check it, and then hand the scene to the user — not to
rebuild it by hand.

## Ground truth

| | |
| --- | --- |
| Cloth | ${facts.cloth.vertices.toLocaleString('en-US')} vertices, ${tris(facts.cloth.triangles)} (\`cloth.obj\`) |
| Body | ${body} |
| Seam pairs | ${facts.seams.total.toLocaleString('en-US')} (${gathered}) |
| Frozen vertices | ${facts.pins.toLocaleString('en-US')} |
| Pattern pieces | ${facts.pieces} |
| Collider gap | ${mm(facts.collider.distanceMetres)} |
| Fabric mass | ${massLabel(facts.fabric.vertexMassKg)} per vertex |
| Units | **metres**, +Y up. Do not rescale, rotate or re-axis the OBJ. |
| Pose | the **flat layout**, not the draped pose. It is meant to look unfinished. |

\`seams.json\` is the contract: it carries every number in that table. If the scene and
the JSON disagree, the scene is wrong.

## Files

- \`cloth.obj\` — the garment, flat layout, metres, faces wound outward
- \`avatar.obj\` — the body the cloth drapes over${facts.bodyTriangles ? '' : ' (absent: there is no avatar in this drape)'}
- \`seams.json\` — seam pairs and rest gaps, gathered rows, pins, fabric settings
- \`import_hyperpattern.py\` — the builder; run this rather than assembling the scene yourself
- \`README.txt\` — the same pack described for a human
`;
}

function blenderAgentsMd(facts: PackAgentsFacts): string {
  const gatherCheck = facts.seams.gathered
    ? `assert '${BLENDER_GATHER}' in cloth.vertex_groups  # gathered rows\n`
    : '';
  const pinCheck = facts.pins
    ? `assert '${BLENDER_PINS}' in cloth.vertex_groups  # frozen pieces\n`
    : '';
  const bodyCheck = facts.bodyTriangles
    ? `body = bpy.data.objects['${BLENDER_BODY}']\n` +
      `assert any(m.type == 'COLLISION' for m in body.modifiers)\n`
    : '';

  return `${prologue(facts, 'Blender')}
## Order of operations

1. \`get_scene_info\` to confirm Blender is running. If the scene already holds the
   user's work, ask before adding anything and never clear it.
2. Check for an existing \`${BLENDER_CLOTH}\`. A previous run means a duplicate is about
   to be created — ask the user before importing again.
3. Run the builder. From the Scripting workspace: Open \`import_hyperpattern.py\` -> Run
   Script. Over MCP: \`execute_blender_code("exec(open(r'<folder>/import_hyperpattern.py').read())")\`.
4. Verify with the block below. Do not report success before it passes.
5. \`get_viewport_screenshot\` and sanity-check it: flat panels held together by seams,
   the body inside the garment, nothing inside out.
6. Bake before scrubbing the timeline: \`bpy.ops.ptcache.bake_all(bake=True)\`.

## Verify

\`\`\`python
import bpy, json, os
d = json.load(open(os.path.join(r'<folder>', 'seams.json')))
cloth = bpy.data.objects['${BLENDER_CLOTH}']
assert len(cloth.data.vertices) == d['cloth']['vertices']
mod = next(m for m in cloth.modifiers if m.type == 'CLOTH')
assert mod.settings.use_sewing_springs
assert mod.settings.sewing_force_max == d['fabric']['sewingForceMax']
${gatherCheck}${pinCheck}${bodyCheck}\`\`\`

## Do not

- **Merge by distance** or any weld. The two sides of every seam are deliberately
  separate vertices; welding them throws the seam away and the garment falls apart.
- **Apply** the Cloth modifier, or convert the cloth to mesh mid-simulation.
- **Import twice.** Importing adds a new object every time; the old one survives as
  \`${BLENDER_CLOTH}.001\` and nothing looks wrong until it drapes through the first copy.
- **Rename** \`${BLENDER_CLOTH}\`, \`${BLENDER_BODY}\` or the \`${BLENDER_GATHER}\` /
  \`${BLENDER_PINS}\` vertex groups. The checks and the modifier bindings use those names.
- **Retune mass or stiffness** "to make it drape faster". The values came from the studio's
  parameters; changing them means the result can no longer be compared with the viewport.

## If it breaks

Every property is set through a \`set_if\` guard, so a knob that does not exist in this
Blender is skipped rather than fatal. Known drift: \`collision_settings\` is on the
**modifier** in 5.x (on \`.settings\` in 4.x); the body gap is \`thickness_outer\` in 5.x
(\`distance\` before); impulse clamping is a float (\`impulse_clamp\`), not a bool; OBJ import
moved from \`import_scene.obj\` to \`wm.obj_import\` in 4.0.

Report the traceback line and which value failed. Do not patch the script in the user's
session and leave it patched.
`;
}

function houdiniAgentsMd(facts: PackAgentsFacts): string {
  const gatherCheck = facts.seams.gathered
    ? '- `get_geometry_info` on `gather_wrangle`: prim count == the distance constraint count\n'
    : '';
  const pinCheck = facts.pins
    ? `- \`vellum_cloth\` pin group "${BLENDER_PINS}" resolves to ${facts.pins.toLocaleString('en-US')} points\n`
    : '';

  return `${prologue(facts, 'Houdini')}
## Order of operations

1. \`ping\` the MCP bridge, then look at \`/obj\` so you know what the user already has.
   Ask before building into a scene they are using.
2. Check whether \`${HOUDINI_ROOT}\` exists. If it does, a previous run is in the file —
   ask before adding a second copy.
3. Run the builder. The reliable route is Houdini's Python Shell: \`exec(open(...).read())\`.
   It also works in **Apprentice**, which \`hython\` does not — \`hou\` checks out a Batch or
   FX licence and Apprentice-licensed \`hython\` is read-only.
4. \`find_error_nodes\` on \`${HOUDINI_ROOT}\` — it must come back empty.
5. \`cook_node\` the solver, then \`get_geometry_info\` and compare with the table above.
6. Step the timeline with \`hou.setFrame(n)\`; do not jump straight to a late frame.

## What the script leaves behind

    ${HOUDINI_ROOT}
      cloth_file       file               cloth.obj
      body_file        file               avatar.obj
      cloth_fields     python             crowd / piece attributes from seams.json
      vellum_cloth     vellumconstraints  cloth constraints + pins
      gather_wrangle   attribwrangle      shortens the rest length of gathered rows
      stitch_prims     python             one stitch constraint per seam pair
      constraints      merge              vellum_cloth:1 + gather_wrangle + stitch_prims
      vellum_solver    vellumsolver       in0 geometry, in1 constraints, in2 collider

## Verify

- \`get_geometry_info\` on the solver: point count == ${facts.cloth.vertices.toLocaleString('en-US')}
- \`get_geometry_info\` on \`stitch_prims\`: prim count == ${facts.seams.total.toLocaleString('en-US')}
- \`vellum_solver\` has all three inputs connected
- \`find_error_nodes\` on \`${HOUDINI_ROOT}\` is empty
${gatherCheck}${pinCheck}- stepping frames changes the point positions

## Do not

- **Wire the constraint stream into input 0.** Input 0 takes the geometry, input 1 the
  constraint prims (a \`vellumconstraints\` node's *second* output), input 2 the collider.
- **Scale or re-axis the OBJ.** It is already in metres, Y-up, which is Houdini's default.
- **Merge or weld the seam rows.** The stitch pairs are explicit index pairs; welding
  collapses the pairs onto each other and the seams disappear.
- **Save as \`.hip\` in Apprentice** — it writes \`.hipnc\`, and a commercial session will
  refuse it. Save as \`.hipnc\` and say so.
- **Rebuild the network by hand** if the script runs. The parm tokens are guarded
  deliberately; a hand-built copy drifts from the pack.

## If it breaks

Parameter names are set through a \`set_if\` guard, so a token that changed between
versions is skipped, not fatal. Report which node and which parameter failed, and the
traceback line. Known drift: the constraint-type menu token for cloth has been \`cloth\`
in every version so far, but the collision thickness token moved between 19 and 20.
`;
}

/** `AGENTS.md` for the Blender pack. */
export function buildBlenderAgentsMd(facts: PackAgentsFacts): string {
  return blenderAgentsMd(facts);
}

/** `AGENTS.md` for the Houdini pack. Draft until the Houdini builder lands. */
export function buildHoudiniAgentsMd(facts: PackAgentsFacts): string {
  return houdiniAgentsMd(facts);
}
