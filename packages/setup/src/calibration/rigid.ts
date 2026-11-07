import { z } from "zod"

// A rigid transform as a profile frame edge: the child's pose in its parent.
const finite = z.number().finite()
export const Pose = z.object({
  translation_m: z.tuple([finite, finite, finite]),
  rotation_xyzw: z.tuple([finite, finite, finite, finite]),
})
export type Pose = z.infer<typeof Pose>
type Quaternion = Pose["rotation_xyzw"]
type Vector = Pose["translation_m"]

export const IDENTITY: Pose = { translation_m: [0, 0, 0], rotation_xyzw: [0, 0, 0, 1] }

function multiply([ax, ay, az, aw]: Quaternion, [bx, by, bz, bw]: Quaternion): Quaternion {
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz]
}

const conjugate = ([x, y, z, w]: Quaternion): Quaternion => [-x, -y, -z, w]

function rotate(q: Quaternion, [x, y, z]: Vector): Vector {
  const [rx, ry, rz] = multiply(multiply(q, [x, y, z, 0]), conjugate(q))
  return [rx, ry, rz]
}

function normalize(q: Quaternion): Quaternion {
  const norm = Math.hypot(...q)
  return [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm]
}

// a∘b: b's child expressed in a's parent.
export function compose(a: Pose, b: Pose): Pose {
  const [x, y, z] = rotate(a.rotation_xyzw, b.translation_m)
  return { translation_m: [a.translation_m[0] + x, a.translation_m[1] + y, a.translation_m[2] + z],
    rotation_xyzw: normalize(multiply(a.rotation_xyzw, b.rotation_xyzw)) }
}

export function invert({ translation_m: [x, y, z], rotation_xyzw }: Pose): Pose {
  const inverse = conjugate(rotation_xyzw)
  const [tx, ty, tz] = rotate(inverse, [x, y, z])
  return { translation_m: [-tx, -ty, -tz], rotation_xyzw: inverse }
}

// The edge's pose when both components are known; undefined for ??? or a root.
export const edgePose = (edge: unknown): Pose | undefined => Pose.safeParse(edge).data
