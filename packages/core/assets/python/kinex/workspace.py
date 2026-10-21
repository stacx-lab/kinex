"""Optional world geometry. Bounds queries are explicit, never motion gates.

All points are in world coordinates (metres). A mobile base can have its own
root; tools working in that root need no world profile.
"""

from kinex import fail, profile
from kinex.geometry import apply_rt, invert_rt, mount_to_rt

_worlds = {}


def _load(name="world"):
    if name not in _worlds:
        try:
            _worlds[name] = profile(name)
        except RuntimeError:
            _worlds[name] = False
    world = _worlds[name]
    if world is False:
        return {}
    if world.get("type") != "world":
        fail(f'device "{name}" must have type world')
    return world


def bounds():
    """Declared AABB, None when absent; null sides are open."""
    value = _load().get("bounds")
    if value == "???":
        fail("profile:world bounds are unknown")
    return value


def contains(point):
    """Membership of the declared box, or None when no box is declared."""
    box = bounds()
    if box is None:
        return None
    return all((low is None or point[i] >= low) and (high is None or point[i] <= high)
               for i, (low, high) in enumerate(zip(box["min"], box["max"])))


def clamp(point):
    """Explicitly project a point into the declared box; requires a box."""
    box = bounds()
    if box is None:
        fail("no world bounds declared for clamp")
    lower = [max(low, value) if low is not None else value for value, low in zip(point, box["min"])]
    return [min(high, value) if high is not None else value for value, high in zip(lower, box["max"])]


def surfaces(world="world"):
    return _load(world).get("surfaces") or []


def surface(name, world="world"):
    for item in surfaces(world):
        if item["name"] == name:
            return item
    fail(f'no surface "{name}" on the world device')


def _inside_polygon(point, vertices):
    x, y = point
    crossings = []
    for a, b in zip(vertices, vertices[1:] + vertices[:1]):
        cross = (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0])
        if abs(cross) < 1e-9 and min(a[0], b[0]) - 1e-9 <= x <= max(a[0], b[0]) + 1e-9 and min(a[1], b[1]) - 1e-9 <= y <= max(a[1], b[1]) + 1e-9:
            return True
        if (a[1] > y) != (b[1] > y):
            crossings.append(x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]))
    return sum(crossings) % 2 == 1


def intersect_surface(item, origin, direction):
    """Ray parameter for a posed surface; reject unknown/outside geometry.

    direction need not be unit length: camera Z-depth is preserved.
    """
    if item["pose"] == "???" or item["extent"] == "???":
        fail(f'surface "{item["name"]}" geometry is unknown')
    transform = invert_rt(mount_to_rt(item["pose"]))
    local = apply_rt(transform, origin)
    rotation = transform[0]
    ray = [sum(rotation[i][j] * direction[j] for j in range(3)) for i in range(3)]
    if abs(ray[2]) < 1e-9:
        fail("pixel ray is parallel to the support surface")
    distance = -local[2] / ray[2]
    if distance <= 0:
        fail("support surface is behind the camera")
    xy = [local[i] + distance * ray[i] for i in range(2)]
    extent = item["extent"]
    if extent["shape"] == "rectangle" and any(abs(xy[i]) > extent["size_m"][i] / 2 + 1e-9 for i in range(2)):
        fail("pixel ray lies outside the support surface extent")
    if extent["shape"] == "polygon" and not _inside_polygon(xy, extent["vertices_m"]):
        fail("pixel ray lies outside the support surface extent")
    return distance
