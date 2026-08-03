using System;
using System.Runtime.InteropServices;
using UnityEngine;
using WaifuAvatar.Avatar;

namespace WaifuAvatar.Window
{
    /// <summary>
    /// 데스크탑 가장자리의 평균 색을 읽는다. **Windows 전용.**
    ///
    /// **이것은 "이거 봐줘" 가 아니다.** 이 프로젝트의 화면 캡처 규칙(에이전트가
    /// 요청하고 사용자가 승인해야 한 장이 넘어간다)은 화면 내용을 **모델에게 보내는**
    /// 경로에 대한 것이다. 여기서 읽은 픽셀은 다르다:
    ///
    ///  - 아바타 셸 프로세스 밖으로 나가지 않는다. 브리지로도, 에이전트로도,
    ///    디스크로도 가지 않는다.
    ///  - 프레임을 보관하지 않는다. 읽자마자 네 개의 평균 색으로 줄이고 버린다.
    ///  - 원본 해상도로 읽지 않는다. 화면 전체를 <see cref="Width"/>×<see cref="Height"/>
    ///    (기본 160×90)로 축소해 받는다. 그 크기에서는 글자를 읽을 수 없다.
    ///  - 기본값이 꺼짐이고 설정에서 끌 수 있다.
    ///
    /// 그래도 화면을 주기적으로 읽는 것은 사실이다. 설정 화면에서 그 사실을 숨기지 않는다.
    ///
    /// 캡처 방식과 밴드 구성은 Mate-Engine X3.3.0 의 <c>DesktopAmbientProbe</c> 에서
    /// 가져왔다.
    /// </summary>
    public static class DesktopAmbient
    {
        public static bool Supported =>
#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
            true;
#else
            false;
#endif

        /// <summary>축소 해상도. 글자를 읽을 수 없을 만큼 작아야 한다.</summary>
        public const int Width = 160;
        public const int Height = 90;

#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN

        const int SmXVirtualScreen = 76;
        const int SmYVirtualScreen = 77;
        const int SmCxVirtualScreen = 78;
        const int SmCyVirtualScreen = 79;
        const int SrcCopy = 0x00CC0020;
        const uint DibRgbColors = 0;

        [StructLayout(LayoutKind.Sequential)]
        struct BitmapInfoHeader
        {
            public uint biSize;
            public int biWidth;
            public int biHeight;
            public ushort biPlanes;
            public ushort biBitCount;
            public uint biCompression;
            public uint biSizeImage;
            public int biXPelsPerMeter;
            public int biYPelsPerMeter;
            public uint biClrUsed;
            public uint biClrImportant;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct BitmapInfo
        {
            public BitmapInfoHeader bmiHeader;
            public uint bmiColors;
        }

        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
        [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool SetStretchBltMode(IntPtr dc, int mode);
        [DllImport("gdi32.dll")]
        static extern bool StretchBlt(IntPtr destDc, int xDest, int yDest, int wDest, int hDest,
            IntPtr srcDc, int xSrc, int ySrc, int wSrc, int hSrc, int rop);
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage,
            out IntPtr bits, IntPtr section, uint offset);

        static readonly byte[] Pixels = new byte[Width * Height * 4];

        /// <summary>
        /// 화면 네 변의 평균 색.
        ///
        /// 아바타 자신이 있는 자리는 <paramref name="exclude"/> 로 빼야 한다. 안 그러면
        /// 아바타가 자기 색으로 자기를 비추는 되먹임이 생겨 색이 한쪽으로 몰린다.
        /// </summary>
        /// <param name="exclude">아바타 창의 데스크탑 사각형. 비어 있으면 무시한다.</param>
        public static bool TrySample(Rect exclude, out AmbientSample sample)
        {
            sample = default;

            var screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero) return false;

            var memoryDc = IntPtr.Zero;
            var bitmap = IntPtr.Zero;
            try
            {
                memoryDc = CreateCompatibleDC(screenDc);
                if (memoryDc == IntPtr.Zero) return false;

                var info = new BitmapInfo
                {
                    bmiHeader = new BitmapInfoHeader
                    {
                        biSize = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader)),
                        biWidth = Width,
                        // 음수 = 위에서 아래로. 양수면 상하가 뒤집혀 저장돼 위/아래 밴드가 바뀐다.
                        biHeight = -Height,
                        biPlanes = 1,
                        biBitCount = 32,
                        biCompression = 0,
                    }
                };

                bitmap = CreateDIBSection(memoryDc, ref info, DibRgbColors, out var bits, IntPtr.Zero, 0);
                if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) return false;

                SelectObject(memoryDc, bitmap);
                // HALFTONE(4). 최근접 축소는 160px 로 줄일 때 한 픽셀이 화면 전체를
                // 대표하게 되어, 커서가 지나가는 것만으로 조명이 흔들린다.
                SetStretchBltMode(memoryDc, 4);

                var vx = GetSystemMetrics(SmXVirtualScreen);
                var vy = GetSystemMetrics(SmYVirtualScreen);
                var vw = Mathf.Max(1, GetSystemMetrics(SmCxVirtualScreen));
                var vh = Mathf.Max(1, GetSystemMetrics(SmCyVirtualScreen));

                if (!StretchBlt(memoryDc, 0, 0, Width, Height, screenDc, vx, vy, vw, vh, SrcCopy)) return false;

                Marshal.Copy(bits, Pixels, 0, Pixels.Length);

                // 아바타 창을 축소 좌표계로 옮긴다.
                var mask = new RectInt(0, 0, 0, 0);
                if (exclude.width > 0f && exclude.height > 0f)
                {
                    mask = new RectInt(
                        Mathf.FloorToInt((exclude.xMin - vx) * Width / vw),
                        Mathf.FloorToInt((exclude.yMin - vy) * Height / vh),
                        Mathf.CeilToInt(exclude.width * Width / vw),
                        Mathf.CeilToInt(exclude.height * Height / vh));
                }

                var band = Mathf.Max(1, Height / 4);
                var side = Mathf.Max(1, Width / 4);
                sample = new AmbientSample
                {
                    Top = Average(new RectInt(0, 0, Width, band), mask),
                    Bottom = Average(new RectInt(0, Height - band, Width, band), mask),
                    Left = Average(new RectInt(0, 0, side, Height), mask),
                    Right = Average(new RectInt(Width - side, 0, side, Height), mask),
                };
                return true;
            }
            finally
            {
                if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
                if (memoryDc != IntPtr.Zero) DeleteDC(memoryDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        /// <summary>밴드 평균. 제외 사각형 안의 픽셀은 세지 않는다.</summary>
        static Color Average(RectInt band, RectInt mask)
        {
            long r = 0, g = 0, b = 0;
            var count = 0;

            var x1 = Mathf.Min(Width, band.xMax);
            var y1 = Mathf.Min(Height, band.yMax);
            for (var y = Mathf.Max(0, band.yMin); y < y1; y++)
            {
                var row = y * Width * 4;
                for (var x = Mathf.Max(0, band.xMin); x < x1; x++)
                {
                    if (mask.width > 0 && x >= mask.xMin && x < mask.xMax && y >= mask.yMin && y < mask.yMax) continue;
                    var i = row + x * 4;
                    // DIB 는 BGRA 순서다.
                    b += Pixels[i];
                    g += Pixels[i + 1];
                    r += Pixels[i + 2];
                    count++;
                }
            }

            // 아바타가 밴드를 통째로 덮으면 셀 픽셀이 없다. 검정을 돌려주면 조명이
            // 갑자기 꺼지므로 중간 회색으로 둔다.
            if (count == 0) return new Color(0.5f, 0.5f, 0.5f);
            return new Color(r / (255f * count), g / (255f * count), b / (255f * count));
        }

#else
        public static bool TrySample(Rect exclude, out AmbientSample sample)
        {
            sample = default;
            return false;
        }
#endif
    }
}
