/**
 * The `bpy` script shipped inside the Blender pack.
 *
 * It has to run unedited in Blender 3.6 and 4.x, so every setting is fetched and
 * bounded rather than assumed: the cloth and collision RNA moved between those
 * releases (the OBJ importer's operator name and argument names changed in 4.0,
 * and cloth sewing lost its vertex group in favour of open edges). Where a knob
 * has no counterpart in hyperPattern the script says so in its comments instead
 * of inventing a value.
 */
export const BLENDER_IMPORT_PY = `"""Import a hyperPattern drape into Blender as a cloth setup.

Run this from Blender (Scripting > Open, then Run Script). It reads the two OBJs
and seams.json that sit next to it and builds:

  * the garment as one mesh, pieces kept separate (their seam rows are open
    edges, which is what Blender's sewing springs work from),
  * a Cloth modifier with sewing on, the gathered row set to shrink, and the
    studio's frozen pieces as a pin group,
  * the body as a collision object,
  * the scene in metres, ready for Play and then Bake.

Nothing here is a port of hyperPattern's solver: Blender's cloth is a different
model (angular bending, proximity sewing, no velocity clamp), so treat the
settings as a starting point for taste, not as a reproduction.
"""

import json
import os

import bpy


HERE = os.path.dirname(os.path.abspath(__file__))
PACK = os.path.join(HERE, "seams.json")


def log(msg):
    print("[hyperpattern] " + msg)


def clamp(value, low, high):
    return max(low, min(high, value))


def import_obj(path):
    """OBJ import, which moved from import_scene.obj to wm.obj_import in 4.0."""
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "obj_import"):
        bpy.ops.wm.obj_import(filepath=path, forward_axis="NEGATIVE_Z", up_axis="Y")
    else:
        bpy.ops.import_scene.obj(filepath=path, axis_forward="-Z", axis_up="Y")
    added = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in added if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("no mesh came out of " + path)
    # One object per file: if the OBJ split into several, join them.
    if len(meshes) > 1:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in meshes:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
    return meshes[0]


def set_if(obj, attr, value):
    """Set a property only when this Blender knows it."""
    if hasattr(obj, attr):
        try:
            setattr(obj, attr, value)
            return True
        except (TypeError, ValueError) as err:
            log("could not set %s=%r (%s)" % (attr, value, err))
    return False


def vertex_group(obj, name):
    group = obj.vertex_groups.get(name)
    if group is None:
        group = obj.vertex_groups.new(name=name)
    return group


def assign(group, indices, weight):
    for index in indices:
        group.add([index], weight, "REPLACE")


def main():
    with open(PACK, "r", encoding="utf-8") as handle:
        data = json.load(handle)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    cloth = import_obj(os.path.join(HERE, data["cloth"]["object"]))
    cloth.name = "hyperpattern_cloth"
    cloth.data.name = "hyperpattern_cloth"

    collider = import_obj(os.path.join(HERE, data["collider"]["object"]))
    collider.name = "hyperpattern_body"
    collider.data.name = "hyperpattern_body"

    # --- gathered rows become shrink, which is the closest Blender has to the
    # studio's crowd floor (a row allowed to compress along the seam).
    gather = {}
    for seam in data["seams"]:
        for side, key in (("i", "gatherI"), ("j", "gatherJ")):
            ratio = seam.get(key)
            if ratio is None or ratio >= 1.0:
                continue
            weight = clamp(1.0 - ratio, 0.0, 1.0)
            index = seam[side]
            gather[index] = max(gather.get(index, 0.0), weight)

    shrink_max = max(gather.values()) if gather else 0.0
    if gather:
        assign(vertex_group(cloth, "hyperpattern_gather"), list(gather.keys()), 1.0)
        group = cloth.vertex_groups["hyperpattern_gather"]
        # Per-vertex weight, so a partly gathered row shrinks partly.
        for index, weight in gather.items():
            group.add([index], weight, "REPLACE")

    pins = data.get("pins") or []
    if pins:
        assign(vertex_group(cloth, "hyperpattern_pins"), pins, 1.0)

    # --- cloth
    for modifier in list(cloth.modifiers):
        if modifier.type == "CLOTH":
            cloth.modifiers.remove(modifier)
    mod = cloth.modifiers.new(name="Cloth", type="CLOTH")
    settings = mod.settings
    fabric = data["fabric"]

    set_if(settings, "quality", int(clamp(fabric["quality"], 1, 20)))
    set_if(settings, "mass", fabric["vertexMassKg"])
    set_if(settings, "air_damping", fabric["airDamping"])
    set_if(settings, "tension_stiffness", fabric["tensionStiffness"])
    set_if(settings, "tension_damping", 5.0)
    set_if(settings, "compression_stiffness", fabric["compressionStiffness"])
    set_if(settings, "shear_stiffness", fabric["shearStiffness"])
    set_if(settings, "bending_stiffness", fabric["bendingStiffness"])
    set_if(settings, "bending_damping", 0.5)
    set_if(settings, "use_sewing_springs", True)
    set_if(settings, "sewing_force_max", fabric["sewingForceMax"])
    if gather:
        set_if(settings, "vertex_group_shrink", "hyperpattern_gather")
        set_if(settings, "shrink_min", 0.0)
        set_if(settings, "shrink_max", shrink_max)
    if pins:
        set_if(settings, "vertex_group_mass", "hyperpattern_pins")
        set_if(settings, "pin_stiffness", 1.0)

    # Collision settings live on the modifier in 5.x and on its settings in 4.x.
    collision = getattr(mod, "collision_settings", None) or getattr(
        settings, "collision_settings", None
    )
    if collision is not None:
        set_if(collision, "use_collision", True)
        set_if(collision, "collision_quality", 4)
        set_if(collision, "distance_min", data["collider"]["distanceMetres"])
        set_if(collision, "use_self_collision", True)
        set_if(collision, "self_distance_min", data["collider"]["selfDistanceMetres"])
        set_if(collision, "self_friction", fabric["friction"])
        set_if(collision, "friction", fabric["friction"])
        # 5.x has the clamp as a distance (0 = off); 4.x keeps a separate switch.
        set_if(collision, "impulse_clamp", 0.5)
        set_if(collision, "self_impulse_clamp", 0.5)
        set_if(collision, "use_impulse_clamp", True)

    # --- body
    for modifier in list(collider.modifiers):
        if modifier.type == "COLLISION":
            collider.modifiers.remove(modifier)
    body = collider.modifiers.new(name="Collision", type="COLLISION")
    margin = data["collider"]["distanceMetres"]
    set_if(body.settings, "use", True)
    # 5.x names the gap "thickness_outer"; 4.x called it "distance".
    if not set_if(body.settings, "thickness_outer", margin):
        set_if(body.settings, "distance", margin)
    set_if(body.settings, "damping", 0.5)
    set_if(body.settings, "cloth_friction", data["fabric"]["friction"] * 5.0)

    # --- leave the cloth selected, at frame 1, so Play does something sensible.
    bpy.ops.object.select_all(action="DESELECT")
    cloth.select_set(True)
    bpy.context.view_layer.objects.active = cloth
    scene.frame_set(scene.frame_start)

    log("cloth: %d verts, %d tris" % (len(cloth.data.vertices), len(cloth.data.polygons)))
    log("seams: %d pairs, pins: %d" % (len(data["seams"]), len(pins)))
    if gather:
        log("gathered rows: %d vertices (shrink up to %.2f)" % (len(gather), shrink_max))
    log("sewing uses open edges: keep the pieces separate, do not merge by distance")
    log("press Play, then Bake (Cloth > Cache) when the drape looks right")
    return 0


# No sys.exit here: inside Blender that would take the whole application down
# with it, and a script that has already built the scene is a success.
if __name__ == "__main__":
    main()
`;
