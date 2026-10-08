import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { resolveLocalFsusUiRepositoryRoot } from '../../../../src/frontend/scripts/fsusui-root.mjs';
import { readAuthorTypographyDimensionMappings } from '@/services/authoring/authorTypographyMapping';
import { describe, expect, it } from 'vitest';

import {
    AUTHOR_TYPOGRAPHY_CHOICES, AUTHOR_TYPOGRAPHY_FIELDS, isAuthorTypographyProfileView
} from '@/view-contracts/authorTypographyProfile';
import { authorTypographySettingsBlock } from '@/view-contracts/authorTypographySettings';
import type { AuthorTypographySettingsView } from '@/view-contracts/authorTypographySettings';

// An explicit test observation, never a production default or verified device fact.
const observation: AuthorTypographySettingsView = {
    profile: {
        schemaVersion: 1, fontFamily: 'cjk-sans', fontSize: 'large', lineHeight: 'relaxed',
        canvasWidth: 'narrow', paragraphSpacing: 'compact'
    },
    revision: 17, status: 'current', permission: 'allowed', device: 'verified',
    designDefault: 'verified', font: 'unavailable'
};

describe('author typography controlled settings contract', () =>
{
    it('audits every dimension against actual documented public tokens without inventing a mapping', () =>
    {
        const uiRoot = resolveLocalFsusUiRepositoryRoot({ override: process.env.FSUSBLOG_LOCAL_FSUSUI_ROOT, repositoryRoot: fileURLToPath(new URL('../../../../', import.meta.url)) });
        expect(uiRoot).not.toBeNull();
        const documentation = readFileSync(resolve(uiRoot!, 'docs/theme/generated/tokens.md'), 'utf8');
        const mappings = readAuthorTypographyDimensionMappings();
        expect(mappings.map(mapping => mapping.dimension)).toEqual(AUTHOR_TYPOGRAPHY_FIELDS);
        expect(Object.isFrozen(mappings)).toBe(true);
        for (const mapping of mappings)
        {
            expect(mapping.values).toEqual(AUTHOR_TYPOGRAPHY_CHOICES[mapping.dimension]);
            expect(mapping.status).toBe('blocked');
            expect(mapping.target).toBeNull();
            expect(mapping.missingContract).not.toBe('');
            expect(Object.isFrozen(mapping)).toBe(true);
            expect(Object.isFrozen(mapping.inspectedPublicContracts)).toBe(true);
            for (const name of mapping.inspectedPublicContracts)
            {
                if (name.startsWith('--'))
                    expect(documentation.split('\n').some(line => line.includes(`\`${name}\``) && /\|\s*public\s*\|/.test(line))).toBe(true);
                else expect(ElMarkdownEditor.props.editorProfile).toBeDefined();
            }
        }
    });


    it('keeps the five client preflight choices exactly equal to the Shared catalog', () =>
    {
        const source = readFileSync(new URL('../../../../src/shared/Contracts/AuthorTypography/AuthorTypographyContracts.cs', import.meta.url), 'utf8');
        const entries = [...source.matchAll(/\["(\w+)"\] = Array\.AsReadOnly\(new\[\] \{ ([^}]+) \}\)/g)]
            .map(([, dimension, values]) => [dimension, [...values.matchAll(/"([^"]+)"/g)].map(([, value]) => value)]);
        expect(Object.fromEntries(entries)).toEqual(AUTHOR_TYPOGRAPHY_CHOICES);
        expect(entries.map(([dimension]) => dimension)).toEqual(AUTHOR_TYPOGRAPHY_FIELDS);
        expect(source).toContain('public const int Version = 1;');
        expect(Object.isFrozen(AUTHOR_TYPOGRAPHY_CHOICES)).toBe(true);
        for (const values of Object.values(AUTHOR_TYPOGRAPHY_CHOICES)) expect(Object.isFrozen(values)).toBe(true);
    });

    it('accepts all 243 closed combinations without assigning a default', () =>
    {
        let count = 0;
        for (const fontFamily of AUTHOR_TYPOGRAPHY_CHOICES.fontFamily)
        for (const fontSize of AUTHOR_TYPOGRAPHY_CHOICES.fontSize)
        for (const lineHeight of AUTHOR_TYPOGRAPHY_CHOICES.lineHeight)
        for (const canvasWidth of AUTHOR_TYPOGRAPHY_CHOICES.canvasWidth)
        for (const paragraphSpacing of AUTHOR_TYPOGRAPHY_CHOICES.paragraphSpacing)
        {
            expect(isAuthorTypographyProfileView({ schemaVersion: 1, fontFamily, fontSize, lineHeight, canvasWidth, paragraphSpacing })).toBe(true);
            count += 1;
        }
        expect(count).toBe(243);
        expect(isAuthorTypographyProfileView({})).toBe(false);
    });

    it('refuses arbitrary values, extra dimensions, modes, font URLs and CSS', () =>
    {
        for (const dimension of AUTHOR_TYPOGRAPHY_FIELDS)
        {
            for (const value of ['18px', 'https://fonts.example/font.woff2', 'var(--custom)', '', null, 18, 'STANDARD'])
                expect(isAuthorTypographyProfileView({ ...observation.profile, [dimension]: value })).toBe(false);
            const missing = { ...observation.profile } as Record<string, unknown>;
            delete missing[dimension];
            expect(isAuthorTypographyProfileView(missing)).toBe(false);
        }
        for (const extra of [{ mode: 'source' }, { articleId: 1 }, { css: 'body{}' }, { [Symbol('extra')]: true }])
            expect(isAuthorTypographyProfileView({ ...observation.profile, ...extra })).toBe(false);
        for (const value of [null, [], '', { ...observation.profile, schemaVersion: 2 }])
            expect(isAuthorTypographyProfileView(value)).toBe(false);
    });

    it.each([
        [{ permission: 'denied' }, 'permission'], [{ permission: 'unavailable' }, 'permission'],
        [{ device: 'unavailable' }, 'device'], [{ designDefault: 'unavailable' }, 'default'],
        [{ profile: null }, 'observation'], [{ revision: null }, 'observation'],
        [{ revision: -1 }, 'observation'], [{ revision: 1.5 }, 'observation'],
        [{ revision: Number.MAX_SAFE_INTEGER }, 'exhausted'], [{ revision: Number.NaN }, 'observation'],
        [{ status: 'loading' }, 'pending'], [{ status: 'saving' }, 'pending'],
        [{ status: 'conflict' }, 'conflict'], [{ status: 'unavailable' }, 'unavailable']
    ] as const)('blocks the observation %j with %s', (patch, reason) =>
    {
        expect(authorTypographySettingsBlock({ ...observation, ...patch })).toBe(reason);
    });

    it('cannot promote synthetic permission/device/default or font flags into an actual mapping', () =>
    {
        for (const font of ['unavailable', 'loading', 'loaded', 'failed', 'fallback'] as const)
            expect(authorTypographySettingsBlock({ ...observation, font })).toBe('mapping');
        expect(authorTypographySettingsBlock({ ...observation, revision: 0 })).toBe('mapping');
        expect(observation.revision).toBe(17);
    });
});
