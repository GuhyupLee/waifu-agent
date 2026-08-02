import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// 소스는 `@shared/*` 로 shared 를 가져온다. 이 별칭은 electron.vite.config.ts 에만 있어서
// vitest 는 모른다. 테스트가 소스를 그대로 import 하려면 여기서도 같은 별칭을 줘야 한다.
export default defineConfig({
  resolve: {
    alias: { '@shared': resolve(__dirname, 'src/shared') }
  },
  test: {
    include: ['tests/**/*.test.ts']
  }
})
