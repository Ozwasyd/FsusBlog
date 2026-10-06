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
import stat
from pathlib import Path


def execute(repository, command):
    result = subprocess.run(command, cwd=repository, capture_output=True, text=True, env={**{k: v for k, v in os.environ.items() if not k.startswith('GIT_')}, 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_LITERAL_PATHSPECS': '1'})
    if result.returncode:
        raise ValueError('command failed: ' + ' '.join(command[:5]))
    return result.stdout


def git(repository, *arguments):
    return execute(repository, ['git', '--no-optional-locks', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', *arguments])


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
    checked(isinstance(manifest['rows'], list) and bool(manifest['rows']), 'empty owned-source roster')
    refs = set()
    for row in manifest['rows']:
        checked(row['ref'].startswith('refs/heads/') and row['ref'] not in refs, 'duplicate/invalid ref')
        refs.add(row['ref'])
        for field in ('expectedRemoteHead', 'sourceHead', 'mergeSha', 'mergeBase'):
            checked(re.fullmatch('[0-9a-f]{40}', row[field]) is not None, 'bad commit identity: ' + field)
        checked(not row['substantiveHeadChangesAfterPRSource'], 'unmerged post-PR increment')
        checked(set(row['wipMetadataPaths']) <= {'.wip/20261005/WIP.md'}, 'valuable source laundered as WIP metadata')
        checked({p['path'] for p in row['wipMetadataIdentities']} == set(row['wipMetadataPaths']), 'WIP metadata identities missing')
        paths = set()
        for value in row['ownedPaths']:
            path = value['path']
            checked(path not in paths and bool(path) and not path.startswith('/') and '..' not in Path(path).parts and '\x00' not in path and '\n' not in path, 'duplicate/unsafe path')
            paths.add(path)
            for field in ('source', 'remoteHead', 'merge', 'currentMaster'):
                item = value[field]
                checked(item is None or (set(item) == {'mode', 'type', 'blob'} and item['mode'] in ('100644', '100755') and item['type'] == 'blob' and re.fullmatch('[0-9a-f]{40}', item['blob']) is not None), 'invalid mode/blob witness')
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
        checked(pr['number'] == row['pr'] and pr['state'] == 'MERGED' and pr['headRefOid'] == row['sourceHead'] and pr['mergeCommit']['oid'] == row['mergeSha'], 'GitHub immutable PR/source/merge mismatch')
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


def read_regular(path, maximum=16 * 1024 * 1024):
    """Hold the original input FD and refuse symlink/special/changed bytes."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        checked(stat.S_ISREG(before.st_mode) and before.st_size <= maximum, 'regular bounded input required')
        parts = []
        remaining = before.st_size
        while remaining:
            part = os.read(descriptor, min(remaining, 1024 * 1024))
            checked(bool(part), 'input truncated')
            parts.append(part)
            remaining -= len(part)
        checked(not os.read(descriptor, 1), 'input grew')
        after = os.fstat(descriptor)
        fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_mode')
        checked(all(getattr(before, k) == getattr(after, k) for k in fields), 'input physical epoch drift')
        checked(all(getattr(after, k) == getattr(os.stat(path, follow_symlinks=False), k) for k in fields), 'input path substitution')
        raw = b''.join(parts)
        return raw, {'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                     'physical': {k: getattr(after, k) for k in (*fields, 'st_uid', 'st_gid', 'st_nlink')}}
    finally:
        os.close(descriptor)


def repository_witness(repository):
    checked(Path(git(repository, 'rev-parse', '--show-toplevel').strip()).resolve() == Path(repository).resolve(), 'explicit repository root required')
    index = Path(git(repository, 'rev-parse', '--git-path', 'index').strip())
    if not index.is_absolute():
        index = Path(repository) / index
    index_identity = read_regular(index, 256 * 1024 * 1024)[1] if os.path.lexists(index) else None
    return {'head': git(repository, 'rev-parse', '--verify', 'HEAD^{commit}').strip(),
            'symbolicHead': git(repository, 'symbolic-ref', '-q', 'HEAD').strip() if execute_optional(repository, ['git', '--no-optional-locks', 'symbolic-ref', '-q', 'HEAD']) else None,
            'index': index_identity,
            'refsSha256': hashlib.sha256(git(repository, 'for-each-ref', '--format=%(refname) %(objectname)').encode()).hexdigest(),
            'trackedStatusSha256': hashlib.sha256(git(repository, 'status', '--porcelain=v1', '--untracked-files=no').encode()).hexdigest(),
            'trackedDiffSha256': hashlib.sha256(git(repository, 'diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--').encode()).hexdigest()}


def execute_optional(repository, command):
    result = subprocess.run(command, cwd=repository, capture_output=True, text=True,
                            env={k: v for k, v in os.environ.items() if not k.startswith('GIT_')})
    checked(result.returncode in (0, 1), 'optional symbolic HEAD read failed')
    return result.returncode == 0


def observe_live(repository, manifest):
    output = git(repository, 'ls-remote', '--heads', 'origin')
    remote = {line.split()[1]: line.split()[0] for line in output.splitlines()}
    pull_requests = {}
    for row in manifest['rows']:
        pull_requests[str(row['pr'])] = json.loads(execute(repository, ['gh', 'pr', 'view', str(row['pr']), '--repo', manifest['repository'], '--json', 'number,state,headRefOid,mergeCommit']))
    return remote, pull_requests


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', required=True)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--manifest-revision', required=True, help='exact committed source revision for the complete historical roster')
    parser.add_argument('--manifest-path', required=True, help='regular tracked path at manifest-revision; supplied bytes must match its whole Git blob')
    parser.add_argument('--expected-head', required=True, help='exact current local HEAD; distinct from the historical auditedMaster')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--historical-bindings', help='explicit recorded remote/PR JSON; no network and no claim of current remote presence')
    mode.add_argument('--live-bindings', action='store_true', help='explicit read-only origin/GitHub observation; moved/deleted historical refs refuse')
    parser.add_argument('--self-test', action='store_true')
    arguments = parser.parse_args(argv)
    checked(re.fullmatch('[0-9a-f]{40}', arguments.expected_head) is not None, 'exact expected HEAD required')
    repository = str(Path(arguments.repository).resolve())
    before = repository_witness(repository)
    checked(before['head'] == arguments.expected_head, 'current local HEAD drift')
    manifest_raw, manifest_identity = read_regular(arguments.manifest)
    checked(re.fullmatch('[0-9a-f]{40}', arguments.manifest_revision) is not None, 'exact manifest revision required')
    checked(bool(arguments.manifest_path) and not arguments.manifest_path.startswith('/') and '..' not in Path(arguments.manifest_path).parts, 'safe manifest source path required')
    checked(git(repository, 'rev-parse', '--verify', arguments.manifest_revision + '^{commit}').strip() == arguments.manifest_revision, 'manifest revision must be an exact Git commit object')
    source_identity = identity(repository, arguments.manifest_revision, arguments.manifest_path)
    checked(source_identity is not None, 'committed whole manifest missing')
    source_result = subprocess.run(['git', '--no-optional-locks', '--no-replace-objects', 'cat-file', 'blob', source_identity['blob']], cwd=repository, capture_output=True, env={k: v for k, v in os.environ.items() if not k.startswith('GIT_')})
    checked(source_result.returncode == 0, 'committed manifest object unreadable')
    source_raw = source_result.stdout
    checked(source_raw == manifest_raw, 'committed whole manifest bytes drift or roster substitution')
    manifest = json.loads(manifest_raw)
    validate_shape(manifest)
    binding_identity = None
    if arguments.historical_bindings:
        binding_raw, binding_identity = read_regular(arguments.historical_bindings)
        bindings = json.loads(binding_raw)
        checked(set(bindings) == {'remote', 'pullRequests'}, 'explicit remote/PR observation shape required')
        remote, pull_requests = bindings['remote'], bindings['pullRequests']
    else:
        remote, pull_requests = observe_live(repository, manifest)
    report = verify(repository, manifest, remote, pull_requests)
    if arguments.self_test:
        report['negativeControls'] = self_test(repository, manifest, remote, pull_requests)
    after = repository_witness(repository)
    checked(before == after, 'repository HEAD/index/refs/tracked worktree changed during verification')
    checked(read_regular(arguments.manifest)[1] == manifest_identity, 'manifest input changed during verification')
    if arguments.historical_bindings:
        checked(read_regular(arguments.historical_bindings)[1] == binding_identity, 'historical binding input changed during verification')
    report.update(bindingMode='recorded-historical' if arguments.historical_bindings else 'live-read-only',
                  currentRemotePresenceCertified=False, semanticEquivalenceCertified=False,
                  currentSourceIntegrationCertified=False, sourceHistoryAncestryCertified=False, manifestCurrentAuthorityGranted=False, repositoryUnchanged=True,
                  manifestSource={'revision': arguments.manifest_revision, 'path': arguments.manifest_path, **source_identity},
                  repositoryWitness=before, manifestInput=manifest_identity, bindingsInput=binding_identity)
    print(json.dumps(report, indent=4))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
