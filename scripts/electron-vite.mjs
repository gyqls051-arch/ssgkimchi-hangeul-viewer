#!/usr/bin/env node
/**
 * electron-vite 실행 래퍼.
 *
 * VS Code 같은 일부 호스트는 자식 프로세스에 ELECTRON_RUN_AS_NODE=1 을 상속시킨다.
 * 이 변수가 켜진 채로 electron 을 띄우면 electron 이 "순수 Node" 모드로 실행되어
 * require('electron') 이 API 객체 대신 바이너리 경로(문자열)를 돌려준다
 * → main 에서 app.isPackaged 접근 시 "Cannot read properties of undefined" 로 죽는다.
 *
 * 그래서 electron 을 띄우는 dev/preview 단계에서는 이 변수를 제거한 환경으로 실행한다.
 * (build 단계는 electron 을 띄우지 않으므로 래핑하지 않는다.)
 */
import { spawn } from 'node:child_process'

delete process.env.ELECTRON_RUN_AS_NODE

const args = process.argv.slice(2)
const child = spawn('electron-vite', args, { stdio: 'inherit', shell: true })

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
