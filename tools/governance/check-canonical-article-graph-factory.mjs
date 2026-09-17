#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const defaultRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);

export const requiredAuthorityFiles = Object.freeze([
    "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphModels.cs",
    "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs",
    "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphVerifier.cs",
    "src/backend/Services/Fixtures/DataScale/ArticleScalePlan.cs"
]);

export function checkCanonicalArticleGraphFactoryAuthority(repositoryRoot = defaultRoot)
{
    const violations = [];

    // 1. Check existence of authority files
    for (const relative of requiredAuthorityFiles)
    {
        const absolute = path.join(repositoryRoot, relative);
        if (!existsSync(absolute))
        {
            violations.push(`required authority file missing: ${relative}`);
        }
    }

    if (violations.length > 0)
    {
        return violations;
    }

    const factorySource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphFactory.cs"),
        "utf8"
    );
    const verifierSource = readFileSync(
        path.join(repositoryRoot, "src/backend/Services/Fixtures/DataScale/CanonicalArticleGraphVerifier.cs"),
        "utf8"
    );

    // 2. Direct SQL prohibition in factory
    if (/(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|SELECT\s+[\w*,\s]+\s+FROM)/iu.test(factorySource))
    {
        violations.push("direct SQL statement prohibited in CanonicalArticleGraphFactory");
    }
    if (/\b(?:ExecuteSql|Ado\.ExecuteCommand|Ado\.GetDataReaderAsync)\b/u.test(factorySource))
    {
        violations.push("raw SQL execution prohibited in CanonicalArticleGraphFactory");
    }
    if (/\b(?:Npgsql|SqlSugar|PostgreSQL|SQLite|MySQL)\b/u.test(factorySource))
    {
        violations.push("database provider dependencies prohibited in CanonicalArticleGraphFactory");
    }

    // 3. Database writes prohibition (pure factory only)
    if (/\b(?:ISqlSugarClient|InsertAsync|UpdateAsync|DeleteAsync|UseTranAsync)\b/u.test(factorySource))
    {
        violations.push("database writes prohibited in CanonicalArticleGraphFactory (pure factory only)");
    }

    // 4. Sentinel hashes prohibition
    if (/(?:recompute|sentinel|placeholder)/iu.test(factorySource))
    {
        violations.push("sentinel or placeholder hashes prohibited in CanonicalArticleGraphFactory");
    }

    // 4b. Fake authority / forged proof prohibition
    if (/CreatedByAdminPrincipalId["\]]{0,2}\s*=\s*1L?\b/u.test(factorySource)
        || /ContentBlockId["\]]{0,2}\s*=\s*1L?\b/u.test(factorySource)
        || /ActorPrincipalId["\]]{0,2}\s*=\s*1L?\b/u.test(factorySource))
    {
        violations.push("hardcoded principal/content-block id=1 prohibited; use semantic-role mapped IDs");
    }
    if (/sig-verified/iu.test(factorySource)
        || /ProofStatus["\]]{0,2}\s*=\s*"verified"/u.test(factorySource)
        || /SignatureBase64Url["\]]{0,2}\s*=\s*"sig-/u.test(factorySource))
    {
        violations.push("forged verified rights-proof signature/status prohibited; use honest readiness fields");
    }
    if (!verifierSource.includes("recompute"))
    {
        violations.push("CanonicalArticleGraphVerifier must explicitly verify absence of 'recompute' sentinel");
    }

    // 5. Cache writes prohibition
    if (/\b(?:ICacheService|Redis|ConnectionMultiplexer|IMemoryCache|IDatabase|SetAsync)\b/u.test(factorySource))
    {
        violations.push("cache writes prohibited in CanonicalArticleGraphFactory");
    }

    // 6. Empty revision shortcut prohibition
    if (!factorySource.includes("ArticleRevisionContentBlock") ||
        !factorySource.includes("ArticleRightsSnapshot") ||
        !factorySource.includes("ArticleResponsibilitySnapshot"))
    {
        violations.push("empty revision shortcut prohibited: all revisions must generate content blocks and integrity snapshots");
    }

    // 7. Second graph factory prohibition
    const srcDir = path.join(repositoryRoot, "src");
    function scanFiles(dir)
    {
        const entries = readdirSync(dir);
        for (const entry of entries)
        {
            const fullPath = path.join(dir, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory())
            {
                scanFiles(fullPath);
            }
            else if (stat.isFile() && entry.endsWith(".cs"))
            {
                if (entry !== "CanonicalArticleGraphFactory.cs" &&
                    entry !== "CanonicalArticleGraphVerifier.cs" &&
                    entry !== "CanonicalArticleGraphModels.cs" &&
                    entry !== "ArticleScalePlan.cs")
                {
                    const content = readFileSync(fullPath, "utf8");
                    if (content.includes("ArticleScaleArticleGraph") &&
                        (content.includes("class ") || content.includes("interface ")) &&
                        /class\s+\w*ArticleGraphFactory\b/u.test(content))
                    {
                        violations.push(`second article graph factory prohibited: found in ${path.relative(repositoryRoot, fullPath)}`);
                    }
                }
            }
        }
    }
    if (existsSync(srcDir))
    {
        scanFiles(srcDir);
    }

    return violations;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    const violations = checkCanonicalArticleGraphFactoryAuthority();
    if (violations.length > 0)
    {
        console.error("Canonical article graph factory authority violations detected:");
        for (const v of violations)
        {
            console.error(`- ${v}`);
        }
        process.exit(1);
    }
    console.log("Canonical article graph factory authority check passed.");
}
