import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getNotebookLMTokens, uploadMultipleFilesToNotebookLM, cleanupNotebookLMSession } from './notebooklm.js';

const state = {
    selectedFiles: [],
    selectedFolder: '',
    selectionMode: '', // 'file' or 'folder'
    uploadModeEnabled: false,
    uploadQueue: [],
    isUploading: false,
    uploadTotal: 0,
    uploadCurrent: 0,
    convertedCount: 0,
    conversionDone: false,
    retryCounts: {},
    totalUploadSuccess: 0,
    totalUploadFailures: [],
    uploadErrorMsg: null
};

let globalNotebookSession = null;

const UI = {
    btnFile: null,
    btnFolder: null,
    btnStart: null,
    selectedFilesText: null,
    chkLocalSave: null,
    chkUpload: null,
    chkIncludeSub: null,
    chkOpenFolder: null,
    notebookUrlSection: null,
    notebookUrl: null,
    statusTextTotal: null,
    statusTextDetail: null,
    progressFill: null,

    init() {
        this.btnFile = document.getElementById('btn-file');
        this.btnFolder = document.getElementById('btn-folder');
        this.btnStart = document.getElementById('btn-start');
        this.selectedFilesText = document.getElementById('file-status');
        this.chkLocalSave = document.getElementById('chk-local-save');
        this.chkUpload = document.getElementById('chk-upload');
        this.chkIncludeSub = document.getElementById('chk-include-sub');
        this.chkOpenFolder = document.getElementById('chk-open-folder');
        this.notebookUrlSection = document.getElementById('url-input-container');
        this.notebookUrl = document.getElementById('notebook-url');
        this.statusTextTotal = document.querySelector('.status-text-total');
        this.statusTextDetail = document.querySelector('.status-text-detail');
        this.progressFill = document.querySelector('.progress-fill.total');
    },

    getModeSelection() {
        const select = document.getElementById('select-convert-mode');
        return select ? select.value : 'DUAL';
    }
};

function updateSelectedFilesUI() {
    if (state.selectedFiles.length === 0) {
        UI.selectedFilesText.innerText = '선택된 파일이 없습니다.';
    } else {
        const firstFileObj = state.selectedFiles[0];
        const firstFileStr = typeof firstFileObj === 'object' ? firstFileObj.path : firstFileObj;
        const firstFile = firstFileStr.split(/[\\/]/).pop();
        if (state.selectedFiles.length === 1) {
            UI.selectedFilesText.innerText = `📄 ${firstFile}`;
        } else {
            UI.selectedFilesText.innerText = `📄 (총 ${state.selectedFiles.length}개) ${firstFile} 외 ${state.selectedFiles.length - 1}개`;
        }
    }
}

async function selectFiles() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
        multiple: true,
        filters: [{
            name: '지원 문서',
            extensions: ['hwp', 'hwpx', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt']
        }]
    });

    if (selected) {
        const arr = Array.isArray(selected) ? selected : [selected];
        state.selectedFiles = arr.map(f => {
            return { path: f, rootPath: "" };
        });
        state.selectionMode = 'file';
        updateSelectedFilesUI();
    }
}

async function selectFolder() {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
        directory: true,
        multiple: false
    });

    if (selected) {
        state.selectedFolder = selected;
        state.selectionMode = 'folder';
        try {
            const files = await invoke('preview_folder_files', {
                folderPath: selected,
                includeSub: UI.chkIncludeSub ? UI.chkIncludeSub.checked : false
            });
            state.selectedFiles = files.map(f => ({ path: f, rootPath: selected }));
            updateSelectedFilesUI();
        } catch (e) {
            await message(`폴더 파일 목록 조회 실패: ${e}`, { type: 'error' });
        }
    }
}

function toggleNotebookLMUpload() {
    state.uploadModeEnabled = UI.chkUpload.checked;
    if (UI.notebookUrlSection) {
        if (state.uploadModeEnabled) {
            UI.notebookUrlSection.style.display = 'block';
        } else {
            UI.notebookUrlSection.style.display = 'none';
        }
    }
}

async function startConversion() {
    if (state.selectedFiles.length === 0) {
        await message('변환할 문서 파일이나 폴더를 먼저 선택해 주세요.', { type: 'warning' });
        return;
    }

    state.uploadModeEnabled = UI.chkUpload ? UI.chkUpload.checked : false;
    const isLocalSave = UI.chkLocalSave ? UI.chkLocalSave.checked : false;

    if (!state.uploadModeEnabled && !isLocalSave) {
        await message('저장 방식이 선택되지 않았습니다.\n"변환파일 로컬 저장" 또는 "G-Notebook 자동 업로드" 중 최소 하나를 켜주세요.', { type: 'warning', title: '경고' });
        return;
    }

    if (UI.btnStart) {
        UI.btnStart.disabled = true;
        UI.btnStart.style.opacity = '0.5';
    }

    let notebookUrl = '', notebookId = '', authUser = '0', session = null;
    
    if (state.uploadModeEnabled) {
        notebookUrl = UI.notebookUrl.value.trim();
        if (!notebookUrl) {
            await message('G-Notebook URL을 입력해주세요.', { type: 'warning' });
            if (UI.btnStart) { UI.btnStart.disabled = false; UI.btnStart.style.opacity = '1'; }
            return;
        }
        if (!notebookUrl.startsWith('http://') && !notebookUrl.startsWith('https://')) {
            notebookUrl = 'https://' + notebookUrl;
        }
        
        const notebookIdMatch = notebookUrl.match(/\/notebooks?\/([^/?#]+)/);
        if (!notebookIdMatch) {
            await message('URL에서 노트북 ID를 찾을 수 없습니다.', { type: 'error' });
            if (UI.btnStart) { UI.btnStart.disabled = false; UI.btnStart.style.opacity = '1'; }
            return;
        }
        notebookId = notebookIdMatch[1];
        
        const authMatch = notebookUrl.match(/authuser=(\d+)/);
        authUser = authMatch ? authMatch[1] : '0';
        
        if (globalNotebookSession) {
            cleanupNotebookLMSession(globalNotebookSession);
            globalNotebookSession = null;
        }

        if (UI.statusTextTotal) UI.statusTextTotal.innerText = "[1단계] 구글 로그인 세션 연결 중...";
        
        try {
            const parsedUrl = new URL(notebookUrl);
            const authBaseUrl = parsedUrl.origin + '/';
            session = await getNotebookLMTokens(authBaseUrl);
            if (!session || !session.tokens) {
                throw new Error("구글 로그인 취소 또는 토큰 수집 실패");
            }
            session.notebookUrl = notebookUrl;
            globalNotebookSession = session;
        } catch (authError) {
            await message(`구글 로그인 실패로 작업이 중단되었습니다.\n(${authError.message})`, { type: 'warning' });
            if (UI.statusTextTotal) UI.statusTextTotal.innerText = "로그인 실패로 취소됨";
            if (UI.btnStart) { UI.btnStart.disabled = false; UI.btnStart.style.opacity = '1'; }
            return;
        }
    }

    const currentMode = UI.getModeSelection();
    const optimize = document.querySelector('input[name="convertMode"]:checked')?.value === 'B';
    const includeSub = UI.chkIncludeSub.checked;
    const openFolder = UI.chkOpenFolder.checked;

    if (UI.progressFill) UI.progressFill.style.width = '0%';
    if (UI.statusTextTotal) UI.statusTextTotal.innerText = "[2단계] 로컬 문서 정제 및 변환 중...";
    if (UI.statusTextDetail) UI.statusTextDetail.innerText = "";

    let unlistenPdf = null;
    let unlistenMd = null;
    let convertedPdfFiles = [];
    let convertedMdFiles = [];

    try {
        unlistenPdf = await listen('pdf-converted', (e) => {
            convertedPdfFiles.push(e.payload);
            const totalEst = state.selectedFiles.length * (currentMode === "DUAL" ? 2 : 1);
            const count = convertedPdfFiles.length + convertedMdFiles.length;
            if (UI.progressFill && totalEst > 0) {
                UI.progressFill.style.width = Math.min(99, Math.round((count / totalEst) * 100)) + '%';
            }
            if (UI.statusTextDetail) {
                const fileName = e.payload.split(/[\\/]/).pop();
                UI.statusTextDetail.innerText = `⏳ 방금 변환 완료: [PDF] ${fileName}`;
            }
        });
        unlistenMd = await listen('md-converted', (e) => {
            convertedMdFiles.push(e.payload);
            const totalEst = state.selectedFiles.length * (currentMode === "DUAL" ? 2 : 1);
            const count = convertedPdfFiles.length + convertedMdFiles.length;
            if (UI.progressFill && totalEst > 0) {
                UI.progressFill.style.width = Math.min(99, Math.round((count / totalEst) * 100)) + '%';
            }
            if (UI.statusTextDetail) {
                const fileName = e.payload.split(/[\\/]/).pop();
                UI.statusTextDetail.innerText = `⏳ 방금 변환 완료: [MD] ${fileName}`;
            }
        });

        const result = await invoke('process_dual_documents', { 
            files: state.selectedFiles,
            mode: currentMode,
            optimize: optimize,
            localSave: isLocalSave,
            includeSub: includeSub,
            openFolder: openFolder
        });

        if (state.uploadModeEnabled && globalNotebookSession) {
            if (UI.statusTextTotal) UI.statusTextTotal.innerText = `[3단계] 업로드 준비 중 (구글 세션 갱신)...`;
            try {
                const parsedUrl = new URL(globalNotebookSession.notebookUrl);
                const freshSession = await getNotebookLMTokens(parsedUrl.origin + '/');
                if (freshSession && freshSession.tokens) {
                    freshSession.notebookUrl = globalNotebookSession.notebookUrl;
                    globalNotebookSession = freshSession;
                }
            } catch (e) {
                console.log("토큰 갱신 실패, 기존 토큰 사용 시도", e);
            }
            
            let mdUploadFiles = [];
            let pdfUploadFiles = [];

            if (currentMode === "PDF") {
                pdfUploadFiles = result.pdf_paths || convertedPdfFiles;
            } else if (currentMode === "MD") {
                mdUploadFiles = result.md_paths || convertedMdFiles;
            } else {
                pdfUploadFiles = result.pdf_paths || convertedPdfFiles;
                mdUploadFiles = result.md_paths || convertedMdFiles;
            }

            mdUploadFiles = Array.from(new Set(mdUploadFiles.filter(f => Boolean(f))));
            pdfUploadFiles = Array.from(new Set(pdfUploadFiles.filter(f => Boolean(f))));

            if (mdUploadFiles.length === 0 && pdfUploadFiles.length === 0) {
                await message('업로드할 대상 변환 파일이 없습니다.', { type: 'warning' });
            } else {
                if (UI.statusTextDetail) UI.statusTextDetail.innerText = "";
                let totalSummary = "";
                
                try {
                    if (mdUploadFiles.length > 0) {
                        if (UI.statusTextTotal) UI.statusTextTotal.innerText = `[3단계] G-Notebook MD 파일(${mdUploadFiles.length}개) 업로드 중...`;
                        const summary = await uploadMultipleFilesToNotebookLM(mdUploadFiles, globalNotebookSession, notebookId, globalNotebookSession.authUser || authUser);
                        totalSummary += "[MD] " + summary + "\n";
                    }
                    
                    if (pdfUploadFiles.length > 0) {
                        if (UI.statusTextTotal) UI.statusTextTotal.innerText = `[4단계] G-Notebook PDF 파일(${pdfUploadFiles.length}개) 업로드 중...`;
                        const summary = await uploadMultipleFilesToNotebookLM(pdfUploadFiles, globalNotebookSession, notebookId, globalNotebookSession.authUser || authUser);
                        totalSummary += "[PDF] " + summary + "\n";
                    }

                    if (UI.progressFill) UI.progressFill.style.width = '100%';
                    if (UI.statusTextTotal) UI.statusTextTotal.innerText = "업로드 완료";
                    await message(totalSummary.trim(), { type: 'info' });
                } catch(uploadErr) {
                    if (UI.statusTextTotal) UI.statusTextTotal.innerText = "업로드 실패";
                    const prevMsg = totalSummary ? `(이전 성공 결과)\n${totalSummary}\n\n` : '';
                    const errorStr = (uploadErr && uploadErr.message) ? uploadErr.message : String(uploadErr);
                    await invoke('save_error_log', { content: `[G-Notebook Upload Error]\n${prevMsg}${errorStr}` }).catch(() => {});
                    await message(`G-Notebook 업로드 중 오류 발생:\n${prevMsg}${errorStr}\n\n(실행기 폴더의 upload_error_log.txt에 에러가 기록되었습니다)`, { type: 'error' });
                }
            }
        } else {
            if (UI.progressFill) UI.progressFill.style.width = '100%';
            if (UI.statusTextTotal) UI.statusTextTotal.innerText = "준비 완료";
            await message('변환 및 로컬 저장이 완료되었습니다.', { type: 'info' });
        }
    } catch (e) {
        if (UI.statusTextTotal) UI.statusTextTotal.innerText = "오류 발생";
        await invoke('save_error_log', { content: `[General Error]\n${e}` }).catch(() => {});
        await message(`작업 중 오류 발생: ${e}`, { type: 'error' });
    } finally {
        if (unlistenPdf) unlistenPdf();
        if (unlistenMd) unlistenMd();
        if (session) {
            cleanupNotebookLMSession(session);
            if (globalNotebookSession === session) globalNotebookSession = null;
        }
        if (UI.statusTextDetail) UI.statusTextDetail.innerText = "";
        try { await invoke('cleanup_temp_files'); } catch(e) {}
        if (UI.btnStart) {
            UI.btnStart.disabled = false;
            UI.btnStart.style.opacity = '1';
        }
    }
}

const CURRENT_VERSION = 'v1.1.0';

function compareVersions(v1, v2) {
    const clean1 = (v1 || '').replace(/^v/i, '').split('.').map(Number);
    const clean2 = (v2 || '').replace(/^v/i, '').split('.').map(Number);
    const maxLen = Math.max(clean1.length, clean2.length);
    for (let i = 0; i < maxLen; i++) {
        const num1 = clean1[i] || 0;
        const num2 = clean2[i] || 0;
        if (num1 < num2) return -1;
        if (num1 > num2) return 1;
    }
    return 0;
}

async function checkUpdate() {
    const banner = document.getElementById('update-banner');
    const icon = document.getElementById('update-banner-icon');
    const text = document.getElementById('update-banner-text');
    const btnDownload = document.getElementById('btn-update-download');
    const btnClose = document.getElementById('btn-update-close');

    if (!banner || !text || !btnDownload) return;

    if (btnClose) {
        btnClose.onclick = () => banner.classList.add('hidden');
    }

    btnDownload.onclick = async (e) => {
        e.preventDefault();
        try {
            const { open } = await import('@tauri-apps/plugin-shell');
            await open('https://github.com/jc-polar/Hwp-to-MD_Converter/releases/latest');
        } catch (err) {
            window.open('https://github.com/jc-polar/Hwp-to-MD_Converter/releases/latest', '_blank');
        }
    };

    try {
        const response = await fetch('https://api.github.com/repos/jc-polar/Hwp-to-MD_Converter/releases/latest', {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!response.ok) return;

        const data = await response.json();
        const latestTag = data.tag_name;

        if (compareVersions(CURRENT_VERSION, latestTag) < 0) {
            if (icon) icon.innerText = '🚀';
            text.innerText = `새로운 버전(${latestTag})이 출시되었습니다!`;
            btnDownload.innerText = '[최신 버전 다운로드]';
            banner.style.borderColor = 'rgba(59, 130, 246, 0.4)';
            banner.classList.remove('hidden');
        }
    } catch (e) {
        // 조용히 조치 (오프라인 상태 등)
    }
}

function initApp() {
    if (UI.btnFile) UI.btnFile.addEventListener('click', selectFiles);
    if (UI.btnFolder) UI.btnFolder.addEventListener('click', selectFolder);
    if (UI.btnStart) UI.btnStart.addEventListener('click', startConversion);
    if (UI.chkUpload) UI.chkUpload.addEventListener('change', toggleNotebookLMUpload);

    const savedUrl = localStorage.getItem('dual_notebooklm_url');
    if (savedUrl && UI.notebookUrl) {
        UI.notebookUrl.value = savedUrl;
    }
    if (UI.notebookUrl) {
        UI.notebookUrl.addEventListener('input', (e) => {
            localStorage.setItem('dual_notebooklm_url', e.target.value.trim());
        });
    }

    function toggleMdModeSection() {
        const selectMode = document.getElementById('select-convert-mode');
        const mdSection = document.getElementById('md-mode-section');
        if (selectMode && mdSection) {
            if (selectMode.value === 'PDF') {
                mdSection.style.display = 'none';
            } else {
                mdSection.style.display = 'block';
            }
        }
    }

    const selectConvertMode = document.getElementById('select-convert-mode');
    if (selectConvertMode) {
        selectConvertMode.addEventListener('change', toggleMdModeSection);
    }

    toggleNotebookLMUpload();
    toggleMdModeSection();
    checkUpdate();

    document.addEventListener('dragover', (e) => e.preventDefault(), false);
    document.addEventListener('drop', (e) => e.preventDefault(), false);

    async function handleDroppedPaths(paths) {
        if (!paths || paths.length === 0) return;
        let expandedFiles = [];
        let hasFolder = false;
        const includeSub = UI.chkIncludeSub ? UI.chkIncludeSub.checked : false;
        
        for (const path of (Array.isArray(paths) ? paths : [paths])) {
            try {
                const files = await invoke('preview_folder_files', {
                    folderPath: path,
                    includeSub: includeSub
                });
                expandedFiles.push(...files.map(f => ({ path: f, rootPath: path })));
                hasFolder = true;
            } catch (e) {
                expandedFiles.push({ path: path, rootPath: "" });
            }
        }
        
        state.selectedFiles = expandedFiles;
        state.selectionMode = hasFolder ? 'folder' : 'file';
        updateSelectedFilesUI();
    }

    listen('tauri://drag-drop', async (event) => {
        let paths = [];
        if (event.payload && event.payload.paths) {
            paths = event.payload.paths;
        } else if (Array.isArray(event.payload)) {
            paths = event.payload;
        }
        await handleDroppedPaths(paths);
    });

    listen('tauri://file-drop', async (event) => {
        let paths = event.payload;
        await handleDroppedPaths(paths);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    UI.init();
    initApp();
});
