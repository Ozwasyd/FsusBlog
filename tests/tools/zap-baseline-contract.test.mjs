import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../../tools/security/run-zap-baseline.sh', import.meta.url), 'utf8');

test('ZAP baseline uses the report-producing legacy runner explicitly', () =>
{
    assert.match(source, /zap-baseline\.py[\s\S]*?--autooff/u);
    assert.match(source, /-J "\$json_report"[\s\S]*?-r "\$html_report"[\s\S]*?-w "\$markdown_report"/u);
});
