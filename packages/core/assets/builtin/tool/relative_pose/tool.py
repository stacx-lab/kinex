"""relative_pose tool: an interface to helpers.relative_pose."""
from kinex import helpers


async def main(a, io):
    return await helpers.relative_pose(io, **a)
