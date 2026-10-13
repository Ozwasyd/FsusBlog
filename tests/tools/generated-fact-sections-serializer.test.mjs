import assert from 'node:assert/strict';
import test from 'node:test';

const { RendererRegistry } = await import(new URL('../../tools/docs/generated-fact-sections/renderers.mjs', import.meta.url));

test('JSON table cells retain compiler-generated names as literal text', () =>
{
    const output = RendererRegistry.render('key-value-table', {
        operation: {
            evidence: ['BinaryEndpoints+<CompleteModerationRuntimeMutationAsync>d__13.MoveNext']
        }
    });
    assert.equal(output, [
        '| Key | Value |',
        '| --- | --- |',
        '| operation | {"evidence":&#91;"BinaryEndpoints+&#60;CompleteModerationRuntimeMutationAsync&#62;d&#95;&#95;13.MoveNext"&#93;} |'
    ].join('\n'));
});

test('JSON table cells preserve ordinary compound values and ordinal order', () =>
{
    assert.equal(RendererRegistry.render('key-value-table', {
        beta: ['first', 2],
        alpha: { count: 2, enabled: true }
    }), [
        '| Key | Value |',
        '| --- | --- |',
        '| alpha | {"count":2,"enabled":true} |',
        '| beta | &#91;"first",2&#93; |'
    ].join('\n'));
});

test('JSON table cells protect pipes newlines escapes and Markdown punctuation', () =>
{
    const output = RendererRegistry.render('key-value-table', {
        literal: { text: '\\|`\n&amp; *x* _y_ ~z~ [label](url) <T>' }
    });
    assert.equal(output, [
        '| Key | Value |',
        '| --- | --- |',
        '| literal | {"text":"&#92;&#92;\\|&#96;&#92;n&#38;amp; &#42;x&#42; &#95;y&#95; &#126;z&#126; &#91;label&#93;(url) &#60;T&#62;"} |'
    ].join('\n'));
});

test('string table cells preserve intentional links markup and existing escaping', () =>
{
    const markup = '[guide](https://example.test/?x=1&y=2) <strong>trusted</strong> `code`';
    const output = RendererRegistry.render('key-value-table', {
        quantity: { value: 5, unit: 'minutes' },
        markup,
        escaped: 'left|right\nnext'
    });
    assert.equal(output, [
        '| Key | Value |',
        '| --- | --- |',
        '| escaped | left\\|right next |',
        `| markup | ${markup} |`,
        '| quantity | 5 minutes |'
    ].join('\n'));
});

test('transition table strings retain delimiter and rejection boundaries', () =>
{
    assert.equal(RendererRegistry.render('transition-table', [
        'Publish:Draft->Published:permission.allowed',
        'Draft->Draft'
    ]), [
        '| From | To | Guard |',
        '| --- | --- | --- |',
        '| Draft | Draft | - |',
        '| Draft | Published | permission.allowed |'
    ].join('\n'));
    for (const invalid of ['Draft-Review->Published', 'Draft>Review->Published', 'Draft-Published'])
    {
        assert.throws(() => RendererRegistry.render('transition-table', [invalid]),
            (error) => error.code === 'GENERATED_SECTION_RENDERER_SHAPE');
    }
});

test('JSON table cells keep compound HTTP URLs literal without autolinks', () =>
{
    const origins = {
        identity: 'Fido2:Origins',
        value: {
            layers: {
                'canonical-repository-config': {
                    layer: 'canonical-repository-config',
                    value: [
                        'http://localhost:3000',
                        'http://localhost:5173',
                        'http://localhost:7291',
                        'http://localhost:8080',
                        'http://127.0.0.1:8080',
                        'http://localhost:55710',
                        'http://127.0.0.1:55710'
                    ]
                }
            },
            nullable: false,
            secret: false,
            type: 'array'
        }
    };
    assert.equal(RendererRegistry.render('key-value-table', {
        origins,
        protocols: [
            'https://example.test:443/path',
            'HTTP://LOCALHOST:3000',
            'HtTpS://example.test:8443/path',
            'urn:example:123',
            'clock:09:30',
            'http&#58;//already-literal.test'
        ]
    }), [
        '| Key | Value |',
        '| --- | --- |',
        '| origins | {"identity":"Fido2:Origins","value":{"layers":{"canonical-repository-config":{"layer":"canonical-repository-config","value":&#91;"http&#58;//localhost:3000","http&#58;//localhost:5173","http&#58;//localhost:7291","http&#58;//localhost:8080","http&#58;//127.0.0.1:8080","http&#58;//localhost:55710","http&#58;//127.0.0.1:55710"&#93;}},"nullable":false,"secret":false,"type":"array"}} |',
        '| protocols | &#91;"https&#58;//example.test:443/path","HTTP&#58;//LOCALHOST:3000","HtTpS&#58;//example.test:8443/path","urn:example:123","clock:09:30","http&#38;#58;//already-literal.test"&#93; |'
    ].join('\n'));
});
