import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite 는 이 파일을 esbuild 로 번들하면서 __dirname 을 **이 파일의 디렉터리**로
// define 치환한다. 그냥 resolve('src/...') 를 쓰면 process.cwd() 에 의존하게 되어
// 다른 cwd 에서 실행하면 조용히 깨진다.
// (import.meta.dirname 은 치환되지 않는다. 이 파일 안에서는 __dirname 을 써야 한다.)
const r = (p: string): string => resolve(__dirname, p)
const alias = { '@shared': r('src/shared') }

export default defineConfig({
  main: {
    // externalizeDepsPlugin() 은 electron-vite 5 에서 deprecated 이고, build.externalizeDeps 가
    // 이미 기본 true 라 불필요하다. 오히려 플러그인을 넣으면 이름 중복 감지 때문에
    // 아래 exclude 설정이 무시된다.
    resolve: { alias },
    build: {
      // exclude = "외부화하지 마라" = 번들에 포함하라.
      // 자식 스크립트(mcp/훅)는 패키징 후 app.asar.unpacked 에서 실행되는데, 거기서는
      // 위로 올라가도 node_modules 가 없다. bare import 를 남기면 ERR_MODULE_NOT_FOUND 로 죽는다.
      externalizeDeps: { exclude: ['@modelcontextprotocol/sdk', 'ws', 'zod'] },
      rollupOptions: {
        // Electron 엔트리 **하나만** 둔다.
        // mcp 서버와 권한 훅을 여기에 같이 넣으면 Rollup 이 공유 모듈을 out/main/chunks/ 로
        // 끌어올리고, src/shared 가 언젠가 electron 을 import 하는 순간 두 자식 스크립트가
        // 로드 타임에 죽는다. 대신 src/main/childEntries.ts 에서 `?modulePath` 로 격리 빌드한다.
        input: { index: r('src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].js' }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: r('src/preload/index.ts') },
        // 명시적 cjs. electron-vite 는 format 이 'es' 일 때만 '[name].mjs' 로 강제 변경한다.
        // package.json 이 "type": "module" 이라 .cjs 확장자가 있어야 모호하지 않다.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react()],
    resolve: { alias },
    server: {
      // 포트가 밀리면 ELECTRON_RENDERER_URL 도 따라 바뀐다. 개발 중 혼란을 줄이려고 고정한다.
      strictPort: true
    },
    build: {
      rollupOptions: {
        // 두 HTML 이 root 바로 아래 있으므로 out/renderer/{avatar,panel}.html 로 평평하게 나온다.
        input: {
          avatar: r('src/renderer/avatar.html'),
          panel: r('src/renderer/panel.html')
        }
      }
    }
  }
})
