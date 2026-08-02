import { clipboard, desktopCapturer, screen } from 'electron'

/**
 * "이거 봐줘" — 사용자가 보여주는 것을 에이전트가 본다.
 *
 * 상시 화면 감시는 하지 않는다. 개인정보 부담이 크고, 무엇보다 매 프레임을 모델에
 * 넣으면 사용량이 감당이 안 된다. 에이전트가 필요할 때 **요청**하고, 사용자가
 * 승인해야 한 장이 넘어간다.
 */

/**
 * 화면을 한 장 뜬다.
 *
 * 원본 해상도 그대로 보내면 4K 한 장이 수 MB 라 토큰도 시간도 크게 쓴다.
 * 긴 변을 기준으로 줄여도 화면의 글자는 대체로 읽힌다.
 */
const MAX_EDGE = 1600

export interface CaptureResult {
  /** PNG base64. */
  data: string
  mimeType: 'image/png'
  width: number
  height: number
}

export async function captureScreen(): Promise<CaptureResult> {
  const display = screen.getPrimaryDisplay()
  // scaleFactor 를 곱해야 고DPI 화면에서 흐릿하지 않다.
  const full = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor)
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(full.width, full.height))
  const thumbnailSize = {
    width: Math.round(full.width * scale),
    height: Math.round(full.height * scale)
  }

  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  const source = sources[0]
  if (!source) throw new Error('화면을 가져올 수 없다')

  const image = source.thumbnail
  if (image.isEmpty()) {
    // Windows 에서 화면 캡처 권한이나 보호된 콘텐츠 때문에 빈 이미지가 오는 경우가 있다.
    // 빈 PNG 를 그대로 넘기면 모델이 "검은 화면" 이라고 답한다.
    throw new Error('빈 이미지가 왔다. 화면 보호 설정이나 캡처 권한을 확인해라.')
  }

  const size = image.getSize()
  return {
    data: image.toPNG().toString('base64'),
    mimeType: 'image/png',
    width: size.width,
    height: size.height
  }
}

/** 클립보드 텍스트. 비어 있으면 null. */
export function readClipboardText(): string | null {
  const text = clipboard.readText()
  return text.trim() ? text : null
}

/**
 * 클립보드 이미지. 없으면 null.
 *
 * 캡처 도구로 잘라둔 화면을 그대로 보여주는 흐름이 자연스럽다 —
 * 전체 화면을 넘기는 것보다 개인정보 노출이 적다.
 */
export function readClipboardImage(): CaptureResult | null {
  const image = clipboard.readImage()
  if (image.isEmpty()) return null

  const size = image.getSize()
  const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height))
  const resized =
    scale < 1
      ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) })
      : image

  const out = resized.getSize()
  return {
    data: resized.toPNG().toString('base64'),
    mimeType: 'image/png',
    width: out.width,
    height: out.height
  }
}
