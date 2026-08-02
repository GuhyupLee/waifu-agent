using System;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>
    /// 다음에 무엇을 언제 재생할지 정하는 규칙.
    ///
    /// **여기서 LLM 을 부르지 않는다.** idle 전환은 초 단위로 일어나고 사용자가
    /// 보고 있지도 않을 때가 대부분이다. 여기에 모델을 태우면 구독 한도를 태우고
    /// 전환이 눈에 띄게 늦는다.
    ///
    /// 씬도 애니메이터도 모른다 — 순수 규칙이라 EditMode 에서 통째로 테스트한다.
    /// </summary>
    public class IdleDirector
    {
        readonly Func<float> _random;
        string[] _clips = Array.Empty<string>();
        float _remaining;

        /// <summary>지금 재생 중인 클립. 클립이 없으면 null.</summary>
        public string Current { get; private set; }

        /// <summary>다음 전환까지 남은 시간(초). 진단용.</summary>
        public float Remaining => _remaining;

        public float MinHoldSec = 8f;
        public float MaxHoldSec = 40f;

        public IdleDirector(Func<float> random = null)
        {
            _random = random ?? (() => UnityEngine.Random.value);
        }

        public void SetClips(string[] clips)
        {
            _clips = clips ?? Array.Empty<string>();
            if (_clips.Length == 0)
            {
                Current = null;
                return;
            }
            if (Current == null || Array.IndexOf(_clips, Current) < 0)
            {
                Current = _clips[0];
                _remaining = NextHold();
            }
        }

        /// <summary>
        /// @returns 클립이 바뀌었으면 새 클립 이름, 아니면 null.
        /// </summary>
        public string Update(float delta)
        {
            if (_clips.Length == 0) return null;

            _remaining -= delta;
            if (_remaining > 0f) return null;

            _remaining = NextHold();
            if (_clips.Length == 1) return null;

            var next = PickDifferent();
            if (next == Current) return null;
            Current = next;
            return next;
        }

        /// <summary>지금 클립을 즉시 끝내고 다음으로 넘긴다. 깨어날 때 쓴다.</summary>
        public void Interrupt()
        {
            _remaining = 0f;
        }

        /// <summary>
        /// 방금 튼 것을 다시 뽑지 않는다.
        ///
        /// 균등 추첨을 그대로 쓰면 같은 클립이 연속으로 나오고, 그때 사용자에게는
        /// "전환이 고장났다" 로 보인다. 확률적으로는 정상이지만 인상은 그렇지 않다.
        /// </summary>
        string PickDifferent()
        {
            var index = Mathf.Clamp(Mathf.FloorToInt(_random() * _clips.Length), 0, _clips.Length - 1);
            if (_clips[index] != Current) return _clips[index];
            // 한 칸 밀어 반드시 다른 것을 고른다. 다시 뽑으면 최악의 경우 계속 같은 게 나온다.
            return _clips[(index + 1) % _clips.Length];
        }

        /// <summary>
        /// 유지 시간은 지수분포다. 균등분포로 하면 "일정 간격으로 자세를 바꾼다" 는
        /// 인상이 남는다 — 깜빡임과 같은 이유다.
        /// </summary>
        float NextHold()
        {
            var mean = Mathf.Max(MinHoldSec, (MinHoldSec + MaxHoldSec) * 0.5f);
            var value = Liveliness.ExponentialInterval(_random(), mean, MinHoldSec);
            return Mathf.Min(value, MaxHoldSec);
        }
    }

    /// <summary>
    /// 언제 잘지 정하는 규칙. 이것도 LLM 없이 처리한다.
    ///
    /// 시간대 규칙은 `fromHour`/`toHour` 가 **둘 다** 있을 때만 본다. 하나만 설정된
    /// 상태를 "밤새 잔다" 로 해석하면 사용자가 의도하지 않은 시간에 아바타가 사라진다.
    /// </summary>
    public class SleepPolicy
    {
        public bool Enabled = true;
        public float AfterIdleMin = 20f;
        /// <summary>시간대 규칙을 쓸지. false 면 From/To 를 아예 보지 않는다.</summary>
        public bool ByClock;
        public int FromHour = 23;
        public int ToHour = 7;

        float _idleSec;

        public bool Asleep { get; private set; }

        /// <summary>사용자 활동이 있었다. 만졌거나, 끌었거나, 에이전트가 말했다.</summary>
        public void Poke()
        {
            _idleSec = 0f;
            if (Asleep) Asleep = false;
        }

        /// <param name="hour">지금 시각의 시(0..23).</param>
        /// <returns>수면 상태가 바뀌었으면 true.</returns>
        public bool Update(float delta, int hour)
        {
            if (!Enabled)
            {
                if (!Asleep) return false;
                Asleep = false;
                return true;
            }

            _idleSec += delta;

            var wanted = _idleSec >= AfterIdleMin * 60f || InSleepHours(hour);
            if (wanted == Asleep) return false;
            Asleep = wanted;
            return true;
        }

        /// <summary>자정을 넘기는 구간(23시~7시)도 다뤄야 한다.</summary>
        public bool InSleepHours(int hour)
        {
            if (!ByClock) return false;
            // from == to 는 "0시간짜리 구간" 이다. 이걸 "하루 종일" 로 읽으면
            // 오타 하나로 아바타가 영영 안 깨어난다.
            if (FromHour == ToHour) return false;
            return FromHour < ToHour
                ? hour >= FromHour && hour < ToHour
                : hour >= FromHour || hour < ToHour;
        }
    }
}
