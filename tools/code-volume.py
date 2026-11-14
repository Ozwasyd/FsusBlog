#!/usr/bin/env python3
"""Static source census of a Git commit or staging index. Never builds the subject."""

import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess

PRETTIER = {
    '.js': 'babel', '.mjs': 'babel', '.cjs': 'babel', '.ts': 'typescript',
    '.mts': 'typescript', '.tsx': 'typescript', '.jsx': 'babel', '.vue': 'vue',
    '.css': 'css', '.scss': 'scss', '.html': 'html', '.svg': 'html',
    '.jsonc': 'jsonc', '.json5': 'json5', '.yaml': 'yaml', '.yml': 'yaml',
}
CLANG = {'.cs', '.c', '.cc', '.cpp', '.h', '.hpp'}
SHELL = {'.sh', '.bash'}
XML = {'.csproj', '.fsproj', '.vbproj', '.esproj', '.props', '.targets', '.xml', '.slnx', '.pubxml', '.dcproj', '.resx'}
SOURCE = CLANG | SHELL | XML | PRETTIER.keys() | {'.go', '.py', '.cmake', '.sql', '.ps1', '.lua', '.conf', '.http', '.toml', '.sln', '.slnlaunch', '.npmrc', '.json', '.env', '.txt', '.webmanifest', '.diff', '.patch'}
CONFIG = XML | {'.sln', '.slnlaunch', '.env', '.conf', '.jsonc', '.json5', '.json', '.toml', '.yaml', '.yml', '.webmanifest', '.npmrc', '.http'}
NAMES = {
    'dockerfile': '.sh', 'containerfile': '.sh', 'cmakelists.txt': '.cmake',
    '.editorconfig': '.toml', '.clang-format': '.yaml', '.clang-tidy': '.yaml',
    '.shellcheckrc': '.conf', '.npmrc': '.npmrc', '.gitattributes': '.conf',
    '.gitignore': '.conf', '.dockerignore': '.conf', '.git-blame-ignore-revs': '.conf',
    'caddyfile': '.conf', 'caddyfile.admin': '.conf',
    '.ignore': '.conf', 'nuget.config': '.xml', 'codeowners': '.conf',
}
LOCKS = {'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'packages.lock.json', 'dependencies.lock.json'}
DEPENDENCY_DIRS = {'vendor', 'vendored', 'third-party', 'third_party', 'node_modules'}
BUILD_DIRS = {'bin', 'obj', 'testresults', '.cache', '__pycache__'}
DOC_EXTENSIONS = {'.md', '.rst', '.adoc'}
EXPORT_DATA = {'.hex', '.aeds', '.tap', '.trx', '.stderr'}
ASSETS = {'.png', '.ico', '.webp', '.wav', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf', '.otf', '.wasm', '.zip', '.gz', '.pdf'}
PATTERN = re.compile(r'\w+|[^\s\w]', re.UNICODE)  # A symmetric lexical proxy, not language tokens.
# Order matters: C# raw/verbatim and Python triple quotes precede ordinary strings.
STRINGS = r'"""+(?s:.*?)"""+|\'\'\'(?s:.*?)\'\'\'|@"(?:""|[^"])*"|"(?:\\[\s\S]|[^"\\])*"|\'(?:\\[\s\S]|[^\'\\\n])*\'|`(?:\\[\s\S]|[^`\\])*`'
JS_REGEXP = r'(?:(?<=[=([{!,:;?])|(?<=\breturn)|(?<=\bthrow))\s*/(?![/*])(?:\\[^\n]|\[(?:\\[^\n]|[^\]\\\n])*\]|[^/\[\\\n])+/[dgimsuvy]*'
MASKS = {
    'c': r'/\*[\s\S]*?(?:\*/|\Z)|//[^\n]*',
    'markup': r'<!--[\s\S]*?(?:-->|\Z)',
    'style': r'/\*[\s\S]*?(?:\*/|\Z)',
    'hash': r'(?<!\S)\#[^\n]*',
    'sql': r'/\*[\s\S]*?(?:\*/|\Z)|--[^\n]*',
    'ps': r'<\#[\s\S]*?(?:\#>|\Z)|(?<!\S)\#[^\n]*',
}


def git(repo, *args):
    return subprocess.check_output(['git', '-C', repo, *args])


def records(repo, revision):
    raw = git(repo, 'ls-tree', '-r', '-z', revision)
    for entry in raw.split(b'\0'):
        if entry:
            header, name = entry.split(b'\t', 1)
            mode, _, sha = header.decode().split()
            yield mode, sha, name.decode()


def select(path, mode):
    name = PurePosixPath(path.lower())
    suffix = name.suffix
    parts = name.parts
    file = name.name
    first = parts[0]
    if mode not in ('100644', '100755'):
        return None, 'gitlink_or_symlink'
    if any(p in DEPENDENCY_DIRS for p in parts[:-1]):
        return None, 'third_party'
    if any(p in BUILD_DIRS for p in parts[:-1]):
        return None, 'build_or_cache'
    if suffix in DOC_EXTENSIONS or file in {'license', 'copying', 'notice', 'usage'}:
        return None, 'documentation'
    if first == 'docs' and (suffix not in SOURCE or suffix == '.svg'):
        return None, 'documentation_asset'
    if suffix in ASSETS:
        return None, 'binary_or_font'
    if suffix in EXPORT_DATA:
        return None, 'encoded_fixture_or_test_result'
    if file in LOCKS:
        return None, 'dependency_lock_snapshot'
    if suffix == '.txt' and ('.fixture.' in file or first in {'src', 'test', 'tests', 'tools', 'config', 'security'}):
        embedded = PurePosixPath(name.stem).suffix
        suffix = embedded if embedded in SOURCE - {'.txt'} else suffix
    if suffix == '.fixture':
        suffix = PurePosixPath(name.stem).suffix
    if suffix in {'.example', '.template'}:
        suffix = PurePosixPath(name.stem).suffix if not file.startswith('.env') else '.env'
    suffix = NAMES.get(file, suffix)
    if suffix == '.dockerfile':
        suffix = '.sh'
    if suffix == '.json' and file.startswith(('tsconfig.', 'appsettings.')):
        suffix = '.jsonc'
    if suffix == '.txt' and first not in {'src', 'test', 'tests', 'tools', 'config', 'security'}:
        return None, 'plain_text'
    if suffix not in SOURCE:
        return None, 'unmapped_extension'
    return suffix, None


def classify(path, suffix, source):
    parts = path.lower().split('/')
    first, file = parts[0], parts[-1]
    # Tracked audit output is measured separately. Consumed fixtures, historical
    # test baselines, and rules (including artifacts/change-contract) stay in scope.
    if suffix == '.json' and (
        path.startswith('docs/reports/')
        or (path.startswith('docs/baseline-') and not path.endswith('.schema.json'))
        or (path.startswith('docs/issues/') and not path.endswith('.schema.json'))
    ):
        return 'evidence_snapshot', False
    if suffix == '.json' and (
        re.match(r'^tests/test-replacement-(?:receipts|transactions)/', path)
        or path in {'tests/test-retention-before.json', 'tests/test-retention-replacements.json'}
    ):
        return 'historical_test_evidence', False
    generated = (
        'generated' in parts[:-1] or bool(re.search(r'\.(?:g|generated|designer)\.', file))
        or bool(re.search(r'(?im)^\s*(?:/{2}|/\*+|#|<!--)\s*(?:<auto-generated|generated (?:by|from)|automatically generated)', source[:1500]))
        or path == 'src/shared/Contracts/Validation/fsusblog.openapi.json'
        or path == 'examples/plugins/comment-guard/dist/main.js'
    )
    test = first in {'test', 'tests', 'benchmarks'} or bool(re.search(r'\.(?:spec|test)\.', file))
    rules = suffix in CONFIG or suffix == '.txt' or file in NAMES or 'schema' in parts[:-1] or 'schemas' in parts[:-1]
    if test:
        return ('test_rules' if rules else 'test'), generated
    if first in {'tools', 'ops', 'scripts', 'cmake', '.github', 'artifacts'} or len(parts) == 1:
        if not generated and not rules and bool(re.match(r'(?:generate|emit|codegen)(?:[-_.]|[A-Z])', Path(path).name)):
            return 'generator', False
        return ('tooling_rules' if rules else 'tooling'), generated
    if rules:
        return ('product_schema' if first in {'src', 'config', 'security'} else 'project_rules'), generated
    return 'production', generated


def clean(source, suffix):
    mask = None
    strings = STRINGS
    if suffix in CLANG or suffix in {'.go', '.ts', '.tsx', '.mts', '.js', '.mjs', '.cjs', '.jsx', '.jsonc', '.json5'}:
        mask = MASKS['c']
        if suffix not in CLANG | {'.go', '.jsonc', '.json5'}:
            strings += '|' + JS_REGEXP
    elif suffix == '.vue':
        # In Vue, only script bodies use JS comments. // remains in template text.
        def section(match):
            sub = '.ts' if match.group(1).lower() == 'script' else '.scss'
            return match.group(0).replace(match.group(2), clean(match.group(2), sub), 1) if match.group(2) else match.group(0)
        source = re.sub(r'<(script|style)\b[^>]*>([\s\S]*?)</\1\s*>', section, source, flags=re.I)
        mask = MASKS['markup']
    elif suffix in XML or suffix in {'.html', '.svg'}:
        mask = MASKS['markup']
    elif suffix in {'.css', '.scss'}:
        mask = MASKS['style']
    elif suffix in {'.sql', '.lua'}:
        mask = MASKS['sql']
    elif suffix == '.ps1':
        mask = MASKS['ps']
    elif suffix in SHELL | {'.py', '.yaml', '.yml', '.env', '.conf', '.toml', '.npmrc', '.cmake', '.http', '.txt'}:
        mask = MASKS['hash']
    if not mask:
        return source
    return re.sub(f'(?P<string>{strings})|(?P<comment>{mask})',
                  lambda match: match.group() if match.group('string') else re.sub(r'[^\n]', ' ', match.group()), source)


def unique_json(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON key {key!r}')
        result[key] = value
    return result


def call(args, source):
    result = subprocess.run(args, input=source.encode('utf-8'), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if not result.returncode:
        return result.stdout.decode('utf-8'), None
    return source, result.stderr.decode(errors='replace').strip().split('\n', 1)[0] or f'Exit {result.returncode}'


class Printer:
    def __init__(self):
        self.proc = subprocess.Popen(
            ['node', str(Path(__file__).with_name('code-volume-format.mjs'))],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding='utf-8')

    def format(self, source, parser):
        self.proc.stdin.write(json.dumps({'source': source, 'parser': parser}) + '\n')
        self.proc.stdin.flush()
        result = json.loads(self.proc.stdout.readline())
        return result.get('formatted', source), result.get('error')

    def close(self):
        self.proc.stdin.close()
        self.proc.stdout.close()
        if self.proc.wait():
            raise RuntimeError('Prettier formatter exited unsuccessfully.')


def simple_format(item):
    index, path, suffix, source = item
    if suffix in CLANG:
        style = '{BasedOnStyle: Microsoft, ColumnLimit: 100, AllowShortFunctionsOnASingleLine: None}'
        out, error = call([os.environ.get('CODE_VOLUME_CLANG_FORMAT', 'clang-format'),
                           f'-style={style}', f'-assume-filename=input{suffix}'], source)
    elif suffix in SHELL and not PurePosixPath(path.lower()).name.endswith(('dockerfile', 'containerfile')):
        out, error = call(['shfmt', '-i', '4', '-ci'], source)
    elif suffix == '.py':
        out, error = call(['ruff', 'format', '--isolated', '--line-length', '100', '-'], source)
    elif suffix == '.go':
        out, error = call(['gofmt'], source)
    elif suffix in XML:
        out, error = call(['xmllint', '--nonet', '--format', '-'], source)
    elif suffix in {'.json', '.slnlaunch', '.webmanifest'}:
        try:
            out, error = json.dumps(json.loads(source, object_pairs_hook=unique_json), indent=2, ensure_ascii=False), None
        except ValueError as problem:
            out, error = source, str(problem)
    else:
        return index, source, None, 'as-authored'
    return index, out, error, 'formatted' if error is None else 'parse-fallback'


def read_sources(repo, revision, exclude, accounts):
    with subprocess.Popen(['git', '-C', repo, 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as proc:
        for mode, sha, path in records(repo, revision):
            suffix, reason = select(path, mode)
            if reason:
                exclude[reason] += 1
                if reason == 'unmapped_extension':
                    accounts[path] = reason
                continue
            proc.stdin.write((sha + '\n').encode())
            proc.stdin.flush()
            header = proc.stdout.readline().decode().split()
            if len(header) != 3 or header[1] != 'blob':
                raise ValueError(f'Missing Git blob {sha} for {path}: {header!r}')
            size = int(header[2])
            data = proc.stdout.read(size)
            if len(data) != size or proc.stdout.read(1) != b'\n':
                raise ValueError(f'Unexpected object stream end for {sha}.')
            source = data.decode('utf-8-sig', errors='strict').replace('\r\n', '\n').replace('\r', '\n')
            if '\x00' in source:
                raise ValueError(f'Expected text in {path}.')
            if suffix == '.txt' and source.startswith('# Open Chinese Convert (OpenCC) Dictionary\n') and '# Source: https://github.com/ByVoid/OpenCC' in source[:1000]:
                exclude['third_party_attributed_text'] += 1
                accounts[path] = 'third_party_attributed_text'
                continue
            category, generated = classify(path, suffix, source)
            yield (path, suffix, source, len(data), category, generated)
        proc.stdin.close()
        if proc.wait():
            raise RuntimeError('Git cat-file --batch failed.')


def census(repo, revision, jobs):
    commit = None if revision == ':index' else git(repo, 'rev-parse', revision + '^{commit}').decode().strip()
    identity = git(repo, 'rev-parse', commit + '^{tree}').decode().strip() if commit else git(repo, 'write-tree').decode().strip()
    excluded, unmapped, by_category, by_area, formatter_counts = Counter(), {}, defaultdict(Counter), defaultdict(Counter), Counter()
    failures = {}
    rows = list(read_sources(repo, identity, excluded, unmapped))
    inputs = [(i, x[0], x[1], x[2]) for i, x in enumerate(rows) if x[1] not in PRETTIER and x[4] != 'evidence_snapshot']
    metrics = Counter()

    def accumulate(index, source, error, formatter):
        path, suffix, original, size, category, generated = rows[index]
        cleaned = clean(source, suffix)
        raw = clean(original, suffix)
        counts = Counter(files=1, ncloc=sum(bool(line.strip()) for line in cleaned.splitlines()),
                         raw_ncloc=sum(bool(line.strip()) for line in raw.splitlines()),
                         bytes=size, token_proxy=sum(1 for _ in PATTERN.finditer(raw)))
        edition = 'generated' if generated else 'handwritten'
        by_category[category + '/' + edition].update(counts)
        if category not in {'evidence_snapshot', 'historical_test_evidence'}:
            metrics.update(counts)
            parts = path.split('/')
            by_area['/'.join(parts[:2]) if len(parts) >= 3 else parts[0]].update(counts)
        formatter_counts[formatter] += 1
        if error:
            failures[path] = error

    with ThreadPoolExecutor(max_workers=jobs) as pool:
        running = pool.map(simple_format, inputs)
        printer = Printer()
        try:
            for i, (_, suffix, source, _, category, _) in enumerate(rows):
                if category == 'evidence_snapshot':
                    accumulate(i, source, None, 'evidence-as-authored')
                elif suffix in PRETTIER:
                    out, error = printer.format(source, PRETTIER[suffix])
                    accumulate(i, out, error, 'formatted' if error is None else 'parse-fallback')
        finally:
            printer.close()
        for item in running:
            accumulate(*item)
    ncloc = metrics['ncloc']
    return {
        'schema': 1, 'tree': identity,
        'commit': commit,
        'total': metrics, 'budget_90_percent_reduction_ncloc': ncloc // 10,
        'total_including_historical_test_evidence': metrics + by_category.get('historical_test_evidence/handwritten', Counter()),
        'by_category': dict(by_category), 'by_area': dict(by_area), 'formatting': formatter_counts,
        'formatter_fallbacks': failures, 'excluded_file_counts': excluded, 'reviewable_exclusions': unmapped,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', default='.')
    parser.add_argument('--rev', default='HEAD', help='Git revision or :index for staged source')
    parser.add_argument('--jobs', default=min(8, os.cpu_count() or 1), type=int)
    args = parser.parse_args()
    print(json.dumps(census(args.repo, args.rev, args.jobs), sort_keys=True, indent=2))


if __name__ == '__main__':
    main()
