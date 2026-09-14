import { AppError, appErrorFromStatus } from '@/utils/appError';

export class HttpApiError extends AppError
{
    constructor(message: string, status?: number, traceId?: string)
    {
        super(appErrorFromStatus(status ?? 500, message, { traceId }).code, message, { status, traceId });
        this.name = 'HttpApiError';
    }
}
