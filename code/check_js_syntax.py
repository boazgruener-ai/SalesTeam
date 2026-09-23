"""Syntax-check every .js file in code/ without Node.

There is no Node/deno/bun on this machine, which is why the project's own notes keep saying
"UNVERIFIED - nothing was syntax-checked" after every batch of changes. The usual failure mode is
brutal and silent: one duplicate top-level declaration, or one unbalanced brace, and the whole page
renders blank with nothing in the UI to say why.

This parses each file with tree-sitter's JavaScript grammar - a real parser, current with modern
syntax (optional chaining, nullish coalescing, class fields) - and reports every ERROR or MISSING
node with its line. It is a SYNTAX check, not a type or lint check: it catches the class of mistake
that blanks a page, not a misspelled variable.

On top of parsing it also flags DUPLICATE TOP-LEVEL DECLARATIONS, which are a SyntaxError in a
module and have bitten this repo before (`bulkSelection` was declared twice in target-accounts.js
and blanked the entire Accounts page).

    set PYTHONDONTWRITEBYTECODE=1
    python code/check_js_syntax.py

PYTHONDONTWRITEBYTECODE is required: a __pycache__ directory inside code/ breaks Chrome's
"Load unpacked" (underscore-reserved name).

One-off install, if it is not already there:

    python -m pip install tree_sitter tree_sitter_javascript
"""

import os
import sys
from collections import defaultdict

try:
    from tree_sitter import Language, Parser
    import tree_sitter_javascript
except ImportError:
    sys.exit("Missing parser. Run:  python -m pip install tree_sitter tree_sitter_javascript")

CODE_DIR = os.path.dirname(os.path.abspath(__file__))

# Declarations that live at the top level of a module and so must be unique within it.
DECL_TYPES = {
    "lexical_declaration": "let/const",
    "variable_declaration": "var",
    "function_declaration": "function",
    "class_declaration": "class",
}


def declared_names(node, source):
    """Every binding name introduced by one top-level declaration node."""
    out = []
    if node.type in ("function_declaration", "class_declaration"):
        name = node.child_by_field_name("name")
        if name is not None:
            out.append(source[name.start_byte:name.end_byte].decode("utf-8"))
        return out
    for child in node.named_children:
        if child.type != "variable_declarator":
            continue
        name = child.child_by_field_name("name")
        # Destructuring ({a, b} = ...) is skipped rather than half-understood: it is rare at the top
        # level here and a wrong answer would be worse than no answer.
        if name is not None and name.type == "identifier":
            out.append(source[name.start_byte:name.end_byte].decode("utf-8"))
    return out


def check(path, parser):
    source = open(path, "rb").read()
    tree = parser.parse(source)
    problems = []

    stack = [tree.root_node]
    while stack:
        node = stack.pop()
        if node.type == "ERROR" or node.is_missing:
            line = node.start_point[0] + 1
            snippet = source[node.start_byte:node.start_byte + 60].decode("utf-8", "replace")
            snippet = snippet.replace("\n", " ").strip()
            kind = "missing token" if node.is_missing else "parse error"
            problems.append((line, "%s near: %s" % (kind, snippet)))
            continue
        stack.extend(node.children)

    seen = defaultdict(list)
    for node in tree.root_node.named_children:
        target = node
        # `export const x = ...` wraps the declaration one level down.
        if node.type == "export_statement":
            inner = node.child_by_field_name("declaration")
            if inner is None:
                continue
            target = inner
        if target.type not in DECL_TYPES:
            continue
        for name in declared_names(target, source):
            seen[name].append(target.start_point[0] + 1)
    for name, lines in sorted(seen.items()):
        if len(lines) > 1:
            problems.append((lines[1], 'duplicate top-level declaration "%s" (also on line %s)'
                             % (name, ", ".join(str(n) for n in lines[:-1]))))

    return sorted(problems)


def main():
    parser = Parser(Language(tree_sitter_javascript.language()))
    files = sorted(f for f in os.listdir(CODE_DIR) if f.endswith(".js"))
    failed = 0
    for name in files:
        problems = check(os.path.join(CODE_DIR, name), parser)
        if problems:
            failed += 1
            print("%s" % name)
            for line, message in problems:
                print("  line %d: %s" % (line, message))
    print()
    if failed:
        print("%d of %d file(s) have problems." % (failed, len(files)))
        return 1
    print("All %d file(s) parse cleanly." % len(files))
    return 0


if __name__ == "__main__":
    sys.exit(main())
