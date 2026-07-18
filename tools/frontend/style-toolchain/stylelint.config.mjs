import stylistic from '@stylistic/stylelint-plugin';
import postcssHtml from 'postcss-html';
import postcssScss from 'postcss-scss';
import recommended from 'stylelint-config-recommended';
import recommendedScss from 'stylelint-config-recommended-scss';
import standard from 'stylelint-config-standard';
import standardScss from 'stylelint-config-standard-scss';
import scss from 'stylelint-scss';

export default {
    plugins: [
        ...scss,
        ...stylistic
    ],
    rules: {
        ...recommended.rules,
        ...standard.rules,
        ...recommendedScss.rules,
        ...standardScss.rules,
        '@stylistic/block-closing-brace-newline-after': 'always',
        '@stylistic/block-closing-brace-newline-before': 'always',
        '@stylistic/block-opening-brace-newline-after': 'always',
        '@stylistic/block-opening-brace-newline-before': 'always',
        '@stylistic/declaration-block-semicolon-newline-after': 'always',
        '@stylistic/declaration-block-trailing-semicolon': 'always',
        '@stylistic/indentation': 4,
        '@stylistic/linebreaks': 'unix',
        '@stylistic/no-eol-whitespace': true,
        '@stylistic/no-missing-end-of-source-newline': true,
        'custom-property-pattern': '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$',
        'declaration-block-single-line-max-declarations': 1,
        'selector-class-pattern': '^[a-z][a-z0-9]*(?:(?:-|__|--)[a-z0-9]+)*$',
        'scss/at-function-pattern': '^[a-z][A-Za-z0-9]*$',
        'scss/at-mixin-pattern': '^[a-z][A-Za-z0-9]*$',
        'scss/dollar-variable-pattern': '^[a-z][A-Za-z0-9]*$'
    },
    overrides: [
        {
            files: ['**/*.vue'],
            customSyntax: postcssHtml
        },
        {
            files: ['**/*.scss'],
            customSyntax: postcssScss
        }
    ]
};
