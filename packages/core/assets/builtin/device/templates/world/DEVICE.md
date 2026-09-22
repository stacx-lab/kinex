---
name: world
type: world
description: Optional spatial reference with declared bounds and posed support surfaces. No driver or control dependency.
---

## Use

Optional spatial reference data, with no driver, access or extrinsics. Read its profile for bounds and surfaces; do not call device read. World is not necessarily the unique root: a mobile base or disconnected frame tree may be a root.

bounds is a world-coordinate AABB in metres; null means no declared bounds, ??? means unknown, and null sides are open. surfaces have their own pose in world and rectangle/polygon/unbounded extent. Do not infer a support surface from the AABB, or physical environment bounds from joint reach.

Geometry is informational and queried explicitly by perception/planning tools. It does not automatically constrain servo motion or gate task readiness. Use only relationships present in the frame graph.

## Setup

Register this device as `world` when the workspace needs world-referenced spatial
information. A mobile base can be an independent root; other devices need no
transform to world for operations within their connected frame graph.

Copy the starter profile below and fill only known geometry. Use `source`, the enumerated
`method`, and `calibrated_at` for provenance. Missing measurements use `???`;
`bounds: null` and `surfaces: []` are valid complete declarations. There is no
access section, driver, or extrinsics section. Load/unload/status require no
process; load/unload only change the inventory activation flag and ping is a no-op.

Bounds are an optional AABB expressed in world coordinates. Preserve measured
coordinates and their reference frame. Do not substitute a URDF reach estimate
for measured environment geometry, infer a desktop from a lower bound, apply TCP
offsets twice, or create automatic motion constraints from these values.

Each surface has a unique name, a pose, and an extent. Record its orientation as
well as its position. Use an unknown extent until measured; unbounded must be
explicit. See DEVICE.md#use for the fixed geometry contract.

`calib_plan` reports world geometry as optional. `move_to` accepts device-native
targets and does not require world data. Perception tools can explicitly query the geometry.

### Adapter and field reference

#### World geometry

The `world` device is an optional spatial reference, not the unique root of the
frame graph. It has no driver, access, or extrinsics. Mobile bases may be roots.

`intrinsics` contains only provenance and spatial data:
- `source`: user, calibration, introspected, default, unknown.
- `method`: unknown, manual, survey, introspection, plane_fit.
- `calibrated_at`: ISO UTC timestamp or null when unavailable.
- Optional `needs_calibration`: the reason for a requested measurement. Clear with null after resolving it.
- `frames`: named fixed transforms in world, e.g. `fixture: [1,0,0,0,0,0,1]`
  addressed as `world:fixture`. Values are xyz in metres followed by xyzw, or
  `???` until measured. World frames cannot use live (`null`) transforms.
- `bounds`: null (no box declared), ??? (pending), or `{min: [x,y,z], max: [x,y,z]}`.
  Coordinates are metres in world. Each side may be null (open).
- `surfaces`: a list of `{name, pose, extent}`, with unique names.
  `pose` is `{translation_m: [x,y,z], rotation_xyzw: [x,y,z,w]}` or ???.
  It places the surface frame in world; the quaternion must be unit length.
  The surface lies in local z=0, with normal +Z.
  `extent` is one of:
  - `{shape: rectangle, size_m: [width,height]}` centered on the local origin;
  - `{shape: polygon, vertices_m: [[x,y],...]}` ordered around the local boundary;
  - `{shape: unbounded}` for an explicitly infinite plane;
  - ??? when unknown. Unknown never means infinite.

Bounds describe a region; they do not prove reachability or collision clearance.
They are not checked or clamped automatically by move_to. Geometry is queried
only by consumers that need it. A surface ray intersection uses both its pose
and extent and rejects unknown geometry, rays behind the camera, and hits beyond
the declared boundary.

### Profile

```yaml
name: world
type: world
loaded: false
intrinsics:
  source: unknown
  method: unknown
  calibrated_at: null
  frames: {}
  bounds: null
  surfaces: []
```
