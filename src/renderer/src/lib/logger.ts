/**
 * 렌더러용 경량 구조적 로거.
 * 개발 중엔 콘솔에 출력, 프로덕션에선 warn/error만 남긴다.
 * (추후 디버깅 게이트에서 파일 로깅/리포팅으로 확장 가능)
 */
type Level = 'debug' | 'info' | 'warn' | 'error'

const isDev = import.meta.env.DEV

function emit(level: Level, scope: string, msg: string, ...rest: unknown[]): void {
  if (!isDev && (level === 'debug' || level === 'info')) return
  const line = `[${scope}] ${msg}`
  // eslint-disable-next-line no-console
  console[level === 'debug' ? 'log' : level](line, ...rest)
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, ...rest: unknown[]) => emit('debug', scope, msg, ...rest),
    info: (msg: string, ...rest: unknown[]) => emit('info', scope, msg, ...rest),
    warn: (msg: string, ...rest: unknown[]) => emit('warn', scope, msg, ...rest),
    error: (msg: string, ...rest: unknown[]) => emit('error', scope, msg, ...rest)
  }
}

export type Logger = ReturnType<typeof createLogger>
