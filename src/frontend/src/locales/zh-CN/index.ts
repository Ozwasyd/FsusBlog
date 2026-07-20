import { admin } from './admin';
import { article } from './article';
import { auth } from './auth';
import { common } from './common';
import { errors } from './errors';
import { publicMessages } from './public';
import { security } from './security';

export const zhCN = {
    common,
    public: publicMessages,
    article,
    auth,
    errors,
    admin,
    security
} as const;
