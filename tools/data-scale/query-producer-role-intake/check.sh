#!/usr/bin/env bash
set -euo pipefail

scriptRoot="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
articleCommit=1440291b065a8e30b6d5f64ed864c090d5a9d79e
commentCommit=8822207ec995f4346eed20f27393b172dd51343a
articleSourceRoot=""
commentSourceRoot=""
evidenceDirectory=""
scratchDirectory=""

Fail()
{
    printf 'query producer refusal controls: %s\n' "$1" >&2
    exit 1
}

Cleanup()
{
    if [[ -n "$scratchDirectory" ]]; then
        rm -rf -- "$scratchDirectory"
    fi
}
trap Cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --help)
            [[ $# -eq 1 ]] || Fail "--help cannot be combined with additional options"
            cat <<'HELP'
Usage: check.sh --article-source-root <absolute Git root> --comment-source-root <absolute Git root> --evidence-directory <new absolute directory>

Compile test/evidence-only refusal controls using immutable article source
1440291b065a8e30b6d5f64ed864c090d5a9d79e and comment backend source
8822207ec995f4346eed20f27393b172dd51343a. The configured Git roots must contain
these commits; their current working-tree contents are not consumed.

All producer and harness build files are temporary. The new evidence directory
retains source hashes and unmodified stage output, including the first failure.
No producer objects, physical IDs, receipts or production queries are generated.
HELP
            exit 0
            ;;
        --article-source-root | --comment-source-root | --evidence-directory)
            [[ $# -ge 2 && -n "$2" ]] || Fail "missing option value: $1"
            case "$1" in
                --article-source-root) articleSourceRoot="$2" ;;
                --comment-source-root) commentSourceRoot="$2" ;;
                --evidence-directory) evidenceDirectory="$2" ;;
            esac
            shift 2
            ;;
        *) Fail "unknown option: $1" ;;
    esac
done
[[ -n "$articleSourceRoot" && -n "$commentSourceRoot" && -n "$evidenceDirectory" ]] \
    || Fail "explicit article/comment Git source roots and a new evidence directory are required"

for sourceRoot in "$articleSourceRoot" "$commentSourceRoot"; do
    [[ "$sourceRoot" == /* && -d "$sourceRoot" && ! -L "$sourceRoot" ]] \
        || Fail "source roots must be absolute Git directories"
    [[ "$(git -C "$sourceRoot" rev-parse --show-toplevel)" == "$(realpath "$sourceRoot")" ]] \
        || Fail "source root must name the Git worktree root"
done
[[ "$(git -C "$articleSourceRoot" cat-file -t "$articleCommit")" == commit ]] \
    || Fail "exact article commit is unavailable"
[[ "$(git -C "$commentSourceRoot" cat-file -t "$commentCommit")" == commit ]] \
    || Fail "exact comment commit is unavailable"
[[ "$evidenceDirectory" == /* && ! -e "$evidenceDirectory" && ! -L "$evidenceDirectory" ]] \
    || Fail "evidence directory must be absolute and new; prior failure output must not be overwritten"
mkdir -p -- "$evidenceDirectory"
evidenceDirectory="$(realpath "$evidenceDirectory")"
scratchDirectory="$(mktemp -d /tmp/fsusblog-query-producer-controls.XXXXXXXX)"
mkdir -- "$scratchDirectory/comment" "$scratchDirectory/article" "$scratchDirectory/harness"

# Archive immutable commits, never working-tree files or prebuilt assemblies.
# Git source roots supply objects; their current HEAD is not claimed as a producer.
git -C "$commentSourceRoot" archive "$commentCommit" | tar -x -C "$scratchDirectory/comment"
identityPath=src/backend/Services/Fixtures/DataScale/ArticleScaleGraphIdentityBindings.cs
git -C "$articleSourceRoot" show "$articleCommit:$identityPath" > "$scratchDirectory/article/ArticleScaleGraphIdentityBindings.cs"
cmp "$scratchDirectory/article/ArticleScaleGraphIdentityBindings.cs" \
    <(git -C "$articleSourceRoot" show "$articleCommit:$identityPath") \
    || Fail "article identity source bytes differ from the exact commit"
planPath=src/backend/Services/Fixtures/DataScale/ArticleScalePlan.cs
[[ "$(git -C "$articleSourceRoot" rev-parse "$articleCommit:$planPath")" \
    == "$(git -C "$commentSourceRoot" rev-parse "$commentCommit:$planPath")" ]] \
    || Fail "linked article identity dependency differs between producer commits"
[[ ! -e "$scratchDirectory/comment/$identityPath" ]] \
    || Fail "comment source already defines article identity bindings"

python3 - "$articleSourceRoot" "$commentSourceRoot" "$articleCommit" "$commentCommit" \
    "$scratchDirectory" "$scriptRoot" "$evidenceDirectory/source-manifest.json" <<'PY'
import hashlib
import json
from pathlib import Path
import subprocess
import sys

article_root, comment_root, article_commit, comment_commit, scratch, controls, output = sys.argv[1:]
entries = []
producer_directory = 'src/backend/Services/Fixtures/DataScale/'
sources = [(article_root, article_commit, producer_directory + 'ArticleScaleGraphIdentityBindings.cs',
            Path(scratch) / 'article/ArticleScaleGraphIdentityBindings.cs')]
for name in ['ArticleScalePlan.cs', 'CommentScalePlan.cs', 'CanonicalCommentGraphModels.cs',
             'CanonicalCommentGraphResolution.cs', 'CanonicalCommentGraphFactory.cs', 'CommentScalePolicyResolver.cs']:
    path = producer_directory + name
    sources.append((comment_root, comment_commit, path, Path(scratch) / 'comment' / path))
for root, commit, path, extracted in sources:
    original = subprocess.check_output(['git', '-C', root, 'show', f'{commit}:{path}'])
    if extracted.is_symlink() or not extracted.is_file() or extracted.read_bytes() != original:
        raise SystemExit(f'exact producer source mismatch: {path}')
    entries.append({'sourceCommit': commit, 'path': path,
                    'gitBlob': subprocess.check_output(['git', '-C', root, 'rev-parse', f'{commit}:{path}'], text=True).strip(),
                    'contentDigest': 'sha256:' + hashlib.sha256(original).hexdigest()})
control_sources = []
for name in ['QueryProducerRoleIntake.cs', 'QueryProducerRoleIntakeControls.cs', 'check.sh']:
    path = Path(controls) / name
    if path.is_symlink() or not path.is_file():
        raise SystemExit(f'control source must be a regular file: {name}')
    control_sources.append({'path': 'tools/data-scale/query-producer-role-intake/' + name,
                            'contentDigest': 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()})
manifest = {'scope': 'compiled-refusal-controls-only', 'qualification': False, 'releaseEvidenceEligible': False,
            'commentBackendTree': subprocess.check_output(['git', '-C', comment_root, 'rev-parse', f'{comment_commit}^{{tree}}'], text=True).strip(),
            'producerSources': entries, 'controlSources': control_sources}
Path(output).write_text(json.dumps(manifest, indent=4) + '\n', encoding='utf-8')
PY

cp -- "$scriptRoot/QueryProducerRoleIntake.cs" "$scriptRoot/QueryProducerRoleIntakeControls.cs" "$scratchDirectory/harness/"
cat > "$scratchDirectory/harness/QueryProducerRoleIntakeControls.csproj" <<'XML'
<Project Sdk="Microsoft.NET.Sdk">
    <PropertyGroup>
        <TargetFramework>net10.0</TargetFramework>
        <OutputType>Exe</OutputType>
        <ImplicitUsings>enable</ImplicitUsings>
        <Nullable>enable</Nullable>
    </PropertyGroup>
    <ItemGroup>
        <ProjectReference Include="../comment/src/backend/FsusBlog.Server.csproj" />
        <Compile Include="../article/ArticleScaleGraphIdentityBindings.cs" Link="OriginalProducer/ArticleScaleGraphIdentityBindings.cs" />
    </ItemGroup>
</Project>
XML

if [[ -f /workspace/.setup/activate.sh ]]; then
    source /workspace/.setup/activate.sh
fi
command -v dotnet >/dev/null || Fail ".NET SDK is unavailable"
command -v timeout >/dev/null || Fail "timeout is unavailable"
dotnet --info > "$evidenceDirectory/dotnet-info.log" 2>&1

RunLogged()
{
    local logName="$1"
    shift
    if "$@" > "$evidenceDirectory/$logName.log" 2>&1; then
        cat "$evidenceDirectory/$logName.log"
    else
        local exitCode=$?
        cat "$evidenceDirectory/$logName.log" >&2
        printf 'First failing stage: %s (exit %s); output preserved in %s\n' \
            "$logName" "$exitCode" "$evidenceDirectory" >&2
        exit "$exitCode"
    fi
}

VerifyManifestSources()
{
    python3 - "$evidenceDirectory/source-manifest.json" "$scriptRoot" "$scratchDirectory" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

manifest_path, controls, scratch = sys.argv[1:]
manifest = json.loads(Path(manifest_path).read_text())
for entry in manifest['controlSources']:
    name = Path(entry['path']).name
    paths = [Path(controls) / name]
    if name.endswith('.cs'):
        paths.append(Path(scratch) / 'harness' / name)
    for path in paths:
        if path.is_symlink() or not path.is_file() or 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest() != entry['contentDigest']:
            raise SystemExit(f'control source changed during compiled check: {entry["path"]}')
for entry in manifest['producerSources']:
    if entry['path'].endswith('/ArticleScaleGraphIdentityBindings.cs'):
        path = Path(scratch) / 'article/ArticleScaleGraphIdentityBindings.cs'
    else:
        path = Path(scratch) / 'comment' / entry['path']
    if path.is_symlink() or not path.is_file() or 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest() != entry['contentDigest']:
        raise SystemExit(f'producer source changed during compiled check: {entry["path"]}')
print('PASS: exact consumer, controls, script and producer source bytes remain bound to the manifest.')
PY
}

RunLogged restore-backend timeout 180 dotnet restore "$scratchDirectory/comment/src/backend/FsusBlog.Server.csproj" --locked-mode
RunLogged restore-harness timeout 180 dotnet restore "$scratchDirectory/harness/QueryProducerRoleIntakeControls.csproj" --no-dependencies
for lockPath in src/backend/packages.lock.json src/core/packages.lock.json src/shared/packages.lock.json \
    tools/architecture/FsusBlog.DiLifetimeAnalyzer/packages.lock.json; do
    cmp "$scratchDirectory/comment/$lockPath" <(git -C "$commentSourceRoot" show "$commentCommit:$lockPath") \
        || Fail "native dependency lock bytes changed during restore: $lockPath"
done
RunLogged build timeout 300 dotnet build "$scratchDirectory/harness/QueryProducerRoleIntakeControls.csproj" \
    --no-restore --configuration Release -p:PublishClientAssets=false -p:FsusBlogCommitSha="$commentCommit"
RunLogged source-binding-before-controls VerifyManifestSources
RunLogged controls timeout 30 dotnet "$scratchDirectory/harness/bin/Release/net10.0/QueryProducerRoleIntakeControls.dll"
RunLogged source-binding-after-controls VerifyManifestSources
printf 'Compiled refusal source manifest and output: %s\n' "$evidenceDirectory"
