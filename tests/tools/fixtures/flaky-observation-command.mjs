import fs from 'node:fs';

const scenario = process.argv[2];
const attempt = Number(process.env.FSUSBLOG_OBSERVATION_ATTEMPT);
const evidence = process.env.FSUSBLOG_OBSERVATION_ATTEMPT_EVIDENCE;

function fail(message, failureClass = 'product')
{
    fs.writeFileSync(evidence, `${JSON.stringify({ failure: message, failureClass })}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
}

if (scenario === 'stable-pass') process.stdout.write(`pass seed=${process.env.FSUSBLOG_OBSERVATION_SEED}\n`);
else if (scenario === 'stable-fail') fail('expected 42 but received 41');
else if (scenario === 'alternating') attempt % 2 === 0 ? process.stdout.write('pass\n') : fail('alternating assertion');
else if (scenario === 'different-failures') fail(attempt % 2 === 0 ? 'second exception' : 'first exception');
else if (scenario === 'environment') fail('browser executable unavailable', 'environment');
else fail(`unknown fixture scenario: ${scenario}`);
