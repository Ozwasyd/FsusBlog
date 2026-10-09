"""Hash this task's evidence bytes without rewriting raw receipts."""

import hashlib
import json
from pathlib import Path


root = Path(__file__).resolve().parent
manifest = root / "evidence-manifest.json"
rows = []
for source in sorted(root.iterdir()):
    if source.is_file() and source != manifest:
        raw = source.read_bytes()
        rows.append({
            "path": source.name,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "bytes": len(raw),
        })

manifest.write_text(json.dumps({
    "testedGeneratedSource": "1767ca27ae78782ea3cf0d599a8149007b501683",
    "runtimeSourceNotRelabelled": "74c0bdb904a1ec320cade56367da8a17e2b7b0c1",
    "hashAlgorithm": "SHA256",
    "fileCount": len(rows),
    "files": rows,
}, indent=4) + "\n")

for row in rows:
    raw = (root / row["path"]).read_bytes()
    assert len(raw) == row["bytes"]
    assert hashlib.sha256(raw).hexdigest() == row["sha256"]
print(f"Verified {len(rows)} task evidence files")
