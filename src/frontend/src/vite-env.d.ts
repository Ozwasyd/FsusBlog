/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string
  readonly VITE_FSUSBLOG_CONSOLE_WELCOME_ENABLED?: string
  readonly VITE_FSUSBLOG_CONSOLE_WELCOME_SHOW_ON_FIRST_RUN?: string
  readonly VITE_FSUSBLOG_CONSOLE_WELCOME_CONTRIBUTE_URL?: string
  readonly VITE_FSUSBLOG_CONSOLE_WELCOME_ISSUE_URL?: string
  readonly VITE_FSUSBLOG_CONSOLE_WELCOME_COMMUNITY_URL?: string
  readonly VITE_FSUSBLOG_CONSOLE_WELCOME_HIDE_FOR_PRIVATE_DEPLOYMENT?: string
  readonly VITE_FSUSBLOG_EXTERNAL_LINKS_ENABLED?: string
  readonly VITE_FSUSBLOG_LOCAL_AUTH_FIXTURE_SECRET?: string
  readonly VITE_FSUSBLOG_PRIVATE_DEPLOYMENT?: string
  readonly VITE_FSUSBLOG_DEPLOYMENT_MODE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  __FSUSBLOG_CONSOLE_WELCOME_CALLOUT__?: import('@/config/consoleWelcomeCallout').ConsoleWelcomeCalloutRuntimeOverride
}
