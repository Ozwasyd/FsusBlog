import { ElMarkdownEditor } from '@ozwasyd/element-plus';
import { describe, expect, it } from 'vitest';

import { readAuthorTypographyMappingAvailability } from '@/services/authoring/authorTypographyMapping';

describe('author typography public mapping boundary', () =>
{
    it('refuses the real aliased public editor contract without manufacturing CSS or defaults', () =>
    {
        const availability = readAuthorTypographyMappingAvailability();
        expect(availability).toEqual({
            status: 'blocked',
            reason: 'public-typography-contract-unavailable',
            publicEditorDefaultProfile: ElMarkdownEditor.props.editorProfile.default
        });
        expect(Object.isFrozen(availability)).toBe(true);
        expect(ElMarkdownEditor.props.editorProfile.validator('markdown')).toBe(true);
        expect(ElMarkdownEditor.props.editorProfile.validator('prose')).toBe(true);
        for (const value of ['reading-serif', 'cjk-sans', 'system-sans', '18px', 'standard'])
        {
            expect(ElMarkdownEditor.props.editorProfile.validator(value)).toBe(false);
        }
    });

    it('cannot apply preferences or mutate a live editor through the capability observation', () =>
    {
        expect(Object.keys(readAuthorTypographyMappingAvailability()).sort()).toEqual([
            'publicEditorDefaultProfile', 'reason', 'status'
        ]);
        expect(readAuthorTypographyMappingAvailability()).not.toHaveProperty('apply');
        expect(readAuthorTypographyMappingAvailability()).not.toHaveProperty('profile');
    });
});
