export const localeDomainIdentity = Object.freeze({ locale: 'ko-KR', domain: 'layout' } as const)

import type { LocaleSchema } from '../keys';
import type { layout as zhCNLayout } from '../zh-CN/layout';

export const layout = {
    siteHeader: {
        ariaLabel: '사이트 탐색',
        navAriaLabel: '기본 탐색',
        mobileNavMenuLabel: '메뉴',
        mobileUtilityAriaLabel: '표시 및 계정',
        searchTriggerLabel: '검색',
        searchCancelLabel: '취소',
        searchAriaLabel: '콘텐츠 검색',
        searchPlaceholder: '게시글, 태그 또는 키워드 검색',
        fallbackTitle: "Fsu's Blog",
        fallbackDescription: '엔지니어링 로그, 성능 벤치마크, UI 시스템, 그리고 FsusBlog 개발 과정.',
        fallbackKeywords: '.NET, 프런트엔드 성능, 시스템 설계, UI 시스템, 기술 블로그, FsusBlog',
        fallbackAuthor: 'Fsu',
        fallbackManifestName: "Fsu's Blog",
        fallbackManifestShortName: 'FsusBlog'
    },
    recommendations: {
        eyebrow: '인기 게시물',
        leadEyebrow: '주요 추천',
        feedEyebrow: '최신 게시물',
        leadLoadingLabel: '추천 게시물 로딩 중',
        feedLoadingLabel: '게시물 목록 로딩 중',
        ariaReadFull: '전체 글 읽기: {title}',
        viewsUnit: '조회'
    },
    themeMode: {
        label: '테마 모드'
    }
} as const satisfies LocaleSchema<typeof zhCNLayout>;
