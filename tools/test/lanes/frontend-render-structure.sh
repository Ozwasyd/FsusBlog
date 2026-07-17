#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
npm --prefix "$ROOT_DIR/src/frontend" run check:dom-depth-static
npm --prefix "$ROOT_DIR/src/frontend" run check:markdown-render-budget

mkdir -p "$ROOT_DIR/.tmp/release-evidence"
node -e 'const fs=require("node:fs");const file=process.argv[1];const existing=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};fs.writeFileSync(file,JSON.stringify({...existing,schema:"fsusblog.frontend-render-structure.v1",status:"ok",evidenceClass:"correctness",affectsCorrectness:true,executionBoundary:"browserless-static-analysis",checks:["dom-depth-static","markdown-render-budget"]},null,2)+"\n")' \
  "$ROOT_DIR/.tmp/release-evidence/frontend-render-structure-summary.json"
