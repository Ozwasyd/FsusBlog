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
const component = readFileSync(path.join(root, componentPath), 'utf8');
const controller = readFileSync(path.join(root, controllerPath), 'utf8');
const writer = readFileSync(path.join(root, writerPath), 'utf8');
const { descriptor, errors } = sfc.parse(component, { filename: componentPath });
const failures = errors.map(error => String(error));
const script = ts.createSourceFile(componentPath, descriptor.scriptSetup?.content ?? '', ts.ScriptTarget.Latest, true);
const controllerTree = ts.createSourceFile(controllerPath, controller, ts.ScriptTarget.Latest, true);
function visit(tree, callback)
{
    callback(tree);
    ts.forEachChild(tree, node => visit(node, callback));
}
for (const tree of [script, controllerTree])
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
    const compiled = sfc.compileScript(descriptor, { id: '2299-source-only',
        fs: { fileExists: ts.sys.fileExists, readFile: ts.sys.readFile } });
    const result = sfc.compileTemplate({ source: descriptor.template?.content ?? '', filename: componentPath,
        id: '2299-source-only', compilerOptions: { bindingMetadata: compiled.bindings } });
    failures.push(...result.errors.map(error => String(error)));
}
catch (error)
{
    failures.push(String(error));
}
console.log(JSON.stringify({ schema: 'fsusblog.authoring-workspace-layout-component-source.v1',
    status: failures.length ? 'source-check-fail' : 'source-check-pass',
    source: [componentPath, controllerPath, writerPath, contextPath].map(file => ({ path: file,
        sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })),
    stableGroupRegions: groups, publicSeparators: separator, failures,
    notCovered: ['actual-host-mounting', 'retention-restore-provenance', 'repository-wide-second-layout-owner',
        'effective-state-joint-publication', 'receipt-independent-verifier', 'browser-geometry-overflow-focus',
        'pointer-keyboard-screen-reader', 'tamper-race-security-privacy-IME-native'] }, null, 4));
process.exitCode = failures.length ? 1 : 0;
