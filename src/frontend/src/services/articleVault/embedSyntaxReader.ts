import { collectMarkdownEmbedNodes } from '@ozwasyd/element-plus/markdown-runtime';

import type { MarkdownEmbedMode } from '@ozwasyd/element-plus/markdown-runtime';

export interface VaultEmbedSyntaxSnapshot {
    readonly sourceSha256: string;
    readonly valid: boolean;
    readonly directives: readonly {
        readonly parserContract: 'fsusui.markdown-embed-directive.v1';
        readonly targetToken: string;
        readonly mode: MarkdownEmbedMode;
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
 * Consumes #290 syntax without interpreting Blog targets or fetching their content.
 * Identity/permission/frozen-coordinate admission belongs to the canonical Blog contracts.
 */
export async function readVaultEmbedSyntax(source: string, expectedSourceSha256: string): Promise<VaultEmbedSyntaxSnapshot>
{
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    const sourceSha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
    if (sourceSha256 !== expectedSourceSha256)
    {
        throw new Error('vault_embed_source_digest_mismatch');
    }
    const nodes = collectMarkdownEmbedNodes(source);
    const diagnostics = nodes.flatMap(node => node.ok ? [] : [Object.freeze({
        code: node.code,
        start: node.range.start,
        end: node.range.end
    })]);
    const directives = diagnostics.length > 0 ? [] : nodes.flatMap(node => node.ok ? [Object.freeze({
        parserContract: 'fsusui.markdown-embed-directive.v1' as const,
        targetToken: node.target,
        mode: node.mode,
        start: node.ranges.full.start,
        end: node.ranges.full.end
    })] : []);
    return Object.freeze({
        sourceSha256,
        valid: diagnostics.length === 0,
        directives: Object.freeze(directives),
        diagnostics: Object.freeze(diagnostics)
    });
}

/** Replays the public parser against exact source rather than trusting serialized token/range fields. */
export async function verifyVaultEmbedSyntax(source: string, expectedSourceSha256: string, candidate: VaultEmbedSyntaxSnapshot): Promise<boolean>
{
    const actual = await readVaultEmbedSyntax(source, expectedSourceSha256);
    return candidate.sourceSha256 === actual.sourceSha256 && candidate.valid === actual.valid
        && candidate.directives.length === actual.directives.length
        && actual.directives.every((checked, index) =>
        {
            const directive = candidate.directives[index];
            return directive?.parserContract === checked.parserContract
                && directive?.targetToken === checked.targetToken && directive?.mode === checked.mode
                && directive?.start === checked.start && directive?.end === checked.end;
        })
        && candidate.diagnostics.length === actual.diagnostics.length
        && actual.diagnostics.every((checked, index) =>
        {
            const diagnostic = candidate.diagnostics[index];
            return diagnostic?.code === checked.code
                && diagnostic?.start === checked.start && diagnostic?.end === checked.end;
        });
}
