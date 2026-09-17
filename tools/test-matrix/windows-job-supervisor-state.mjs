export const windowsJobSupervisorStateSchema = 'fsusblog.windows-job-supervisor-state.v1';

const requiredAdapterMethods = [
    'assignProcess',
    'cleanupHandshake',
    'closeJob',
    'closeProcess',
    'configureKillOnClose',
    'createJob',
    'createProcessSuspended',
    'resumeProcess',
    'signalReady',
    'terminateJob',
    'terminateProcess',
    'waitForProcess',
    'waitForStart'
];

function validateAdapter(adapter)
{
    for (const method of requiredAdapterMethods)
    {
        if (typeof adapter?.[method] !== 'function')
        {
            throw new Error(`Windows Job supervisor adapter is missing ${method}`);
        }
    }
}

function attachRecoveryFailure(primary, recovery)
{
    if (!primary || !recovery)
    {
        return;
    }
    try
    {
        primary.windowsJobRecoveryError = recovery;
    }
    catch
    {}
}

export async function runWindowsJobSupervisorStateMachine({ adapter } = {})
{
    validateAdapter(adapter);
    let job = null;
    let suspendedProcess = null;
    let assigned = false;
    let exitCode = null;
    let primaryError = null;
    let recoveryError = null;

    try
    {
        job = await adapter.createJob();
        await adapter.configureKillOnClose(job);
        await adapter.signalReady(job);
        await adapter.waitForStart(job);
        suspendedProcess = await adapter.createProcessSuspended(job);
        await adapter.assignProcess(job, suspendedProcess);
        assigned = true;
        await adapter.resumeProcess(suspendedProcess);
        exitCode = await adapter.waitForProcess(suspendedProcess);
        await adapter.terminateJob(job, exitCode);
    }
    catch (error)
    {
        primaryError = error;
        try
        {
            if (suspendedProcess && !assigned)
            {
                await adapter.terminateProcess(suspendedProcess, 1);
            }
            if (job)
            {
                await adapter.terminateJob(job, 1);
            }
        }
        catch (errorDuringRecovery)
        {
            recoveryError = errorDuringRecovery;
            attachRecoveryFailure(primaryError, recoveryError);
        }
    }
    finally
    {
        try
        {
            if (suspendedProcess)
            {
                await adapter.closeProcess(suspendedProcess);
            }
            if (job)
            {
                await adapter.closeJob(job);
            }
            await adapter.cleanupHandshake();
        }
        catch (errorDuringClose)
        {
            if (primaryError)
            {
                recoveryError ??= errorDuringClose;
                attachRecoveryFailure(primaryError, errorDuringClose);
            }
            else
            {
                primaryError = errorDuringClose;
            }
        }
    }

    if (primaryError)
    {
        throw primaryError;
    }
    return {
        schema: windowsJobSupervisorStateSchema,
        assignedBeforeResume: assigned,
        exitCode,
        killPolicy: 'kill-on-job-close',
        recoveryError
    };
}
