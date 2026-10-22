# Ownership fields are assigned by Kinex communication.publish.
string owner
uint64 generation
string command_id
# Commanded joint references timed from acceptance; joint_names may cover a subset.
trajectory_msgs/JointTrajectory trajectory
