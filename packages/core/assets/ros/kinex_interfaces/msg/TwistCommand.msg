# Ownership fields are assigned by Kinex communication.publish.
string owner
uint64 generation
string command_id
# Body velocity held for duration_s of world time from acceptance, then zero.
geometry_msgs/Twist twist
float64 duration_s
