"""Hash this task's original receipts without rewriting raw evidence."""

import hashlib
import json
from pathlib import Path


root = Path(__file__).resolve().parent
manifest = root / "evidence-manifest.json"
rows = []
for source in sorted(root.rglob("*")):
    if source.is_file() and source != manifest:
        raw = source.read_bytes()
        rows.append({
            "path": source.relative_to(root).as_posix(),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        })

manifest.write_text(json.dumps({
    "testedSource": "018fe311aa6a214cc698281edcac23e6cd4704cf",
    "priorRuntimeSourceNotRelabelled": "74c0bdb904a1ec320cade56367da8a17e2b7b0c1",
    "hashAlgorithm": "SHA256",
    "fileCount": len(rows),
    "files": rows,
}, indent=4) + "\n")

for row in rows:
    raw = (root / row["path"]).read_bytes()
    assert len(raw) == row["bytes"]
    assert hashlib.sha256(raw).hexdigest() == row["sha256"]
print(f"Verified {len(rows)} task evidence files")
