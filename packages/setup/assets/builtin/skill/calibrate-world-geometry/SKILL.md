---
name: calibrate-world-geometry
description: Record independently measured world bounds or surfaces only for tasks that need those spatial facts.
---

# Calibrate world geometry

Bind `world` to the world device. This procedure is optional unless the current
task needs a specific world reference, boundary or surface. A robot can operate
in local frames without world geometry.

Use surveyed coordinates, verified simulator geometry or a calibrated measurement
method. Record frames, units, source and uncertainty. Bounds may be null, including
individual open sides. Surfaces need a measured pose and explicit extent; unknown
extent stays unknown. Follow the core world guide for the profile schema.

Do not infer a support surface from an arm reach AABB, or use a sampled reachable
region as environment bounds. For TCP observations preserve reference frames and
apply each offset once. Archive the measurements and fitting diagnostics, then
write only the requested verified fields with `profile_write`. Keep broader
requests open if unrelated fields remain incomplete.

See [procedure.json](procedure.json) for machine-readable roles and field coverage.
