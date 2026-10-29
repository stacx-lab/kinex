"""run_policy tool: an interface to helpers.run_policy."""
from kinex import helpers


async def main(a, io):
    return await helpers.run_policy(io, **a)
