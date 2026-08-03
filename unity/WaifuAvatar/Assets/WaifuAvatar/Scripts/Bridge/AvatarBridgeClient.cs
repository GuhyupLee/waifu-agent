using System;
using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace WaifuAvatar.Bridge
{
    /// <summary>
    /// Electron main 의 AvatarBridgeServer 에 붙는 클라이언트.
    ///
    /// <c>ClientWebSocket</c> 을 쓴다 — BCL 표준 구현이라 직접 짠 프레이밍보다 믿을 만하고,
    /// 저쪽(직접 구현한 서버)이 규격을 지키는지 검증하는 역할도 겸한다.
    ///
    /// 스레딩: 수신은 백그라운드 Task 에서 돌고, Unity API 는 메인 스레드에서만 부를 수
    /// 있다. 그래서 받은 것을 큐에 넣고 <see cref="Drain"/> 이 Update 에서 꺼낸다.
    ///
    /// **연결이 끊기면 프로세스를 끝낸다.** 이게 고아 프로세스에 대한 진짜 안전망이다 —
    /// Electron 이 크래시하면 저쪽 정리 코드는 실행될 기회조차 없다. 투명하고 클릭이
    /// 통과하는 창이 남으면 사용자는 그것을 닫을 방법이 없다.
    /// </summary>
    public class AvatarBridgeClient : IDisposable
    {
        readonly ConcurrentQueue<AvatarCommandDto> _inbox = new ConcurrentQueue<AvatarCommandDto>();
        readonly CancellationTokenSource _cancel = new CancellationTokenSource();
        ClientWebSocket _socket;
        Task _receiveLoop;

        /// <summary>인증까지 끝났는가.</summary>
        public bool Authenticated { get; private set; }

        /// <summary>연결이 끝났다. 인자는 로그용 사유다.</summary>
        public event Action<string> Closed;

        public static bool TryReadEnvironment(out string url, out string token, out string error)
        {
            url = null;
            token = null;

            var port = Environment.GetEnvironmentVariable(Protocol.PortEnv);
            token = Environment.GetEnvironmentVariable(Protocol.TokenEnv);

            if (string.IsNullOrEmpty(port) || string.IsNullOrEmpty(token))
            {
                error = $"{Protocol.PortEnv} / {Protocol.TokenEnv} 환경변수가 없다. " +
                        "이 플레이어는 Electron 이 띄워야 한다.";
                return false;
            }
            if (!int.TryParse(port, out var parsed) || parsed <= 0 || parsed > 65535)
            {
                error = $"{Protocol.PortEnv} 값이 포트가 아니다: {port}";
                return false;
            }

            // 루프백 고정. 주소를 환경변수로 받으면 셸이 엉뚱한 호스트에 붙을 수 있다.
            url = $"ws://127.0.0.1:{parsed}";
            error = null;
            return true;
        }

        public async Task<bool> ConnectAsync(string url, string token)
        {
            _socket = new ClientWebSocket();
            try
            {
                await _socket.ConnectAsync(new Uri(url), _cancel.Token);
            }
            catch (Exception e)
            {
                Closed?.Invoke($"연결 실패: {e.Message}");
                return false;
            }

            // **첫 메시지는 인증이다.** 저쪽은 다른 게 먼저 오면 끊는다.
            var hello = JsonUtility.ToJson(new Hello { token = token });
            if (!await SendRawAsync(hello))
            {
                Closed?.Invoke("hello 전송 실패");
                return false;
            }

            var ackRaw = await ReceiveOneAsync();
            if (ackRaw == null)
            {
                Closed?.Invoke("hello-ack 를 받지 못했다");
                return false;
            }

            var ack = Json.TryParse<HelloAck>(ackRaw);
            if (ack == null || ack.type != "hello-ack" || !ack.ok)
            {
                // 저쪽이 사유를 준다. 무응답으로 끊기면 토큰 문제인지 앱이 죽은 건지
                // 구분할 수 없으므로, 받은 사유를 그대로 남긴다.
                var reason = ack?.reason ?? "알 수 없음";
                Closed?.Invoke($"인증 거절: {reason}");
                return false;
            }

            // 버전이 어긋나면 끊는다. 셸은 Electron 과 따로 빌드되므로 앱만 업데이트하고
            // 예전 플레이어가 남아 있는 조합이 실제로 생긴다. 그때 조용히 반쯤 동작하면
            // "명령이 가끔 안 먹는다" 는 재현 불가능한 버그가 된다.
            //
            // 예전에는 ack 의 protocolVersion 을 역직렬화해두고 비교하지 않아서,
            // 핸드셰이크에서 끊겠다는 계약이 실제로는 지켜지지 않았다.
            if (ack.protocolVersion != Protocol.Version)
            {
                Closed?.Invoke($"프로토콜 버전 불일치: 셸 {Protocol.Version}, main {ack.protocolVersion}");
                return false;
            }

            Authenticated = true;
            _receiveLoop = Task.Run(ReceiveLoopAsync);
            return true;
        }

        /// <summary>메인 스레드에서 부른다. 받아둔 명령을 순서대로 넘긴다.</summary>
        public void Drain(Action<AvatarCommandDto> handle)
        {
            while (_inbox.TryDequeue(out var command))
            {
                try
                {
                    handle(command);
                }
                catch (Exception e)
                {
                    // 명령 하나가 터졌다고 나머지를 버리면 상태가 어긋난 채로 남는다.
                    Debug.LogError($"[waifu] 명령 처리 실패 ({command?.type}): {e}");
                }
            }
        }

        public void SendEvent<T>(T value)
        {
            if (!Authenticated) return;
            _ = SendRawAsync(Json.Event(value));
        }

        async Task<bool> SendRawAsync(string text)
        {
            if (_socket == null || _socket.State != WebSocketState.Open) return false;
            try
            {
                var bytes = Encoding.UTF8.GetBytes(text);
                await _socket.SendAsync(
                    new ArraySegment<byte>(bytes),
                    WebSocketMessageType.Text,
                    true,
                    _cancel.Token);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>메시지 하나를 끝까지 받는다. 끊겼으면 null.</summary>
        async Task<string> ReceiveOneAsync()
        {
            var buffer = new byte[8192];
            var builder = new StringBuilder();

            while (true)
            {
                WebSocketReceiveResult result;
                try
                {
                    result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), _cancel.Token);
                }
                catch (Exception)
                {
                    return null;
                }

                if (result.MessageType == WebSocketMessageType.Close) return null;
                builder.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));

                // 한 메시지가 여러 프레임으로 쪼개져 올 수 있다. EndOfMessage 까지 모은다.
                if (result.EndOfMessage) return builder.ToString();
            }
        }

        async Task ReceiveLoopAsync()
        {
            while (!_cancel.IsCancellationRequested)
            {
                var raw = await ReceiveOneAsync();
                if (raw == null)
                {
                    Closed?.Invoke("연결이 끊겼다");
                    return;
                }

                var head = Json.TryParse<MessageHead>(raw);
                if (head == null)
                {
                    // 깨진 JSON 하나로 연결을 끊지 않는다. 버리고 계속 읽는다.
                    Debug.LogWarning("[waifu] 깨진 JSON 을 버렸다");
                    continue;
                }
                if (head.type != "command") continue;

                var envelope = Json.TryParse<CommandEnvelope>(raw);
                if (envelope?.command == null) continue;
                _inbox.Enqueue(envelope.command);
            }
        }

        public void Dispose()
        {
            Authenticated = false;
            try
            {
                _cancel.Cancel();
            }
            catch (Exception)
            {
                // 이미 정리됐다.
            }

            if (_socket != null)
            {
                try
                {
                    if (_socket.State == WebSocketState.Open)
                    {
                        // 응답을 기다리지 않는다. 종료 중이라 어차피 곧 사라진다.
                        _ = _socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "shutdown", CancellationToken.None);
                    }
                    _socket.Dispose();
                }
                catch (Exception)
                {
                    // 이미 끊긴 소켓.
                }
                _socket = null;
            }

            _cancel.Dispose();
        }
    }
}
