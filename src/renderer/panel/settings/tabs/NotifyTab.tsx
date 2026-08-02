import { useEffect, useState } from 'react'
import type { StoredReminder } from '@shared/protocol'
import { Check, Field, ManagedList, S, Section } from '../controls'
import type { TabProps } from '../Settings'

export function NotifyTab({ config, patch }: TabProps): React.JSX.Element {
  return (
    <>
      <Section title="방해 금지">
        <div style={S.hint}>
          이 시간대에는 먼저 말을 걸지 않는다. 걸린 알림은 버리지 않고 시간이 지나면 온다.
          두 값이 같으면 방해 금지가 없다.
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <Field
            label="시작"
            value={config.notify.quietFrom}
            onCommit={(v) => patch({ notify: { ...config.notify, quietFrom: v.trim() } })}
          />
          <Field
            label="끝"
            value={config.notify.quietTo}
            onCommit={(v) => patch({ notify: { ...config.notify, quietTo: v.trim() } })}
          />
        </div>
      </Section>

      <Reminders />

      <Section title="Discord 원격">
        <div style={S.hint}>
          밖에서 DM 으로 부탁하고 결과를 받는다. 토큰과 허용 사용자 ID 가 모두 있어야 켜진다.
        </div>
        <Check
          label="켜기"
          checked={config.discord.enabled}
          onChange={(v) => patch({ discord: { ...config.discord, enabled: v } })}
        />
        <Field
          label="봇 토큰"
          password
          value={config.discord.token}
          onCommit={(v) => patch({ discord: { ...config.discord, token: v.trim() } })}
        />
        <Field
          label="허용할 Discord 사용자 ID (줄바꿈으로 구분)"
          multiline
          value={config.discord.allowedUserIds.join('\n')}
          onCommit={(v) =>
            patch({
              discord: {
                ...config.discord,
                allowedUserIds: v.split('\n').map((s) => s.trim()).filter(Boolean)
              }
            })
          }
        />
        {config.discord.enabled && config.discord.allowedUserIds.length === 0 && (
          <div style={S.warn}>
            허용 사용자가 없어 봇이 시작되지 않는다. 비워두면 아무나 들어올 수 있게 되므로
            일부러 막아둔 것이다.
          </div>
        )}
        <div style={{ ...S.hint, marginTop: '8px' }}>
          원격 요청은 최대 &apos;도와주기&apos; 까지만 허용된다. 눈앞에 없는 사람이 무제한 자동
          실행을 시키지 못하게 한다.
        </div>
      </Section>
    </>
  )
}

function Reminders(): React.JSX.Element {
  const [items, setItems] = useState<StoredReminder[]>([])

  const reload = (): void => {
    void window.waifu.listReminders().then(setItems)
  }
  useEffect(reload, [])

  return (
    <Section title="예약된 알림">
      <ManagedList
        items={items}
        empty="예약된 알림이 없다. 대화에서 '이따 알려줘' 라고 하면 생긴다."
        primary={(r) => r.text}
        secondary={(r) =>
          `${new Date(r.dueAt).toLocaleString()}${r.repeat === 'none' ? '' : ` · ${r.repeat}`} · ${r.channel}`
        }
        removeLabel="취소"
        onRemove={(r) => void window.waifu.cancelReminder(r.id).then(reload)}
      />
    </Section>
  )
}
