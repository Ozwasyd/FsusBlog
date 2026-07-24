// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import { enUS } from '@/locales/en-US';
import { zhCN } from '@/locales/zh-CN';
import {
    enumeratePlaceholders,
    extractInterpolationParams,
    parseMigrationPlaceholder,
    validateLeafValue,
    validateLocaleParity
} from '@/locales/validator';

describe('locale parity and migration placeholder contract (#1479)', () => {
    it('validates root-level zh-CN and en-US structure parity', () => {
        const result = validateLocaleParity(
            zhCN as unknown as Record<string, unknown>,
            enUS as unknown as Record<string, unknown>
        );
        expect(result.errors).toEqual([]);
        expect(result.isValid).toBe(true);
    });

    it('parses valid and invalid migration placeholders', () => {
        const valid = parseMigrationPlaceholder(
            '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyEnabled',
            'identity.overview.passkeyEnabled'
        );
        expect(valid.isPlaceholder).toBe(true);
        expect(valid.isValid).toBe(true);
        expect(valid.key).toBe('identity.overview.passkeyEnabled');

        const keyMismatch = parseMigrationPlaceholder(
            '__FSUSBLOG_TRANSLATION_PENDING__:identity.overview.passkeyEnabled',
            'identity.overview.wrongPath'
        );
        expect(keyMismatch.isPlaceholder).toBe(true);
        expect(keyMismatch.isValid).toBe(false);
        expect(keyMismatch.error).toContain('placeholder key mismatch');

        const invalidFormat = parseMigrationPlaceholder(
            '__FSUSBLOG_TRANSLATION_PENDING__:invalid key with spaces'
        );
        expect(invalidFormat.isPlaceholder).toBe(true);
        expect(invalidFormat.isValid).toBe(false);
        expect(invalidFormat.error).toContain('invalid key format');
    });

    it('verifies 0 migration placeholders remain in enUS dictionary (#1485)', () => {
        const placeholders = enumeratePlaceholders(enUS);
        expect(placeholders.length).toBe(0);
    });

    it('extracts interpolation parameters accurately', () => {
        expect(extractInterpolationParams('Hello {name}, you have {count} messages.')).toEqual(['count', 'name']);
        expect(extractInterpolationParams('No params here.')).toEqual([]);
    });

    it('rejects forbidden phrases such as TODO, TBD', () => {
        expect(validateLeafValue('TODO: translate', 'test.path')).toContain('forbidden placeholder phrase "TODO"');
        expect(validateLeafValue('TODO_TRANSLATE', 'test.path')).toContain('forbidden placeholder phrase "TODO_TRANSLATE"');
        expect(validateLeafValue('TBD', 'test.path')).toContain('forbidden placeholder phrase "TBD"');
    });

    it('negative fixture: fails parity when en-US is missing a key or has extra key', () => {
        const zh = { auth: { title: '登录' } };
        const enMissing = { auth: {} };
        const resultMissing = validateLocaleParity(zh, enMissing);
        expect(resultMissing.isValid).toBe(false);
        expect(resultMissing.errors[0]).toContain('Missing key in en-US: "auth.title"');

        const enExtra = { auth: { title: 'Login', extra: 'Extra' } };
        const resultExtra = validateLocaleParity(zh, enExtra);
        expect(resultExtra.isValid).toBe(false);
        expect(resultExtra.errors[0]).toContain('Extra key in en-US');
    });

    it('negative fixture: fails parity when interpolation parameters mismatch', () => {
        const zh = { common: { msg: 'Welcome {name} ({count})' } };
        const en = { common: { msg: 'Welcome {name}' } };
        const result = validateLocaleParity(zh, en);
        expect(result.isValid).toBe(false);
        expect(result.errors[0]).toContain('Interpolation parameter mismatch');
    });

    it('negative fixture: fails parity when placeholder key path is mismatched', () => {
        const zh = { identity: { status: '状态' } };
        const en = { identity: { status: '__FSUSBLOG_TRANSLATION_PENDING__:wrong.path' } };
        const result = validateLocaleParity(zh, en);
        expect(result.isValid).toBe(false);
        expect(result.errors[0]).toContain('placeholder key mismatch');
    });
});
