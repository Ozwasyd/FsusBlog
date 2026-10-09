import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const runtimePaths = [
    '../../../../src/frontend/src/services/authoring/articleGraphQuery.ts',
    '../../../../src/frontend/src/services/authoring/articleGraphSession.ts',
    '../../../../src/frontend/src/components/admin/article/ArticleRelationGraph.vue',
    '../../../../src/backend/Services/Authoring/ArticleGraphQueryService.cs',
    '../../../../src/shared/Contracts/ArticleGraph/ArticleGraphContracts.cs',
    '../../../../src/shared/Contracts/ArticleGraph/ArticleGraphContract.cs'
];
const controls = [
    { reason: 'persistent-state', forbidden: /(?:localStorage|sessionStorage|indexedDB|history\.replaceState|localStorage\.setItem)/u, mutation: 'localStorage.setItem("depth", "2")' },
    { reason: 'client-scanner', forbidden: /(?:parseMarkdown|DOMParser|querySelectorAll|innerHTML|markdownBody)/u, mutation: 'new DOMParser()' },
    { reason: 'second-edge-authority', forbidden: /(?:relationCache|edgeCache|relationIndex|RelationIndexStore)/u, mutation: 'const relationCache = new Map()' },
    { reason: 'unbounded-animation', forbidden: /(?:requestAnimationFrame|setInterval|forceSimulation|WebGLRenderer)/u, mutation: 'requestAnimationFrame(tick)' },
    { reason: 'nondeterministic-layout', forbidden: /Math\.random/u, mutation: 'Math.random()' },
    { reason: 'relation-writeback', forbidden: /(?:updateArticle|saveRelation|rewriteSource|setCategory|ArticleService)/u, mutation: 'saveRelation(edge)' },
    { reason: 'ai-edges', forbidden: /(?:embedding|recommendationScore|aiCluster)/u, mutation: 'const aiCluster = []' },
    { reason: 'navigation-guess', forbidden: /(?:router\.push|window\.open|location\.href|findByTitle)/u, mutation: 'router.push(node.title)' }
];

const findings = (source: string): string[] => controls.filter(control => control.forbidden.test(source)).map(control => control.reason);

describe('graph authority negative controls', () => {
    it('keeps the new runtime free of persistence/scanners/second index/force/writeback/route guesses', () => {
        for (const path of runtimePaths) {
            expect(findings(readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')), path).toEqual([]);
        }
    });

    it.each(controls)('kills $reason mutation', control => {
        expect(findings(control.mutation)).toContain(control.reason);
    });
});
