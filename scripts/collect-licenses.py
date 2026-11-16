"""Collect available upstream license/NOTICE files for packaged dependencies.

Does not copy source code, credentials, local paths or application data.
Run after npm ci and cargo dependency resolution, before release packaging.
"""
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def license_files(folder):
    result = []
    for file in sorted(folder.iterdir()):
        if file.is_file() and file.name.lower().startswith(("license", "licence", "copying", "notice", "copyright")):
            result.append(file)
    return result


sections = ["Local Workbench — third-party dependency notices\n\n"
            "Original application license: ../LICENSE. React Bits: react-bits-LICENSE.md.\n"
            "This inventory includes available upstream notices for installed npm production\n"
            "dependencies and the Windows Rust dependency graph, including build dependencies.\n"
            "Each dependency retains its own license; declared SPDX expressions are informational.\n"]


def add(name, version, declared, folder):
    files = license_files(folder)
    sections.append(f"\n{'=' * 76}\n{name} {version}\nDeclared license: {declared}\n")
    if not files:
        sections.append("No separate top-level notice file was included in this package distribution.\n")
    for file in files:
        sections.append(f"\n--- {file.name} ---\n" + file.read_text(encoding="utf-8", errors="replace") + "\n")


cmd = "npm ls --omit=dev --all --parseable"
result = subprocess.run(cmd if os.name == "nt" else cmd.split(), cwd=ROOT, shell=os.name == "nt", capture_output=True, text=True, encoding="utf-8", errors="replace")
paths = [Path(line.strip()) for line in result.stdout.splitlines() if line.strip()]
seen = set()
for folder in paths:
    if folder == ROOT or not (folder / "package.json").is_file():
        continue
    info = json.loads((folder / "package.json").read_text(encoding="utf-8"))
    key = (info["name"], info.get("version", ""))
    if key in seen:
        continue
    seen.add(key)
    add(*key, info.get("license", "See upstream notices"), folder)

result = subprocess.run(["cargo", "metadata", "--manifest-path", "src-tauri/Cargo.toml", "--filter-platform", "x86_64-pc-windows-msvc", "--format-version", "1", "--locked"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True)
metadata = json.loads(result.stdout)
nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
visited, queue = set(), [metadata["resolve"]["root"]]
while queue:
    current = queue.pop()
    if current in visited:
        continue
    visited.add(current)
    queue.extend(nodes[current]["dependencies"])
for package in sorted(metadata["packages"], key=lambda p: (p["name"], p["version"])):
    if package["id"] not in visited or not package.get("source"):
        continue
    add(package["name"], package["version"], package.get("license") or "See upstream notices", Path(package["manifest_path"]).parent)

target = ROOT / "licenses" / "DEPENDENCY-LICENSES.txt"
target.write_text("\n".join(sections), encoding="utf-8")
print(f"Collected notices: {len(seen)} npm packages, {len(visited) - 1} Rust packages; {target.stat().st_size:,} bytes.")
