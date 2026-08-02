import { useEffect, useState } from 'react'
import type { StoredMemory, StoredRoutine } from '@shared/protocol'
import { ManagedList, S, Section } from '../controls'

/**
 * 와이프가 나에 대해 무엇을 알고 있는지 볼 수 있어야 한다.
 * 볼 수 없는 기억은 신뢰할 수 없다.
 */
export function MemoryTab(): React.JSX.Element {
  return (
    <>
      <Memories />
      <Routines />
    </>
  )
}

function Memories(): React.JSX.Element {
  const [items, setItems] = useState<StoredMemory[]>([])

  const reload = (): void => {
    void window.waifu.listMemories().then(setItems)
  }
  useEffect(reload, [])

  return (
    <Section title="기억">
      <div style={{ ...S.hint, marginBottom: '8px' }}>
        대화에서 알게 된 것들. 틀린 게 있으면 지워라 — 다음 대화부터 반영된다.
      </div>
      <ManagedList
        items={items}
        empty="아직 기억하는 것이 없다."
        primary={(m) => m.key}
        secondary={(m) => m.value}
        onRemove={(m) => void window.waifu.forgetMemory(m.key).then(reload)}
      />
    </Section>
  )
}

function Routines(): React.JSX.Element {
  const [items, setItems] = useState<StoredRoutine[]>([])

  const reload = (): void => {
    void window.waifu.listRoutines().then(setItems)
  }
  useEffect(reload, [])

  return (
    <Section title="루틴">
      <div style={{ ...S.hint, marginBottom: '8px' }}>
        저장해둔 절차. 이름을 부르면 그대로 따라간다. 저절로 실행되지는 않는다.
      </div>
      <ManagedList
        items={items}
        empty="저장된 루틴이 없다. 작업이 끝난 뒤 '다음에도 이렇게 할까?' 라고 물으면 생긴다."
        primary={(r) => r.name}
        secondary={(r) =>
          `${r.summary}${r.runCount > 0 ? ` · ${r.runCount}번 실행` : ' · 아직 안 씀'}`
        }
        onRemove={(r) => void window.waifu.removeRoutine(r.name).then(reload)}
      />
    </Section>
  )
}
