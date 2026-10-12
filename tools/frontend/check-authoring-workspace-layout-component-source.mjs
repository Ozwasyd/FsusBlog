import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Parse/compile source only. Do not import/mount/evaluate candidate product modules.
if (process.argv.length !== 2)
{
    throw new Error('usage: node tools/frontend/check-authoring-workspace-layout-component-source.mjs');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFrontend = createRequire(path.join(root, 'src/frontend/package.json'));
const ts = requireFrontend('typescript');
const sfc = requireFrontend('@vue/compiler-sfc');
const dom = requireFrontend('@vue/compiler-dom');
const componentPath = 'src/frontend/src/components/admin/article/AuthoringWorkspaceLayout.vue';
const controllerPath = 'src/frontend/src/services/authoring/authoringWorkspaceLayoutController.ts';
const writerPath = 'src/frontend/src/views/admin/article/Write.vue';
const contextPath = 'src/frontend/src/services/authoring/authoringWorkspaceLayoutContext.ts';
const outletPath = 'src/frontend/src/components/admin/article/AuthoringWorkspaceSessionOutlet.vue';
const component = readFileSync(path.join(root, componentPath), 'utf8');
const controller = readFileSync(path.join(root, controllerPath), 'utf8');
const writer = readFileSync(path.join(root, writerPath), 'utf8');
const outlet = readFileSync(path.join(root, outletPath), 'utf8');
const outletDescriptor = sfc.parse(outlet, { filename: outletPath });
const writerDescriptor = sfc.parse(writer, { filename: writerPath });
const { descriptor, errors } = sfc.parse(component, { filename: componentPath });
const failures = [...errors, ...outletDescriptor.errors, ...writerDescriptor.errors].map(error => String(error));
const script = ts.createSourceFile(componentPath, descriptor.scriptSetup?.content ?? '', ts.ScriptTarget.Latest, true);
const controllerTree = ts.createSourceFile(controllerPath, controller, ts.ScriptTarget.Latest, true);
const outletTree = ts.createSourceFile(outletPath, outletDescriptor.descriptor.scriptSetup?.content ?? '', ts.ScriptTarget.Latest, true);
function visit(tree, callback)
{
    callback(tree);
    ts.forEachChild(tree, node => visit(node, callback));
}
for (const tree of [script, controllerTree, outletTree])
{
    if (tree.parseDiagnostics.length)
    {
        failures.push(`${tree.fileName}:parse-error`);
    }
    visit(tree, node =>
    {
        if (ts.isNewExpression(node) && ['AuthoringTabGroupRegistry', 'OpenArticleDocumentRegistry', 'AuthoringSessionHost'].includes(node.expression.getText(tree)))
        {
            failures.push('duplicate-original-authority');
        }
        if (ts.isIdentifier(node) && ['MarkdownEditor', 'localStorage', 'sessionStorage', 'querySelector', 'querySelectorAll'].includes(node.text))
        {
            failures.push(`private-editor-or-runtime-state:${node.text}`);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && ['commit', 'openWorkspace', 'releaseWorkspace', 'attach', 'activate', 'restoreSnapshot'].includes(node.expression.name.text))
        {
            failures.push(`unowned-publication-or-lifecycle:${node.expression.name.text}`);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === 'execute'
            && (node.expression.expression.getText(tree) !== 'groups' || node.arguments.length !== 1
                || !ts.isObjectLiteralExpression(node.arguments[0])
                || !node.arguments[0].properties.some(property => ts.isPropertyAssignment(property)
                    && property.name.getText(tree) === 'kind' && ts.isStringLiteral(property.initializer)
                    && property.initializer.text === 'set-effective-single')))
        {
            failures.push('layout-command-outside-effective-state-owner');
        }
        if (node.kind === ts.SyntaxKind.AwaitExpression || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        {
            failures.push('async-layout-admission');
        }
        if (ts.isStringLiteral(node) && node.text === 'ready')
        {
            failures.push('fabricated-ready-state');
        }
    });
}
for (const required of ['<Teleport', ':to="placement.target"', ':hidden="!placement.visible"',
    'value.readEntry(expected)', 'tab.editorSessionRef === entry.editorSessionRef', 'tab.documentEpoch === entry.documentContext.documentEpoch',
    'tab.lifecycleRevision === entry.lifecycleRevision', 'value.root?.isConnected', 'node?.isConnected',
    'value.ownsRegion(index, node)', 'isCurrent(value)', 'observer?.disconnect()', 'ref="parkingElement"'])
{
    if (!outlet.includes(required))
    {
        failures.push(`missing-real-persistent-outlet:${required}`);
    }
}
for (const required of ['groups !== expected.groups', 'registry !== expected.registry', '!groups.verifyBinding(registry)',
    'registry.getRevision() !== expected.projection.state.articleRegistryRevision',
    'current.state.revision === expected.projection.state.revision',
    'current.state.contentDigest === expected.projection.state.contentDigest',
    'owner.identity.articleId !== entry.identity.articleId', 'owner.identity.draftId !== entry.identity.draftId',
    'owner.identity.documentId !== entry.identity.documentId',
    'owner.documentContext.documentEpoch !== entry.documentContext.documentEpoch',
    'owner.documentContext.sourceRevision !== entry.documentContext.sourceRevision',
    'owner.documentContext.draftRevision !== entry.documentContext.draftRevision'])
{
    if (!writer.includes(required))
    {
        failures.push(`missing-original-expected-placement-or-native-coordinate:${required}`);
    }
}
if (/\bv-if\b|\bv-for\b|:key=|\bnew Map\b|\bnew WeakMap\b/u.test(outlet)
    || !writer.includes(':read-entry="readPrimaryWorkspaceEntry"')
    || !writer.includes('source.readDocumentBinding(entry.editorSessionRef)')
    || !writer.includes('articleWorkspaceTabRouter.getRegistry() !== registry'))
{
    failures.push('recreated-session-subtree-or-parallel-mount-authority');
}
for (const required of ['getArticleWorkspaceRecoveryCheckpoint', 'checkpoint = bound.bindRecoveryCheckpoint(entry.editorSessionRef)',
    'registry.getRevision() === registryRevision', 'calculateOpenArticleDocumentDigest(registry.getEntry(entry.tabId)) === entryDigest',
    'recoveryCheckpoint = checkpoint', 'checkpoint.release()', 'releaseRecoveryCheckpoint();'])
{
    if (!writer.includes(required))
    {
        failures.push(`missing-original-journal-host-binding:${required}`);
    }
}
if (/new\s+(?:ArticleRecoveryJournal|Map|WeakMap)\b/u.test(writer))
{
    failures.push('parallel-journal-or-host-owner-store');
}
for (const required of ['getArticleWorkspaceRetainedRecoveryPort', 'const retainedRecoveryPort = createArticleWorkspaceRetainedRecoveryPort({',
    'const checkpoint = getArticleWorkspaceRecoveryCheckpoint()', 'checkpoint !== getArticleWorkspaceRecoveryCheckpoint()',
    'return { entry, checkpoint };', 'return getArticleWorkspaceRecoveryCheckpoint() ? retainedRecoveryPort : null;'])
{
    if (!writer.includes(required))
    {
        failures.push(`missing-original-partial-factory-caller:${required}`);
    }
}
if (/\.(?:prepareSnapshot|restoreSnapshot)\s*\(|\binstallArticleWorkspaceEditorSessions\b/u.test(writer))
{
    failures.push('automatic-partial-checkpoint-or-alternate-host-installation');
}
const template = dom.parse(descriptor.template?.content ?? '');
let groups = 0;
let separator = 0;
function templateVisit(node)
{
    if (node.type === 1)
    {
        if (node.tag === 'section')
        {
            groups++;
        }
        if (node.tag === 'FsusResizeSeparator')
        {
            separator++;
        }
        for (const prop of node.props)
        {
            if (prop.type === 7 && ['if', 'else', 'else-if', 'for'].includes(prop.name) && node.tag !== 'FsusResizeSeparator')
            {
                failures.push('conditional-or-reconstructed-group-DOM');
            }
        }
    }
    for (const child of node.children ?? [])
    {
        templateVisit(child);
    }
}
templateVisit(template);
if (groups !== 2 || separator !== 1)
{
    failures.push('missing-exact-two-stable-regions-or-public-separator');
}
if (!component.includes('satisfies AuthoringWorkspaceLayoutPort')
    || !writer.includes('ref="workspaceLayoutRef"')
    || !writer.includes('getAuthoringWorkspaceLayoutPort: () => workspaceLayoutRef.value'))
{
    failures.push('missing-actual-layout-public-port-forwarding');
}
for (const previous of ['previous.projection', 'previous.geometry', 'previous.separatorProps', '...renderState.value'])
{
    if (component.includes(previous))
    {
        failures.push(`retained-revoked-render-state:${previous}`);
    }
}
for (const required of ['renderState.value = fallbackRenderState();', ': fallbackRenderState(value)',
    'projection: null, geometry: null', 'emit(\'observation\', copyAuthoringWorkspaceLayoutObservation(value))',
    ':group="slotProjection?.state.groups[0] ?? null"', ':group="slotProjection?.state.groups[1] ?? null"'])
{
    if (!component.includes(required))
    {
        failures.push(`missing-revocation-or-external-isolation:${required}`);
    }
}
for (const required of ['Object.freeze(tab)', 'Object.freeze(group.tabs)', 'Object.freeze(group)',
    'Object.freeze(activation)', 'Object.freeze(state.groups)', 'Object.freeze(state.focusHistory)',
    'Object.freeze(state.activationHistory)', 'Object.freeze(state.splitRatio)', 'Object.freeze(state)',
    'freezeProjection(groups.exportProjection())', 'structuredClone(projection.state)',
    'ratioScope: projection.ratioScope, splitRatioRef: projection.splitRatioRef'])
{
    if (!controller.includes(required))
    {
        failures.push(`missing-frozen-original-projection-member:${required}`);
    }
}
const styles = descriptor.styles.map(style => style.content).join('\n');
if (/font-size|font-stretch|scale\s*\(|(?:transition|animation)\s*:|(?:^|[\s,])(?:body|html)\s*[{,]/mu.test(styles))
{
    failures.push('font-shrink-animation-or-global-overflow-owner');
}
for (const required of ['verifyAuthoringSessionHostState(host)', 'record.registryEntryDigest !== entry.contentDigest',
    'resolveMounted(entry)', 'sameProjection(projection)', 'effective-layout-publication-required', 'focused-collapse-owner-mismatch'])
{
    if (!controller.includes(required))
    {
        failures.push(`missing-real-source-gate:${required}`);
    }
}
try
{
    sfc.registerTS(() => ts);
    for (const [file, candidate] of [[componentPath, descriptor], [outletPath, outletDescriptor.descriptor], [writerPath, writerDescriptor.descriptor]])
    {
        const compiled = sfc.compileScript(candidate, { id: '2299-source-only',
            fs: { fileExists: ts.sys.fileExists, readFile: ts.sys.readFile } });
        const result = sfc.compileTemplate({ source: candidate.template?.content ?? '', filename: file,
            id: '2299-source-only', compilerOptions: { bindingMetadata: compiled.bindings } });
        failures.push(...result.errors.map(error => String(error)));
    }
}
catch (error)
{
    failures.push(String(error));
}
console.log(JSON.stringify({ schema: 'fsusblog.authoring-workspace-layout-component-source.v1',
    status: failures.length ? 'source-check-fail' : 'source-check-pass',
    source: [componentPath, controllerPath, writerPath, contextPath, outletPath].map(file => ({ path: file,
        sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })),
    stableGroupRegions: groups, publicSeparators: separator, failures,
    notCovered: ['actual-host-mounting', 'retention-restore-provenance', 'repository-wide-second-layout-owner',
        'effective-state-joint-publication', 'receipt-independent-verifier', 'browser-geometry-overflow-focus',
        'pointer-keyboard-screen-reader', 'tamper-race-security-privacy-IME-native'] }, null, 4));
process.exitCode = failures.length ? 1 : 0;
