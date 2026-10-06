#!/usr/bin/env python3
"""Owned Git fixtures exercise the actual read-only source; no live services."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.dont_write_bytecode = True

SOURCE = Path(__file__).resolve().parents[2] / 'tools/operations/verify-historical-preservation.py'
spec = importlib.util.spec_from_file_location('historical_preservation', SOURCE)
owner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(owner)


class HistoricalPreservationTests(unittest.TestCase):
    def setUp(self):
        fixture_root = os.environ['FSUSBLOG_OPERATIONS_FIXTURE_ROOT']
        self.temporary = tempfile.TemporaryDirectory(prefix='historical-git-', dir=fixture_root)
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repository = self.root / 'repository'
        self.repository.mkdir()
        self.env = {**os.environ, 'GIT_AUTHOR_NAME': 'owned fixture', 'GIT_AUTHOR_EMAIL': 'fixture@invalid',
                    'GIT_COMMITTER_NAME': 'owned fixture', 'GIT_COMMITTER_EMAIL': 'fixture@invalid',
                    'GIT_AUTHOR_DATE': '2026-10-06T00:00:00Z', 'GIT_COMMITTER_DATE': '2026-10-06T00:00:00Z'}
        self.git('init', '-b', 'master')
        self.git('config', 'commit.gpgsign', 'false')
        self.write('base.txt', 'base\n')
        self.commit('base')
        base = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', '-b', 'source')
        self.write('owned.txt', 'source\n')
        self.write('exact.txt', 'exact\n')
        self.commit('source')
        source = self.git('rev-parse', 'HEAD').strip()
        self.write('.wip/20261005/WIP.md', 'metadata only\n')
        self.commit('metadata')
        remote_head = self.git('rev-parse', 'HEAD').strip()
        self.git('checkout', 'master')
        self.write('current-only.txt', 'current\n')
        self.commit('independent current parent')
        self.git('cherry-pick', source)
        merged = self.git('rev-parse', 'HEAD').strip()
        self.write('owned.txt', 'source plus current owner\n')
        self.commit('current owner increment')
        self.head = self.git('rev-parse', 'HEAD').strip()
        values = []
        for path in ['owned.txt', 'exact.txt']:
            value = {'path': path, 'source': owner.identity(str(self.repository), source, path),
                     'remoteHead': owner.identity(str(self.repository), remote_head, path),
                     'merge': owner.identity(str(self.repository), merged, path),
                     'currentMaster': owner.identity(str(self.repository), self.head, path),
                     'preservation': 'fixture owner review witness'}
            value['mappingKind'] = 'exact-mode-blob' if value['source'] == value['currentMaster'] else 'reviewed-current-owner-increment'
            for field, before, after in [('sourceToCurrentDiff', source, self.head), ('originalOwnedIncrement', base, source)]:
                value[field] = owner.git(str(self.repository), 'diff', '--no-ext-diff', '--no-textconv', before, after, '--', path)
                value[field + 'Sha256'] = hashlib.sha256(value[field].encode()).hexdigest()
            values.append(value)
        metadata = '.wip/20261005/WIP.md'
        self.manifest = {'schema': 'fsusblog.historical-remote-source-preservation.v1', 'generated': False,
                         'currentAcceptanceClaim': False, 'issueClosureClaim': False, 'auditedMaster': self.head,
                         'repository': 'owned/fixture', 'rows': [{'ref': 'refs/heads/source', 'expectedRemoteHead': remote_head,
                          'sourceHead': source, 'pr': 1, 'mergeSha': merged, 'mergeBase': base,
                          'substantiveHeadChangesAfterPRSource': [], 'wipMetadataPaths': [metadata],
                          'wipMetadataIdentities': [{'path': metadata, **owner.identity(str(self.repository), remote_head, metadata)}],
                          'ownedPaths': values, 'currentWIPIssueCommentLinks': []}]}
        self.bindings = {'remote': {'refs/heads/master': self.head, 'refs/heads/source': remote_head},
                         'pullRequests': {'1': {'number': 1, 'state': 'MERGED', 'headRefOid': source, 'mergeCommit': {'oid': merged}}}}
        self.manifest_path = self.root / 'manifest.json'
        self.bindings_path = self.root / 'bindings.json'
        self.persist()
        self.write('historical-proof/manifest.json', self.manifest_path.read_text())
        self.commit('whole historical roster input')
        self.head = self.git('rev-parse', 'HEAD').strip()

    def git(self, *arguments):
        result = subprocess.run(['git', '-C', str(self.repository), *arguments], env=self.env, capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(result.stderr)
        return result.stdout

    def write(self, path, content):
        destination = self.repository / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(content)

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-m', message)

    def persist(self):
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.bindings_path.write_text(json.dumps(self.bindings))

    def arguments(self):
        return ['--repository', str(self.repository), '--expected-head', self.head,
                '--manifest', str(self.manifest_path), '--manifest-revision', self.head, '--manifest-path', 'historical-proof/manifest.json', '--historical-bindings', str(self.bindings_path)]

    def test_actual_offline_cli_and_original_eleven_refusals(self):
        before = owner.repository_witness(str(self.repository))
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertEqual(owner.main(self.arguments() + ['--self-test']), 0)
        report = json.loads(output.getvalue())
        self.assertEqual(len(report['negativeControls']), 11)
        self.assertEqual(report['ownedPaths'], 2)
        self.assertEqual(report['rows'][0]['semanticReviewStillRequiredFor'], ['owned.txt'])
        self.assertEqual(report['bindingMode'], 'recorded-historical')
        for key in ['currentCIQualified', 'issueAcceptanceCertified', 'deleteAuthorized',
                    'currentRemotePresenceCertified', 'semanticEquivalenceCertified', 'currentSourceIntegrationCertified']:
            self.assertIs(report[key], False)
        self.assertEqual(before, owner.repository_witness(str(self.repository)))

    def test_exact_current_head_is_independent_required_binding(self):
        arguments = self.arguments()
        arguments[arguments.index('--expected-head') + 1] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'HEAD drift'):
            owner.main(arguments)

    def test_full_roster_and_source_at_merge_refuse(self):
        omitted = copy.deepcopy(self.manifest)
        omitted['rows'][0]['ownedPaths'].pop()
        with self.assertRaisesRegex(ValueError, 'ALL-owned-path omission'):
            owner.verify(str(self.repository), omitted, self.bindings['remote'], self.bindings['pullRequests'])
        foreign_pr = copy.deepcopy(self.bindings['pullRequests'])
        foreign_pr['1']['number'] = 2
        with self.assertRaisesRegex(ValueError, 'PR/source/merge mismatch'):
            owner.verify(str(self.repository), self.manifest, self.bindings['remote'], foreign_pr)
        substituted = copy.deepcopy(self.manifest)
        substituted['rows'][0]['ownedPaths'][0]['merge'] = owner.identity(str(self.repository), self.head, 'owned.txt')
        with self.assertRaisesRegex(ValueError, 'object/mode drift: merge'):
            owner.verify(str(self.repository), substituted, self.bindings['remote'], self.bindings['pullRequests'])

    def test_symlink_input_and_real_index_mutation_refuse(self):
        link = self.root / 'input-link.json'
        link.symlink_to(self.manifest_path)
        with self.assertRaises(OSError):
            owner.read_regular(link)
        shadow = copy.deepcopy(self.manifest)
        shadow['rows'] = []
        self.manifest_path.write_text(json.dumps(shadow))
        with self.assertRaisesRegex(ValueError, 'whole manifest bytes drift or roster substitution'):
            owner.main(self.arguments())
        self.persist()
        original_verify = owner.verify
        def observe_then_mutate(*arguments):
            report = original_verify(*arguments)
            self.write('index-drift.txt', 'task-owned staged drift\n')
            self.git('add', 'index-drift.txt')
            return report
        owner.verify = observe_then_mutate
        try:
            with self.assertRaisesRegex(ValueError, 'repository HEAD/index/refs/tracked worktree changed'):
                owner.main(self.arguments())
        finally:
            owner.verify = original_verify


if __name__ == '__main__':
    unittest.main()
