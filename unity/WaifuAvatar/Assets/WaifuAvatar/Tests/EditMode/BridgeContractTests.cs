using NUnit.Framework;
using UnityEngine;
using WaifuAvatar.Avatar;
using WaifuAvatar.Bridge;

namespace WaifuAvatar.Tests
{
    /// <summary>
    /// 계약 미러가 어긋나지 않았는지 본다.
    ///
    /// 여기 있는 JSON 문자열은 **TypeScript 쪽이 실제로 보내는 모양**이다. 손으로
    /// 예쁘게 다듬지 마라 — 그 순간 이 테스트는 우리 상상을 검증하게 된다.
    /// </summary>
    public class BridgeContractTests
    {
        [Test]
        public void 프로토콜_버전은_1이다()
        {
            // protocol.ts 의 AVATAR_PROTOCOL_VERSION 과 같아야 한다.
            // 한쪽만 올리면 핸드셰이크에서 끊긴다 — 그게 의도된 동작이다.
            Assert.AreEqual(1, Protocol.Version);
        }

        [Test]
        public void hello_는_토큰과_버전을_싣는다()
        {
            var json = JsonUtility.ToJson(new Hello { token = "deadbeef" });

            Assert.That(json, Does.Contain("\"type\":\"hello\""));
            Assert.That(json, Does.Contain("\"token\":\"deadbeef\""));
            Assert.That(json, Does.Contain("\"protocolVersion\":1"));
            Assert.That(json, Does.Contain("\"client\":\"unity\""));
        }

        [Test]
        public void 성공한_hello_ack_를_읽는다()
        {
            var ack = Json.TryParse<HelloAck>("{\"type\":\"hello-ack\",\"ok\":true,\"protocolVersion\":1}");

            Assert.IsNotNull(ack);
            Assert.IsTrue(ack.ok);
            Assert.AreEqual("hello-ack", ack.type);
        }

        [Test]
        public void 거절된_hello_ack_는_사유를_준다()
        {
            var ack = Json.TryParse<HelloAck>("{\"type\":\"hello-ack\",\"ok\":false,\"reason\":\"bad-token\"}");

            Assert.IsNotNull(ack);
            Assert.IsFalse(ack.ok);
            // 무응답으로 끊기면 토큰 문제인지 앱이 죽은 건지 구분할 수 없다.
            Assert.AreEqual("bad-token", ack.reason);
        }

        [Test]
        public void 깨진_JSON_은_null_이지_예외가_아니다()
        {
            // 깨진 메시지 하나로 셸이 죽으면 아바타가 통째로 사라진다.
            Assert.IsNull(Json.TryParse<HelloAck>("{ 깨짐"));
            Assert.IsNull(Json.TryParse<CommandEnvelope>("not json at all"));
        }

        [TestCase("{\"type\":\"command\",\"seq\":1,\"command\":{\"type\":\"status\",\"state\":\"thinking\"}}",
            "status")]
        [TestCase("{\"type\":\"command\",\"seq\":2,\"command\":{\"type\":\"set-scale\",\"scale\":1.5}}",
            "set-scale")]
        [TestCase("{\"type\":\"command\",\"seq\":3,\"command\":{\"type\":\"stop-speaking\"}}",
            "stop-speaking")]
        public void Phase1_명령_봉투를_읽는다(string raw, string expected)
        {
            var envelope = Json.TryParse<CommandEnvelope>(raw);

            Assert.IsNotNull(envelope);
            Assert.AreEqual("command", envelope.type);
            Assert.AreEqual(expected, envelope.command.type);
        }

        [Test]
        public void load_model_의_url_과_format_을_읽는다()
        {
            var envelope = Json.TryParse<CommandEnvelope>(
                "{\"type\":\"command\",\"seq\":1,\"command\":" +
                "{\"type\":\"load-model\",\"url\":\"F:/models/new.vrm\",\"format\":\"vrm\"}}");

            Assert.AreEqual("F:/models/new.vrm", envelope.command.url);
            Assert.AreEqual("vrm", envelope.command.format);
        }

        [Test]
        public void say_는_id_와_자막을_읽고_없는_필드는_기본값이다()
        {
            var envelope = Json.TryParse<CommandEnvelope>(
                "{\"type\":\"command\",\"seq\":7,\"command\":" +
                "{\"type\":\"say\",\"id\":\"utt-1\",\"text\":\"안녕\",\"emotion\":\"happy\"}}");

            Assert.AreEqual("utt-1", envelope.command.id);
            Assert.AreEqual("안녕", envelope.command.text);
            Assert.AreEqual("happy", envelope.command.emotion);
            // 펼친 DTO 라 실려오지 않은 필드는 기본값으로 남는다. 이게 무너지면
            // set-scale 없이 온 say 가 배율을 0 으로 만든다.
            Assert.AreEqual(1f, envelope.command.scale);
            Assert.AreEqual(1f, envelope.command.intensity);
        }

        [Test]
        public void 이벤트는_event_봉투에_담긴다()
        {
            var json = Json.Event(new ClickedEvent());

            Assert.That(json, Does.Contain("\"type\":\"event\""));
            Assert.That(json, Does.Contain("\"clicked\""));
        }

        [Test]
        public void model_loaded_실패는_ok_false_와_사유를_싣는다()
        {
            var json = Json.Event(new ModelLoadedEvent { ok = false, error = "파일 없음" });

            Assert.That(json, Does.Contain("\"ok\":false"));
            Assert.That(json, Does.Contain("파일 없음"));
        }

        [Test]
        public void hover_이벤트는_over_를_싣는다()
        {
            Assert.That(Json.Event(new HoverEvent { over = true }), Does.Contain("\"over\":true"));
        }
    }

    public class AvatarStateTests
    {
        [TestCase("idle", AgentState.Idle)]
        [TestCase("thinking", AgentState.Thinking)]
        [TestCase("working", AgentState.Working)]
        [TestCase("speaking", AgentState.Speaking)]
        [TestCase("error", AgentState.Error)]
        public void protocol_의_다섯_상태를_모두_읽는다(string raw, AgentState expected)
        {
            Assert.IsTrue(AvatarStateMachine.TryParse(raw, out var state));
            Assert.AreEqual(expected, state);
        }

        [Test]
        public void 모르는_상태는_실패로_알리고_idle_로_둔다()
        {
            // 조용히 idle 로 떨어지면 상태 전환이 동작하는지 구분할 수 없다.
            // 호출자가 경고를 남길 수 있도록 false 를 돌려주는 게 핵심이다.
            Assert.IsFalse(AvatarStateMachine.TryParse("dancing", out var state));
            Assert.AreEqual(AgentState.Idle, state);
        }

        [Test]
        public void 모델이_없어도_표정_명령이_터지지_않는다()
        {
            // 모델 로드 전에 express 가 도착하는 순서는 실제로 생긴다.
            var machine = new AvatarStateMachine();
            Assert.DoesNotThrow(() => machine.SetEmotion("happy", 1f));
            Assert.DoesNotThrow(() => machine.SetState(AgentState.Thinking));
        }
    }
}
