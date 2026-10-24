"""locate_object_3d tool: an interface to helpers.locate_object_3d."""
from kinex import helpers


async def main(a, io):
    return await helpers.locate_object_3d(io, **a)
