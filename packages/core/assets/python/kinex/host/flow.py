"""Flow charts for the TypeScript runtime: `flow.py FILE FUNCTION LIB_ROOT...` prints,
as JSON, the structured flow of a function, or of the whole program in FILE when
FUNCTION is empty, and of every function it can reach.

Source is parsed, never imported, so charting a program runs none of it. A flow is a
tree of steps: device operations, calls that open into the callee's own flow,
subagent judgments, folded computation, and the branches, loops, scopes and concurrency
around them.
"""
import ast
import json
import os
import sys
from importlib.machinery import PathFinder

DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)
OPAQUE = (*DEFS, ast.Lambda, ast.ClassDef)
COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
VERBS = {"request", "publish", "read", "subscribe"}
STREAM = {"next", "latest"}
SPAWN = {"asyncio.create_task", "asyncio.ensure_future"}
LIB = "kinex.lib"
LIMIT = 400


def text(node, limit=80):
    value = " ".join(ast.unparse(node).split())
    return value if len(value) <= limit else value[:limit - 1] + "…"


def dotted(node):
    """The names of an attribute chain such as a.b.c, or None for any other expression."""
    names = []
    while isinstance(node, ast.Attribute):
        names.append(node.attr)
        node = node.value
    return [node.id, *reversed(names)] if isinstance(node, ast.Name) else None


def spec(names, search):
    """What Python would import for a dotted module below search, without importing it."""
    found = None
    for name in names:
        found = PathFinder.find_spec(name, search) if search is not None else None
        if found is None:
            return None
        search = found.submodule_search_locations
    return found


class Module:
    def __init__(self, file, roots):
        self.file = file
        with open(file, encoding="utf-8") as handle:
            self.source = handle.read()
        self.lines = self.source.splitlines()
        self.tree = ast.parse(self.source, file)
        self.functions = {node.name: node for node in self.tree.body if isinstance(node, DEFS)}
        self.name = self.package = None
        for root in roots:
            relative = os.path.relpath(file, root)
            if not relative.startswith(os.pardir):
                parts = relative[:-len(".py")].split(os.sep)
                package = parts[-1] == "__init__"
                self.name = ".".join([LIB, *parts[:-1 if package else None]])
                self.package = self.name if package else self.name.rpartition(".")[0]
                break
        # Every name an import binds, as the dotted name it stands for.
        self.aliases = {}
        for node in ast.walk(self.tree):
            if isinstance(node, ast.Import):
                for item in node.names:
                    self.aliases[item.asname or item.name.partition(".")[0]] = item.name if item.asname else item.name.partition(".")[0]
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ""
                if node.level:
                    if self.package is None:
                        continue
                    parent = self.package.split(".")[:len(self.package.split(".")) - node.level + 1]
                    base = ".".join([*parent, *([base] if base else [])])
                for item in node.names:
                    self.aliases[item.asname or item.name] = f"{base}.{item.name}"


class Charts:
    def __init__(self, roots):
        self.roots = roots
        self.modules = {}
        self.functions = {}
        self.problems = []

    def module(self, file):
        file = os.path.realpath(file)
        if file not in self.modules:
            try:
                self.modules[file] = Module(file, self.roots)
            except (OSError, SyntaxError, ValueError) as error:
                self.modules[file] = None
                self.problems.append(f"{file}: {error}")
        return self.modules[file]

    def locate(self, name, origin, seen=()):
        """The (module, function) a dotted name calls, following re-exports."""
        parts = name.split(".")
        if parts[:2] == LIB.split("."):
            search, parts = self.roots, parts[2:]
        elif origin.name is None:
            search = [os.path.dirname(origin.file)]
        else:
            return None
        *modules, function = parts
        found = spec(modules, search) if modules else None
        if not found or not found.origin or not found.origin.endswith(".py"):
            return None
        module = self.module(found.origin)
        if module is None or (module.file, function) in seen:
            return None
        if function in module.functions:
            return module, function
        alias = module.aliases.get(function)
        return self.locate(alias, module, (*seen, (module.file, function))) if alias else None

    def chart(self, module, qualified, node, outer=None):
        """Chart a function, or a whole program from its module node, once and return its identifier."""
        identifier = f"{module.file}::{qualified}"
        if identifier not in self.functions and len(self.functions) < LIMIT:
            file = os.path.basename(module.file)
            if isinstance(node, ast.Module):
                path, signature, line, end = file, "", 1, len(module.lines)
            else:
                path = f"{module.name[len(LIB) + 1:]}.{qualified}".lstrip(".") if module.name else f"{file}:{qualified}"
                signature = (f"{'async ' if isinstance(node, ast.AsyncFunctionDef) else ''}def {node.name}({ast.unparse(node.args)})"
                             + (f" -> {ast.unparse(node.returns)}" if node.returns else ""))
                line, end = node.lineno, node.end_lineno
            entry = self.functions[identifier] = {
                "id": identifier, "path": path, "name": qualified.rpartition(".")[2] or file, "file": module.file, "line": line, "end": end,
                "signature": signature, "doc": ast.get_docstring(node) or "", "source": "\n".join(module.lines[line - 1:end]),
            }
            entry["body"] = Function(self, module, qualified, node, outer).block(node.body)
        return identifier if identifier in self.functions else None


class Function:
    """One function's statements as steps."""

    def __init__(self, charts, module, qualified, node, outer=None):
        self.charts, self.module, self.qualified = charts, module, qualified
        # Functions defined inside this one or around it, the names bound to subscriptions
        # and to tasks, and the name each call's result is assigned to.
        self.nested = dict(outer.nested) if outer else {}
        self.streams = dict(outer.streams) if outer else {}
        self.tasks, self.bound = set(outer.tasks) if outer else set(), {}
        pending = list(node.body)
        while pending:
            child = pending.pop()
            if isinstance(child, DEFS):
                self.nested[child.name] = (f"{qualified}.{child.name}".lstrip("."), child, self)
            elif not isinstance(child, OPAQUE):
                pending.extend(ast.iter_child_nodes(child))

    def qualify(self, names):
        """A dotted name with its import resolved."""
        return ".".join([self.module.aliases.get(names[0], names[0]), *names[1:]]) if names else None

    def name(self, call):
        return self.qualify(dotted(call.func))

    def operation(self, call):
        """The operation an io call names, or None when the call is not one."""
        names = dotted(call.func)
        if not names or len(names) < 2 or names[-1] not in VERBS or not call.args:
            return None
        if self.name(call) != f"kinex.io.{names[-1]}" and names[-2] != "io":
            return None
        first = call.args[0]
        literal = isinstance(first, ast.Constant) and isinstance(first.value, str)
        return {"verb": names[-1], "operation": first.value if literal else text(first), "dynamic": not literal}

    def target(self, name):
        """The chart a called name opens: a nested, local or imported function."""
        if name in self.nested:
            return self.charts.chart(self.module, *self.nested[name])
        if name in self.module.functions:
            return self.charts.chart(self.module, name, self.module.functions[name])
        found = self.charts.locate(name, self.module)
        return self.charts.chart(found[0], found[1], found[0].functions[found[1]]) if found else None

    def steps(self, node):
        """The steps an expression performs, in evaluation order."""
        if node is None or isinstance(node, OPAQUE):
            return []
        at = {"line": node.lineno, "end": node.end_lineno} if hasattr(node, "lineno") else {}
        if isinstance(node, COMPREHENSIONS):
            first, *rest = node.generators
            elements = [node.key, node.value] if isinstance(node, ast.DictComp) else [node.elt]
            inner = [step for part in (*first.ifs, *rest, *elements) for step in self.steps(part)]
            header = " ".join(f"for {text(g.target, 30)} in {text(g.iter, 40)}" for g in (first, *rest))
            return self.steps(first.iter) + ([{"kind": "loop", "header": header, "body": inner, "orelse": [], **at}] if inner else [])
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Name) and node.value.id in self.tasks:
            return [{"kind": "join", "task": node.value.id, **at}]
        if isinstance(node, ast.Await) and isinstance(node.value, ast.Call):
            found = self.call(node.value, at)
            # An awaited call is a point where the program waits, even when its target is unknown.
            return found if found is not None else self.steps(node.value.func) + self.inputs(node.value) + [{"kind": "call", "label": text(node.value.func, 60), "target": None, **at}]
        if isinstance(node, ast.Call):
            found = self.call(node, at)
            return found if found is not None else self.steps(node.func) + self.inputs(node)
        return [step for child in ast.iter_child_nodes(node) for step in self.steps(child)]

    def inputs(self, call, skip=0):
        """The steps of a call's arguments."""
        parts = [*call.args[skip:], *(keyword.value for keyword in call.keywords)]
        return [step for part in parts for step in self.steps(part)]

    def branch(self, argument):
        """One concurrent branch of a gather or wait."""
        if isinstance(argument, ast.Starred) and isinstance(argument.value, COMPREHENSIONS):
            loop = self.steps(argument.value)
            if loop and loop[-1]["kind"] == "loop":
                return {"each": loop[-1]["header"], "body": loop[-1]["body"]}
        if isinstance(argument, ast.Starred):
            return {"each": f"for each of {text(argument.value, 40)}", "body": []}
        if isinstance(argument, ast.Name):
            return {"each": None, "body": [{"kind": "join", "task": argument.id, "line": argument.lineno, "end": argument.end_lineno}]}
        return {"each": None, "body": self.steps(argument)}

    def call(self, call, at):
        """The steps of a call this chart understands, or None for any other call."""
        name, names = self.name(call), dotted(call.func)
        io = self.operation(call)
        if io:
            return self.inputs(call, 1) + [{"kind": "io", **io, **at}]
        if name == "kinex.subagent" and call.args:
            first = call.args[0]
            literal = isinstance(first, ast.Constant) and isinstance(first.value, str) and first.value.strip()
            shown = next((keyword.value for keyword in call.keywords if keyword.arg == "show"), None)
            shows = [text(key, 30) if not isinstance(key, ast.Constant) else str(key.value) for key in shown.keys if key] if isinstance(shown, ast.Dict) else []
            instruction = first.value.strip().splitlines()[0] if literal else text(first, 120)
            return self.inputs(call, 1) + [{"kind": "subagent", "instruction": instruction, "dynamic": not literal, "shows": shows, **at}]
        if name == "kinex.finish":
            label = ", ".join(text(part, 40) for part in (*call.args, *call.keywords))
            return self.inputs(call) + [{"kind": "exit", "how": "finish", "label": label, **at}]
        func = call.func
        if isinstance(func, ast.Attribute) and func.attr in STREAM:
            source = self.operation(func.value) if isinstance(func.value, ast.Call) else None
            stream = source or (self.streams.get(func.value.id) if isinstance(func.value, ast.Name) else None)
            if stream:
                before = self.inputs(func.value, 1) if source else []
                return before + self.inputs(call) + [{"kind": "io", **stream, "verb": func.attr, **at}]
        if isinstance(func, ast.Attribute) and func.attr == "cancel" and isinstance(func.value, ast.Name) and func.value.id in self.tasks:
            return [{"kind": "cancel", "task": func.value.id, **at}]
        if name in SPAWN or (isinstance(func, ast.Attribute) and func.attr == "create_task"):
            task = self.bound.get(id(call))
            if task:
                self.tasks.add(task)
            return [{"kind": "spawn", "task": task, "body": self.steps(call.args[0]) if call.args else [], **at}]
        if name == "asyncio.gather":
            return [{"kind": "parallel", "mode": "all", "branches": [self.branch(argument) for argument in call.args], **at}]
        if name == "asyncio.wait" and call.args:
            mode = next((text(keyword.value) for keyword in call.keywords if keyword.arg == "return_when"), "")
            tasks = call.args[0].elts if isinstance(call.args[0], (ast.List, ast.Tuple, ast.Set)) else [ast.Starred(call.args[0])]
            return [{"kind": "parallel", "mode": "first" if "FIRST" in mode else "all", "branches": [self.branch(task) for task in tasks], **at}]
        if name == "asyncio.wait_for" and call.args:
            limit = call.args[1] if len(call.args) > 1 else next((keyword.value for keyword in call.keywords if keyword.arg == "timeout"), None)
            return [{"kind": "scope", "label": f"timeout {text(limit, 30)} s" if limit else "timeout", "timeout": True, "body": self.steps(call.args[0]), **at}]
        if name == "asyncio.sleep":
            return self.inputs(call) + [{"kind": "wait", "label": f"sleep {text(call.args[0], 30)} s" if call.args else "sleep", **at}]
        skip = 0
        if name == "asyncio.to_thread" and call.args and dotted(call.args[0]):
            names, skip = dotted(call.args[0]), 1
            name = self.qualify(names)
        if not name:
            return None
        target = self.target(name)
        if target is None and not name.startswith(f"{LIB}."):
            return None
        label = name[len(LIB) + 1:] if name.startswith(f"{LIB}.") else ".".join(names)
        return self.inputs(call, skip) + [{"kind": "call", "label": label, "target": target, **at}]

    def scope(self, item):
        """The scope a with item opens, as (steps before it, its label, extra fields)."""
        expression = item.context_expr
        if isinstance(expression, ast.Call):
            io = self.operation(expression)
            if io and io["verb"] == "subscribe":
                if isinstance(item.optional_vars, ast.Name):
                    self.streams[item.optional_vars.id] = io
                return self.inputs(expression, 1), f"subscribed to {io['operation']}", {}
            name = self.name(expression)
            if name in ("asyncio.timeout", "asyncio.timeout_at") and expression.args:
                unit = " s" if name == "asyncio.timeout" else ""
                return self.inputs(expression), f"timeout {'at ' if not unit else ''}{text(expression.args[0], 30)}{unit}", {"timeout": True}
            if name == "asyncio.TaskGroup":
                return [], "task group: leaves when every task has finished", {}
        return self.steps(expression), f"with {text(expression, 60)}", {}

    def block(self, statements):
        steps, plain = [], []

        def flush():
            if plain:
                names = list(dict.fromkeys(name for _, _, found in plain for name in found))
                steps.append({"kind": "compute", "names": names, "line": plain[0][0], "end": plain[-1][1]})
                plain.clear()

        def add(statement, found):
            # Steps that only compute join the computation around them.
            assigned = [node.id for node in ast.walk(statement) if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store)]
            if all(computes(step) for step in found):
                plain.append((statement.lineno, statement.end_lineno, assigned))
                return
            for step in found:
                if computes(step):
                    plain.append((step["line"], step["end"], assigned))
                else:
                    flush()
                    steps.append(step)

        for statement in statements:
            at = {"line": statement.lineno, "end": statement.end_lineno}
            if isinstance(statement, (ast.Import, ast.ImportFrom, ast.Pass, ast.Global, ast.Nonlocal, *OPAQUE)):
                continue
            if isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Constant):
                continue
            if isinstance(statement, ast.If):
                arms, current = [], statement
                while True:
                    arms.append({"condition": text(current.test), "body": self.block(current.body)})
                    following = current.orelse
                    # An elif whose test performs steps stays nested: it runs only when reached.
                    if len(following) != 1 or not isinstance(following[0], ast.If) or self.steps(following[0].test):
                        break
                    current = following[0]
                add(statement, self.steps(statement.test) + [{"kind": "branch", "arms": arms, "orelse": self.block(current.orelse), **at}])
            elif isinstance(statement, getattr(ast, "Match", ())):
                arms = [{"condition": f"{text(statement.subject, 30)} matches {text(case.pattern, 40)}", "body": self.block(case.body)} for case in statement.cases]
                add(statement, self.steps(statement.subject) + [{"kind": "branch", "arms": arms, "orelse": [], **at}])
            elif isinstance(statement, ast.While):
                body = self.steps(statement.test) + self.block(statement.body)
                forever = isinstance(statement.test, ast.Constant) and statement.test.value is True
                add(statement, [{"kind": "loop", "header": "repeat" if forever else f"while {text(statement.test)}", "body": body, "orelse": self.block(statement.orelse), **at}])
            elif isinstance(statement, (ast.For, ast.AsyncFor)):
                stream = self.streams.get(statement.iter.id) if isinstance(statement.iter, ast.Name) else None
                header = f"for {text(statement.target, 30)} in {'each message of ' + stream['operation'] if stream else text(statement.iter, 50)}"
                body = self.block(statement.body)
                if isinstance(statement, ast.AsyncFor):
                    head = {"line": statement.lineno, "end": statement.lineno}
                    body = [{"kind": "io", **stream, "verb": "next", **head} if stream else {"kind": "wait", "label": "wait for the next item", **head}, *body]
                add(statement, self.steps(statement.iter) + [{"kind": "loop", "header": header, "body": body, "orelse": self.block(statement.orelse), **at}])
            elif isinstance(statement, (ast.With, ast.AsyncWith)):
                opened = [self.scope(item) for item in statement.items]
                body = self.block(statement.body)
                for before, label, extra in reversed(opened):
                    body = before + [{"kind": "scope", "label": label, "timeout": False, **extra, "body": body, **at}]
                add(statement, body)
            elif isinstance(statement, (ast.Try, getattr(ast, "TryStar", ast.Try))):
                handlers = [{"exception": text(handler.type, 50) if handler.type else "any error", "body": self.block(handler.body)} for handler in statement.handlers]
                add(statement, [{"kind": "try", "body": self.block(statement.body), "handlers": handlers,
                                 "orelse": self.block(statement.orelse), "final": self.block(statement.finalbody), **at}])
            elif isinstance(statement, (ast.Return, ast.Raise)):
                value = statement.value if isinstance(statement, ast.Return) else statement.exc
                flush()
                steps.extend(self.steps(value))
                steps.append({"kind": "exit", "how": "return" if isinstance(statement, ast.Return) else "raise", "label": text(value, 60) if value else "", **at})
            elif isinstance(statement, (ast.Break, ast.Continue)):
                flush()
                steps.append({"kind": "exit", "how": "break" if isinstance(statement, ast.Break) else "continue", "label": "", **at})
            else:
                value = getattr(statement, "value", None)
                targets = getattr(statement, "targets", None) or [getattr(statement, "target", None)]
                if isinstance(value, ast.Await):
                    value = value.value
                if isinstance(value, ast.Call) and isinstance(targets[0], ast.Name):
                    self.bound[id(value)] = targets[0].id
                    io = self.operation(value)
                    if io and io["verb"] == "subscribe":
                        self.streams[targets[0].id] = io
                add(statement, self.steps(statement))
        flush()
        return steps


def computes(step, looping=False):
    """Whether a step and everything inside it is computation only."""
    kind = step["kind"]
    blocks = []
    if kind == "exit":
        return looping and step["how"] in ("break", "continue")
    if kind == "branch":
        blocks = [step["orelse"], *(arm["body"] for arm in step["arms"])]
    elif kind == "loop":
        blocks, looping = [step["body"], step["orelse"]], True
    elif kind == "scope" and not step["timeout"] and step["label"].startswith("with "):
        blocks = [step["body"]]
    elif kind == "try":
        blocks = [step["body"], step["orelse"], step["final"], *(handler["body"] for handler in step["handlers"])]
    elif kind != "compute":
        return False
    return all(computes(inner, looping) for block in blocks for inner in block)


def main(file, function, roots):
    charts = Charts([os.path.realpath(root) for root in roots])
    module = charts.module(file)
    if module is None:
        sys.exit(charts.problems[0])
    if function and function not in module.functions:
        defined = ", ".join(module.functions) or "no functions"
        sys.exit(f"{file} defines no function {function}; it defines {defined}")
    entry = charts.chart(module, function, module.functions[function] if function else module.tree)
    return {"entry": entry, "functions": charts.functions, "problems": charts.problems}


if __name__ == "__main__":
    print(json.dumps(main(sys.argv[1], sys.argv[2], sys.argv[3:])))
