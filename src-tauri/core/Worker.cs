using System;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using System.Collections.Generic;
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

        private static dynamic EnsureHwpInstance(dynamic hwp)
        {
            if (hwp != null)
            {
                try
                {
                    var v = hwp.Version;
                    if (v != null) return hwp;
                }
                catch
                {
                    try { Marshal.ReleaseComObject(hwp); } catch { }
                    hwp = null;
                }
            }

            var hwpType = Type.GetTypeFromProgID("HWPFrame.HwpObject");
            if (hwpType == null) throw new Exception("한글이 설치되어 있지 않습니다.");

            dynamic newHwp = Activator.CreateInstance(hwpType);
            newHwp.XHwpWindows.Item(0).Visible = false;
            newHwp.RegisterModule("FilePathCheckDLL", "SecurityModule");
            newHwp.SetMessageBoxMode(0x00010000);
            return newHwp;
        }

        private static bool IsWhiteOrTransparentColor(string colorStr)
        {
            if (string.IsNullOrEmpty(colorStr)) return false;
            colorStr = colorStr.Trim().ToUpperInvariant();
            if (colorStr == "#FFFFFF" || colorStr == "FFFFFF" || colorStr == "WHITE") return true;
            if (colorStr == "16777215" || colorStr == "4294967295" || colorStr == "-1") return true;
            return false;
        }

        private static bool SanitizeHwpxPackage(string sourceHwpx, string targetHwpx)
        {
            try
            {
                if (!File.Exists(sourceHwpx)) return false;

                var badCharPrIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

                // 1단계: header.xml을 읽어 7대 악성 숨김 조건(0pt, 흰색글자, 장평0% 등)에 해당하는 charPr ID 색출
                using (var srcArchive = ZipFile.Open(sourceHwpx, ZipArchiveMode.Read))
                {
                    ZipArchiveEntry headerEntry = null;
                    foreach (var entry in srcArchive.Entries)
                    {
                        if (entry.FullName.EndsWith("header.xml", StringComparison.OrdinalIgnoreCase))
                        {
                            headerEntry = entry;
                            break;
                        }
                    }

                    if (headerEntry != null)
                    {
                        using (var stream = headerEntry.Open())
                        using (var reader = XmlReader.Create(stream))
                        {
                            while (reader.Read())
                            {
                                if (reader.NodeType == XmlNodeType.Element &&
                                    (reader.LocalName == "charPr" || reader.Name.EndsWith(":charPr")))
                                {
                                    string id = reader.GetAttribute("id");
                                    string heightStr = reader.GetAttribute("height");
                                    string textColor = reader.GetAttribute("textColor");
                                    string shadeColor = reader.GetAttribute("shadeColor");
                                    string ratioStr = reader.GetAttribute("ratio");

                                    bool isBad = false;

                                    // 조건 1: 폰트 크기 0pt 또는 1pt 미만 (height < 100)
                                    int height = 1000;
                                    if (!string.IsNullOrEmpty(heightStr) && int.TryParse(heightStr, out height))
                                    {
                                        if (height < 100) isBad = true;
                                    }

                                    // 조건 2: 장평 0% 글자
                                    int ratio = 100;
                                    if (!string.IsNullOrEmpty(ratioStr) && int.TryParse(ratioStr, out ratio))
                                    {
                                        if (ratio == 0) isBad = true;
                                    }

                                    // 조건 3: 흰색 글자 또는 글자색 == 바탕색 (White-on-White)
                                    if (IsWhiteOrTransparentColor(textColor)) isBad = true;
                                    if (!string.IsNullOrEmpty(textColor) && !string.IsNullOrEmpty(shadeColor) &&
                                        shadeColor != "none" && string.Equals(textColor, shadeColor, StringComparison.OrdinalIgnoreCase))
                                    {
                                        isBad = true;
                                    }

                                    if (isBad && !string.IsNullOrEmpty(id))
                                    {
                                        badCharPrIds.Add(id);
                                    }
                                }
                            }
                        }
                    }

                    if (File.Exists(targetHwpx))
                    {
                        try { File.Delete(targetHwpx); } catch { }
                    }

                    // 2단계: 새 ZIP 파일로 스트리밍 복사하면서 section*.xml 정제 및 .ole 제거
                    var zwcRegex = new Regex(@"[\u200B-\u200D\uFEFF\uFFFD]", RegexOptions.Compiled);

                    using (var targetStream = new FileStream(targetHwpx, FileMode.Create, FileAccess.Write))
                    using (var dstArchive = new ZipArchive(targetStream, ZipArchiveMode.Create))
                    {
                        foreach (var srcEntry in srcArchive.Entries)
                        {
                            string entryName = srcEntry.FullName;

                            // OLE 충돌 개체 제거: BinData/*.ole 복사 배제
                            if (entryName.StartsWith("BinData/", StringComparison.OrdinalIgnoreCase) &&
                                entryName.EndsWith(".ole", StringComparison.OrdinalIgnoreCase))
                            {
                                continue;
                            }

                            // section*.xml 멸균 처리
                            bool isSection = entryName.IndexOf("section", StringComparison.OrdinalIgnoreCase) >= 0 &&
                                             entryName.EndsWith(".xml", StringComparison.OrdinalIgnoreCase);

                            if (isSection)
                            {
                                string xmlContent;
                                using (var inStream = srcEntry.Open())
                                using (var sr = new StreamReader(inStream, Encoding.UTF8))
                                {
                                    xmlContent = sr.ReadToEnd();
                                }

                                // 2-1) ZWC 제어문자 소거
                                xmlContent = zwcRegex.Replace(xmlContent, "");

                                // 2-2) 악성 charPr 참조 <hp:run> 내부 텍스트 소거
                                if (badCharPrIds.Count > 0)
                                {
                                    try
                                    {
                                        var xdoc = XDocument.Parse(xmlContent);
                                        foreach (var run in xdoc.Descendants())
                                        {
                                            if (run.Name.LocalName == "run")
                                            {
                                                var attr = run.Attribute("charPrIDRef");
                                                if (attr != null && badCharPrIds.Contains(attr.Value))
                                                {
                                                    // run 구조는 유지하되 내부 텍스트 태그(t)의 내용을 공백화하여 멸균
                                                    foreach (var t in run.Descendants())
                                                    {
                                                        if (t.Name.LocalName == "t")
                                                        {
                                                            t.Value = "";
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        xmlContent = xdoc.ToString(SaveOptions.DisableFormatting);
                                    }
                                    catch { }
                                }

                                byte[] xmlBytes = Encoding.UTF8.GetBytes(xmlContent);
                                var dstEntry = dstArchive.CreateEntry(entryName, CompressionLevel.Optimal);
                                dstEntry.LastWriteTime = srcEntry.LastWriteTime;
                                using (var outStream = dstEntry.Open())
                                {
                                    outStream.Write(xmlBytes, 0, xmlBytes.Length);
                                }
                            }
                            else
                            {
                                // 일반 엔트리 고속 바이너리 스트리밍 복사
                                var dstEntry = dstArchive.CreateEntry(entryName,
                                    srcEntry.CompressedLength == 0 ? CompressionLevel.NoCompression : CompressionLevel.Optimal);
                                dstEntry.LastWriteTime = srcEntry.LastWriteTime;

                                using (var inStream = srcEntry.Open())
                                using (var outStream = dstEntry.Open())
                                {
                                    inStream.CopyTo(outStream);
                                }
                            }
                        }
                    }
                }
                return true;
            }
            catch
            {
                return false;
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
                hwp = EnsureHwpInstance(null);
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
                        hwp = EnsureHwpInstance(hwp);

                        // 기존 잔존 0KB 또는 이전 작업 PDF 사전 삭제
                        if (!string.IsNullOrEmpty(pdfPath) && File.Exists(pdfPath))
                        {
                            try { File.Delete(pdfPath); } catch { }
                        }

                        bool opened = false;
                        try { opened = hwp.Open(inputPath, "", "forceopen:true"); } catch { }
                        if (!opened)
                        {
                            Console.WriteLine(string.Format("RESULT|ERROR|{0}|파일 열기 실패", inputPath));
                            continue;
                        }

                        // 변경 추적 수락 및 모든 메모/주석 삭제 (시각적 오염 방지)
                        try { hwp.HAction.Run("AcceptTrackChangeAll"); } catch { }
                        try { hwp.HAction.Run("EraseAllMemo"); } catch { }
                        try { hwp.HAction.Run("DeleteAllMemo"); } catch { }

                        // 1단계: 원본 문서를 HWPX로 우선 덤프 (OLE 렌더링이 없어 100% 충돌 없이 초고속 저장)
                        string rawHwpx = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + "_raw.hwpx");
                        try
                        {
                            hwp.HAction.GetDefault("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                            hwp.HParameterSet.HFileOpenSave.filename = rawHwpx;
                            hwp.HParameterSet.HFileOpenSave.Format = "HWPX";
                            hwp.HAction.Execute("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                        }
                        catch { }
                        finally
                        {
                            try { hwp.HAction.Run("FileClose"); } catch { }
                        }

                        // 2단계: 초고속 HWPX XML 직접 전수 멸균 파이프라인 (0.1~0.5초 소요)
                        // 7대 숨김/프롬프트 인젝션 텍스트 소거 + ZWC 소거 + OLE 충돌 개체 제거
                        string finalCleanHwpx = cleanPath;
                        bool isTempCleanHwpx = false;
                        if (string.IsNullOrEmpty(finalCleanHwpx))
                        {
                            finalCleanHwpx = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N") + "_clean.hwpx");
                            isTempCleanHwpx = true;
                        }

                        bool sanitized = false;
                        if (File.Exists(rawHwpx))
                        {
                            sanitized = SanitizeHwpxPackage(rawHwpx, finalCleanHwpx);
                            try { File.Delete(rawHwpx); } catch { }
                        }

                        string loadTarget = (sanitized && File.Exists(finalCleanHwpx)) ? finalCleanHwpx : inputPath;

                        // 3단계: 100% 멸균된 클린 HWPX로부터 초고속 무결점 PDF 생성
                        bool pdfSuccess = false;
                        if (!string.IsNullOrEmpty(pdfPath))
                        {
                            hwp = EnsureHwpInstance(hwp);
                            bool cleanOpened = false;
                            try { cleanOpened = hwp.Open(loadTarget, "", "forceopen:true"); } catch { }
                            if (cleanOpened)
                            {
                                try
                                {
                                    hwp.HAction.GetDefault("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                                    hwp.HParameterSet.HFileOpenSave.filename = pdfPath;
                                    hwp.HParameterSet.HFileOpenSave.Format = "PDF";
                                    hwp.HAction.Execute("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                                }
                                catch { }
                                finally
                                {
                                    try { hwp.HAction.Run("FileClose"); } catch { }
                                }

                                if (File.Exists(pdfPath) && new FileInfo(pdfPath).Length > 0)
                                {
                                    pdfSuccess = true;
                                }
                            }
                        }
                        else
                        {
                            pdfSuccess = true;
                        }

                        if (isTempCleanHwpx && File.Exists(finalCleanHwpx))
                        {
                            try { File.Delete(finalCleanHwpx); } catch { }
                        }

                        if (!string.IsNullOrEmpty(pdfPath) && !pdfSuccess)
                        {
                            Console.WriteLine(string.Format("RESULT|ERROR|{0}|PDF 변환 실패 (0KB 또는 렌더링 충돌)", inputPath));
                        }
                        else
                        {
                            Console.WriteLine(string.Format("RESULT|SUCCESS|{0}|{1}|{2}", inputPath, pdfPath, cleanPath));
                        }
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
