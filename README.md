# patternCanvas

Browser-first open-canvas studio for **drafting garment patterns in real units** and **draping them with WebGPU cloth simulation**.

Pattern frames, remesh previews, Transform 3D layouts, and sim viewports live on one pannable board—wired together like a node graph. Designed for indie makers, students, hobbyists, and researchers who want inspectable physics and remixable studies—not a Marvelous Designer / CLO clone.

Product direction and architecture: **[docs/PRD.md](docs/PRD.md)**.

---

## Quick start

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

| Entry | What it is |
| --- | --- |
| `/` (`index.html`) | **patternCanvas studio** |
| [`demo.html`](demo.html) | Legacy cloth drop / wind playground |

### Requirements

- A WebGPU browser: **Chrome / Edge 113+**, Safari 18+ (WebGPU on), or a recent Firefox Nightly / supported build
- Desktop recommended for editing; WebGPU also works on many phones

If you see “WebGPU is not supported,” update the browser and confirm WebGPU is enabled.

---

## What you can do

### Canvas project
- Pan the board (Alt-drag empty space) · zoom with ⌘/Ctrl-wheel
- **Right-click empty canvas** to add a node — **New pattern** (2D), **New drape** (3D), a **Note**, or an **Image reference…** — and it lands where you clicked
- Wire **pattern → remesh → transform → drape**; wires show assignments
- Save / load / import projects from the **Projects** modal · undo / redo (⌘Z / ⌘⇧Z)
- Image refs (the **Image reference…** menu entry, paste, or drop) are stored with the project, so they come back on reload. An image whose stored bytes are gone shows a **Re-link image…** button on the node
- Duplicate a node with **⌘D** or **⌥-drag**. Select several (Shift- or ⌘/Ctrl-click a node, or ⌘/Ctrl-drag the board to rectangle-select) and **⌘D** duplicates the set as one group: links between the copies stay between the copies, so a duplicated pattern → remesh → transform → drape is a chain of its own. Duplicating a drape brings the remesh / transform it hides along as copies too, so the new drape drapes the new pattern
- **Backspace / Delete** removes the selected node(s) — no confirmation, undo brings them back · **Esc** clears the selection
- Fullscreen a node (**⛶**); when wired, header **tabs** jump between Pattern / Remesh / Transform / Drape

### Pattern editor
- Move, and four rail menus: **Add** (pen, rectangle, circle, block library, SVG import), **Modify** (extrude, join, bridge), **Remove** (knife, dart) and **Sew** (segment, many-to-many), plus the ruler button — which puts either a **Ruler** or a **Measure line** in hand — and lengths in **cm or inches**
- Knife tools, under **Remove** → **Knife**: the mode is a row of toggles on the canvas ribbon at the top left, so it can be changed without leaving the cut — **Line** and **Circle** are drag cutters (**Line** from one end of the cut to the other, **Circle** from its centre out to its radius), **Inset** cuts a smaller copy of the panel under the pointer, sized by where the pointer is inside it, **Curve** cuts along a chain you click down, and **Loop** / **Loop straight** preview across the piece from any hovered outline, following the contours between it and the far side or taking the plain chord. Every end of a line and every click of a curve lands on a point or edge under the pointer when there is one, so cuts start on the corner they were aimed at
- **A cut can leave a hole**: a panel is its outline *and* any contours cut out of it, so an inset, or a circle dropped inside a panel, leaves a real opening — the cloth mesh has the hole in it, the hole's edge is an edge of the panel for measuring, seam allowance and sewing, and its points are editable like any others. The bar along the bottom of the viewport carries **Hole** (drop the piece that was cut out) and **Sew pieces** (sew it back into the opening it came from) for every knife that cuts one out, and **Sew pieces** for the cuts that leave two halves — which welds them back together along the cut
- Join fuses two pieces along picked edges into one, moving/bending/scaling the first onto the second
- Bridge closes the gap between two pieces — or between two runs of one piece — with new straight edges, leaving the outlines exactly where they are
- Simplify a picked run of points: live reduce/fit preview, seam ends protected
- **Seam allowance**: show the allowance line outside every piece — half an inch by default — and click an edge to give that one its own value, from the ribbon at the top left
- **View**: a typed viewport zoom with **Fit to pattern**, a **lock** that holds the zoom level while you pan, and **hicon projection** — outlines and their measurements in white, the allowance shown, over a grid at double opacity
- Soft snap, multi-select scale, avatar reference overlay, X-ray fill
- Seam bindings become sew constraints after remesh

### Mesh
- Remesh from the linked pattern (structured / Delaunay / centroidal settings in the inspector)

### Transform 3D
- Arrange pieces in space **before** simulating · pose feeds connected sims

### Sim (drape)
- **Play / Pause / Reset / Rebuild / Snapshot**
- Engines: **CPU mass-spring** or **GPU XPBD**
- Avatar body collision — the generated avatar (from **Avatars**), or the bundled reference body · optional SDF bake/cache under `refPpl/`
- **Strain** map toggle (blue compress · green rest · red stretch)
- **Freeze a piece** — right-click it and choose *Freeze piece*; it holds its current pose while the rest drapes and across rebuilds, with its seams still pulling. Right-click again to *Unfreeze piece*
- One active sim at a time; paused sims keep their pose

### Viewport shading (sim + transform)
- The **shading button** in the top-right of a 3D viewport (left of the rotation gnomon) cycles
  **Wireframe** (edges only, no fill, ground and floor hidden) → **Simple** (the plain lit fabric, no
  environment) →
  **PBR** (GGX + image-based lighting, tone mapped), and the caret beside it opens the panel.
- **HDRI background / light probe**: pick any file from `hdri/` (1024×512 `.exr`, decoded in the browser),
  or *None* for a built-in neutral studio gradient. Decoded values are clamped into the half-float range
  before upload — a night HDRI in `hdri/` peaks at 4.2e5, which is 6× what an `rgba16float` texture can
  hold, and storing it as Inf makes the hardware return NaN through every filtered lookup, which shows
  up as the model dissolving into black-and-white static. The chosen map lights the fabric and paints the
  background in PBR mode. The file is a latlong `texture_2d` to every reader: the background unwraps it
  around the camera as a sphere, and the light-probe cubemap is baked from the *same* unwrap once at
  load (`src/render/latlong.ts` holds the single copy of the mapping, and `latlong.test.ts` checks both
  readers against the hardware cube sampling so the probe can never end up lit from the opposite
  hemisphere to the sky you can see).
- In **PBR** the floor becomes a cylinder of the floor's own radius, 12 inches tall, coloured as the
  reference model 25 % darker, and the collision reference mesh (avatar body, or the demo's sphere
  collider) is lit with the same environment instead of the flat shader.
- **Background blur** 50 % by default, 0–100 %, picks a level from a mip chain built once when the
  HDRI loads and samples it through a trilinear filter, so the defocus is continuous rather than a
  handful of repeated ghost taps. One fetch per pixel and the light probe is untouched.
- **Exposure** 0.20×–4.00× scales the HDRI background *and* the PBR shading, keeping the scene and the
  environment on the same stop, plus a **Show background** toggle. Simple and Wireframe never draw the
  environment, so switching modes cannot change how the pattern tools read.
- **Materials** (collapsed section of the same panel): colour, roughness and metallic for the
  **reference model** and the **cloth**. The **pedestal** always takes the reference colour 25 %
  darker — its swatch is read-only — while its roughness/metallic are its own. Colours are stored
  linear (the colour picker converts), so what you pick is what the PBR shader uses.
- Materials live in a shared library that the renderer asks per surface (`forPiece(pieceId)`); every
  piece uses the cloth material today, which is the single seam a future materials node after Remesh
  will use to hand out per-piece materials and textures.
- **Tonemapping** (second collapsed section of the same panel): *Reinhard*, *Uncharted 2*, *ACES*
  (default) or *Lottes* — the four operators from `~/Documents/Dev/pbr-webgpu`, ported verbatim into
  `src/shaders/tonemapping.wgsl`. All four are compiled into the PBR and background shaders and picked
  by an index in the shading uniforms, so switching is a buffer write and a redraw — no pipeline
  rebuild, and the background and the fabric always agree. ACES is the fallback arm of the shader
  switch, so a stored value the shader does not know keeps the original look.
- The mode, HDRI, blur, exposure, tonemapping and materials persist per browser (`localStorage`) and
  apply to every 3D viewport; a new viewport opens in **PBR**, the app's default look, or in whatever
  mode you last chose.

### Split view (2D + 3D at once)
- Open any stage fullscreen and click the **split toggle** between the *Pattern* and *Remesh* chips: the pattern editor fills the left pane and a 3D stage the right.
- The **Remesh / Transform / Drape** chips pick which 3D stage the right pane shows (splitting from a 3D view keeps that view on the right); the pattern stays on the left.
- Editing the pattern tints the 3D viewport's border amber and raises a **“Pattern changed — the 3D build is out of date”** banner just above that viewport's action buttons, with a **Resync 3D** button that remeshes and rebuilds the transforms and sims.
- **Piece selection mirrors both ways**: pick a piece in either pane and it is picked in the other. Leaving split (toggle again, or clicking the *Pattern* chip) returns to the single-node fullscreen.

---

## Controls (studio)

| Action | Input |
| --- | --- |
| Pan board | Alt-drag empty canvas |
| Zoom board | ⌘/Ctrl + wheel |
| Undo / Redo | ⌘/Ctrl+Z · ⌘/Ctrl+Shift+Z |
| Select several nodes | Shift- or ⌘/Ctrl-click a node to add it (⌘/Ctrl-click it again to drop it) · ⌘/Ctrl-drag empty board to rectangle-select · click empty board or press Esc to clear |
| Duplicate node(s) | ⌘/Ctrl+D · or ⌥/Alt-drag — a group duplicated together keeps its links between the copies |
| Delete node(s) | Backspace / Delete (undo restores them) · or right-click → Delete, or the inspector's Delete button |
| Orbit 3D (sim / transform) | Drag empty space in the viewport |
| Move fabric | Drag the cloth (Play or paused) |
| Move points on one axis | Shift-drag a point/piece in the pattern editor |
| Select several panels | Move tool: ⌘-click (Ctrl on Windows/Linux) a panel to add it (⌘-click it again to drop it), or ⌘-drag a rectangle — the ⌘ rectangle takes whole panels it touches and never single points, so a plain drag still picks points and a Shift-drag still adds points |
| Add tools | **Add** (+) in the tool rail: the menu opens beside the rail with **Pen**, **Rectangle**, **Circle**, **Block…** and **Import SVG…** — **Block…** swaps the same menu over to the block library, with **‹ Add** to come back; **Import SVG…** opens the file picker and leaves the tool in hand alone |
| Set the zoom | **Zoom** in the tool rail, just above the seam allowance button: type a percent of the editor's default framing, or nudge it 1% at a time with − / + · **Fit to pattern** frames the work |
| Lock the zoom | **Lock zoom**, inside the zoom popover: the wheel and the zoom controls leave the level alone, so panning cannot drift it. The readout and the rail button keep showing where it is locked; the same row unlocks it |
| Hicon projection | **Hicon projection** in the tool rail, just above **Seam allowance**: the pattern as a line drawing — no fill, white outlines and their measurements, the allowance shown, and the grid at double opacity. Seams, points, handles and grain are put away while it is on, but pieces can still be picked and dragged |
| Seam allowance view | **Seam allowance** in the tool rail, just above **Seam links**. With it on, every piece draws the line its allowance makes — dashed, in teal, outside the seam line |
| Measure the pattern | **Ruler & measure** in the tool rail → **Measure line**. Click points and edges to add them to the measurement in hand — points chain in the order picked (two give the distance between them, a third carries the walk on) and each edge adds its own arc length, so a run of edges sums to one value. Drag on empty canvas instead to draw a line across the work: where it crosses a piece outline a **measure point** is added, and the stretch inside each piece is measured, so a line across two panels reads both and not the gap between them |
| Read a measurement | The readout shows the total and what it is made of ("2 spans + 1 edge"). Hover it and everything it reads lights up — the edges, the points, and the measure points on them. Drag the readout anywhere you want it; a dashed leader ties it back to its work |
| Total several measurements | With **Measure line** in hand, **Shift-click** readouts to gather them: the bar names how many and their running total, and **Sum** adds one measurement reading the lot. Everything gathered is left as it was |
| Remove a measurement | Right-click its readout (⌘/Ctrl+Z brings it back). **Delete** in the measure bar throws away the measurement being built |
| Set a seam allowance | With the allowance shown and the Move tool in hand, hover an edge to light it up and click it: the ribbon at the top left shows the picked edge (in the canvas' unit) and the piece's allowance. **Piece** covers every edge without a setting of its own, **Edge** is just this one (grey while it follows the piece), **All edges** spreads this edge's value over the piece, **Use piece** drops this edge's own value. ⌘/Ctrl is left free, so ⌘-click still drops a point on the edge |
| Insert a point on an edge | Move tool: ⌘-click (Ctrl on Windows/Linux) the edge — the point lands under the pointer and can be dragged on from there. The same modifier on a panel, away from its edges, picks the panel instead |
| Add a point | Add (+) → Pen: click a piece's outline (or anywhere inside a closed panel) — the point lands on the piece you clicked |
| Draw a panel | Add (+) → Pen: click empty canvas to start, keep clicking to add points, click the first point to close |
| Extrude an edge | **Modify** → **Extrude edge…**: drag away from any edge — the outline grows a parallel copy of it, joined back by two edges (hold Shift to lock the drag to an axis) |
| Knife tool | **Remove** → **Knife**: the knife comes up with the canvas ribbon showing its modes — click one to change knife mid-cut |
| Line cut | **Line**: drag from one end of the cut to the other; the panel the drag runs through is the one it cuts, and either end snaps to a point or edge under the pointer · Shift locks the angle (and then keeps the end where you released it) |
| Circle cut | **Circle**: press where the centre goes, drag out to the radius, release to cut · Shift quantises the radius to half a centimetre |
| Inset | **Inset** on the knife ribbon: hover inside a panel — the loop is a smaller copy of that panel and follows the pointer, so the bar reads the size it keeps and how far in that runs — and click to cut it out · a round panel gives a smaller round loop, a 2:1 panel gives a smaller 2:1 panel · **Hole** leaves the opening empty, **Sew pieces** sews the cut-out back into it, neither leaves the cut-out lying in the opening |
| Cut a hole with a circle | **Circle**: drag a circle that lies wholly inside a panel and it is cut *out* of the panel rather than refused — the same cut-out as an inset, with the same **Hole** / **Sew pieces** toggles. A circle that crosses the outline is still a cut in two |
| Curve knife | **Curve** on the knife ribbon: click points down along the cut, adjust **Fit** / **Sew pieces** in the bar at the bottom of the viewport, then **Done** (or Enter) · **Cancel** / Esc / right-click throws it away |
| Loop cut | **Loop** or **Loop straight** on the knife ribbon: hover a piece's outline, the cut previews square to the edge under the pointer, click to cut |
| Simplify points | Pick a run of points (Shift-click, or right-click the piece for all of them) → right-click → **Simplify points (n)**; then Reduce / Fit in the bar at the bottom of the viewport, **Done** or **Cancel** |
| Join two pieces | **Modify** → **Join…**: click the edges to fuse — the first piece picked moves onto the second — then **Fuse pieces** (or Enter) in the bar at the bottom of the viewport · **Swap sides** makes the other piece the one that moves · **Cancel** / Esc throws the picks away, and **Cancel** only comes alive once something has been picked |
| Join settings (tool settings popover) | **Modify** → **Join…** puts the join's settings in the popover at the top left of the canvas: **1:1** or **Many : many** edges, and **Move & scale** (the default) or **Warp**. **Move & scale** moves, turns and rescales the whole piece and leaves its outline alone, so the picked edges match only as well as their shapes allow: if the worst of them sits within the **Tolerance** (cm), the fuse goes ahead and whatever the two chains leave between them is filled in, the way a bridge fills between two runs; if it does not, the bar says how far apart they would have sat. **Warp** bends, stretches and turns the moving piece until its edges lie exactly on the other's, and has nothing left to fill |
| Join a run of edges (many to many) | **Modify** → **Join…** → **Many : many** in the tool settings: pick as many edges as you like on the piece that moves, then **Confirm edges →** (or Enter) and pick the run they fuse onto · two edges onto three, one onto four, whatever the seams are · along a boundary the two pieces share, where a click cannot say which piece it means, a click counts for the side being worked on — the moving piece's before **Confirm edges →**, the second piece's after · the button turns round to **← First side** once the picking has crossed over, so more edges can be added to either side without starting again |
| Bridge two pieces | **Modify** → **Bridge…**: click an edge on each piece — neither piece moves — then **Bridge pieces** (or Enter) in the bar at the bottom of the viewport · **Cancel** / Esc throws the picks away |
| Bridge a bay within one piece | **Modify** → **Bridge…**: click an edge on one side of a bay or notch and the edge across it — both on the same piece — then **Bridge pieces** (or Enter): the bay is filled and closed off with one straight edge, and the walls and the far side of it go interior |
| Bridge a run of edges (many to many) | **Modify** → **Bridge…** → **Edge runs (many)**: pick as many edges as you like on the first piece, then **Confirm edges →** (or Enter) and pick the run they bridge to · the button turns round to **← First side** once the picking has crossed over · a click on a boundary the two pieces share counts for the side being worked on, exactly as it does for a join |
| Split 2D + 3D | Split toggle between the Pattern and Remesh chips (fullscreen) |
| Aim a seam's direction | **Sew** → **Segment sewing** / **Many-to-many**: hover/click the half of the edge to read from (2D + 3D) |
| Preview the stitches | With one edge picked, hover a partner (2D + 3D) — dashed lines show the pairing |
| Reverse / delete a seam | Right-click a sewn edge (Sew edges on) → popover |
| Freeze / unfreeze a piece | Right-click the piece in the Sim viewport |
| Change shading (wireframe / simple / PBR) | Shading button, top-right of any 3D viewport |
| Pick an HDRI / blur it / set exposure / pick a tonemapper | Shading panel (caret next to the shading button) |
| Set material colour / roughness / metallic | Shading panel → Materials |
| Exit fullscreen | Esc or ✕ |

Pattern viewport: ⌘/Ctrl-wheel (or a plain wheel, or a trackpad scroll) zooms the pattern, the **Zoom** button types an exact percent of the default framing (or steps it 1% at a time), and **Fit to pattern** frames the work; Alt-drag pans inside the editor. **Lock zoom**, in the zoom popover, holds the level where it is — the wheel and the zoom controls stop moving it, while panning stays free.

The knife's modes, in detail: they are toggles on the canvas ribbon at the top left, not rows in the rail menu, because the mode *is* the knife's setting and changing it is something you do while looking at the piece you are about to cut. **Remove** → **Knife** puts the knife in hand in whatever mode the ribbon is set to, and the row that opened it names that mode; the rail's own tip carries it too ("Remove · Knife · Loop cut, straight across"). Switching modes mid-session drops any draft in hand — a half-clicked chain belongs to the knife that was drawing it.

The drag cutters, in detail: **Line** and **Circle** each work with a press and a release, and both take their aim from the outline. A line cut runs from where the press landed to where it was released; either end that lands near an outline point or edge is taken from there, so a cut can be run from corner to corner without the end sitting a few pixels off the corner you clicked. Shift locks the angle instead, and then the end is the release point: the preview shows which of the two the cut is going to do. The panel a line cut is for is the one the drag itself runs through — the panel between the press and the pointer, measured by how much of the drag lies inside it — and never one the line's own direction happens to reach *behind* the press, so a cut drawn away from a panel leaves that panel alone however squarely it is pointed at. Within its panel the cut is the whole line through the two points, reaching the outline on both sides — which is what the drawn preview shows, and how a cut started in the middle of a panel still runs edge to edge. A circle is set down where the press lands and sized by the drag — the centre stays on the spot it was placed at however far the rim is dragged out, and Shift quantises the radius to half a centimetre — and the release cuts. What it cuts along is the part of the rim *inside* the panel: a circle dropped over an edge trims an arc out of that edge, and one taking a bite out of an edge is cut around its long way, the side that stays in the panel. So a circle whose centre sits outside the panel is not a circle that misses it: the rim crossing the edge is the cut. A circle lying wholly *inside* the panel is cut out of it — an opening in the panel with the disc that came out of it as a piece of its own, which is what the **Hole** and **Sew pieces** toggles are for; one lying wholly *outside* it crosses the outline nowhere and separates nothing, and is refused rather than left in two. Two crossings on one edge — a shallow arc trimmed from a straight edge, an edge bowed out and back — cut as readily as any other, both cut points landing on the outline exactly where the preview drew them.

The inset and the hole, in detail: **Inset** cuts along a *smaller copy* of the panel under the pointer — the same shape, scaled down about the panel's own centre of area, which is the difference that makes an inset read as an inset rather than as a line held a fixed distance from the edge. A uniform offset cannot help changing the proportions: take 2 cm off every side of a 40 × 20 panel and what is left is 36 × 16, no longer that panel's shape at all, and off a bend that tightens the line goes wrong relative to its neighbours. A scaled copy keeps every proportion and every ratio of curvature exactly — a round panel gives a round loop to well under a hundredth of a millimetre, a 2:1 panel gives a smaller 2:1 panel, and a shaped edge keeps its shape — so the loop always looks like the piece it was cut from, a little way inside it. It is exact rather than near, too: scaling a cubic's anchors and handles about a point scales the whole curve about that point, so nothing is approximated and nothing drifts as the loop gets smaller.

The pointer sets the size: the loop is drawn through the point you are hovering, so pushing the pointer in from the edge shrinks the copy and pulling it back out grows it, the way you would size a facing by eye. The bar reads both numbers that matter — the size the copy keeps, as a percentage of the panel, and how far inside the edge it runs at its tightest, which is the depth you would cut a facing to; Shift quantises the size to a whole percent so the same loop can be asked for twice. A loop with no room for it is simply not offered: not inside the panel at all, right on its edge where the copy would be the panel itself, or so deep that the copy would run through a hole already cut in the piece — and the bar keeps saying where to hover.

Cutting a loop out of a panel leaves two things, and what becomes of the second is the toggles in the cut bar. The panel keeps every point it had and gains the loop as a **hole**: its cloth is now the panel less what was cut out, the mesh leaves the opening empty — a drape hangs around it, not across it — and the loop's own edges belong to the panel, so they are measured, allowed for and sewn like any other edge, and its points are edited like any other points. The piece that came out of the hole is a piece in its own right: left lying in the opening by default, sewn back into it all the way round by **Sew pieces** (which is how a lining, a facing or a bound opening is drafted), or dropped altogether by **Hole**, which leaves the opening as a hole and nothing else. The same cut, and the same two toggles, come with a circle dragged inside a panel — the gesture for punching a hole — and **Sew pieces** on a cut that leaves two *halves* rather than a loop welds them back together along the cut, which is how a piece is cut for drafting while the cloth stays whole. A panel that already has a hole is not something the knife will cut again, or fuse or bridge: those all work from a single closed outline, and the bar says so rather than quietly handing back a piece with its hole lost. Cut first, then punch.

Curve knife, in detail: click points down the way the pen draws them, and the chain through them is the cut. The panel it cuts is the one the chain is *drawn through* — the one it spends most of itself inside — so a cut never takes a panel beyond the end of the chain, or before its beginning, however the ends are carried on. Each end is carried out to that panel's outline along the direction the chain was going, drawn faintly and stopping at the edge, so a cut started in the middle still runs edge to edge instead of refusing to leave the inside; clicks that land near a point or an edge snap onto it, so a cut can be started exactly on a corner. **Fit** decides how the clicks are joined: **Smooth** bends through them, each point carrying one tangent read from its neighbours, and **Straight** joins them with plain edges. The bar names the panel the cut will take and how it will leave it — "Cuts Front panel A in two", "The cut has to cross … twice" — and **Done** is only offered when the cut really does cross the outline twice with panel left on both sides. **Sew split** welds the two halves back together along the cut: the cut's own edges are sewn to each other, so a piece can be divided for drafting — grainlines, seam allowance, a panel that is really two — while the cloth stays whole on the stand. Done commits as one undo step; Cancel, Escape or a right-click throws the draft away. ⌘/Ctrl+Z puts a cut back.

Join, in detail: pick the edges to fuse — one edge each, or whole runs with **Many : many** in the tool settings — and the first piece picked is brought onto the second: **Move & scale**, the default, moves, turns and rescales the whole piece until its edges match the other's within the **Tolerance**, filling whatever is left between the two chains the way a bridge fills between two runs, and **Warp** bends, stretches and turns it until the edges lie exactly on the other's. Many mode is many-to-many: each side takes a run of whole edges, the runs need not have the same number of edges or the same lengths, and each run is read off the outline in the order it was picked; **Confirm edges →** (or Enter) hands the picking over to the second piece — the button then reads **← First side** and hands it back, so either run can still be added to — which decides where a click on a *shared* boundary — two pieces laid along the same edge, or the two halves a knife left behind — belongs: before the hand-over such a click is the moving piece's, so a run along the shared edge can be picked, and after it the click is the second piece's. Warp's deform is a ribbon map: every point of the moving piece keeps its distance *along* its picked edges (as a share of their length) and its perpendicular offset, so the picked edges land exactly on the other piece's, the piece stretches along them by the ratio of their lengths, and the rest follows and bends with them. Points and handles both move, so a curve drawn into the moving piece keeps its shape and picks up the other piece's contour. Which way round the two chains meet is not asked of you: there are only two ways two outlines can share one boundary, and the one whose fused outline holds both pieces' area and keeps the moved piece whole is the one taken. Edges of the moving piece that had been sewn keep their seams — they are read at the point they became after the fuse — and so do seams on the second piece; seams along the two fused chains belonged to edges that no longer exist and go with them. A run that turns a corner harder than the piece is deep cannot be brought round without folding, and a fold is not a fuse: the bar says so and refuses ("pick a shorter run, or one that turns the same way") rather than hand back an outline the two pieces have been mangled into. The bar says what the fuse would do — which piece moves onto which, and *why not* when it cannot ("Those edges are not next to each other", "That join would fold the pieces onto each other") — and the outline it would make is ghosted in the viewport before anything is committed. **Fuse pieces** commits it as one undo step: the two pieces become one, keeping the second piece's name, and ⌘/Ctrl+Z puts them back.

Bridge, in detail: both runs may be on one piece, which is how a bay or a notch is filled: the two runs leave two arcs of its outline between them, a single straight edge is drawn across one of them, and the other arc goes interior with the runs, so the piece grows to hold what lay between them. Which arc that is depends on which way the runs face each other, so both are tried and the one that leaves the piece *bigger* than it was is the fill — the other is always just a cut-off piece of the outline, never a fill — and runs with no bay between them (a panel's bottom edge and its top edge, say) are refused with the reason. A bridge is otherwise a fuse where nothing moves. Pick the edges to span — one edge each with **Bridge · One edge each**, or whole runs with **Bridge · Edge runs (many)**, picked side at a time with **Confirm edges →** just as a join is — and the two picked runs are closed by a straight edge at each end, so the area in between becomes part of one piece with them. Every anchor and handle of both outlines comes through unchanged, and at the four joints the handles that used to run along the picked edges are squared off, because a bridge is a straight line where those edges were; the picked edges themselves are interior now and drop out of the outline. Which of the two runs meets which end of the other is not asked of you: as with a fuse there are only two ways round, both are tried, and the one whose outline does not cross itself is taken, whichever way the second piece happens to be wound. Bridging the two halves a knife left gives the panel they were cut from, with the joints that landed on the same spot folded into single vertices — seams that named them are read at the point they became. A bridge between runs that face away from each other, or to a piece that is already on top of another, would have to double the outline back on itself, and is refused with the reason rather than handed over as a shape nothing can be cut from ("That bridge would cross itself — pick runs that face each other"). The outline it would make is ghosted in the viewport first, and **Bridge pieces** commits it as one undo step, keeping the second piece's name; ⌘/Ctrl+Z puts both pieces back.

Loop cut, in detail: the cut enters square to the edge under the pointer and crosses the piece. **Loop (follow)** — the default — holds the pointer's own share of the way between the piece's two contours as it steps across, so a panel with parallel sides cuts straight, one whose sides curve together bends with them, and a tapering panel gets an evenly spaced cut. The walls it measures that share against are the contours *the cut runs between* — the ones roughly parallel to it — read at each step around where the cut already is, so a cut cannot be dragged outwards along the edge it is about to end on, or around a corner to a wall it should never have seen. It ends where it meets the boundary, which is usually the far side of the piece but not always: across a panel that tapers away, the cut is still on the panel after the edge normal has left it, and the trace follows it out to the edge it actually reaches. Slides sideways are capped and the traced line is faired, which keeps corners and notches in the outline as turns rather than spikes. **Loop (straight)** takes the plain chord. Either way the result is an ordinary cut: the piece splits, its seams remap, and ⌘/Ctrl+Z puts it back.

Undo / Redo restores the document only — views never move: 3D camera, 2D pattern zoom/pan, and the board's own pan/zoom all stay put.

Seam allowance, in detail: it is the fabric left *outside* the seam line, so it is drawn as its own dashed line and never touches the pattern's geometry — the mesh, the sewing and the drape all stay on the seam line, and editing an allowance does not make the 3D build stale. A piece carries one allowance for all of its edges and any number of per-edge overrides; the standard half inch (1.27 cm) is what an untouched piece uses, so nothing is written into the document until you actually change something. Overrides are keyed by the id of the point an edge starts at, which is the edge's identity, so they survive inserts and deletes elsewhere on the piece, travel with a piece that is duplicated or mirrored, and are kept when a drafted block regenerates its outline (its ids come back the same every time). The line itself is a mitred offset of every edge by its own value, which is why a change of allowance at a corner reads as a step: the edge with no allowance sits on the seam line, and the outline steps out to meet the rest. Smaller values shrink it, 0 puts it back on the seam line, and 10 cm is the ceiling.

Measuring, in detail: the rail's ruler button carries two tools, because they answer different questions — a **Ruler** is a real rule laid over the work, its length a *person's* body measurement, while a **Measure line** reads the pattern itself. A measurement is a list of things to read, and its value is their sum: an edge contributes its arc length, and two points contribute the distance between them, so picking three edges gives you the run's total and picking two points gives you the gap. Points chain in the order you pick them, which means a third pick carries the walk on rather than starting again, and a pick waiting for a partner is held as a session pick — a measurement never contains half a span. Overlaying a run of edges and reading one number is what the hover highlight is for: the value says how much, the highlight says of what.

Totalling measurements, in detail: **Shift-click** readouts with the measure tool in hand to gather them. The bar then says how many and what they come to, and **Sum** adds one more measurement that reads all of their items — so the total is the number you would get by adding the readouts up, and it stays live against the pattern because the items name pieces and edges rather than coordinates. The gathered measurements are left exactly as they are: the sum is a fourth measurement beside them, drawn with its parts dimmed and its readout tagged "sum of 3", which can be moved, hovered and deleted like any other. It copies their items rather than pointing at them, so a later pick added to one of the parts does not follow through into the total — re-gather and sum again for that.

The measure line, in detail: dragging across the work is left-to-right on a technical drawing, but here it cuts the piece wherever you draw it. Every place the line crosses an outline becomes a measure point, and what is measured is the stretch of the line that lies *inside* a piece — entry to exit. That is why a line drawn right across a panel reads its width along that diagonal, why one drawn across two panels reads both of them and adds them, and why the empty canvas *between* pieces is measured by neither: only the work is measured, never the space around it. A line that misses the work, or only grazes one edge, makes nothing at all, and one that starts inside a piece has entered before the drag began, so the first crossing it meets is the way out and that piece contributes nothing (start outside to read it). A measure point is **not a control point**: it is stored as a fraction along the edge it landed on, and resolved through the piece every time it is drawn or measured. That is what makes it ride the outline — drag an edge's points around and the measure point stays at the same share of the way along it, so one placed in the middle of an edge is still in the middle of the reshaped edge, and it moves not at all when a *different* edge is edited. It costs nothing to remove for the same reason: deleting a measurement leaves the piece exactly as it was. The one thing it cannot survive is its edge being split in two, because the edge it named is gone; the measurement then says it is incomplete rather than reading a number that is no longer true. Like rulers, measurements are drafting references — they round-trip with the project and never leave a mesh stale.

Simplify points, in detail: hand-drawn curves arrive with dozens of anchors where the shape needs five, and a piece you have to edit point by point is easier to work with after they are thinned. Pick a run of points and the reduction is previewed live in the viewport — the outline really is rewritten as **Reduce** moves, so you are looking at the piece, not a sketch of it — and the bar says how many points are left ("24 → 9 points"), counting runs when the picks were not all in one stretch. **Reduce** is a share of the picked points: 0% keeps them all, 100% keeps the two that end the run (fewer, if the shape is simple enough to collapse). **Fit** decides what happens between the survivors: **Corner** draws straight edges; **Smooth** keeps the tangent the outline was drawn with at each survivor, reaching a third of the way to the next one, so a curve drawn through the run stays a curve and a corner stays a corner instead of being rounded off — the default matches what the run already was. **Done** commits it as one undo step; **Cancel**, Escape, or any fresh gesture on the canvas puts the points back. Nothing outside the run moves — not the neighbouring anchors, and not their handles, which belong to the edge before the run. Seam and dart ends are held onto whatever the reduction is asked for: a seam is an *edge* between two points, so dropping one of its ends would leave the stitching pointing at an outline that no longer has that edge.

---

## Project layout

```
src/
  app/           Studio shell (canvas, inspector, projects, undo)
  pattern/       2D pattern editor + geometry
  mesh/          Triangulation, OBJ/avatar, SDF bake
  sim/           Cloth engines (CPU + GPU XPBD), gizmos, viewports
  project/       Document model, library, undo stack
  shaders/       Cloth + floor WGSL
  styles/        studio.css
docs/PRD.md      Product requirements
refPpl/          Default avatar / SDF cache assets
demo.html        Legacy cloth demo
```

---

## Scripts

```bash
npm run dev       # Vite dev server
npm run build     # tsc + production build
npm run preview   # preview the build
```

---

## Notes

- Canonical units are **centimeters**; the **Units** button on the toolbar opens a popover to switch the display to inches. The change is document data, so every canvas follows it and the project file records it.
- The studio toolbar is icons only: **New**, **Projects**, project name, **Undo / Redo**, **Avatars** (the person icon), **Units**. Each carries its label as a tooltip. Nodes are added from the canvas — right-click empty board.
- A boarded node draws its title and **⛶** over the top of its own viewport rather than in a bar above it, so the preview gets the whole rectangle. The strip between them is transparent: dragging a node on the board is done by its title chip, and a gesture in that top band still reaches the viewport underneath. Text notes keep their bar.
- Loading a **custom avatar model** (your own OBJ / SDF) is off the toolbar for now; avatars come from **Avatars** (measurements → generated model).
- Type is **IBM Plex Sans** throughout, with **IBM Plex Mono** for anything read as a number, a code or a key; both are pulled from Google Fonts in [`index.html`](index.html).
- Rebuild the mesh (and sim) after pattern or sew changes so topology stays in sync.
- Avatar SDF baking can write into `refPpl/` via the Vite dev API so you don’t rebake every session.

Legacy WebGPU cloth demos and GIFs from the earlier drop/wind playground remain available via [`demo.html`](demo.html).
