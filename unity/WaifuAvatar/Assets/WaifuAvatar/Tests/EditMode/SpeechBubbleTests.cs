using NUnit.Framework;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    public class SpeechBubbleTests
    {
        [Test]
        public void 짧은_문장은_그대로_둔다()
        {
            Assert.AreEqual("안녕", SpeechBubble.Format("안녕", 140));
        }

        [Test]
        public void 빈_입력은_빈_문자열이다()
        {
            Assert.AreEqual(string.Empty, SpeechBubble.Format(null, 140));
            Assert.AreEqual(string.Empty, SpeechBubble.Format("", 140));
        }

        [Test]
        public void 줄바꿈을_한_줄로_눕힌다()
        {
            // 줄바꿈이 많으면 말풍선이 세로로 늘어나 화면을 덮는다.
            Assert.AreEqual("첫째 둘째 셋째", SpeechBubble.Format("첫째\n둘째\r\n셋째", 140));
        }

        [Test]
        public void 연속_공백을_하나로_줄인다()
        {
            Assert.AreEqual("앞 뒤", SpeechBubble.Format("앞    뒤", 140));
        }

        [Test]
        public void 상한을_넘으면_자르고_말줄임표를_붙인다()
        {
            var long_ = new string('가', 200);
            var result = SpeechBubble.Format(long_, 20);

            Assert.LessOrEqual(result.Length, 20, "자른 뒤에도 상한을 넘었다");
            Assert.IsTrue(result.EndsWith("…"));
        }

        [Test]
        public void 자를_때_단어_중간을_피한다()
        {
            var text = "아바타가 데스크톱에 자연스럽게 존재하도록 만드는 것이 목표다";
            var result = SpeechBubble.Format(text, 20);

            // 말줄임표 앞이 공백으로 끝나면 안 되고, 단어가 잘려서도 안 된다.
            Assert.IsTrue(result.EndsWith("…"));
            var body = result.Substring(0, result.Length - 1);
            Assert.IsFalse(body.EndsWith(" "));
            Assert.IsTrue(text.StartsWith(body), "원문에 없는 조각이 만들어졌다");
        }

        [Test]
        public void 공백_없는_긴_단어도_상한을_지킨다()
        {
            // URL 같은 것이 오면 자를 공백이 없다. 그래도 넘치면 안 된다.
            var result = SpeechBubble.Format(new string('x', 300), 30);
            Assert.LessOrEqual(result.Length, 30);
        }

        [Test]
        public void 상한이_0_이하면_아무것도_보여주지_않는다()
        {
            Assert.AreEqual(string.Empty, SpeechBubble.Format("무언가", 0));
            Assert.AreEqual(string.Empty, SpeechBubble.Format("무언가", -5));
        }

        [Test]
        public void 표시_시간이_최소값_아래로_내려가지_않는다()
        {
            // 짧은 대답이 눈에 들어오기 전에 사라지면 읽을 수가 없다.
            Assert.GreaterOrEqual(SpeechBubble.DurationSec("응", 2.5f), 2.5f);
        }

        [Test]
        public void 긴_문장은_더_오래_떠_있다()
        {
            var short_ = SpeechBubble.DurationSec("짧다");
            var long_ = SpeechBubble.DurationSec(new string('가', 100));
            Assert.Greater(long_, short_);
        }

        [Test]
        public void 표시_시간에_상한이_있다()
        {
            // 아주 긴 답변이 몇 분씩 화면에 남으면 방해가 된다.
            Assert.LessOrEqual(SpeechBubble.DurationSec(new string('가', 100000)), 20f);
        }
    }
}
