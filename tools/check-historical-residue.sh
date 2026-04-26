#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[residue-check] verifying legacy gateway markers..."
if rg -n "ILegacy|Legacy[A-Za-z]+Gateway" FsusBlog.Core FsusBlog.Server FsusBlog.Client FsusBlog.Shared; then
  echo "[residue-check] legacy gateway residue detected"
  exit 1
fi

echo "[residue-check] verifying obsolete AOT shell builder names..."
if rg -n "BuildHomeShell|BuildArticleDetailShell|BuildFilterShell|BuildAboutShell|BuildArchiveShell" FsusBlog.Server/Infrastructure/PublicAot/PublicAotShellService.cs; then
  echo "[residue-check] obsolete AOT shell builder names detected"
  exit 1
fi

echo "[residue-check] verifying old dto aliases..."
if rg -n "\b(ArticleListDto|ArticleDetailDto|CategoryDto|PageResultDto|CursorResult|SeoConfigDto|PageContentDto|UserCommentDto|ArticleDto|SearchDto|ArticleQueryRequestDto)\b" FsusBlog.Server FsusBlog.Shared FsusBlog.Client; then
  echo "[residue-check] old dto alias residue detected"
  exit 1
fi

echo "[residue-check] passed"
