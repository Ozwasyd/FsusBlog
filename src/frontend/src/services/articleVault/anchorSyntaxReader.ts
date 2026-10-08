import { collectMarkdownAnchorNodes } from '@ozwasyd/element-plus/markdown-runtime';

/** A caller-validated Vault/source coordinate; paths and labels never identify it. */
export interface VaultAnchorSourceBinding {
    readonly siteIdentity: string;
    readonly vaultIdentity: string;
    readonly portableArticleIdentity: string;
    readonly sourceRevision: number;
    readonly sourceSha256: string;
}

export interface VaultAnchorSyntaxSnapshot {
    readonly binding: VaultAnchorSourceBinding;
    readonly valid: boolean;
    readonly anchors: readonly {
        readonly anchorIdentity: string;
        readonly start: number;
        readonly end: number;
    }[];
    readonly diagnostics: readonly {
        readonly code: string;
        readonly start: number;
        readonly end: number;
    }[];
}

/**
 * Reads only the public #289 grammar. One malformed/duplicate occurrence blocks
 * the whole snapshot, so an earlier occurrence cannot become a first-match target.
 * This ephemeral projection is neither a durable registry nor a relation index.
 */
export async function readVaultAnchorSyntax(
    source: string,
    binding: VaultAnchorSourceBinding,
    expected: VaultAnchorSourceBinding
): Promise<VaultAnchorSyntaxSnapshot>
{
    if (binding.siteIdentity !== expected.siteIdentity
        || binding.vaultIdentity !== expected.vaultIdentity
        || binding.portableArticleIdentity !== expected.portableArticleIdentity
        || binding.sourceRevision !== expected.sourceRevision
        || binding.sourceSha256 !== expected.sourceSha256
        || !Number.isSafeInteger(binding.sourceRevision)
        || binding.sourceRevision < 1
        || !binding.siteIdentity || !binding.vaultIdentity || !binding.portableArticleIdentity)
    {
        throw new Error('vault_anchor_source_binding_mismatch');
    }
    const bytes = new TextEncoder().encode(source);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const sourceSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sourceSha256 !== binding.sourceSha256)
    {
        throw new Error('vault_anchor_source_digest_mismatch');
    }
    const nodes = collectMarkdownAnchorNodes(source);
    const diagnostics = nodes.flatMap(node => node.ok ? [] : [Object.freeze({
        code: node.code,
        start: node.range.start,
        end: node.range.end
    })]);
    const anchors = diagnostics.length > 0 ? [] : nodes.flatMap(node => node.ok ? [Object.freeze({
        anchorIdentity: node.id,
        start: node.ranges.marker.start,
        end: node.ranges.marker.end
    })] : []);
    return Object.freeze({
        binding: Object.freeze({ ...binding }),
        valid: diagnostics.length === 0,
        anchors: Object.freeze(anchors),
        diagnostics: Object.freeze(diagnostics)
    });
}

/** Reconsumes the real grammar and exact bytes; caller-provided ranges never become authority. */
export async function verifyVaultAnchorSyntax(
    source: string,
    expected: VaultAnchorSourceBinding,
    candidate: VaultAnchorSyntaxSnapshot
): Promise<boolean>
{
    const actual = await readVaultAnchorSyntax(source, expected, expected);
    return candidate.binding.siteIdentity === actual.binding.siteIdentity
        && candidate.binding.vaultIdentity === actual.binding.vaultIdentity
        && candidate.binding.portableArticleIdentity === actual.binding.portableArticleIdentity
        && candidate.binding.sourceRevision === actual.binding.sourceRevision
        && candidate.binding.sourceSha256 === actual.binding.sourceSha256
        && candidate.valid === actual.valid
        && candidate.anchors.length === actual.anchors.length
        && actual.anchors.every((checked, index) =>
        {
            const anchor = candidate.anchors[index];
            return anchor?.anchorIdentity === checked.anchorIdentity
                && anchor?.start === checked.start && anchor?.end === checked.end;
        })
        && candidate.diagnostics.length === actual.diagnostics.length
        && actual.diagnostics.every((checked, index) =>
        {
            const diagnostic = candidate.diagnostics[index];
            return diagnostic?.code === checked.code
                && diagnostic?.start === checked.start && diagnostic?.end === checked.end;
        });
}
