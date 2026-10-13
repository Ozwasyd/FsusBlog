import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from xml.etree import ElementTree

root = Path(sys.argv[1])
source = "bd41be32ecae1f8b9b4797dab8c5a90807334df8"
base = "18f667c8108689f65b72e92a3a41e00e40a27b20"
wire = "dedf804ad6231affb698c4ddddb110be68207085"
delivery = "914c3f2cf6247687f89bc5fff508ff184d41e0c3"
prototype = "d33a417865ec41b16d7470178288a5d78679f553"

def git(*args):
    return subprocess.check_output(["git", "-C", str(root), *args])

assert git("rev-parse", "HEAD").decode().strip() == source
binding = json.loads(git("show", delivery + ":artifacts/package-candidate-review-wire/source-bindings.json"))
roster = []
for item in binding["ownedFiles"] + binding["consumedDependencies"]:
    path = item["path"]
    supplied = git("show", wire + ":" + path)
    assert hashlib.sha256(supplied).hexdigest() == item["sha256"]
    assert git("rev-parse", wire + ":" + path).decode().strip() == item["blob"]
    assert (root / path).read_bytes() == git("show", source + ":" + path) == supplied
    roster.append(path)

extra = [
    "src/frontend/src/composables/useArticlePackageCandidateReadHost.ts",
    "src/frontend/src/composables/useArticlePackageCandidateReview.ts",
    "src/frontend/src/components/admin/article-packages/ArticlePackageCandidateReview.vue",
    "tests/frontend/unit/components/admin/ArticlePackageCandidateReview.test.ts",
    "tests/frontend/unit/composables/useArticlePackageCandidateReadHost.test.ts",
    "tests/frontend/unit/composables/useArticlePackageCandidateReview.test.ts",
]
for path in extra:
    assert (root / path).read_bytes() == git("show", source + ":" + path) == git("show", prototype + ":" + path)
roster.extend(extra)
assert len(roster) == 47

server_project = "src/backend/FsusBlog.Server.csproj"
test_project = "tests/backend/FsusBlog.Server.Tests.csproj"
old_route = "Modules/Endpoints/AuthoringEndpoints.ArticlePackageCandidateRoutes.cs"
old_test = "Unit/ArticlePackageCandidateReadEndpointTests.cs"
old_paths = {
    "src/backend/" + old_route: "1004ba200a29c15a91604dd55e6f788d7e08c668",
    "tests/backend/" + old_test: "8e522aa641f7fa5d08d2355f231e28fa436aae8a",
}
for path, blob in old_paths.items():
    assert git("rev-parse", prototype + ":" + path).decode().strip() == blob
    assert not (root / path).exists()

def removes(path, commit):
    document = ElementTree.fromstring(git("show", commit + ":" + path))
    return [item.get("Remove", "").replace("\\", "/") for item in document.iter("Compile") if "Remove" in item.attrib]

server_removes = removes(server_project, source)
test_removes = removes(test_project, source)
assert server_removes == removes(server_project, base) + [old_route]
assert test_removes == [old_test] + removes(test_project, base)
for project, exclusion in [(server_project, old_route), (test_project, old_test)]:
    document = ElementTree.fromstring(git("show", source + ":" + project))
    matches = [(group, item) for group in document if group.tag == "ItemGroup" for item in group if item.tag == "Compile" and item.get("Remove", "").replace("\\", "/") == exclusion]
    assert len(matches) == 1
    group, item = matches[0]
    assert "Condition" not in group.attrib and "Condition" not in item.attrib

map_pattern = r"(?:private|internal|public)\s+static\s+void\s+MapArticlePackageCandidateReviewRoutes\s*\("
handler_pattern = r"(?:private|internal|public)\s+static\s+async\s+Task<IResult>\s+ReadArticlePackageCandidateReviewAsync\s*\("
current_sources = {path.relative_to(root / "src/backend").as_posix(): path.read_text() for path in (root / "src/backend").rglob("*.cs")}
canonical = "Modules/Endpoints/AuthoringEndpoints.ArticlePackageCandidateReviewRoutes.cs"
assert canonical in current_sources
assert sum(len(re.findall(map_pattern, text)) for text in current_sources.values()) == 1
assert sum(len(re.findall(handler_pattern, text)) for text in current_sources.values()) == 1
# Read-only source-selection projection adds the two exact frozen blobs as inputs.
# It does not execute MSBuild, compile or discover any test.
combined = dict(current_sources)
combined[old_route] = git("show", prototype + ":src/backend/" + old_route).decode()

def projection(server_exclusions, test_exclusions):
    selected = [text for path, text in combined.items() if path not in server_exclusions]
    return {
        "mappingDefinitions": sum(len(re.findall(map_pattern, text)) for text in selected),
        "handlerDefinitions": sum(len(re.findall(handler_pattern, text)) for text in selected),
        "prototypeTestSelected": old_test not in test_exclusions,
    }

before = projection([], [])
after = projection(server_removes, test_removes)
assert before == {"mappingDefinitions": 2, "handlerDefinitions": 2, "prototypeTestSelected": True}
assert after == {"mappingDefinitions": 1, "handlerDefinitions": 1, "prototypeTestSelected": False}
missing_server = projection([p for p in server_removes if p != old_route], test_removes)
missing_test = projection(server_removes, [p for p in test_removes if p != old_test])
assert missing_server["mappingDefinitions"] == missing_server["handlerDefinitions"] == 2
assert missing_test["prototypeTestSelected"]

changed = set(git("diff", "--name-only", base, source).decode().splitlines())
assert changed == set(roster + [server_project, test_project])
assert "MapArticlePackageCandidateReviewRoutes(" not in (root / "src/backend/Modules/Endpoints/AuthoringEndpoints.cs").read_text()
di = (root / "src/backend/Infrastructure/Bootstrap/RuntimeDomainServiceCollectionExtensions.cs").read_text()
assert "ISystemSiteIdentityReader" not in di and "ArticlePackageCandidateReviewReadService" not in di
assert "ArticlePackageCandidateReviewReadRequest" not in (root / "src/shared/Contracts/Validation/aeds-protocol.json").read_text()
git("diff", "--check", base, source)
print(json.dumps({
    "schema": "fsusblog.package-source-composition-check.v1",
    "sourceCommit": source,
    "byteExactConsumedPaths": 47,
    "sourceChangedPaths": 49,
    "actualCanonicalDefinitions": {"mapping": 1, "handler": 1},
    "readOnlyCombinedSourceProjectionBefore": before,
    "readOnlyCombinedSourceProjectionAfter": after,
    "negativeSourceControls": {"omitServerExclusion": missing_server, "omitTestExclusion": missing_test, "omitBoth": before},
    "unrelatedSourceChanges": 0,
    "deletedFiles": 0,
    "routeFrameAbiDiActivated": False,
    "sdkProjectEvaluationCompilationDiscoveryBodies": "UNRUN",
    "runtimeQualification": False,
    "result": "PASS source-only declarations and bounded exact-file XML exclusions",
}, indent=2))
