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

                        // 변경 추적 모두 수락 (PDF 및 HWPX 변환 시 빨간 줄 제거)
                        try { hwp.HAction.Run("AcceptTrackChangeAll"); } catch { }

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
    }
}
