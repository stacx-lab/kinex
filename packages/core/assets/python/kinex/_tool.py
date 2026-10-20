"""Run one async tool in an invocation-scoped communication context."""
import sys
from kinex import args, finish
from kinex.ros_tools import run

finish(run(sys.argv[1], args()))
