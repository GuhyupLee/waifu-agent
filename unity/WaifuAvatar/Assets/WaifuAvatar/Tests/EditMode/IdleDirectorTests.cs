using System.Collections.Generic;
using NUnit.Framework;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Tests
{
    public class IdleDirectorTests
    {
        static IdleDirector Make(params float[] sequence)
        {
            var i = 0;
            return new IdleDirector(() => sequence[i++ % sequence.Length]);
        }

        [Test]
        public void 클립이_없으면_아무것도_하지_않는다()
        {
            var director = Make(0.5f);
            director.SetClips(new string[0]);
            Assert.IsNull(director.Current);
            Assert.IsNull(director.Update(100f));
        }

        [Test]
        public void 첫_클립을_바로_고른다()
        {
            var director = Make(0.5f);
            director.SetClips(new[] { "idle_a", "idle_b" });
            Assert.AreEqual("idle_a", director.Current);
        }

        [Test]
        public void 유지_시간_전에는_바꾸지_않는다()
        {
            var director = Make(0.5f);
            director.MinHoldSec = 8f;
            director.MaxHoldSec = 40f;
            director.SetClips(new[] { "idle_a", "idle_b" });

            Assert.IsNull(director.Update(1f));
            Assert.AreEqual("idle_a", director.Current);
        }

        [Test]
        public void 유지_시간이_지나면_다른_클립으로_바꾼다()
        {
            var director = Make(0.5f);
            director.MinHoldSec = 1f;
            director.MaxHoldSec = 2f;
            director.SetClips(new[] { "idle_a", "idle_b" });

            var changed = director.Update(100f);
            Assert.IsNotNull(changed);
            Assert.AreNotEqual("idle_a", changed);
        }

        [Test]
        public void 같은_클립을_연속으로_고르지_않는다()
        {
            // 확률적으로는 정상이지만 사용자에게는 "전환이 고장났다" 로 보인다.
            // random 이 늘 0 이어서 항상 첫 클립을 가리켜도 갈려야 한다.
            var director = Make(0f);
            director.MinHoldSec = 1f;
            director.MaxHoldSec = 2f;
            director.SetClips(new[] { "idle_a", "idle_b", "idle_c" });

            var seen = new List<string> { director.Current };
            for (var i = 0; i < 10; i++)
            {
                var next = director.Update(100f);
                if (next != null) seen.Add(next);
            }

            for (var i = 1; i < seen.Count; i++)
            {
                Assert.AreNotEqual(seen[i - 1], seen[i], "같은 클립이 연속으로 나왔다");
            }
        }

        [Test]
        public void 클립이_하나뿐이면_전환하지_않는다()
        {
            var director = Make(0.5f);
            director.MinHoldSec = 1f;
            director.SetClips(new[] { "only" });
            Assert.IsNull(director.Update(100f));
            Assert.AreEqual("only", director.Current);
        }

        [Test]
        public void 유지_시간이_상한을_넘지_않는다()
        {
            // 지수분포는 꼬리가 길다. 상한이 없으면 몇 분씩 같은 자세로 굳는다.
            var director = Make(0.999999f);
            director.MinHoldSec = 8f;
            director.MaxHoldSec = 40f;
            director.SetClips(new[] { "idle_a", "idle_b" });
            Assert.LessOrEqual(director.Remaining, 40f);
        }

        [Test]
        public void 유지_시간이_최소값_아래로_내려가지_않는다()
        {
            var director = Make(0f);
            director.MinHoldSec = 8f;
            director.MaxHoldSec = 40f;
            director.SetClips(new[] { "idle_a", "idle_b" });
            Assert.GreaterOrEqual(director.Remaining, 8f);
        }

        [Test]
        public void Interrupt_는_다음_프레임에_전환시킨다()
        {
            var director = Make(0.5f);
            director.MinHoldSec = 30f;
            director.MaxHoldSec = 60f;
            director.SetClips(new[] { "idle_a", "idle_b" });

            director.Interrupt();
            Assert.IsNotNull(director.Update(0.016f));
        }
    }

    public class SleepPolicyTests
    {
        [Test]
        public void 유휴_시간이_차면_잔다()
        {
            var policy = new SleepPolicy { AfterIdleMin = 1f };
            Assert.IsFalse(policy.Update(30f, 12));
            Assert.IsFalse(policy.Asleep);

            Assert.IsTrue(policy.Update(31f, 12));
            Assert.IsTrue(policy.Asleep);
        }

        [Test]
        public void 건드리면_깬다()
        {
            var policy = new SleepPolicy { AfterIdleMin = 1f };
            policy.Update(61f, 12);
            Assert.IsTrue(policy.Asleep);

            policy.Poke();
            Assert.IsFalse(policy.Asleep);
        }

        [Test]
        public void 꺼져_있으면_자지_않고_자던_것도_깨운다()
        {
            var policy = new SleepPolicy { AfterIdleMin = 1f };
            policy.Update(61f, 12);
            Assert.IsTrue(policy.Asleep);

            policy.Enabled = false;
            Assert.IsTrue(policy.Update(1f, 12));
            Assert.IsFalse(policy.Asleep);
        }

        [Test]
        public void byClock_이_꺼져_있으면_시간대를_보지_않는다()
        {
            // null 대신 명시적 스위치를 쓰는 이유다. 꺼져 있으면 시각과 무관해야 한다.
            var policy = new SleepPolicy { ByClock = false, FromHour = 23, ToHour = 7 };
            for (var hour = 0; hour < 24; hour++)
            {
                Assert.IsFalse(policy.InSleepHours(hour), $"{hour}시");
            }
        }

        [Test]
        public void 자정을_넘기는_수면_시간대를_다룬다()
        {
            var policy = new SleepPolicy { ByClock = true, FromHour = 23, ToHour = 7 };
            Assert.IsTrue(policy.InSleepHours(23));
            Assert.IsTrue(policy.InSleepHours(0));
            Assert.IsTrue(policy.InSleepHours(6));
            Assert.IsFalse(policy.InSleepHours(7));
            Assert.IsFalse(policy.InSleepHours(12));
        }

        [Test]
        public void 같은_날_안의_수면_시간대도_다룬다()
        {
            var policy = new SleepPolicy { ByClock = true, FromHour = 13, ToHour = 15 };
            Assert.IsFalse(policy.InSleepHours(12));
            Assert.IsTrue(policy.InSleepHours(13));
            Assert.IsTrue(policy.InSleepHours(14));
            Assert.IsFalse(policy.InSleepHours(15));
        }

        [Test]
        public void 수면_시간대면_유휴와_무관하게_잔다()
        {
            var policy = new SleepPolicy { AfterIdleMin = 999f, ByClock = true, FromHour = 23, ToHour = 7 };
            Assert.IsTrue(policy.Update(1f, 2));
            Assert.IsTrue(policy.Asleep);
        }

        [Test]
        public void 수면_시간대에서_깨워도_시간대가_유지되면_다시_잔다()
        {
            // 자는 시간에 만지면 잠깐 깨지만, 손을 떼면 다시 자야 한다.
            var policy = new SleepPolicy { AfterIdleMin = 999f, ByClock = true, FromHour = 23, ToHour = 7 };
            policy.Update(1f, 2);
            policy.Poke();
            Assert.IsFalse(policy.Asleep);

            Assert.IsTrue(policy.Update(1f, 2));
            Assert.IsTrue(policy.Asleep);
        }
    }
}
