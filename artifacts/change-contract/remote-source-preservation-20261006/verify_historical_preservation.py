#!/usr/bin/env python3
"""Read-only provenance verifier. It does not certify semantic review or CI.
Produces a fresh report on stdout; no checkout, Git mutations or outward writes.
"""
import argparse
import copy
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path


def execute(repository, command):
    result = subprocess.run(command, cwd=repository, capture_output=True, text=True, env={**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1'})
    if result.returncode:
        raise ValueError('command failed: ' + ' '.join(command[:5]))
    return result.stdout


def git(repository, *arguments):
    return execute(repository, ['git', '--no-replace-objects', *arguments])


def identity(repository, revision, path):
    line = git(repository, 'ls-tree', revision, '--', path).strip()
    if not line:
        return None
    meta, name = line.split('\t', 1)
    mode, kind, blob = meta.split()
    if name != path or kind != 'blob' or mode not in ('100644', '100755'):
        raise ValueError('non-regular/ambiguous path: ' + path)
    return {'mode': mode, 'type': kind, 'blob': blob}


def checked(condition, message):
    if not condition:
        raise ValueError(message)


def validate_shape(manifest):
    checked(manifest['schema'] == 'fsusblog.historical-remote-source-preservation.v1', 'schema mismatch')
    checked(manifest['generated'] is False and manifest['currentAcceptanceClaim'] is False and manifest['issueClosureClaim'] is False, 'authority/acceptance inflation')
    checked(re.fullmatch('[0-9a-f]{40}', manifest['auditedMaster']) is not None, 'bad master')
    refs = set()
    for row in manifest['rows']:
        checked(row['ref'].startswith('refs/heads/') and row['ref'] not in refs, 'duplicate/invalid ref')
        refs.add(row['ref'])
        checked(not row['substantiveHeadChangesAfterPRSource'], 'unmerged post-PR increment')
        checked(set(row['wipMetadataPaths']) <= {'.wip/20261005/WIP.md'}, 'valuable source laundered as WIP metadata')
        checked({p['path'] for p in row['wipMetadataIdentities']} == set(row['wipMetadataPaths']), 'WIP metadata identities missing')
        paths = set()
        for value in row['ownedPaths']:
            path = value['path']
            checked(path not in paths and not path.startswith('/') and '..' not in Path(path).parts, 'duplicate/unsafe path')
            paths.add(path)
            for field in ('sourceToCurrentDiff', 'originalOwnedIncrement'):
                digest = hashlib.sha256(value[field].encode()).hexdigest()
                checked(digest == value[field + 'Sha256'], 'diff witness hash drift: ' + path)
            checked(value['mappingKind'] in ('exact-mode-blob', 'reviewed-current-owner-increment'), 'unknown mapping kind')
            if value['mappingKind'] == 'exact-mode-blob':
                checked(value['source'] == value['currentMaster'], 'false exact mapping')
            else:
                checked(bool(value['preservation']) and bool(value['sourceToCurrentDiff']), 'missing semantic review witness')
    return len(refs)


def verify(repository, manifest, remote, pull_requests):
    count = validate_shape(manifest)
    checked(remote.get('refs/heads/master') == manifest['auditedMaster'], 'master moved; re-audit all current owner mappings')
    summaries = []
    for row in manifest['rows']:
        checked(remote.get(row['ref']) == row['expectedRemoteHead'], 'remote CAS drift: ' + row['ref'])
        pr = pull_requests[str(row['pr'])]
        checked(pr['state'] == 'MERGED' and pr['headRefOid'] == row['sourceHead'] and pr['mergeCommit']['oid'] == row['mergeSha'], 'GitHub immutable PR/source/merge mismatch')
        git(repository, 'merge-base', '--is-ancestor', row['mergeSha'], manifest['auditedMaster'])
        actual_base = git(repository, 'merge-base', manifest['auditedMaster'], row['expectedRemoteHead']).strip()
        checked(actual_base == row['mergeBase'], 'merge-base drift')
        actual_owned = set(git(repository, 'diff', '--name-only', '--no-renames', actual_base, row['expectedRemoteHead']).splitlines())
        checked(actual_owned == {v['path'] for v in row['ownedPaths']} | set(row['wipMetadataPaths']), 'ALL-owned-path omission')
        for metadata in row['wipMetadataIdentities']:
            checked(identity(repository, row['expectedRemoteHead'], metadata['path']) == {k: metadata[k] for k in ('mode', 'type', 'blob')}, 'WIP metadata mode/blob drift')
        post_source = set(git(repository, 'diff', '--name-only', '--no-renames', row['sourceHead'], row['expectedRemoteHead']).splitlines())
        checked(post_source <= set(row['wipMetadataPaths']), 'hidden post-PR source increment')
        semantic = []
        for value in row['ownedPaths']:
            path = value['path']
            for field, revision in [('source', row['sourceHead']), ('remoteHead', row['expectedRemoteHead']), ('merge', row['mergeSha']), ('currentMaster', manifest['auditedMaster'])]:
                checked(identity(repository, revision, path) == value[field], 'object/mode drift: ' + field + ':' + path)
            checked(value['source'] == value['merge'], 'source not retained at bound merge: ' + path)
            for field, before, after in [('sourceToCurrentDiff', row['sourceHead'], manifest['auditedMaster']), ('originalOwnedIncrement', row['mergeBase'], row['sourceHead'])]:
                diff = git(repository, 'diff', '--no-ext-diff', '--no-textconv', before, after, '--', path)
                checked(diff == value[field], 'diff witness mismatch: ' + field + ':' + path)
            if value['mappingKind'] == 'reviewed-current-owner-increment':
                semantic.append(path)
        summaries.append({'ref': row['ref'], 'allOwnedPathCount': len(row['ownedPaths']), 'provenanceVerified': True, 'semanticReviewStillRequiredFor': semantic, 'issueWIPLinksRecorded': row['currentWIPIssueCommentLinks'], 'deleteAuthorized': False})
    return {'schema': 'fsusblog.historical-source-preservation-verification.v1', 'master': manifest['auditedMaster'], 'refs': count, 'ownedPaths': sum(len(r['ownedPaths']) for r in manifest['rows']), 'rows': summaries, 'currentCIQualified': False, 'issueAcceptanceCertified': False, 'deleteAuthorized': False}


def self_test(repository, manifest, remote, pull_requests):
    validate_shape(manifest)
    cases = []
    variants = [('claim-inflation', lambda m: m.update(currentAcceptanceClaim=True)), ('duplicate-ref', lambda m: m['rows'].append(copy.deepcopy(m['rows'][0]))), ('hidden-post-PR-source', lambda m: m['rows'][0].update(substantiveHeadChangesAfterPRSource=['src/valuable.cs'])), ('unsafe-path', lambda m: m['rows'][0]['ownedPaths'][0].update(path='../outside')), ('witness-tamper', lambda m: m['rows'][0]['ownedPaths'][0].update(sourceToCurrentDiff='changed')), ('source-laundered-as-metadata', lambda m: m['rows'][0]['wipMetadataPaths'].append('src/valuable.cs'))]
    for name, mutate in variants:
        probe = copy.deepcopy(manifest)
        mutate(probe)
        try:
            validate_shape(probe)
        except ValueError:
            cases.append(name)
        else:
            raise ValueError('negative control unexpectedly accepted: ' + name)
    for name in ('owned-path-omission', 'remote-CAS-drift', 'current-master-drift', 'GitHub-head-drift', 'current-blob-drift'):
        probe = copy.deepcopy(manifest)
        remote_probe = dict(remote)
        pr_probe = copy.deepcopy(pull_requests)
        if name == 'owned-path-omission':
            probe['rows'][0]['ownedPaths'].pop()
        elif name == 'remote-CAS-drift':
            remote_probe[probe['rows'][0]['ref']] = '0' * 40
        elif name == 'current-master-drift':
            remote_probe['refs/heads/master'] = '0' * 40
        elif name == 'GitHub-head-drift':
            pr_probe[str(probe['rows'][0]['pr'])]['headRefOid'] = '0' * 40
        else:
            value = probe['rows'][0]['ownedPaths'][-1]
            value['currentMaster']['blob'] = '0' * 40
        try:
            verify(repository, probe, remote_probe, pr_probe)
        except ValueError:
            cases.append(name)
        else:
            raise ValueError('bound-source negative control unexpectedly accepted: ' + name)
    return cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--self-test', action='store_true')
    arguments = parser.parse_args()
    manifest = json.loads(Path(arguments.manifest).read_text())
    repository = arguments.repository
    output = git(repository, 'ls-remote', '--heads', 'origin')
    remote = {line.split()[1]: line.split()[0] for line in output.splitlines()}
    pull_requests = {}
    for row in manifest['rows']:
        pull_requests[str(row['pr'])] = json.loads(execute(repository, ['gh', 'pr', 'view', str(row['pr']), '--repo', manifest['repository'], '--json', 'number,state,headRefOid,mergeCommit']))
    report = verify(repository, manifest, remote, pull_requests)
    if arguments.self_test:
        report['negativeControls'] = self_test(repository, manifest, remote, pull_requests)
    print(json.dumps(report, indent=4))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
