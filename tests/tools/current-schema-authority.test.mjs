import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const { validateCurrentSchemaAuthority } = await import(new URL('../../tools/db/check-current-schema-authority.mjs', import.meta.url));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const canonicalRelative = 'src/shared/Contracts/Schema/CurrentSchemaCanonicalAuthority.cs';
const extractorRelative = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaCanonicalModel.cs';
const recipeExtractorRelative = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaRecipeFactExtractor.cs';
const exporterRelative = 'src/backend/Infrastructure/SchemaMigration/CurrentSchemaOwnedProjectionExporter.cs';
const neutralRelatives = [
    canonicalRelative,
    'src/shared/Contracts/Schema/CurrentSchemaModel.cs',
    'src/shared/Contracts/Schema/SchemaPhysicalTypeProjection.cs',
    'src/shared/Contracts/Schema/SchemaModelComparer.cs'
];
const inspectorRelative = 'src/backend/Infrastructure/SchemaMigration/SchemaModelInspector.cs';
const materializerRelative = 'src/backend/Infrastructure/Testing/CurrentSchemaTestMaterializer.cs';

function mutatedRepository(mutate)
{
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fsusblog-current-schema-authority-'));
    for (const relative of [...neutralRelatives, extractorRelative, inspectorRelative, recipeExtractorRelative, exporterRelative])
    {
        const target = path.join(temporary, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, relative), target);
    }
    mutate(temporary);
    return temporary;
}

test('current schema authority has one canonical extractor, three adapters and one verifier', () =>
{
    assert.deepEqual(validateCurrentSchemaAuthority(root), []);
});

test('recipe facts retain one original source owner and reject second extractors', () =>
{
    const duplicate = mutatedRepository((repository) =>
    {
        fs.writeFileSync(path.join(repository, 'src/shared/Contracts/Schema/SecondRecipeExtractor.cs'),
            'internal static class CurrentSchemaRecipeFactExtractor {}\n');
    });
    assert.ok(validateCurrentSchemaAuthority(duplicate).some((error) => error.includes('exactly one production declaration')));
    const substituted = mutatedRepository((repository) =>
    {
        const file = path.join(repository, exporterRelative);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('CurrentSchemaRuntimeRollupTables.Tables.Select', 'callerRecipes.Select'));
    });
    assert.ok(validateCurrentSchemaAuthority(substituted).some((error) => error.includes('sole original current-owned recipe catalog')));
});

test('current schema authority rejects migration catalog input and fixture reconstruction', () =>
{
    for (const mutation of [
        'SchemaMigrationRegistry registry = new();',
        'string expected = File.ReadAllText("tests/Fixtures/current-schema.json");'
    ])
    {
        const temporary = mutatedRepository((repository) =>
        {
            fs.appendFileSync(path.join(repository, canonicalRelative), `\n${mutation}\n`);
        });
        assert.notDeepEqual(validateCurrentSchemaAuthority(temporary), []);
    }
});

test('current schema authority rejects a hand-written inventory or second generator', () =>
{
    const handWritten = mutatedRepository((repository) =>
    {
        const target = path.join(repository, 'src/backend/Services/SecondSchemaInventory.cs');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'var table = new SchemaTableModel("manual", [], []);\n');
    });
    assert.ok(validateCurrentSchemaAuthority(handWritten).some((error) => error.includes('hand-written')));

    const secondGenerator = mutatedRepository((repository) =>
    {
        const target = path.join(repository, 'src/backend/Services/SecondSchemaGenerator.cs');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'var model = CurrentSchemaCanonicalAuthority.Extract(entityTypes);\n');
    });
    assert.ok(validateCurrentSchemaAuthority(secondGenerator).some((error) => error.includes('second current schema producer')));
});

test('neutral extraction preserves one producer and rejects duplicate or missing owners', () =>
{
    const duplicate = mutatedRepository((repository) =>
    {
        const target = path.join(repository, 'src/shared/Contracts/Schema/SecondSchemaAuthority.cs');
        fs.writeFileSync(target, 'public static class CurrentSchemaCanonicalAuthority {}\n');
    });
    assert.ok(validateCurrentSchemaAuthority(duplicate).some((error) => error.includes('exactly one production declaration')));
    const missing = mutatedRepository((repository) =>
    {
        fs.unlinkSync(path.join(repository, extractorRelative));
    });
    assert.ok(validateCurrentSchemaAuthority(missing).some((error) => error.includes('missing entity current schema extractor')));
    const secondExtractor = mutatedRepository((repository) =>
    {
        const target = path.join(repository, 'src/backend/Services/SecondEntityExtractor.cs');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'var model = CurrentSchemaEntityExtractor.Extract(entityTypes);\n');
    });
    assert.ok(validateCurrentSchemaAuthority(secondExtractor).some((error) => error.includes('second current schema producer')));
});

test('test current schema materializer remains explicit, canonical and pre-runtime', () =>
{
    const materializer = fs.readFileSync(path.join(root, materializerRelative), 'utf8');
    const program = fs.readFileSync(path.join(root, 'src/backend/Program.cs'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap-acceptance-env.sh'), 'utf8');
    const homogeneousTwoNode = fs.readFileSync(
        path.join(root, 'tools/test/lanes/homogeneous-two-node-fixture.sh'),
        'utf8'
    );

    assert.doesNotMatch(materializer, /SchemaMigration(?:Registry|Manifest|Descriptor)|GetDescriptors\s*\(/u);
    assert.doesNotMatch(materializer, /CurrentSchemaCanonicalAuthority\.Extract\s*\(/u);
    assert.match(materializer, /inspector\.BuildCanonicalModel\(entityTypes\)/u);
    assert.match(materializer, /current_schema_materializer_test_environment_required/u);
    assert.match(materializer, /current_schema_materializer_opt_in_required/u);
    assert.match(materializer, /current_schema_materializer_loopback_required/u);
    assert.match(materializer, /current_schema_materializer_public_search_path_required/u);
    assert.match(materializer, /current_schema_materializer_public_schema_not_empty/u);
    assert.match(materializer, /ValidateAssemblySourceCommit\(options\.SourceCommit\)/u);
    assert.match(materializer, /ValidateServiceEnvelope\([\s\S]*options\.RunId/u);
    assert.match(materializer, /BeginTranAsync\(IsolationLevel\.RepeatableRead\)[\s\S]*InitTables\([\s\S]*observer\.ReadAsync[\s\S]*AtomicWrite\(preparedOutputPath[\s\S]*CommitTranAsync\(\)[\s\S]*AtomicWrite\(resolvedOutputPath/u);
    assert.match(materializer, /InitTables\([\s\S]*CurrentSchemaRuntimeRollupTables\.ApplyEnsureTableStepsAsync[\s\S]*PgCurrentSchemaControlShape\.EnsureApplyJournalAsync[\s\S]*observer\.ReadAsync/u);
    assert.match(materializer, /RollbackTranAsync\(\)/u);
    assert.match(materializer, /File\.Move\(temporaryPath, fullPath, overwrite: false\)/u);

    const inspector = fs.readFileSync(path.join(root, inspectorRelative), 'utf8');
    assert.match(inspector, /PgCurrentSchemaCatalogObserver\.ReadAsync\(connection, (?:borrowed|transaction), cancellationToken\)/u);
    const nativeCatalog = fs.readFileSync(
        path.join(root, 'src/shared/Algorithms/Schema/PgCurrentSchemaCatalogObserver.cs'), 'utf8'
    );
    assert.match(nativeCatalog, /owning_constraint\.conindid = index_meta\.indexrelid[\s\S]*owning_constraint\.contype = 'p'/u);

    const commandRoute = program.indexOf('CurrentSchemaTestMaterializationCommandLine.IsRequested(args)');
    const serveParser = program.indexOf('ServerCommandLine.Parse(args)');
    assert.ok(commandRoute >= 0 && commandRoute < serveParser);
    assert.match(program, /exceptionCode\.StartsWith\("current_schema_"/u);

    const databaseServices = bootstrap.indexOf("RunBootstrapParallel 'database services and backend producer'");
    const materialization = bootstrap.indexOf('MaterializeCurrentSchemaForTestRuntime\n', databaseServices);
    const runtimeReadyGate = bootstrap.indexOf('RequireCurrentSchemaRuntimeReady\n', materialization);
    const runtimeApplications = bootstrap.indexOf("RunBootstrapParallel 'runtime applications'", runtimeReadyGate);
    assert.ok(databaseServices >= 0 && materialization > databaseServices);
    assert.ok(runtimeReadyGate > materialization && runtimeApplications > runtimeReadyGate);
    assert.match(bootstrap, /ASPNETCORE_ENVIRONMENT=Test[\s\\]*\n[\s\S]*FSUSBLOG_CURRENT_SCHEMA_TEST_MATERIALIZATION=1/u);
    assert.match(bootstrap, /ConnectionStrings__DefaultConnection="\$\{POSTGRES_CONNECTION\};Search Path=public"/u);
    assert.match(bootstrap, /--service-envelope "\$EXECUTION_SERVICE_ENVELOPE_FILE"/u);
    assert.match(bootstrap, /--service-catalog "\$serviceCatalogFile"/u);
    const materializerFunction = bootstrap.slice(
        bootstrap.indexOf('MaterializeCurrentSchemaForTestRuntime()'),
        bootstrap.indexOf('EnsureBackend()')
    );
    const materializerInvocation = materializerFunction.slice(
        materializerFunction.indexOf('materialize-current-schema-test'),
        materializerFunction.indexOf('verify-current-schema-test-materialization-receipt.mjs')
    );
    assert.doesNotMatch(materializerInvocation, /--output/u);
    assert.match(bootstrap, /CurrentSchemaRunDigest\(\)[\s\S]*?printf '%s' "\$runId" \| sha256sum/u);
    assert.match(materializerFunction, /current-schema-test-materialization-\$\{runDigest\}\.json/u);
    assert.match(
        materializerFunction,
        /--verify-envelope "\$EXECUTION_SERVICE_ENVELOPE_FILE"[\s\S]*?materialize-current-schema-test[\s\S]*?verify-current-schema-test-materialization-receipt\.mjs[\s\S]*?--receipt-root "\$TMP_DIR"/u
    );
    assert.match(
        bootstrap,
        /ResolveCurrentSchemaCandidateAssembly\(\)[\s\S]*?FSUSBLOG_PRODUCTION_BUILD_ROOT[\s\S]*?FSUSBLOG_BACKEND_SERVER_DLL[\s\S]*?CURRENT_SCHEMA_CANDIDATE_ASSEMBLY="\$candidateAssembly"/u
    );
    assert.match(
        bootstrap,
        /verifyProductionBuildConsumerMaterialization[\s\S]*?backend-runtime[\s\S]*?FsusBlog\.Server\.dll/u
    );
    assert.match(
        bootstrap,
        /productionBuildEnvironmentAssignments\(\{ root, runId \}\)[\s\S]*?FSUSBLOG_PRODUCTION_BUILD_ROOT !== buildRoot[\s\S]*?FSUSBLOG_BACKEND_SERVER_DLL !== candidateAssembly/u
    );
    assert.match(
        materializerFunction,
        /ResolveCurrentSchemaCandidateAssembly "\$runtimeConfiguration"[\s\S]*?build-with-data-env\.sh dotnet "\$CURRENT_SCHEMA_CANDIDATE_ASSEMBLY"[\s\S]*?materialize-current-schema-test/u
    );
    assert.doesNotMatch(materializerFunction, /dotnet run|--project src\/backend\/FsusBlog\.Server\.csproj/u);
    assert.ok(
        bootstrap.match(/--assembly "\$\{?CURRENT_SCHEMA_CANDIDATE_ASSEMBLY/gu).length >= 6,
        'every materializer, admission, environment-ready, topology, and terminal consumer uses one candidate assembly'
    );
    assert.doesNotMatch(
        bootstrap,
        /--assembly "\$ROOT_DIR\/src\/backend\/bin\/\$\{?FSUSBLOG_RUNTIME_CONFIGURATION/u
    );

    const servicesOnly = homogeneousTwoNode.indexOf('bootstrap-acceptance-env.sh" --services-only');
    const productionEnvironment = homogeneousTwoNode.indexOf('export-production-build-environment.mjs');
    const sourceBoundBuild = homogeneousTwoNode.indexOf('-p:FsusBlogCommitSha=');
    const schemaMaterialization = homogeneousTwoNode.indexOf('MaterializeCurrentSchemaForTestRuntime');
    const schemaRuntimeReadyGate = homogeneousTwoNode.indexOf('RequireCurrentSchemaRuntimeReady');
    const nodeSpawn = homogeneousTwoNode.indexOf('homogeneous-two-node-fixture.mjs');
    assert.ok(productionEnvironment >= 0 && servicesOnly > productionEnvironment && sourceBoundBuild > servicesOnly);
    assert.ok(schemaMaterialization > sourceBoundBuild);
    assert.ok(schemaRuntimeReadyGate > schemaMaterialization && nodeSpawn > schemaRuntimeReadyGate);
    assert.match(homogeneousTwoNode, /FSUSBLOG_BOOTSTRAP_SOURCE_ONLY=1[\s\S]*?source "\$ROOT_DIR\/tools\/bootstrap-acceptance-env\.sh"/u);
    assert.match(homogeneousTwoNode, /BACKEND_ARTIFACT="\$\{FSUSBLOG_BACKEND_SERVER_DLL:\?two-node candidate assembly is required\}"/u);
    assert.doesNotMatch(homogeneousTwoNode, /src\/backend\/bin\/\$CONFIGURATION\/net10\.0\/FsusBlog\.Server\.dll/u);
    assert.match(homogeneousTwoNode, /PORT_LEASE_RELEASE_ON_EXIT=0[\s\S]*?MaterializeCurrentSchemaForTestRuntime/u);
    assert.match(
        bootstrap,
        /RequireCurrentSchemaRuntimeReady\(\)[\s\S]*?expectedRuntimeReadyFile[\s\S]*?verify-current-schema-runtime-topology-admission/u
    );
    assert.match(bootstrap, /write-acceptance-runtime-topology[\s\S]*?verify-current-schema-terminal-dag/u);
    assert.match(bootstrap, /--service-generation "sha256:\$\{FSUSBLOG_FIXTURE_SERVICE_GENERATION/u);
    assert.match(bootstrap, /fixtureExecutionIdentity:[\s\S]*?runId: \$executionRunId[\s\S]*?namespace: \$namespace[\s\S]*?commit: \$sourceCommit[\s\S]*?worktreeFingerprint: \$sourceFingerprint[\s\S]*?serviceGeneration: \$serviceGeneration/u);
    assert.match(
        bootstrap,
        /ConnectionStrings__DefaultConnection="\$\{POSTGRES_CONNECTION\};Search Path=public"[\s\\]*\n[\s\S]*?verify-current-schema-runtime-topology-admission/u
    );
    assert.ok(
        bootstrap.match(/ConnectionStrings__DefaultConnection="\$\{POSTGRES_CONNECTION\};Search Path=public"/gu).length >= 6,
        'every publish, admission, environment-ready, topology, and final verifier process needs the live database identity'
    );
    const main = bootstrap.slice(bootstrap.indexOf('Main() {'));
    const topologyInput = main.indexOf('WriteRuntimeTopologyInput');
    const bootstrapMaterializer = main.indexOf('MaterializeCurrentSchemaForTestRuntime');
    const preSpawnAdmission = main.indexOf('RequireCurrentSchemaRuntimeReady', bootstrapMaterializer);
    const runtimeSpawn = main.indexOf("RunBootstrapParallel 'runtime applications'");
    const terminalDag = main.indexOf('verify-current-schema-terminal-dag');
    assert.ok(topologyInput >= 0 && topologyInput < bootstrapMaterializer);
    assert.ok(bootstrapMaterializer < preSpawnAdmission && preSpawnAdmission < runtimeSpawn);
    assert.ok(runtimeSpawn < terminalDag, 'completed runtime topology remains terminal evidence, not a pre-spawn liveness claim');
});
