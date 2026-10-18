import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
    checkArticleRelationCatalog,
    checkArticleRelations,
    checkArticleRelationSources,
    readArticleRelationSources
} from "../../tools/governance/check-article-relations.mjs";

const root = path.resolve(import.meta.dirname, "../..");

const contractsPath =
    "src/shared/Contracts/ArticleRelations/ArticleRelationContracts.cs";
const catalogPath =
    "src/shared/Contracts/ArticleRelations/ArticleRelationCatalog.cs";
const validatorPath =
    "src/shared/Contracts/ArticleRelations/ArticleRelationContractValidator.cs";
const parserBridgePath = "src/backend/Services/Authoring/CanonicalArticleRelationParserBridge.cs";
const parserBridgeScriptPath = "src/backend/Services/Authoring/canonicalArticleRelationParserBridge.mjs";

function sources()
{
    return new Map(readArticleRelationSources());
}

function diagnostics(mutator)
{
    const fixture = sources();
    mutator(fixture);
    return checkArticleRelationSources(fixture).join("\n");
}

test("block target schema admits canonical raw anchors and rejects noncanonical prefixed suffixes", () =>
{
    const { catalog, schema } = jsonFixtures();
    const rule = new RegExp(schema.$defs.targetIdentity.properties.blockAnchorIdentity.oneOf[0].pattern, "u");
    for (const anchor of ["a", "release-notes-2026", "a".repeat(64)])
    {
        for (const prefix of ["", "block:", "anchor:"])
        {
            assert.equal(rule.test(`${prefix}${anchor}`), true);
        }
    }
    for (const anchor of ["", "UPPERCASE", "bad_suffix", "1leading", "a:alias", "é", "^marker", "#fragment", "a%20", "a b", "a".repeat(65)])
    {
        for (const prefix of ["", "block:", "anchor:"])
        {
            assert.equal(rule.test(`${prefix}${anchor}`), false);
        }
    }
    schema.$defs.targetIdentity.properties.blockAnchorIdentity.oneOf[0].pattern = "^(?:block|anchor):[^\\s/#?=]+$";
    assert.match(checkArticleRelationCatalog(catalog, schema).join("\n"), /canonical raw anchors/u);
});

function jsonFixtures()
{
    return {
        catalog: JSON.parse(
            readFileSync(path.join(root, "config/contracts/article-relation-catalog.json"), "utf8")
        ),
        schema: JSON.parse(
            readFileSync(path.join(root, "config/schemas/article-relation-contract.schema.json"), "utf8")
        )
    };
}

test("article relation authority is one closed contract/catalog/validator slice", () =>
{
    assert.deepEqual(checkArticleRelations(), []);
});

test("canonical bridge admission is exact to its owner, original reader and public runtime", () =>
{
    const original = sources();
    const mutations = [
        (fixture) => fixture.set("src/backend/OtherCanonicalArticleRelationParserBridge.cs", original.get(parserBridgePath)),
        (fixture) => fixture.set(parserBridgePath, original.get(parserBridgePath).replace("AuthoringRevisionComparePackageReader reader", "OtherReader reader")),
        (fixture) => fixture.delete(parserBridgeScriptPath),
        (fixture) => fixture.set(parserBridgeScriptPath, original.get(parserBridgeScriptPath).replace("runtime.createMarkdownEditorProjection(", "otherParser(")),
        (fixture) => fixture.set(parserBridgeScriptPath, original.get(parserBridgeScriptPath) + "\nconst second = new RegExp('body');"),
        (fixture) => fixture.set(parserBridgeScriptPath, original.get(parserBridgeScriptPath) + "\nimport '@element-plus/wasm';")
    ];
    for (const mutate of mutations)
    {
        const fixture = new Map(original);
        mutate(fixture);
        assert.match(checkArticleRelationSources(fixture).join("\n"), /forbidden downstream implementation|sole public-runtime script/u);
    }
});

test("catalog closes kinds, resolution states, lifecycle events and public policy", () =>
{
    const { catalog, schema } = jsonFixtures();
    assert.deepEqual(checkArticleRelationCatalog(catalog, schema), []);
    assert.deepEqual(
        catalog.kinds.map((entry) => entry.key),
        ["outgoing", "backlink", "broken", "visibility-risk", "unlinked-mention"]
    );
    assert.deepEqual(
        catalog.receipts,
        ["index", "query", "ignore-decision", "prepublish", "inspector"]
    );
    assert.equal(schema["x-fsusblog-contract"].publicQueryPolicy, "current-public-publication-only");
    assert.deepEqual(
        schema["x-fsusblog-contract"].forbiddenAuthorities,
        ["frontend-regex", "rendered-dom", "related-reading", "search-index", "ai", "embedding"]
    );
});

test("duplicate authorities and downstream implementations fail closed", () =>
{
    const mutations = [
        [
            "src/backend/OtherArticleRelationSchemas.cs",
            "public static class ArticleRelationSchemas {}",
            /exact-one schema constants/u
        ],
        [
            "src/backend/OtherArticleRelationRecord.cs",
            "public record ArticleRelationRecord();",
            /exact-one relation record/u
        ],
        [
            "src/backend/OtherArticleRelationCatalog.cs",
            "public static class ArticleRelationCatalog {}",
            /exact-one relation catalog/u
        ],
        [
            "src/backend/OtherArticleRelationStatus.cs",
            "public enum ArticleRelationResolutionStatus { Other = 99 }",
            /exact-one resolution status enum/u
        ],
        [
            "src/backend/OtherArticleRelationQuery.cs",
            "public class ArticleRelationQuery {}",
            /forbidden downstream implementation/u
        ],
        [
            "src/backend/OtherArticleRelationParser.cs",
            "public class ArticleRelationParser {}",
            /forbidden downstream implementation/u
        ]
    ];
    for (const [relative, source, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) => fixture.set(relative, source)),
            expected
        );
    }
});

test("parser, rendered, transport, storage, AI and projection inputs are forbidden", () =>
{
    const mutations = [
        [" var token = parseMarkdown(value);", /Markdown parser or regular-expression scanning/u],
        [" var html = new HtmlDocument();", /rendered HTML, DOM, component or browser payload/u],
        [" var client = new HttpClient();", /database, transport or business write/u],
        [" var vector = new Embedding();", /AI, embedding, fuzzy or semantic relationship type/u],
        [" var item = RelatedReading.Resolve(value);", /related-reading or search-index authority/u],
    ];
    for (const [injected, expected] of mutations)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(contractsPath, `${fixture.get(contractsPath)}\n${injected}\n`)
            ),
            expected
        );
    }
});

test("stable identity and visibility boundaries are guarded", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "string? BlockAnchorIdentity);",
                        "string? BlockAnchorIdentity,\n    string? Url);"
                    )
            )
        ),
        /stable identities only, never URL\/slug\/title\/heading text/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                `${fixture.get(contractsPath)}\npublic record ArticleRelationVisibilityProjection(bool IsVisible);\n`
            )
        ),
        /must not collapse to a visible boolean/u
    );
});

test("required fail-closed guards cannot be removed", () =>
{
    const guards = [
        ["ArticleRelationCatalog.Validate", /missing catalog validation guard/u],
        ["article_relation_kind_orphan", /missing kind orphan rejection guard/u],
        ["article_relation_kind_target_required", /missing stable target requirement guard/u],
        ["article_relation_duplicate_or_orphan_record", /missing duplicate relation rejection guard/u],
        ["article_relation_public_draft_or_private_mix", /missing draft\/public rejection guard/u],
        ["article_relation_target_draft_revision_lifecycle_mismatch", /missing target revision\/lifecycle consistency guard/u],
        ["article_relation_contract_version_unknown", /missing unknown contract rejection guard/u],
        ["article_relation_lifecycle_owner_mismatch", /missing unowned lifecycle rejection guard/u],
        ["article_relation_identity_digest_mismatch", /missing relation identity digest guard/u],
        ["article_relation_record_digest_mismatch", /missing record digest guard/u],
        ["article_relation_mention_candidate_invalid", /missing candidate non-authority rejection guard/u],
        ["article_relation_lifecycle_obligations_invalid", /missing lifecycle obligation validation guard/u],
        ["article_relation_receipt_digest_mismatch", /missing receipt digest validation guard/u]
    ];
    for (const [removed, expected] of guards)
    {
        assert.match(
            diagnostics((fixture) =>
                fixture.set(
                    validatorPath,
                    fixture.get(validatorPath).replaceAll(removed, "removed_guard")
                )
            ),
            expected
        );
    }
});

test("closed schemas reject projection fields and authoritative mention candidates", () =>
{
    const { catalog, schema } = jsonFixtures();
    const targetIdentity = schema.$defs.targetIdentity;
    targetIdentity.properties.url = { type: "string" };
    assert.match(
        checkArticleRelationCatalog(catalog, schema).join("\n"),
        /target identity schema must not define URL\/slug\/title\/heading-text fields/u
    );

    const fixtures = jsonFixtures();
    fixtures.schema.$defs.relation.additionalProperties = true;
    assert.match(
        checkArticleRelationCatalog(fixtures.catalog, fixtures.schema).join("\n"),
        /schema definition relation must remain closed/u
    );

    const candidateFixtures = jsonFixtures();
    candidateFixtures.schema.$defs.mentionCandidate.properties.isAuthoritative.const = true;
    assert.match(
        checkArticleRelationCatalog(candidateFixtures.catalog, candidateFixtures.schema).join("\n"),
        /unlinked mention candidate schema must be explicitly non-authoritative/u
    );
});

test("relation receipts carry only identities, statuses and digests", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replace(
                        "string ReceiptDigest);",
                        "string ReceiptDigest,\n    string Content);"
                    )
            )
        ),
        /relation receipts must record identities, statuses and digests only/u
    );
});

test("canonical serialization remains length-prefixed and tamper evidence remains mandatory", () =>
{
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                contractsPath,
                fixture
                    .get(contractsPath)
                    .replaceAll("CanonicalSerialization", "SerializationMode")
                    .replaceAll("length-prefixed-utf8-v1", "delimited-utf8")
            )
        ),
        /relation contracts must declare the canonical length-prefixed serialization/u
    );
    assert.match(
        diagnostics((fixture) =>
            fixture.set(
                validatorPath,
                fixture.get(validatorPath).replaceAll("ComputeRelationIdentity", "ComputeRelation")
                    .replaceAll("article_relation_identity_digest_mismatch", "removed_guard")
            )
        ),
        /missing relation identity digest guard/u
    );
});
