import type { AvatarCommand, WaifuApi } from '@shared/protocol'
import { Recorder } from '../avatar/recorder'
import { RecordingCoordinator } from '../avatar/recording'
import { SpeechPlayer } from '../avatar/speech'

declare global {
  interface Window {
    waifu: WaifuApi
  }
}

const waifu = window.waifu
const speech = new SpeechPlayer()
let recording: RecordingCoordinator
const recorder = new Recorder({
  onAutoStop: (wavBase64) => recording.autoStopped(wavBase64)
})

recording = new RecordingCoordinator(recorder, {
  onRecording: (on) => waifu.sendAvatarEvent({ type: 'recording', on }),
  onRecorded: (wavBase64) => waifu.sendAvatarEvent({ type: 'recorded', wavBase64 }),
  onError: (error) => console.error(`[voice] 마이크를 쓸 수 없다: ${error.message}`)
})

function handle(command: AvatarCommand): void {
  switch (command.type) {
    case 'say':
      if (command.audio && command.visemes) {
        speech.play(command.audio, command.visemes, () => {
          waifu.sendAvatarEvent({ type: 'speech-end', id: command.id })
        })
      }
      break

    case 'stop-speaking':
      speech.stop()
      break

    case 'record':
      recording.request(command.on)
      break

    default:
      break
  }
}

waifu.onAvatarCommand(handle)

window.addEventListener('beforeunload', () => {
  speech.stop()
  recording.request(false)
})
