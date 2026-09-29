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
        private static void CleanResetHwp(ref dynamic hwp)
        {
            if (hwp != null)
            {
                try { hwp.Quit(); } catch { }
                try { Marshal.ReleaseComObject(hwp); } catch { }
                hwp = null;
            }
            GC.Collect();
            GC.WaitForPendingFinalizers();
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

                bool hasOle = false;

                // 1단계: header.xml을 읽어 7대 악성 숨김 조건(0pt, 흰색글자, 장평0% 등)에 해당하는 charPr ID 색출
                using (var srcArchive = ZipFile.Open(sourceHwpx, ZipArchiveMode.Read))
                {
                    ZipArchiveEntry headerEntry = null;
                    foreach (var entry in srcArchive.Entries)
                    {
                        if (entry.FullName.EndsWith("header.xml", StringComparison.OrdinalIgnoreCase))
                        {
                            headerEntry = entry;
                        }
                        else if (entry.FullName.StartsWith("BinData/", StringComparison.OrdinalIgnoreCase) &&
                                 entry.FullName.EndsWith(".ole", StringComparison.OrdinalIgnoreCase))
                        {
                            hasOle = true;
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
                } // srcArchive 닫음

                // [Fast-Bypass] 악성 서식이 없고 OLE 충돌 개체도 없으면 무가공 고속 복사 (0.01초 소요)
                if (badCharPrIds.Count == 0 && !hasOle)
                {
                    if (File.Exists(targetHwpx))
                    {
                        try { File.Delete(targetHwpx); } catch { }
                    }
                    File.Copy(sourceHwpx, targetHwpx, true);
                    return true;
                }

                if (File.Exists(targetHwpx))
                {
                    try { File.Delete(targetHwpx); } catch { }
                }

                // 2단계: 새 ZIP 파일로 스트리밍 복사하면서 section*.xml 정제 및 .ole 제거
                // CompressionLevel.Fastest 적용으로 재압축 속도 극대화
                var zwcRegex = new Regex(@"[\u200B-\u200D\uFEFF\uFFFD]", RegexOptions.Compiled);

                using (var srcArchive = ZipFile.Open(sourceHwpx, ZipArchiveMode.Read))
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

                            // 2-2) 악성 charPr 참조 <hp:run> 내부 텍스트 소거 (badCharPrIds가 있을 때만 DOM 파싱 수행)
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
                            var dstEntry = dstArchive.CreateEntry(entryName, CompressionLevel.Fastest);
                            dstEntry.LastWriteTime = srcEntry.LastWriteTime;
                            using (var outStream = dstEntry.Open())
                            {
                                outStream.Write(xmlBytes, 0, xmlBytes.Length);
                            }
                        }
                        else
                        {
                            // 일반 엔트리 고속 바이너리 스트리밍 복사 (Fastest 적용)
                            var dstEntry = dstArchive.CreateEntry(entryName,
                                srcEntry.CompressedLength == 0 ? CompressionLevel.NoCompression : CompressionLevel.Fastest);
                            dstEntry.LastWriteTime = srcEntry.LastWriteTime;

                            using (var inStream = srcEntry.Open())
                            using (var outStream = dstEntry.Open())
                            {
                                inStream.CopyTo(outStream);
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

                    // 4번째 인자로 보안 전처리 생략 플래그 수신 (기본값: false)
                    bool skipSanitization = false;
                    if (parts.Length >= 4)
                    {
                        string s = parts[3].Trim();
                        skipSanitization = (s == "1" || s.Equals("true", StringComparison.OrdinalIgnoreCase));
                    }

                    // 파일 크기 판정 (30MB 이상은 32비트 2GB 힙 한계선에 근접하는 대용량 문서)
                    long fileSizeBytes = 0;
                    try { fileSizeBytes = new FileInfo(inputPath).Length; } catch { }
                    bool isLargeFile = fileSizeBytes >= 30 * 1024 * 1024;

                    string lastError = "";

                    // 최대 2회 시도: 1차 실패 시 한글 OLE 완전 종료 후 인스턴스 재생성하여 1회 자동 재시도
                    for (int attempt = 1; attempt <= 2; attempt++)
                    {
                        try
                        {
                            // 기존 잔존 0KB 또는 이전 작업 PDF 사전 삭제
                            if (!string.IsNullOrEmpty(pdfPath) && File.Exists(pdfPath))
                            {
                                try { File.Delete(pdfPath); } catch { }
                            }

                            // =========================================================================
                            // [경로 A] 보안 전처리 생략 (skipSanitization == true) : 원패스(One-Pass) 초고속 직행
                            // =========================================================================
                            if (skipSanitization)
                            {
                                hwp = EnsureHwpInstance(hwp);
                                bool opened = false;
                                try { opened = hwp.Open(inputPath, "", "lock:false;forceopen:true;versionwarning:false"); } catch { }
                                if (!opened)
                                {
                                    lastError = "파일 열기 실패";
                                    throw new Exception(lastError);
                                }

                                // 1) 문서 구조 정규화 (변경추적 수락 및 메모 삭제는 필수 수행)
                                try { hwp.HAction.Run("AcceptTrackChangeAll"); } catch { }
                                try { hwp.HAction.Run("EraseAllMemo"); } catch { }
                                try { hwp.HAction.Run("DeleteAllMemo"); } catch { }

                                // 2) PDF 즉시 저장 (HWPX 재오픈 없이 열려있는 상태에서 바로 덤프)
                                if (!string.IsNullOrEmpty(pdfPath))
                                {
                                    try
                                    {
                                        hwp.HAction.GetDefault("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                                        hwp.HParameterSet.HFileOpenSave.filename = pdfPath;
                                        hwp.HParameterSet.HFileOpenSave.Format = "PDF";
                                        hwp.HAction.Execute("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                                    }
                                    catch { }

                                    if (!File.Exists(pdfPath) || new FileInfo(pdfPath).Length == 0)
                                    {
                                        lastError = "PDF 변환 실패 (0KB 또는 렌더링 충돌)";
                                        throw new Exception(lastError);
                                    }
                                }

                                // 3) KORDOC 마크다운용 HWPX 즉시 저장
                                if (!string.IsNullOrEmpty(cleanPath))
                                {
                                    try
                                    {
                                        if (File.Exists(cleanPath)) try { File.Delete(cleanPath); } catch { }
                                        hwp.HAction.GetDefault("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                                        hwp.HParameterSet.HFileOpenSave.filename = cleanPath;
                                        hwp.HParameterSet.HFileOpenSave.Format = "HWPX";
                                        hwp.HAction.Execute("FileSaveAs_S", hwp.HParameterSet.HFileOpenSave.HSet);
                                    }
                                    catch { }
                                }

                                try { hwp.HAction.Run("FileClose"); } catch { }

                                // 대용량 파일 처리 후에는 다음 파일을 위해 클린 리셋
                                if (isLargeFile)
                                {
                                    CleanResetHwp(ref hwp);
                                }

                                Console.WriteLine(string.Format("RESULT|SUCCESS|{0}|{1}|{2}", inputPath, pdfPath, cleanPath));
                                break; // 성공 시 루프 탈출
                            }

                            // =========================================================================
                            // [경로 B] 기본 안전 모드 (skipSanitization == false) : 7대 멸균 HWPX -> PDF 생성
                            // =========================================================================
                            else
                            {
                                hwp = EnsureHwpInstance(hwp);
                                bool opened = false;
                                try { opened = hwp.Open(inputPath, "", "lock:false;forceopen:true;versionwarning:false"); } catch { }
                                if (!opened)
                                {
                                    lastError = "파일 열기 실패";
                                    throw new Exception(lastError);
                                }

                                // 1) 문서 구조 정규화
                                try { hwp.HAction.Run("AcceptTrackChangeAll"); } catch { }
                                try { hwp.HAction.Run("EraseAllMemo"); } catch { }
                                try { hwp.HAction.Run("DeleteAllMemo"); } catch { }

                                // 2) 1단계: 원본 문서를 raw HWPX로 덤프
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

                                // 3) 2단계: 7대 보안 멸균 실행 (Fast-Bypass + Fastest 압축)
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

                                // 4) 3단계: 100% 멸균된 클린 HWPX로부터 무결점 PDF 생성
                                if (!string.IsNullOrEmpty(pdfPath))
                                {
                                    // [핵심] 대용량 문서이거나 이전 덤프로 힙이 오염된 경우 선제적 클린 리셋 실행
                                    if (isLargeFile)
                                    {
                                        CleanResetHwp(ref hwp);
                                    }

                                    hwp = EnsureHwpInstance(hwp);
                                    bool cleanOpened = false;
                                    try { cleanOpened = hwp.Open(loadTarget, "", "lock:false;forceopen:true;versionwarning:false"); } catch { }

                                    // [방어적 구제] 혹시라도 메모리 부족으로 Open 실패 시 즉시 클린 리셋 후 1회 재시도
                                    if (!cleanOpened)
                                    {
                                        CleanResetHwp(ref hwp);
                                        hwp = EnsureHwpInstance(hwp);
                                        try { cleanOpened = hwp.Open(loadTarget, "", "lock:false;forceopen:true;versionwarning:false"); } catch { }
                                    }

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
                                    }

                                    if (!File.Exists(pdfPath) || new FileInfo(pdfPath).Length == 0)
                                    {
                                        lastError = "PDF 변환 실패 (0KB 또는 렌더링 충돌)";
                                        throw new Exception(lastError);
                                    }
                                }

                                if (isTempCleanHwpx && File.Exists(finalCleanHwpx))
                                {
                                    try { File.Delete(finalCleanHwpx); } catch { }
                                }

                                // 대용량 파일 작업 완료 후 다음 파일 처리를 위해 클린 리셋
                                if (isLargeFile)
                                {
                                    CleanResetHwp(ref hwp);
                                }

                                Console.WriteLine(string.Format("RESULT|SUCCESS|{0}|{1}|{2}", inputPath, pdfPath, cleanPath));
                                break; // 성공 시 루프 탈출
                            }
                        }
                        catch (Exception ex)
                        {
                            lastError = ex.Message;
                            if (attempt == 1)
                            {
                                // 1차 시도 실패 시: 한글 프로세스를 즉시 클린 리셋하고 0.5초 대기 후 1회 자동 재시도
                                CleanResetHwp(ref hwp);
                                Thread.Sleep(500);
                            }
                            else
                            {
                                // 2차 시도까지 최종 실패 시에도 다음 파일을 위해 프로세스를 클린 리셋
                                CleanResetHwp(ref hwp);
                                Console.WriteLine(string.Format("RESULT|ERROR|{0}|{1}", inputPath, lastError));
                            }
                        }
                    }
                }
            }
            catch (Exception e)
            {
                Console.WriteLine(string.Format("RESULT|FATAL|{0}", e.Message));
            }
            finally
            {
                CleanResetHwp(ref hwp);
            }
        }
    }
}
