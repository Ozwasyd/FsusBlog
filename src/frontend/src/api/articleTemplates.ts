/** Proposed owner-facing transport projection. Implement through existing typed AEDS/session/PoW
 * infrastructure; this module registers no routes, codecs, stores or alternate article writer. */
export interface ArticleTemplateSummary
{
    readonly templateId: string;
    readonly name: string;
    readonly description: string | null;
    readonly scope: 'personal' | 'site';
    readonly status: 'active' | 'retired' | 'deleted';
    readonly definitionRevision: number;
    readonly versionId: string;
    readonly versionNumber: number;
    readonly versionDigest: string;
    readonly canManage: boolean;
}

export interface ArticleTemplateDefaults
{
    readonly titlePlaceholder: string | null;
    readonly summaryPlaceholder: string | null;
    readonly categoryId: number | null;
    readonly tagIds: readonly number[];
    readonly assetIds: readonly string[];
    readonly propertyDefaults: readonly {
        readonly definitionId: string;
        readonly valueKind: number;
        readonly canonicalValue: string | null;
        readonly optionIds: readonly string[];
    }[];
    readonly rightsProfile: { readonly profileId: string; readonly revision: number; } | null;
    readonly responsibilityProfile: { readonly profileId: string; readonly revision: number; } | null;
    readonly prepublishProfile: { readonly profileId: string; readonly revision: number; } | null;
}

export interface ArticleTemplateVersion extends ArticleTemplateSummary
{
    /** Display-only source. It must never become client-expanded article content. */
    readonly source: string;
    readonly variables: readonly ('title' | 'date' | 'author' | 'site_locale')[];
    readonly defaults: ArticleTemplateDefaults;
    readonly scopeRevision: number;
    readonly provenanceCount: number;
}

export interface ArticleTemplateVersionReference
{
    readonly versionId: string;
    readonly versionNumber: number;
    readonly versionDigest: string;
}

export interface ArticleTemplateInputs
{
    readonly title: string | null;
    readonly businessTimeUtc: string;
    readonly timeZoneId: string;
    readonly localeCode: string;
}

export interface ArticleTemplatePlan
{
    readonly templateId: string;
    readonly versionId: string;
    readonly versionNumber: number;
    readonly versionDigest: string;
    readonly definitionRevision: number;
    readonly planDigest: string;
    readonly inputDigest: string;
    readonly sourceDigest: string;
    readonly inputs: ArticleTemplateInputs;
    readonly issuedAtUtc: string;
    readonly expiresAtUtc: string;
    readonly qualification: 'qualified';
}

export interface CanonicalArticleCreateReceipt
{
    readonly articleId: number;
    readonly receiptId: string;
    readonly contentDigest: string;
}

/** No omitted/partial template state, client expansion, or post-create patch exists in this union. */
export type CanonicalArticleCreateRequest =
    | { readonly kind: 'blank'; readonly requestId: string; }
    | {
        readonly kind: 'explicit-template';
        readonly requestId: string;
        readonly templateId: string;
        readonly versionId: string;
        readonly versionDigest: string;
        readonly planDigest: string;
        readonly inputDigest: string;
        readonly inputs: ArticleTemplateInputs;
    };

export type ArticleTemplateManagementCommand =
    | {
        readonly kind: 'create'; readonly requestId: string; readonly templateId: string;
        readonly versionId: string; readonly scope: 'personal' | 'site'; readonly expectedScopeRevision: number;
        readonly name: string; readonly description: string | null; readonly source: string;
        readonly defaults: ArticleTemplateDefaults;
    }
    | {
        readonly kind: 'new-version'; readonly requestId: string; readonly templateId: string;
        readonly versionId: string; readonly expectedScopeRevision: number; readonly expectedDefinitionRevision: number;
        readonly expectedCurrentVersionNumber: number; readonly source: string; readonly defaults: ArticleTemplateDefaults;
    }
    | {
        readonly kind: 'rename'; readonly requestId: string; readonly templateId: string;
        readonly expectedScopeRevision: number; readonly expectedDefinitionRevision: number;
        readonly name: string; readonly description: string | null;
    }
    | {
        readonly kind: 'retire' | 'delete'; readonly requestId: string; readonly templateId: string;
        readonly expectedScopeRevision: number; readonly expectedDefinitionRevision: number;
    };

export interface ArticleTemplateTransport
{
    listVersions(input: { readonly templateId: string; readonly afterVersionNumber: number | null; readonly limit: number; }, signal: AbortSignal): Promise<{
        readonly items: readonly ArticleTemplateVersionReference[]; readonly nextVersionNumber: number | null;
    }>;
    list(input: { readonly query: string; readonly cursor: string | null; readonly limit: number; }, signal: AbortSignal): Promise<{
        readonly items: readonly ArticleTemplateSummary[]; readonly nextCursor: string | null;
    }>;
    getVersion(input: { readonly templateId: string; readonly versionId: string; }, signal: AbortSignal): Promise<ArticleTemplateVersion>;
    plan(input: {
        readonly templateId: string; readonly versionId: string; readonly versionDigest: string;
        readonly definitionRevision: number; readonly inputs: ArticleTemplateInputs;
    }, signal: AbortSignal): Promise<ArticleTemplatePlan>;
    manage(command: ArticleTemplateManagementCommand): Promise<{ readonly receiptId: string; readonly contentDigest: string; }>;
}

/** The integration owner must supply the existing canonical create API and unique workspace opener. */
export interface ArticleTemplateCreateHost
{
    create(request: CanonicalArticleCreateRequest): Promise<CanonicalArticleCreateReceipt>;
    openOrActivate(articleId: number): Promise<void>;
}
