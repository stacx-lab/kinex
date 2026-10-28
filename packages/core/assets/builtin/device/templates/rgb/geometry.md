# Camera geometry services

Raw images and masks stay in their published grid. Nodes use vendor SDKs or
OpenCV; Kinex does not implement lens-distortion equations.

Declare geometry, unproject and project as input services of type
kinex_interfaces/srv/Json, with endpoint, timeout and descriptions.

- geometry accepts {} and returns {"streams":{"color":descriptor,"depth":descriptor}}.
  Omit depth unless native. Descriptors require positive width/height, optical
  frame and nonempty calibration_id. Projection/distortion snapshots are optional.
- unproject accepts {stream,calibration_id,pixels:[[u,v],...]} and returns
  {rays:[[x,y,1],...]}. Color-registered depth uses color geometry.
- project accepts {stream,calibration_id,points:[[X,Y,Z],...]} and returns
  {pixels:[[u,v],...]}. Points are optical-frame metres with positive Z.
- Preserve order/count; null means invalid individual result. Malformed requests,
  unsupported directions and stale IDs fail. Maximum batch size is 8192.

Calibration/configuration must remain fixed while loaded. Reload to change them;
SDK reconnect handlers halt publication if calibration changes. Consumers fetch
descriptors before acquisition and reuse IDs within an invocation. Profile
snapshots, if present, must match. Archive SDK version and calibration provenance.

In the node factory call kinex.lib.camera_geometry.serve_geometry(node, profile,
adapters), mapping color/native depth to immutable adapters:
- RealSenseGeometry(active_video_profile.get_intrinsics(), optical_frame) uses
  the installed SDK directly, preserving reported model and coefficients.
- OpenCVGeometry(stream_descriptor, fisheye=False) uses standard OpenCV Brown.
  fisheye=True uses OpenCV's four-coefficient fisheye API. Include the optical
  frame in the descriptor. Standard coefficients are k1,k2,p1,p2,k3;
  fisheye uses coefficients:[k1,k2,k3,k4]. Unsupported mappings fail.

Install optional SDK/OpenCV dependencies in the node environment. Core has no
mandatory vendor dependency. Services follow existing permissions and lifecycle.

Only complete, explicitly undistorted pinhole intrinsics allow local geometry.
Viewing/model inference does not require geometry services. An accepted model
name does not imply geometric readiness. FOV may remain ??? or be supplied using
boundary rays. Geometry services never resample images.

Optional rectified outputs need their own intrinsics and matching depth grid.
Never reuse raw masks in a rectified grid; these services create no extra stream.
