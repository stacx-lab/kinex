# Ownership fields are assigned by Kinex communication.publish.
string owner
uint64 generation
string command_id
# Body posture offset from the nominal stance; it persists until replaced.
geometry_msgs/Pose pose
