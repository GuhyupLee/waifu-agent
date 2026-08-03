import { describe, expect, it } from 'vitest'
import { permissionDetails, summarizePermission } from '../src/renderer/panel/home/permissionSummary'

describe('permissionSummary', () => {
  it('파일 경로와 수정의 되돌리기 한계를 사람이 읽는 순서로 요약한다', () => {
    const summary = summarizePermission({
      id: 'p1',
      toolName: 'Edit',
      input: { file_path: 'E:\\waifu-agent\\src\\main.ts', old_string: 'a', new_string: 'b' },
      reason: '설정 오류를 고치기 위해 필요하다.'
    })
    expect(summary.action).toBe('파일 수정')
    expect(summary.reason).toContain('설정 오류')
    expect(summary.target).toBe('E:\\waifu-agent\\src\\main.ts')
    expect(summary.reversibility).not.toMatch(/반드시|항상 되돌/)
  })

  it('셸 명령은 되돌릴 수 있다고 단정하지 않는다', () => {
    const summary = summarizePermission({
      id: 'p2',
      toolName: 'Bash',
      input: { command: 'npm run build' }
    })
    expect(summary.target).toBe('npm run build')
    expect(summary.reversibility).toContain('결과에 따라')
  })

  it('알 수 없는 입력은 안전한 fallback과 접을 세부 JSON을 제공한다', () => {
    const input = { nested: { value: 1 } }
    const summary = summarizePermission({ id: 'p3', toolName: 'CustomTool', input })
    expect(summary.target).toContain('자동으로 확인하지 못했어')
    expect(summary.reversibility).toContain('확인되지 않아')
    expect(permissionDetails(input)).toContain('"nested"')
  })

  it('세부 입력이 너무 길면 패널을 채우지 않도록 잘라 표시한다', () => {
    const details = permissionDetails({ content: '가'.repeat(10_000) })
    expect(details.length).toBeLessThan(6_100)
    expect(details).toContain('일부만 표시했어')
  })
})
