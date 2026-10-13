#!/usr/bin/env python3
"""Group cloc 2.06 --git --by-file --json output; reads metadata only."""
import argparse
import json
from collections import defaultdict
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("kind", choices=["commercial", "kadri"])
parser.add_argument("report", type=Path)
args = parser.parse_args()
report = json.loads(args.report.read_text())
groups = defaultdict(lambda: dict(files=0, code=0, comment=0, blank=0))
for filename, stats in report.items():
    if filename in {"header", "SUM"}:
        continue
    path = filename.removeprefix("./")
    language = stats["language"]
    category = "other"
    if args.kind == "commercial":
        if path.startswith("lib/imapproxy/imap-core/"):
            category = "bundled_imap_core_all"
        elif (path.startswith(("lib/", "workers/")) or path in {"server.js", "bin/emailengine.js"}) and language in {"JavaScript", "Lua"}:
            category = "backend_js_lua"
        elif path.startswith("test/") and language == "JavaScript":
            category = "test_js"
        elif path.startswith("views/"):
            category = "views"
        elif path.startswith("static/"):
            category = "static_all"
    else:
        if path.startswith("src/") and path.endswith(".test.ts"):
            category = "unit_tests"
        elif path.startswith("src/"):
            category = "production_ts"
        elif path.startswith("test/") and language == "JavaScript":
            category = "test_js"
    group = groups[category]
    group["files"] += 1
    for key in ("code", "comment", "blank"):
        group[key] += stats[key]

for key in ("code", "comment", "blank"):
    assert sum(group[key] for group in groups.values()) == report["SUM"][key]
assert sum(group["files"] for group in groups.values()) == report["SUM"]["nFiles"]
print(json.dumps(dict(groups), indent=2))
