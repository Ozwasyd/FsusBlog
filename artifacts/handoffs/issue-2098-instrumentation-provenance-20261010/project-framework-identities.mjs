import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createCompositionSource } from '../FsusBlog/tests/frontend/support/layout/compositionSource.mjs';
import { compositionAnalyzerSources } from '../FsusBlog/tests/frontend/support/layout/compositionAnalyzer.mjs';

const repositoryRoot = '/workspace/chain-1895-origin-export-successor/FsusBlog';
const fsusUIRoot = '/workspace/chain-1895-component-prop-source/FsusUI';
const projections = [];
// Readonly inventory of actual imports/package exports; it is not an analyzer receipt gate.
const ts = createRequire(resolve(repositoryRoot, 'src/frontend/package.json'))('typescript');
const visited = new Set();
const repositoryImportEdges = [];
const externalImports = [];
function follow(file) {
    file = realpathSync(file);
    if (visited.has(file)) return;
    visited.add(file);
    if (file.endsWith('.json')) return;
    const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    assert.equal(ast.parseDiagnostics.length, 0);
    for (const statement of ast.statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith('node:')) continue;
        const resolved = realpathSync(createRequire(file).resolve(specifier));
        if (!resolved.startsWith(repositoryRoot + '/') || resolved.includes('/node_modules/')) {
            externalImports.push({ from: relative(repositoryRoot, file), specifier, resolved });
            continue;
        }
        repositoryImportEdges.push({ from: relative(repositoryRoot, file), specifier, to: relative(repositoryRoot, resolved) });
        follow(resolved);
    }
}
compositionAnalyzerSources.forEach(file => follow(resolve(repositoryRoot, file)));
const transitiveRepositorySourcePaths = [...visited].map(file => relative(repositoryRoot, file)).sort();
assert.ok(transitiveRepositorySourcePaths.includes('src/frontend/scripts/fsusui-root.mjs'));
assert.ok(transitiveRepositorySourcePaths.includes('tools/test-matrix/schema-validator/validate.mjs'));
for (const [path, name, firstArgument, expectedOffset] of [
    ['slider/src/slider.vue', 'toRefs', 'props', 6981],
    ['form/src/hooks/use-form-item.ts', 'toRef', 'props', 1531]
]) {
    const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
    const file = resolve(fsusUIRoot, 'vue/packages/components', path);
    const candidates = [];
    function visit(node) {
        const ts = source.resolver.ts;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
            && node.expression.text === name && node.arguments[0]?.getText() === firstArgument) {
            candidates.push(node.expression);
        }
        ts.forEachChild(node, visit);
    }
    source.resolver.parse(file).scripts.forEach(({ ast }) => visit(ast));
    assert.equal(candidates.length, 1);
    const callee = candidates[0];
    const observation = source.resolver.resolveFrameworkExport(file, callee);
    const caller = source.resolver.sourceStep(file, callee);
    assert.equal(caller.offset, expectedOffset);
    const object = observation.dependencies.find((entry) => entry.classDeclaration?.name.text === 'ObjectRefImpl');
    assert.ok(object);
    const setter = object.classDeclaration.members.find((member) => source.resolver.ts.isSetAccessorDeclaration(member) && member.name.text === 'value');
    assert.ok(setter.body.getText().includes('this._object[this._key] = newVal'));
    projections.push({ caller, exportIdentity: observation.exportIdentity,
        function: source.resolver.sourceStep(observation.file, observation.fn),
        edges: observation.edges.map((entry) => ({ file: entry.file, resolvedFile: entry.resolvedFile,
            exportedName: entry.exportedName, originalImportOrExportAST: source.resolver.sourceStep(entry.file, entry.originalImportOrExportAST) })),
        dependencies: observation.dependencies.map((entry) => ({ file: entry.file,
            kind: entry.fn ? 'function' : 'class', name: (entry.fn ?? entry.classDeclaration).name?.text,
            originalAST: source.resolver.sourceStep(entry.file, entry.fn ?? entry.classDeclaration) })),
        actualObjectSetter: { source: source.resolver.sourceStep(object.file, setter),
            authoredWrite: 'this._object[this._key] = newVal' },
        unresolvedDependencies: observation.unresolvedDependencies, inputs: observation.inputs,
        dependencyScope: 'actual direct call/new bodies only; indirect and native-value bodies remain unproved',
        qualificationEligible: observation.qualificationEligible, readonlyVerdictProvidedByInterface: false });
}
writeFileSync(resolve(import.meta.dirname, 'actual-framework-identities.json'), JSON.stringify({
    blogCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    blogTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
    fsusUICommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fsusUIRoot, encoding: 'utf8' }).trim(),
    observedAt: new Date().toISOString(), projections, sourceClosurePaths: compositionAnalyzerSources, transitiveRepositorySourcePaths, repositoryImportEdges, externalImports,
    closureBoundary: "Canonical analyzer declares 17 files; actual static repository imports add two unchanged helpers. External npm implementation closures and computed/dynamic loads are not certified by this readonly inventory.",
    provenance: 'Read-only projection of original resolver observations, not another parser or effect checker',
    qualificationEligible: false, productionInventoryRun: false, runtimeState: 'unbound'
}, null, 2) + '\n');
console.log('actual SDK identities projected: 2; qualificationEligible=false');
