export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'errors' } as const)

import type { LocaleSchema } from '../keys';
import type { errors as zhCNErrors } from '../zh-CN/errors';

export const errors = {
    forbidden: {
        codePrefix: '403',
        title: '접근 거부',
        description: '현재 계정은 이 영역에 대한 접근 권한이 없습니다.',
        homeCta: '홈',
        reLoginCta: '다른 계정 사용'
    },
    notFound: {
        codePrefix: '404',
        title: '페이지를 찾을 수 없음',
        description: '리소스가 이동되었거나 삭제되었거나 존재하지 않습니다.',
        homeCta: '홈',
        searchCta: '게시글 검색',
        archiveCta: '아카이브'
    }
} as const satisfies LocaleSchema<typeof zhCNErrors>;
