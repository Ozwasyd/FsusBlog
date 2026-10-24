import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import jsdoc from 'eslint-plugin-jsdoc';
import vue from 'eslint-plugin-vue';
import globals from 'globals';
import typescript from 'typescript';
import tseslint from 'typescript-eslint';

import { wrapParentImportRule } from './closed-canonical-edge.mjs';

const governedImportX = {
    ...importX,
    rules: {
        ...importX.rules,
        'no-relative-parent-imports': wrapParentImportRule(importX.rules['no-relative-parent-imports'])
    }
};

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const repositoryRoot = path.resolve(process.env.FSUSBLOG_STYLE_ROOT ?? defaultRoot);
const frontendRoot = path.join(repositoryRoot, 'src/frontend');
const { resolveLocalFsusUiApplicationProject } = await import(
    new URL('../../../src/frontend/scripts/run-local-fsusui-typecheck.mjs', import.meta.url)
);
let applicationProjectOptions;
function resolveApplicationProjectOptions()
{
    if (applicationProjectOptions === undefined)
    {
        const localApplicationProject = resolveLocalFsusUiApplicationProject({ repositoryRoot, typescript });
        applicationProjectOptions = localApplicationProject
            ? { projectService: false, project: [localApplicationProject], extraFileExtensions: ['.vue'] }
            : { projectService: true };
    }
    return applicationProjectOptions;
}

const typedFiles = [
    'src/frontend/src/**/*.{ts,tsx}',
    'src/frontend/wasm/web/**/*.{ts,tsx}'
];
const vueFiles = ['src/frontend/src/**/*.vue'];
const nodeFiles = ['tools/**/*.mjs', 'tests/**/*.mjs'];
const frontendNodeFiles = [
    'src/frontend/scripts/**/*.{js,mjs,cjs}',
    'src/frontend/*.{js,mjs,cjs}'
];
const nodeDeclarationFiles = ['src/frontend/scripts/**/*.d.{mts,cts}'];
const browserJavaScriptFiles = [
    'src/frontend/src/**/*.{js,mjs}',
    'src/frontend/wasm/web/**/*.{js,mjs}',
    'src/frontend/public/**/*.{js,mjs}'
];
const allLintFiles = [...typedFiles, ...vueFiles, ...nodeFiles, ...frontendNodeFiles, ...nodeDeclarationFiles, ...browserJavaScriptFiles];

const mergeRules = (configs) => Object.assign({}, ...configs.map((config) => config.rules ?? {}));
const typedRecommendedRules = mergeRules(tseslint.configs.recommendedTypeChecked);
const typedStylisticRules = mergeRules(tseslint.configs.stylisticTypeChecked);

const commonRules = {
    '@stylistic/brace-style': ['error', 'allman', { allowSingleLine: false }],
    '@stylistic/comma-dangle': ['error', 'never'],
    '@stylistic/eol-last': ['error', 'always'],
    '@stylistic/function-call-spacing': ['error', 'never'],
    '@stylistic/indent': ['error', 4, {
        SwitchCase: 1,
        VariableDeclarator: 1,
        ignoredNodes: ['ConditionalExpression *', 'TSConditionalType *']
    }],
    '@stylistic/keyword-spacing': ['error', { before: true, after: true }],
    '@stylistic/linebreak-style': ['error', 'unix'],
    '@stylistic/max-statements-per-line': ['error', { max: 1 }],
    '@stylistic/member-delimiter-style': ['error', {
        multiline: { delimiter: 'semi', requireLast: true },
        singleline: { delimiter: 'semi', requireLast: true }
    }],
    '@stylistic/no-multi-spaces': 'error',
    '@stylistic/no-trailing-spaces': 'error',
    '@stylistic/semi': ['error', 'always'],
    '@stylistic/type-annotation-spacing': 'error',
    'curly': ['error', 'all'],
    'import-x/no-duplicates': 'error',
    'import-x/no-relative-parent-imports': 'error',
    'import-x/order': ['error', {
        groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'object', 'type'],
        pathGroups: [
            { pattern: '@/**', group: 'internal', position: 'before' },
            { pattern: '@wasm/**', group: 'internal', position: 'before' }
        ],
        pathGroupsExcludedImportTypes: ['builtin'],
        'newlines-between': 'always',
        alphabetize: { order: 'asc', caseInsensitive: true }
    }],
    'no-duplicate-imports': 'off',
    'no-fallthrough': 'error',
    'no-unreachable': 'error',
    'one-var': ['error', 'never']
};

const typedRules = {
    ...js.configs.recommended.rules,
    ...typedRecommendedRules,
    ...typedStylisticRules,
    ...commonRules,
    '@typescript-eslint/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports'
    }],
    '@typescript-eslint/consistent-type-assertions': ['error', {
        assertionStyle: 'as',
        objectLiteralTypeAssertions: 'never'
    }],
    '@typescript-eslint/naming-convention': ['error',
        {
            selector: 'typeLike',
            format: ['PascalCase']
        },
        {
            selector: 'interface',
            format: ['PascalCase'],
            custom: { regex: '^I[A-Z]', match: false }
        },
        {
            selector: 'parameter',
            format: ['camelCase'],
            leadingUnderscore: 'allow'
        },
        {
            selector: 'variable',
            format: ['camelCase', 'PascalCase', 'UPPER_CASE'],
            leadingUnderscore: 'allow'
        },
        {
            selector: 'function',
            format: ['camelCase', 'PascalCase']
        },
        {
            selector: 'classProperty',
            modifiers: ['private'],
            format: ['camelCase'],
            leadingUnderscore: 'forbid'
        }
    ],
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/no-unnecessary-type-assertion': 'error',
    '@typescript-eslint/no-unsafe-argument': 'error',
    '@typescript-eslint/no-unsafe-assignment': 'error',
    '@typescript-eslint/no-unsafe-call': 'error',
    '@typescript-eslint/no-unsafe-member-access': 'error',
    '@typescript-eslint/no-unsafe-return': 'error'
};

export default [
    {
        name: 'fsusblog/global-ignores',
        ignores: [
            '**/node_modules/**',
            'artifacts/**',
            'src/frontend/coverage/**',
            'src/frontend/dist/**',
            'src/frontend/public/wasm/**',
            'src/frontend/src/generated/**',
            'src/frontend/wasm/build/**',
            'src/frontend/wasm/dist/**',
            'src/frontend/wasm/stage/**',
            'tests/**/Fixtures/**',
            'tests/**/fixtures/**',
            '**/*.min.js'
        ]
    },
    ...vue.configs['flat/essential'],
    {
        name: 'fsusblog/common-ast-style',
        files: allLintFiles,
        plugins: {
            '@stylistic': stylistic,
            'import-x': governedImportX
        },
        linterOptions: {
            reportUnusedDisableDirectives: 'error'
        },
        rules: commonRules
    },
    {
        name: 'fsusblog/node-tooling',
        files: [...nodeFiles, ...frontendNodeFiles],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.node
        },
        plugins: {
            jsdoc
        },
        rules: {
            ...js.configs.recommended.rules,
            ...commonRules,
            'jsdoc/check-types': 'error',
            'jsdoc/no-undefined-types': 'error',
            'jsdoc/valid-types': 'error',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-script-url': 'error'
        }
    },
    {
        name: 'fsusblog/pure-receipt-canonicalizer-dependency',
        files: ['tools/docs/behavior-doc-minimal-contract-build-v3-contract.mjs'],
        rules: {
            'import-x/no-relative-parent-imports': ['error', {
                ignore: ['^\\.\\./fact-extractors/lib/canonicalize\\.mjs$']
            }]
        }
    },
    {
        name: 'fsusblog/browser-javascript',
        files: browserJavaScriptFiles,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: globals.browser
        },
        rules: {
            ...js.configs.recommended.rules,
            ...commonRules,
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
            'no-script-url': 'error'
        }
    },
    {
        name: 'fsusblog/type-aware-node-declarations',
        files: nodeDeclarationFiles,
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                ecmaVersion: 'latest',
                projectService: false,
                project: [path.join(frontendRoot, 'tsconfig.node.json')],
                sourceType: 'module',
                tsconfigRootDir: frontendRoot
            },
            globals: globals.node
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin
        },
        rules: typedRules
    },
    {
        name: 'fsusblog/type-aware-typescript',
        files: typedFiles,
        languageOptions: {
            parser: tseslint.parser,
            get parserOptions()
            {
                return {
                    ecmaVersion: 'latest',
                    ...resolveApplicationProjectOptions(),
                    sourceType: 'module',
                    tsconfigRootDir: frontendRoot
                };
            },
            globals: {
                ...globals.browser,
                ...globals.worker
            }
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin
        },
        rules: typedRules
    },
    {
        name: 'fsusblog/vue-sfc',
        files: vueFiles,
        languageOptions: {
            get parserOptions()
            {
                return {
                    ecmaVersion: 'latest',
                    extraFileExtensions: ['.vue'],
                    parser: tseslint.parser,
                    ...resolveApplicationProjectOptions(),
                    sourceType: 'module',
                    tsconfigRootDir: frontendRoot
                };
            },
            globals: globals.browser
        },
        plugins: {
            '@typescript-eslint': tseslint.plugin
        },
        rules: {
            ...typedRules,
            '@stylistic/indent': 'off',
            'vue/attribute-hyphenation': ['error', 'always'],
            'vue/block-order': ['error', { order: ['template', 'script', 'style'] }],
            'vue/component-definition-name-casing': ['error', 'PascalCase'],
            'vue/component-name-in-template-casing': ['error', 'PascalCase', {
                registeredComponentsOnly: false,
                ignores: []
            }],
            'vue/custom-event-name-casing': 'off',
            'vue/first-attribute-linebreak': ['error', {
                singleline: 'beside',
                multiline: 'below'
            }],
            'vue/html-closing-bracket-newline': ['error', {
                singleline: 'never',
                multiline: 'always'
            }],
            'vue/html-indent': ['error', 4, {
                attribute: 1,
                baseIndent: 1,
                closeBracket: 0,
                alignAttributesVertically: false
            }],
            'vue/max-attributes-per-line': ['error', {
                singleline: { max: 1 },
                multiline: { max: 1 }
            }],
            'vue/prop-name-casing': ['error', 'camelCase'],
            'vue/script-indent': ['error', 4, {
                baseIndent: 0,
                switchCase: 1
            }]
        }
    }
];
