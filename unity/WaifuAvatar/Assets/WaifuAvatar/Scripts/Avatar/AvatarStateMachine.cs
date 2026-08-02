using System;
using System.Collections.Generic;
using UniVRM10;
using UnityEngine;

namespace WaifuAvatar.Avatar
{
    /// <summary>protocol.ts 의 AgentState.</summary>
    public enum AgentState
    {
        Idle,
        Thinking,
        Working,
        Speaking,
        Error
    }

    /// <summary>
    /// 상태 -> 보이는 것.
    ///
    /// Phase 1 에는 전용 모션이 없다. 그래서 대부분 placeholder 인데, **무엇이
    /// placeholder 인지 로그로 드러낸다.** 조용히 idle 로 떨어지면 상태 전환이
    /// 동작하는지 아닌지 구분할 수 없고, "thinking 이 안 먹는다"는 재현 불가능한
    /// 보고만 남는다.
    /// </summary>
    public class AvatarStateMachine
    {
        /// <summary>
        /// 상태를 대신할 표정. 모션이 생기면 이 표는 모션 이름으로 바뀐다.
        ///
        /// speaking 은 여기 없다 — 발화 중 표정은 say 명령이 실어 보낸 emotion 이
        /// 우선이다. 상태로 덮어쓰면 에이전트가 지정한 감정이 사라진다.
        /// </summary>
        static readonly Dictionary<AgentState, ExpressionPreset> StatePlaceholder =
            new Dictionary<AgentState, ExpressionPreset>
            {
                { AgentState.Idle, ExpressionPreset.neutral },
                { AgentState.Thinking, ExpressionPreset.relaxed },
                { AgentState.Working, ExpressionPreset.neutral },
                { AgentState.Error, ExpressionPreset.sad }
            };

        Vrm10Instance _instance;
        ExpressionKey? _applied;

        public AgentState State { get; private set; } = AgentState.Idle;

        public void Bind(Vrm10Instance instance)
        {
            _instance = instance;
            _applied = null;
            Apply(State, "모델 로드");
        }

        public static bool TryParse(string raw, out AgentState state)
        {
            switch (raw)
            {
                case "idle": state = AgentState.Idle; return true;
                case "thinking": state = AgentState.Thinking; return true;
                case "working": state = AgentState.Working; return true;
                case "speaking": state = AgentState.Speaking; return true;
                case "error": state = AgentState.Error; return true;
                default: state = AgentState.Idle; return false;
            }
        }

        public void SetState(AgentState state)
        {
            if (State == state) return;
            State = state;
            Apply(state, "상태 전환");
        }

        void Apply(AgentState state, string why)
        {
            if (state == AgentState.Speaking)
            {
                // 발화 표정은 say 가 쥔다. 여기서 건드리지 않는다.
                Debug.Log($"[waifu] 상태 {state} — 표정은 say 의 emotion 을 따른다 ({why})");
                return;
            }

            if (!StatePlaceholder.TryGetValue(state, out var preset))
            {
                Debug.LogWarning($"[waifu] 상태 {state} 에 대응하는 표현이 없다 ({why})");
                return;
            }

            Debug.Log($"[waifu] 상태 {state} — placeholder 표정 {preset} 적용 ({why}). " +
                      "전용 모션은 Phase 2 다.");
            SetExpression(preset, 1f);
        }

        /// <summary>express 명령. 이름이 맞지 않으면 무시하되 이유를 남긴다.</summary>
        public void SetEmotion(string emotion, float intensity)
        {
            if (!Enum.TryParse<ExpressionPreset>(emotion, out var preset))
            {
                Debug.LogWarning($"[waifu] 알 수 없는 표정: {emotion}");
                return;
            }
            SetExpression(preset, Mathf.Clamp01(intensity));
        }

        void SetExpression(ExpressionPreset preset, float weight)
        {
            var expression = _instance?.Runtime?.Expression;
            if (expression == null) return;

            var key = ExpressionKey.CreateFromPreset(preset);
            // 이전 표정을 0 으로 내리지 않으면 값이 겹쳐 얼굴이 무너진다.
            if (_applied.HasValue && !_applied.Value.Equals(key))
            {
                expression.SetWeight(_applied.Value, 0f);
            }
            expression.SetWeight(key, weight);
            _applied = key;
        }
    }
}
