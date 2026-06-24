// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

/**
 * ESLint flat config (ESLint v9+).
 * - typecheck 스크립트(tsc)와 공존: 타입 검사는 tsc가, 코드 품질/훅 규칙은 ESLint가 담당.
 * - 설치는 사용자가 수행: npm i -D eslint @eslint/js typescript-eslint eslint-plugin-react-hooks globals
 */
export default tseslint.config(
  {
    // 빌드 산출물·의존성·정적 자산은 린트 대상에서 제외
    ignores: ['node_modules/**', 'out/**', 'release/**', 'dist/**', 'scripts/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // 메인/프리로드: Node 환경
  {
    files: ['src/main/**/*.{ts,tsx}', 'src/preload/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  // 렌더러: 브라우저 환경 + React Hooks 규칙
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    plugins: {
      'react-hooks': reactHooks
    },
    rules: {
      ...reactHooks.configs.recommended.rules
    }
  }
)
