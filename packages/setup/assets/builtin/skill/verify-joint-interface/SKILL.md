---
name: verify-joint-interface
description: Verify a joint device's live interface (joint names, feedback, controller state, freshness) against its declared model without commanding motion.
---

# Verify joint interface

Bind `arm` to the joint device. Read the core joint guide and the device's own
guide (resolve the bundle name in Device guide roots). Prepare the driver and
load it explicitly through core lifecycle; a load that fails fast names the
exact remediation (for a bundle, `stack.sh start`). Interface inspection never
commands motion. If a fact requires movement, use `verify-joint-motion`.

Resolve the selected profile's `access.driver.entry` relative to the device
directory. Its containing directory is the selected driver generation; use that
directory's `check.sh` when present. If it also contains `stack.sh`, first run
`bash "<generation>/stack.sh" status` through host bash and continue only when it
exits 0. Then run `bash "<generation>/check.sh"`. It prints `ok` or
`FAIL <check>: expected X measured Y` lines and writes
`<device dir>/verify/measurements.json`. Pass that file unchanged to
`calib_compute operation:verify-checks`; do not re-derive, prune or relax its
checks. A failed check is reported by name with the bundle guide's
troubleshooting entry, not by reading stack logs.

Without a checker beside the selected driver, author the same named checks from
fresh `calib_sample` reads and archive them in a measurements file (the
`calib_compute` tool description defines the format): `joints` compares the exact measured joint
names and order with the declared model; `rate:<source>` is a shortfall from
timestamps across at least two reads (expected 0, measured `max(0, min_hz -
hz)`, tolerance 0, units Hz); `limits:<joint>` compares measured positions
with model limits numerically with an explicit tolerance and units; `faults`
expects an empty list. Name only the checks the task needs in
`required_checks`; every check cites its reference source.

Fix only proven mismatches, and only by changing facts and rerunning
`setup.sh`, or by restarting the stack with `stack.sh`; never edit a bundle's
generated files or driver. Reload through core lifecycle and rerun the check.
For a template driver, fix the proven conversion error in `driver.py`, reload
and rerun. Do not tune controllers. Record only the resolved plan node with the
numbered result evidence returned by `calib_compute`.

See [procedure.json](procedure.json) for roles and computations.
