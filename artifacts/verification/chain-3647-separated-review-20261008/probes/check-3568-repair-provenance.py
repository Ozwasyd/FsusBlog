#!/usr/bin/env python3
"""Verify already-present canonical lock repair without modifying review heads."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import posixpath
import subprocess
import xml.etree.ElementTree as ET

parser = argparse.ArgumentParser()
parser.add_argument('--repo', required=True)
parser.add_argument('--prerequisite-root', required=True)
parser.add_argument('--docs-root', required=True)
parser.add_argument('--dotnet', required=True)
parser.add_argument('--out', required=True)
args = parser.parse_args()
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
refs = {
    'acceptedBase': 'aaba7b8c84ecfb336c71443e30d9fd82d21fb16d',
    'supplier': 'ea4e47dd2979cdab87e5287c33888fbbf7e6d768',
    'previousSupplier': 'b104b99d84b91af577336efd6430d492c25683c9',
    'establishedRepair': '53075182a4cccf400e1a389d5dfc7dca5ab4d09d',
    'prerequisite': '4fde8307d43ca8ee1b38cf71fbde3786f6ae46f5',
    'docs': '7288b3b0e0211b2c0fa0531ab01e657e4f5e57c2',
}

def git(*arguments):
    return subprocess.check_output(['git', '-C', args.repo, *arguments])

def source(ref, path):
    return git('show', ref + ':' + path)

roots = {'prerequisite': args.prerequisite_root, 'docs': args.docs_root}
for scope, root in roots.items():
    assert subprocess.check_output(['git', '-C', root, 'rev-parse', 'HEAD'], text=True).strip() == refs[scope]
    assert not subprocess.check_output(['git', '-C', root, 'status', '--porcelain', '--untracked-files=no'])

projects = set()
todo = ['tests/backend/FsusBlog.Server.Tests.csproj']
while todo:
    path = todo.pop()
    if path in projects:
        continue
    projects.add(path)
    for element in ET.fromstring(source(refs['docs'], path)).iter():
        if element.tag.split('}')[-1] == 'ProjectReference':
            todo.append(posixpath.normpath(posixpath.join(posixpath.dirname(path), element.attrib['Include'].replace('\\', '/'))))
        assert element.tag.split('}')[-1] != 'Import', 'Review new explicit import before widening graph comparison'

tree_paths = git('ls-tree', '-r', '--name-only', refs['docs']).decode().splitlines()
parents = {'.'}
for project in projects:
    parents.update(str(parent) for parent in Path(project).parents)
controls = {path for path in tree_paths if Path(path).parent.as_posix() in parents and Path(path).name in {'Directory.Build.props', 'Directory.Build.targets', 'Directory.Packages.props', 'global.json', 'NuGet.Config', 'nuget.config'}}
paths = sorted(projects | controls | {posixpath.join(posixpath.dirname(path), 'packages.lock.json') for path in projects})
rows = []
for path in paths:
    row = {'path': path, 'gitBlob': {}, 'sha256': {}}
    for name, ref in refs.items():
        data = source(ref, path)
        row['gitBlob'][name] = git('rev-parse', ref + ':' + path).decode().strip()
        row['sha256'][name] = hashlib.sha256(data).hexdigest()
        if name in roots:
            assert (Path(roots[name]) / path).read_bytes() == data
    if path != 'tests/backend/packages.lock.json':
        assert len(set(row['sha256'].values())) == 1, path
    rows.append(row)

locks = {name: json.loads(source(ref, 'tests/backend/packages.lock.json')) for name, ref in refs.items()}
expected = json.loads(json.dumps(locks['acceptedBase']))
repaired = []
for framework, graph in expected['dependencies'].items():
    if 'fsusblog.server' in graph:
        assert 'AngleSharp' not in graph['fsusblog.server']['dependencies']
        graph['fsusblog.server']['dependencies']['AngleSharp'] = '[1.5.0, )'
        repaired.append(framework)
assert repaired == ['net10.0']
for name in refs:
    if name != 'acceptedBase':
        assert locks[name] == expected, name
lock_row = next(row for row in rows if row['path'] == 'tests/backend/packages.lock.json')
assert len({value for name, value in lock_row['gitBlob'].items() if name != 'acceptedBase'}) == 1

evaluations = []
for scope, root in roots.items():
    for project in ['tests/backend/FsusBlog.Server.Tests.csproj', 'src/backend/FsusBlog.Server.csproj']:
        command = [args.dotnet, 'msbuild', project, '-nologo', '-p:RestoreLockedMode=true', '-p:NuGetAudit=true', '-getItem:ProjectReference,PackageReference,PackageVersion', '-getProperty:TargetFramework,ManagePackageVersionsCentrally,RestorePackagesWithLockFile,RestoreLockedMode,NuGetAudit,MSBuildAllProjects']
        result = subprocess.run(command, cwd=root, env=os.environ.copy(), capture_output=True, text=True)
        assert result.returncode == 0, result.stderr + result.stdout
        evaluated = json.loads(result.stdout)
        assert evaluated['Properties']['RestoreLockedMode'] == 'true'
        assert evaluated['Properties']['NuGetAudit'] == 'true'
        if project.startswith('src/backend/'):
            assert any(item['Identity'] == 'AngleSharp' for item in evaluated['Items']['PackageReference'])
            assert any(item['Identity'] == 'AngleSharp' and item['Version'] == '1.5.0' for item in evaluated['Items']['PackageVersion'])
        evaluations.append({'scope': scope, 'candidate': refs[scope], 'project': project, 'command': command, 'exitCode': result.returncode, 'stdout': evaluated, 'stderr': result.stderr})

supplier_paths = git('diff', '--name-only', refs['supplier'] + '^1', refs['supplier']).decode().splitlines()
report = {
    'schema': 'fsusblog.canonical-lock-provenance.v1', 'startUtc': started,
    'endUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'refs': refs,
    'projects': sorted(projects), 'graphRows': rows, 'actualMsbuildEvaluations': evaluations,
    'sameMissingProjectEdge': True, 'alreadyPresentAtBothFrozenHeads': True,
    'allDeclaredResolvedVersionsAndPackageHashesUnchanged': True,
    'backendLockBlob': lock_row['gitBlob']['supplier'], 'backendLockSha256': lock_row['sha256']['supplier'],
    'actualSupplierPathsVsFirstParent': supplier_paths,
    'supplierRangeDiscrepancy': 'Includes ordinary naming metadata in addition to the one-line backend lock repair; not a lock-only total commit diff.',
    'newlyEnabledFormalChecks': [], 'testRunsRepeated': False,
    'decision': 'Already present: do not cherry-pick, regenerate, or move frozen review heads. Record exact provenance only.',
    'supplierAcceptanceInherited': False, 'sqliteNu1903': 'Separate existing real warning retained in original audit-on restore receipts; not repaired or waived.',
    'existingLocalReceipts': 'summary.json: exact prerequisite248/248 and docs15/15 plus audit-on locked restores already ran at these frozen candidates; their SHAs are not rebound to supplier.',
}
for scope, root in roots.items():
    assert subprocess.check_output(['git', '-C', root, 'rev-parse', 'HEAD'], text=True).strip() == refs[scope]
    assert not subprocess.check_output(['git', '-C', root, 'status', '--porcelain', '--untracked-files=no'])
Path(args.out).write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'output': args.out, 'projectsCompared': len(projects), 'graphFilesCompared': len(rows), 'evaluations': len(evaluations), 'alreadyPresent': True, 'backendLockBlob': report['backendLockBlob']}))
