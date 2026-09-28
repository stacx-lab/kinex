"""Execute an inline lambda or a module defining main."""

import ast
import json
import sys

from kinex import finish


def run(source, values):
    tree = ast.parse(source, filename="<inline>")
    namespace = {"__name__": "__kinex_inline__"}
    if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Lambda):
        function = eval(compile(ast.Expression(tree.body[0].value), "<inline>", "eval"), namespace)
    else:
        exec(compile(tree, "<inline>", "exec"), namespace)
        function = namespace.get("main")
    if not callable(function):
        raise ValueError("inline Python must be a lambda or define main")
    return function(**values)


if __name__ == "__main__":
    finish(run(sys.argv[1], json.loads(sys.argv[2])))
