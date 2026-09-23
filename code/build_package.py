# -*- coding: utf-8 -*-
"""Builds the Chrome Web Store upload package for the version in code/manifest.json.

    python build_package.py

Writes builds/v<version>/SalesTeam-v<version>.zip (plus a copy of manifest.json next to it, like earlier
builds) and runs the checks that catch a broken package before the store does. The package is everything in
code/ except developer tooling: Python scripts, sketch/scratch pages, caches and the OS clutter.
"""
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EXCLUDED_DIRS = {"__pycache__", ".git", "node_modules"}
EXCLUDED_SUFFIXES = (".py", ".pyc", ".md", ".docx", ".map", ".bak", ".tmp")
EXCLUDED_NAMES = {"sketch.html", ".DS_Store", "Thumbs.db"}


def package_files():
    files = []
    for dirpath, dirnames, filenames in os.walk(HERE):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIRS]
        for name in filenames:
            if name in EXCLUDED_NAMES or name.lower().endswith(EXCLUDED_SUFFIXES) or name.startswith("zz_"):
                continue
            full = os.path.join(dirpath, name)
            files.append((full, os.path.relpath(full, HERE).replace(os.sep, "/")))
    return sorted(files, key=lambda f: f[1])


def check(zip_path, version):
    problems = []
    z = zipfile.ZipFile(zip_path)
    if z.testzip() is not None:
        problems.append("zip is damaged")
    names = {i.filename for i in z.infolist()}
    manifest = json.loads(z.read("manifest.json"))
    if manifest.get("version") != version:
        problems.append(f"manifest version {manifest.get('version')} != {version}")
    # every file the manifest names must be in the package
    wanted = [manifest["background"]["service_worker"], manifest["side_panel"]["default_path"]]
    wanted += list(manifest.get("icons", {}).values()) + list(manifest["action"]["default_icon"].values())
    for cs in manifest.get("content_scripts", []):
        wanted += cs.get("js", [])
    for w in wanted:
        if w not in names:
            problems.append(f"manifest references missing file: {w}")
    # every relative import in a script and every script/stylesheet an HTML page loads must exist
    for n in sorted(names):
        text = z.read(n).decode("utf-8", "replace") if n.endswith((".js", ".html")) else ""
        if n.endswith(".js"):
            for m in re.finditer(r'''(?:from|import)\s*\(?\s*["']\./([^"']+)["']''', text):
                if m.group(1) not in names:
                    problems.append(f"{n} imports ./{m.group(1)}, which is not in the package")
        if n.endswith(".html"):
            for m in re.finditer(r'''(?:src|href)="([^"#:]+\.(?:js|css|png))"''', text):
                if m.group(1) not in names:
                    problems.append(f"{n} loads {m.group(1)}, which is not in the package")
    for n in names:
        if n.endswith((".py", ".pyc")) or "__pycache__" in n:
            problems.append(f"developer file in package: {n}")
        if any(ord(ch) < 9 for ch in z.read(n).decode("latin-1")[:0]):
            pass
    return problems, manifest, len(names)


def main():
    manifest = json.load(open(os.path.join(HERE, "manifest.json"), encoding="utf-8"))
    version = manifest["version"]
    out_dir = os.path.join(ROOT, "builds", f"v{version}")
    os.makedirs(out_dir, exist_ok=True)
    zip_path = os.path.join(out_dir, f"SalesTeam-v{version}.zip")
    if os.path.exists(zip_path):
        os.remove(zip_path)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for full, rel in package_files():
            z.write(full, rel)
    with open(os.path.join(HERE, "manifest.json"), "rb") as src, open(os.path.join(out_dir, "manifest.json"), "wb") as dst:
        dst.write(src.read())
    problems, manifest_in_zip, count = check(zip_path, version)
    size_kb = os.path.getsize(zip_path) / 1024
    print(f"Built {zip_path}\n  {count} files, {size_kb:.0f} KB, version {version}")
    print(f"  permissions: {manifest_in_zip['permissions']}")
    print(f"  host permissions: {manifest_in_zip['host_permissions']}")
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("Checks passed: valid zip, manifest matches, every referenced/imported file is in the package, no developer files.")


if __name__ == "__main__":
    main()
