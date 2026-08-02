import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { app, BrowserWindow, session } from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'out', 'renderer', 'assets')
const workletName = readdirSync(assetsDir).find((name) => /^pcm-recorder\.worklet-.*\.js$/.test(name))
if (!workletName) throw new Error('빌드된 pcm-recorder worklet을 찾을 수 없다. npm run build를 먼저 실행하라.')

const workletUrl = pathToFileURL(join(assetsDir, workletName)).href
const avatarHtml = join(root, 'out', 'renderer', 'avatar.html')
const preload = join(root, 'out', 'preload', 'index.cjs')

async function main() {
  await app.whenReady()
  // src/main/csp.ts의 배포 정책과 같은 script 경계를 걸어 file:// 패키지 조건을 재현한다.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: waifu-asset:; media-src 'self' blob:; connect-src 'self' blob: data: waifu-asset:; font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
        ]
      }
    })
  })
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  try {
    await win.loadFile(avatarHtml)
    const result = await win.webContents.executeJavaScript(`(async () => {
      const context = new AudioContext({ sampleRate: 16000 });
      await context.audioWorklet.addModule(${JSON.stringify(workletUrl)});
      const node = new AudioWorkletNode(context, 'waifu-pcm-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { maxSamples: 16000 }
      });
      const mute = context.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(context.destination);

      let samples = 0;
      let finishFlush;
      const flushed = new Promise((resolve) => { finishFlush = resolve; });
      node.port.onmessage = (event) => {
        if (event.data?.type === 'chunk') samples += new Float32Array(event.data.samples).length;
        if (event.data?.type === 'flushed') finishFlush();
      };

      const oscillator = context.createOscillator();
      const inputGain = context.createGain();
      inputGain.gain.value = 0.03;
      oscillator.connect(inputGain).connect(node);
      await context.resume();
      oscillator.start();
      await new Promise((resolve) => setTimeout(resolve, 350));
      oscillator.stop();
      inputGain.disconnect();
      node.port.postMessage({ type: 'flush' });
      await Promise.race([
        flushed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('flush ACK timeout')), 2000))
      ]);

      node.disconnect();
      node.port.close();
      await context.close();
      return { samples, sampleRate: context.sampleRate };
    })()`, true)

    if (result.samples <= 0 || result.sampleRate !== 16_000) {
      throw new Error(`worklet 결과가 잘못됐다: ${JSON.stringify(result)}`)
    }
    process.stdout.write(`PASS: AudioWorklet file:// load, ${result.samples} samples at ${result.sampleRate}Hz\n`)
  } finally {
    win.destroy()
    app.quit()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
