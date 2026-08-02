using System;
using UnityEngine;

namespace WaifuAvatar.Bridge
{
    /// <summary>
    /// src/shared/protocol.ts 의 미러. **저쪽이 원본이다.**
    ///
    /// JsonUtility 를 쓰기 때문에 판별 유니온을 그대로 옮길 수 없다. 대신 모든 변형의
    /// 필드를 한 클래스에 펼쳐두고 <c>type</c> 으로 갈라 읽는다. JsonUtility 는 없는
    /// 필드를 기본값으로 두므로, 해당 변형이 쓰는 필드만 보면 된다.
    ///
    /// 뉴턴소프트를 끌어오지 않는 이유: 의존성 하나를 아끼는 것도 있지만, 이 경계를
    /// 지나는 JSON 은 우리가 만든 것뿐이라 관용적 파서가 필요하지 않다.
    /// </summary>
    public static class Protocol
    {
        /// <summary>protocol.ts 의 AVATAR_PROTOCOL_VERSION 과 **반드시** 같아야 한다.</summary>
        public const int Version = 1;

        // AVATAR_BRIDGE_ENV
        public const string PortEnv = "WAIFU_AVATAR_PORT";
        public const string TokenEnv = "WAIFU_AVATAR_TOKEN";

        // AVATAR_WINDOW_ENV — 첫 프레임 전에 필요해서 명령이 아니라 환경변수로 온다.
        public const string AnchorXEnv = "WAIFU_AVATAR_ANCHOR_X";
        public const string AnchorYEnv = "WAIFU_AVATAR_ANCHOR_Y";
        public const string TopmostEnv = "WAIFU_AVATAR_TOPMOST";
        public const string HitAlphaEnv = "WAIFU_AVATAR_HIT_ALPHA";
        public const string ScaleEnv = "WAIFU_AVATAR_SCALE";
        public const string ModelPathEnv = "WAIFU_AVATAR_MODEL";
    }

    [Serializable]
    public class Hello
    {
        public string type = "hello";
        public string token;
        public int protocolVersion = Protocol.Version;
        public string client = "unity";
    }

    [Serializable]
    public class HelloAck
    {
        public string type;
        public bool ok;
        public int protocolVersion;
        public string reason;
    }

    /// <summary>메시지 종류만 먼저 보기 위한 최소 형태.</summary>
    [Serializable]
    public class MessageHead
    {
        public string type;
    }

    /// <summary>
    /// main -> Unity 명령. AvatarCommand 의 모든 변형을 합친 모양이다.
    /// Phase 1 이 쓰는 것은 load-model, status, express, say, stop-speaking, set-scale 이다.
    /// </summary>
    [Serializable]
    public class AvatarCommandDto
    {
        public string type;

        // load-model
        public string url;
        public string format;

        // say
        public string id;
        public string text;
        public string motion;

        // express
        public string emotion;
        public float intensity = 1f;

        // status
        public string state;

        // set-scale / tuning
        public float scale = 1f;

        // motion
        public string name;
        public bool loop;

        // set-presence
        public bool asleep;

        // presence-config
        public PresenceSettingsDto settings;
    }

    /// <summary>protocol.ts 의 PresenceSettings 미러 (Phase 2).</summary>
    [Serializable]
    public class PresenceSettingsDto
    {
        public IdleDto idle = new IdleDto();
        public TrackingDto tracking = new TrackingDto();
        public bool touch = true;
        public bool dragMotion = true;
        public bool clampToScreen = true;
        public SleepDto sleep = new SleepDto();
        public BubbleDto bubble = new BubbleDto();
    }

    [Serializable]
    public class IdleDto
    {
        public bool enabled = true;
        public float minHoldSec = 8f;
        public float maxHoldSec = 40f;
    }

    [Serializable]
    public class TrackingDto
    {
        public bool enabled = true;
        public float eye = 1f;
        public float head = 1f;
        public float body = 0.5f;
    }

    [Serializable]
    public class SleepDto
    {
        public bool enabled = true;
        public float afterIdleMin = 20f;
        /// <summary>false 면 fromHour/toHour 를 아예 보지 않는다.</summary>
        public bool byClock;
        public int fromHour = 23;
        public int toHour = 7;
    }

    [Serializable]
    public class BubbleDto
    {
        public bool enabled = true;
        public int maxChars = 140;
    }

    [Serializable]
    public class CommandEnvelope
    {
        public string type;
        public int seq;
        public AvatarCommandDto command;
    }

    [Serializable]
    public class HoverEvent
    {
        public string type = "hover";
        public bool over;
    }

    [Serializable]
    public class ClickedEvent
    {
        public string type = "clicked";
    }

    [Serializable]
    public class SpeechEndEvent
    {
        public string type = "speech-end";
        public string id;
    }

    [Serializable]
    public class FpsEvent
    {
        public string type = "fps";
        public float value;
    }

    [Serializable]
    public class PresenceEvent
    {
        public string type = "presence";
        public bool asleep;
    }

    /// <summary>사용자가 아바타를 만졌다. 반응 자체는 셸이 이미 했고, 이건 통보다.</summary>
    [Serializable]
    public class TouchedEvent
    {
        public string type = "touched";
        public string bone;
        public string kind;
    }

    /// <summary>
    /// model-loaded 는 <c>ok</c> 로 갈리는 두 변형이다. JsonUtility 는 필드를 전부
    /// 내보내므로 실패 쪽에도 presets 같은 필드가 빈 값으로 실린다 — 판별자가
    /// <c>ok</c> 라 TypeScript 쪽에서 문제되지 않는다.
    /// </summary>
    [Serializable]
    public class ModelLoadedEvent
    {
        public string type = "model-loaded";
        public bool ok;
        public bool hasExpressions;
        public bool hasLookAt;
        public string[] presets = Array.Empty<string>();
        public string error;
    }

    public static class Json
    {
        /// <summary>실패하면 null. 깨진 JSON 때문에 셸이 죽으면 안 된다.</summary>
        public static T TryParse<T>(string raw) where T : class
        {
            try
            {
                return JsonUtility.FromJson<T>(raw);
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// 이벤트를 `{"type":"event","event":{...}}` 봉투에 넣는다.
        ///
        /// **문자열로 조립하는 이유**: JsonUtility 는 제네릭 타입을 직렬화하지 못한다.
        /// <c>EventEnvelope&lt;T&gt;</c> 같은 클래스를 만들면 조용히 `{}` 가 나가고,
        /// 저쪽은 "이벤트가 안 온다"로 보인다. 안쪽 객체만 JsonUtility 에 맡기고
        /// 바깥 두 필드는 우리가 붙인다.
        /// </summary>
        public static string Event<T>(T value)
        {
            return "{\"type\":\"event\",\"event\":" + JsonUtility.ToJson(value) + "}";
        }
    }
}
