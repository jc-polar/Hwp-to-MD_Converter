using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

namespace HwpPdfWorker
{
    class Program
    {
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool EnumWindows(EnumWindowsProc enumFunc, IntPtr lParam);
        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int nMax);

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

        const byte VK_N = 0x4E;
        const uint WM_KEYDOWN = 0x0100;
        const uint WM_KEYUP = 0x0101;
        const int SW_HIDE = 0;

        static void AutoClickLoop()
        {
            while (true)
            {
                Thread.Sleep(5);
                try
                {
                    EnumWindows((hWnd, _) =>
                    {
                        if (!IsWindowVisible(hWnd)) return true;

                        var cls = new StringBuilder(256);
                        GetClassName(hWnd, cls, 256);
                        string c = cls.ToString();

                        if (c.StartsWith("HwndWrapper[hwp.exe"))
                        {
                            SetForegroundWindow(hWnd);
                            System.Windows.Forms.SendKeys.SendWait("N");
                            Thread.Sleep(300);
                        }
                        return true;
                    }, IntPtr.Zero);
                }
                catch { }
            }
        }

        [STAThread]
        static void Main(string[] args)
        {
            var clicker = new Thread(AutoClickLoop);
            clicker.IsBackground = true;
            clicker.Start();

            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding  = Encoding.UTF8;

            dynamic hwp = null;
            try
            {
                var hwpType = Type.GetTypeFromProgID("HWPFrame.HwpObject");
                if (hwpType == null)
                {
                    Console.WriteLine("RESULT|FATAL|한글이 설치되어 있지 않습니다.");
                    return;
                }

                hwp = Activator.CreateInstance(hwpType);
                hwp.XHwpWindows.Item(0).Visible = false;
                hwp.RegisterModule("FilePathCheckDLL", "SecurityModule");
                hwp.SetMessageBoxMode(0x00010000);

                Console.WriteLine("READY");

                while (true)
                {
                    string line = Console.ReadLine();
                    if (string.IsNullOrEmpty(line) || line.Trim() == "EXIT") break;

                    string[] parts = line.Split('|');
                    if (parts.Length < 1) continue;

                    string inputPath = parts[0].Trim();
                    string pdfPath = parts.Length >= 2 ? parts[1].Trim() : "";
                    string cleanPath = parts.Length >= 3 ? parts[2].Trim() : "";

                    try
                    {
                        bool opened = hwp.Open(inputPath, "", "forceopen:true");
                        if (!opened)
                        {
                            Console.WriteLine(string.Format("RESULT|ERROR|{0}|파일 열기 실패", inputPath));
                            continue;
                        }

                        // HWP 사전 전처리 (Pre-processing): 변경 추적 모두 수락 및 모든 메모/주석 삭제 (PDF 오염 방지)
                        try { hwp.HAction.Run("AcceptTrackChangeAll"); } catch { }
                        try { hwp.HAction.Run("EraseAllMemo"); } catch { }
                        try { hwp.HAction.Run("DeleteAllMemo"); } catch { }
                        try { CleanPromptInjection(hwp); } catch { }

                        if (!string.IsNullOrEmpty(pdfPath))
                        {
                            hwp.HAction.GetDefault("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                            hwp.HParameterSet.HFileOpenSave.filename = pdfPath;
                            hwp.HParameterSet.HFileOpenSave.Format = "PDF";
                            hwp.HAction.Execute("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                        }

                        if (!string.IsNullOrEmpty(cleanPath))
                        {
                            hwp.HAction.GetDefault("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                            hwp.HParameterSet.HFileOpenSave.filename = cleanPath;
                            hwp.HParameterSet.HFileOpenSave.Format = "HWPX";
                            hwp.HAction.Execute("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                        }

                        hwp.HAction.Run("FileClose");

                        Console.WriteLine(string.Format("RESULT|SUCCESS|{0}|{1}|{2}", inputPath, pdfPath, cleanPath));
                    }
                    catch (Exception ex)
                    {
                        Console.WriteLine(string.Format("RESULT|ERROR|{0}|{1}", inputPath, ex.Message));
                    }
                }
            }
            catch (Exception e)
            {
                Console.WriteLine(string.Format("RESULT|FATAL|{0}", e.Message));
            }
            finally
            {
                if (hwp != null) try { hwp.Quit(); } catch { }
            }
        }

        private static void CleanPromptInjection(dynamic hwp)
        {
            try
            {
                // 1) 사전 전처리: 변경 추적 수락, 모든 메모/주석 삭제, ZWC/FFFD 글로벌 멸균 치환
                try { hwp.HAction.Run("AcceptTrackChangeAll"); } catch { }
                try { hwp.HAction.Run("EraseAllMemo"); } catch { }
                try { hwp.HAction.Run("DeleteAllMemo"); } catch { }
                try
                {
                    string[] zwcChars = new string[] { "\u200B", "\u200C", "\u200D", "\uFEFF", "\uFFFD" };
                    foreach (string zwc in zwcChars)
                    {
                        try { hwp.HAction.Run("MoveDocBegin"); } catch { }
                        hwp.HAction.GetDefault("AllReplace", hwp.HParameterSet.HFindReplace.HSet);
                        hwp.HParameterSet.HFindReplace.FindString = zwc;
                        hwp.HParameterSet.HFindReplace.ReplaceString = "";
                        hwp.HParameterSet.HFindReplace.Direction = 2;
                        hwp.HParameterSet.HFindReplace.IgnoreMessage = 1;
                        hwp.HAction.Execute("AllReplace", hwp.HParameterSet.HFindReplace.HSet);
                    }
                }
                catch { }

                // 2) 프롬프트 인젝션 & 숨김 글자 7대 조건 탐지 스캔
                var deleteTargets = new System.Collections.Generic.List<object>();
                try
                {
                    hwp.InitScan(0, 0, 0, 0, 0, 0);

                    while (true)
                    {
                        object[] args = new object[] { null };
                        System.Reflection.ParameterModifier[] pMods = new System.Reflection.ParameterModifier[] { new System.Reflection.ParameterModifier(1) };
                        pMods[0][0] = true;

                        int state = 0;
                        try
                        {
                            state = (int)hwp.GetType().InvokeMember("GetText",
                                System.Reflection.BindingFlags.InvokeMethod,
                                null, hwp, args, pMods, null, null);
                        }
                        catch { break; }

                        if (state == 0 || state == 1) break; // 스캔 완결 조건

                        string text = args[0] as string;
                        if (string.IsNullOrEmpty(text)) continue;

                        bool shouldDelete = false;

                        try
                        {
                            hwp.HAction.GetDefault("CharShape", hwp.HParameterSet.HCharShape.HSet);
                            dynamic cs = hwp.HParameterSet.HCharShape;

                            int height = Convert.ToInt32(cs.Height);
                            int ratio = Convert.ToInt32(cs.RatioHangul);
                            long textColor = Convert.ToInt64(cs.TextColor);
                            long shadeColor = Convert.ToInt64(cs.ShadeColor);
                            long attr = Convert.ToInt64(cs.Property);

                            // 조건 1: 폰트 크기 0pt 또는 1pt 미만 (Height < 100)
                            if (height > 0 && height < 100) shouldDelete = true;

                            // 조건 2: 너비/장평 0% 글자
                            if (ratio == 0) shouldDelete = true;

                            // 조건 3 & 6: 글자색 == 바탕색 (White-on-White) 또는 완전 투명 글자
                            if (textColor != 0 && textColor == shadeColor) shouldDelete = true;
                            if ((textColor & 0xFF000000) == 0xFF000000 && (textColor & 0xFFFFFF) == 0xFFFFFF) shouldDelete = true;

                            // 조건 4: 한글 내장 [숨김] 비트 속성 (0x200000)
                            if ((attr & 0x200000) != 0) shouldDelete = true;
                        }
                        catch { }

                        if (shouldDelete)
                        {
                            try
                            {
                                dynamic pos = hwp.GetPosSet();
                                if (pos != null) deleteTargets.Add(pos);
                            }
                            catch { }
                        }
                    }
                }
                finally
                {
                    try { hwp.ReleaseScan(); } catch { }
                }

                // 3) 투패스 역순 삭제 (Bottom-Up Deletion)
                deleteTargets.Reverse();
                foreach (dynamic pos in deleteTargets)
                {
                    try
                    {
                        hwp.SetPosSet(pos);
                        hwp.HAction.Run("MoveSelRight");
                        hwp.HAction.Run("Delete");
                    }
                    catch { }
                }
            }
            catch { }
        }
    }
}
