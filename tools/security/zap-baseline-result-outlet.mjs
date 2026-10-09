import { appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Transport one raw baseline result, awaiting the supplied outlet callback.
 * Report paths are ordinary file observations; contents are never parsed.
 * Callback failure is returned alongside the unchanged result and raw scanner
 * failure takes precedence in exitCode. Collection errors reject the promise.
 * @param {{target: string, scannerExitCode: number, reportPaths: string[]}} input Input from the existing scanner dispatch.
 * @param {function(object): Promise<void>} outlet Ordinary result consumer.
 * @returns {Promise<object>} Raw result, callback error, and effective per-target exit code.
 */
export async function publishBaselineResult(input, outlet)
{
    if (typeof input?.target !== 'string' || input.target.length === 0
        || !Number.isInteger(input.scannerExitCode) || input.scannerExitCode < 0 || input.scannerExitCode > 255
        || !Array.isArray(input.reportPaths)
        || input.reportPaths.some((reportPath) => typeof reportPath !== 'string' || reportPath.length === 0)
        || typeof outlet !== 'function')
    {
        throw new TypeError('expected actual target, raw shell exit code, report paths and outlet callback');
    }

    const result = {
        target: input.target,
        scannerExitCode: input.scannerExitCode,
        reportPaths: [],
        missingReportPaths: []
    };
    for (const reportPath of input.reportPaths)
    {
        let present;
        try
        {
            present = (await stat(reportPath)).isFile();
        }
        catch (error)
        {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
            {
                throw error;
            }
            present = false;
        }
        (present ? result.reportPaths : result.missingReportPaths).push(reportPath);
    }

    try
    {
        await outlet(result);
        return { result, outletError: null, outletExitCode: 0, exitCode: input.scannerExitCode };
    }
    catch (outletError)
    {
        const exitCode = input.scannerExitCode === 0 || input.scannerExitCode === 2 ? 1 : input.scannerExitCode;
        return { result, outletError, outletExitCode: 1, exitCode };
    }
}

async function runCli(argv)
{
    if (argv.length !== 6 || !/^(0|[1-9][0-9]*)$/u.test(argv[2]))
    {
        throw new Error('usage: node zap-baseline-result-outlet.mjs OUTPUT TARGET EXIT_CODE JSON_REPORT HTML_REPORT MARKDOWN_REPORT');
    }
    const [outputPath, target, scannerExitText, ...reportPaths] = argv;
    const outcome = await publishBaselineResult({ target, scannerExitCode: Number(scannerExitText), reportPaths },
        (result) => appendFile(outputPath, `${JSON.stringify(result)}\n`, 'utf8'));
    if (outcome.outletExitCode !== 0)
    {
        throw outcome.outletError;
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
{
    try
    {
        await runCli(process.argv.slice(2));
    }
    catch (error)
    {
        console.error(`[zap-baseline-result-outlet] ${error?.message ?? String(error)}`);
        process.exitCode = 1;
    }
}
