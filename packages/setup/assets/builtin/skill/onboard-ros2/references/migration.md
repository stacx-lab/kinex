# Legacy ROS workspace migration

Read the existing profile YAML and facts as data before schema changes; record
loaded intent and calibration. Do not treat profiles omitted by strict discovery
as originally unloaded. Stop/unload affected devices through core before upgrade.

Move `access.connection.domain_id` and `namespace` into bundle facts and
`camera_info_topic` into driver configuration. Conflicting duplicates require
resolution from evidence. Stage a complete generation with the installed setup
library. Replace access through `profile_write`, preserving driver settings and
other connection fields; replace intrinsics only to update a generated model path.
Preserve calibration and needed markers. Load explicitly after validation.

If already upgraded, repair in a stopped session using the original YAML rather
than relying on discovery. Keep the repaired device unloaded until the new
adapter and interface checks succeed.

Rollback between compatible generations restores saved sections through
`profile_write` after unloading the candidate. Legacy rollback is different:
old profiles may require removed schema fields and old drivers import modules
no longer present in core. A failed legacy migration stays unloaded and repairs
forward. Returning to that integration requires its matching package version and
saved configuration, not just restoring its old profile under the new core.
