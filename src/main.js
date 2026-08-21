import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getNotebookLMTokens, uploadMultipleFilesToNotebookLM, cleanupNotebookLMSession } from './notebooklm.js';

const state = {
    selectedFiles: [],
    selectedFolder: '',
    selectionMode: '', // 'file' or 'folder'
    accumulateMode: false, // '담기' 모드 (기본값: false, 꺼짐)
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

const SUPPORTED_EXTS = new Set(['hwp', 'hwpx', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt']);

function isSupportedFile(path) {
    if (!path) return false;
    const ext = path.split('.').pop().toLowerCase();
    return SUPPORTED_EXTS.has(ext);
}

const UI = {
    btnFile: null,
    btnFolder: null,
    btnStart: null,
    fileListContainer: null,
    fileCountBadge: null,
    btnToggleAccumulate: null,
    btnClearFiles: null,
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
        this.fileListContainer = document.getElementById('file-list-container');
        this.fileCountBadge = document.getElementById('file-count-badge');
        this.btnToggleAccumulate = document.getElementById('btn-toggle-accumulate');
        this.btnClearFiles = document.getElementById('btn-clear-files');
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

function toggleAccumulateMode() {
    state.accumulateMode = !state.accumulateMode;
    if (UI.btnToggleAccumulate) {
        if (state.accumulateMode) {
            UI.btnToggleAccumulate.innerText = '📥 담기: ON';
            UI.btnToggleAccumulate.classList.add('active');
            UI.btnToggleAccumulate.title = '담기 ON: 새 파일을 넣으면 기존 목록에 누적 추가됩니다.';
        } else {
            UI.btnToggleAccumulate.innerText = '📥 담기: OFF';
            UI.btnToggleAccumulate.classList.remove('active');
            UI.btnToggleAccumulate.title = '담기 OFF: 새 파일을 넣으면 이전 목록이 지워지고 교체됩니다.';
        }
    }
}

function updateSelectedFilesUI() {
    if (!UI.fileListContainer || !UI.fileCountBadge) return;

    const count = state.selectedFiles.length;
    UI.fileCountBadge.innerText = `대기 문서: ${count}개`;

    if (count === 0) {
        UI.fileListContainer.classList.add('empty');
        UI.fileListContainer.innerHTML = `
            <div class="file-list-placeholder">
                <span>문서나 폴더를 이곳에 드래그하거나<br>폴더 선택 또는 파일 선택 버튼을 눌러 추가하세요.</span>
            </div>
        `;
    } else {
        UI.fileListContainer.classList.remove('empty');
        UI.fileListContainer.innerHTML = '';

        state.selectedFiles.forEach((fileObj, idx) => {
            const filePath = typeof fileObj === 'object' ? fileObj.path : fileObj;
            const fileName = filePath.split(/[\\/]/).pop();
            const ext = fileName.split('.').pop().toLowerCase();

            let icon = '📄';
            if (ext === 'pdf') icon = '📕';
            else if (ext === 'hwp' || ext === 'hwpx') icon = '📝';
            else if (ext === 'xls' || ext === 'xlsx') icon = '📊';

            const itemEl = document.createElement('div');
            itemEl.className = 'file-item';
            itemEl.title = filePath;

            const leftEl = document.createElement('div');
            leftEl.className = 'file-item-left';

            const iconEl = document.createElement('span');
            iconEl.className = 'file-item-icon';
            iconEl.innerText = icon;

            const nameEl = document.createElement('span');
            nameEl.className = 'file-item-name';
            nameEl.innerText = fileName;

            leftEl.appendChild(iconEl);
            leftEl.appendChild(nameEl);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'file-item-remove';
            removeBtn.setAttribute('title', '이 파일 목록에서 제외');
            removeBtn.innerHTML = '&times;';
            removeBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                removeFile(idx);
            });

            itemEl.appendChild(leftEl);
            itemEl.appendChild(removeBtn);
            UI.fileListContainer.appendChild(itemEl);
        });
    }
}

function appendFiles(filesToAdd) {
    if (!filesToAdd || filesToAdd.length === 0) return;

    // 담기(accumulateMode)가 꺼져 있으면 기존 목록 비우고 새로 교체
    if (!state.accumulateMode) {
        state.selectedFiles = [];
    }

    const existingPaths = new Set(state.selectedFiles.map(f => (typeof f === 'object' ? f.path : f)));
    let addedCount = 0;

    for (const item of filesToAdd) {
        const filePath = typeof item === 'object' ? item.path : item;
        const rootPath = typeof item === 'object' ? (item.rootPath || "") : "";

        if (!filePath || !isSupportedFile(filePath)) continue;
        if (existingPaths.has(filePath)) continue;

        existingPaths.add(filePath);
        state.selectedFiles.push({ path: filePath, rootPath: rootPath });
        addedCount++;
    }

    updateSelectedFilesUI();
}

function removeFile(index) {
    if (index >= 0 && index < state.selectedFiles.length) {
        state.selectedFiles.splice(index, 1);
        updateSelectedFilesUI();
    }
}

function clearFiles() {
    state.selectedFiles = [];
    state.selectedFolder = '';
    state.selectionMode = '';
    updateSelectedFilesUI();
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
        appendFiles(arr.map(f => ({ path: f, rootPath: "" })));
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
        try {
            const files = await invoke('preview_folder_files', {
                folderPath: selected,
                includeSub: UI.chkIncludeSub ? UI.chkIncludeSub.checked : false
            });
            if (files && files.length > 0) {
                appendFiles(files.map(f => ({ path: f, rootPath: selected })));
            } else {
                await message('선택한 폴더에 지원하는 문서 파일이 없습니다.', { type: 'info' });
            }
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

function setInteractionDisabled(disabled) {
    if (UI.btnFile) {
        UI.btnFile.disabled = disabled;
        UI.btnFile.style.opacity = disabled ? '0.6' : '1';
    }
    if (UI.btnFolder) {
        UI.btnFolder.disabled = disabled;
        UI.btnFolder.style.opacity = disabled ? '0.6' : '1';
    }
    if (UI.btnToggleAccumulate) {
        UI.btnToggleAccumulate.disabled = disabled;
        UI.btnToggleAccumulate.style.opacity = disabled ? '0.6' : '1';
    }
    if (UI.btnClearFiles) {
        UI.btnClearFiles.disabled = disabled;
        UI.btnClearFiles.style.opacity = disabled ? '0.6' : '1';
    }
    const removeButtons = document.querySelectorAll('.file-item-remove');
    removeButtons.forEach(btn => {
        btn.disabled = disabled;
        btn.style.pointerEvents = disabled ? 'none' : 'auto';
    });
}

async function startConversion() {
    if (state.selectedFiles.length === 0) {
        await message('변환할 문서 파일이나 폴더를 먼저 선택해 주세요.', { type: 'warning' });
        return;
    }

    const currentMode = UI.getModeSelection();

    let hwpCount = 0;
    let nonHwpCount = 0;
    state.selectedFiles.forEach(f => {
        const p = typeof f === 'object' ? f.path : f;
        const ext = (p.split('.').pop() || '').toLowerCase();
        if (ext === 'hwp' || ext === 'hwpx') {
            hwpCount++;
        } else {
            nonHwpCount++;
        }
    });

    if (currentMode === 'PDF' && hwpCount === 0) {
        await message('선택된 파일 중 PDF 변환을 지원하는 한글 문서(HWP/HWPX)가 없습니다.\n\n💡 엑셀, 워드, 텍스트 문서는 [MD 전용 변환] 또는 [통합 변환]을 이용해 주세요.', { 
            type: 'warning', 
            title: 'PDF 변환 대상 없음' 
        });
        return;
    }

    state.uploadModeEnabled = UI.chkUpload ? UI.chkUpload.checked : false;
    const isLocalSave = UI.chkLocalSave ? UI.chkLocalSave.checked : false;

    if (!state.uploadModeEnabled && !isLocalSave) {
        await message('저장 방식이 선택되지 않았습니다.\n"변환파일 로컬 저장" 또는 "G-Notebook 자동 업로드" 중 최소 하나를켜주세요.', { type: 'warning', title: '경고' });
        return;
    }

    if (UI.btnStart) {
        UI.btnStart.disabled = true;
        UI.btnStart.style.opacity = '0.5';
    }
    setInteractionDisabled(true);

    let notebookUrl = '', notebookId = '', authUser = '0', session = null;
    
    if (state.uploadModeEnabled) {
        notebookUrl = UI.notebookUrl.value.trim();
        if (!notebookUrl) {
            await message('G-Notebook URL을 입력해주세요.', { type: 'warning' });
            if (UI.btnStart) { UI.btnStart.disabled = false; UI.btnStart.style.opacity = '1'; }
            setInteractionDisabled(false);
            return;
        }
        if (!notebookUrl.startsWith('http://') && !notebookUrl.startsWith('https://')) {
            notebookUrl = 'https://' + notebookUrl;
        }
        
        const notebookIdMatch = notebookUrl.match(/\/notebooks?\/([^/?#]+)/);
        if (!notebookIdMatch) {
            await message('URL에서 노트북 ID를 찾을 수 없습니다.', { type: 'error' });
            if (UI.btnStart) { UI.btnStart.disabled = false; UI.btnStart.style.opacity = '1'; }
            setInteractionDisabled(false);
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
            setInteractionDisabled(false);
            return;
        }
    }

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
                state.selectedFiles.forEach(f => {
                    const p = typeof f === 'object' ? f.path : f;
                    const ext = (p.split('.').pop() || '').toLowerCase();
                    if (ext === 'pdf') pdfUploadFiles.push(p);
                });
            } else if (currentMode === "MD") {
                mdUploadFiles = result.md_paths || convertedMdFiles;
            } else {
                pdfUploadFiles = result.pdf_paths || convertedPdfFiles;
                mdUploadFiles = result.md_paths || convertedMdFiles;
                
                // DUAL(통합) 모드: 입력 파일 중 이미 PDF였던 원본 문서도 PDF 업로드 큐에 포함!
                state.selectedFiles.forEach(f => {
                    const p = typeof f === 'object' ? f.path : f;
                    const ext = (p.split('.').pop() || '').toLowerCase();
                    if (ext === 'pdf') pdfUploadFiles.push(p);
                });
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
                    
                    let finalUploadMsg = totalSummary.trim();
                    if (currentMode === "DUAL" && nonHwpCount > 0) {
                        finalUploadMsg += `\n\n💡 안내: PDF 변환은 한글(HWP/HWPX) 문서만 지원되어, 엑셀/워드/텍스트(${nonHwpCount}개)는 MD로만 변환되었습니다.`;
                    } else if (currentMode === "PDF" && nonHwpCount > 0) {
                        finalUploadMsg += `\n\n💡 안내: PDF 변환은 한글(HWP/HWPX) 문서만 지원되어, 엑셀/워드/텍스트(${nonHwpCount}개)는 변환 대상에서 제외되었습니다.`;
                    }
                    await message(finalUploadMsg, { type: 'info', title: '업로드 완료' });
                    clearFiles();
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
            
            let localCompleteMsg = '변환 및 로컬 저장이 완료되었습니다.';
            if (currentMode === "DUAL" && nonHwpCount > 0) {
                localCompleteMsg += `\n\n💡 안내: PDF 변환은 한글(HWP/HWPX) 문서만 지원되어, 엑셀/워드/텍스트(${nonHwpCount}개)는 MD로만 변환되었습니다.`;
            } else if (currentMode === "PDF" && nonHwpCount > 0) {
                localCompleteMsg += `\n\n💡 안내: PDF 변환은 한글(HWP/HWPX) 문서만 지원되어, 엑셀/워드/텍스트(${nonHwpCount}개)는 변환 대상에서 제외되었습니다.`;
            }
            await message(localCompleteMsg, { type: 'info', title: '변환 완료' });
            clearFiles();
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
        setInteractionDisabled(false);
        if (UI.btnStart) {
            UI.btnStart.disabled = false;
            UI.btnStart.style.opacity = '1';
        }
    }
}

const CURRENT_VERSION = 'v1.1.2';

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
    if (UI.btnToggleAccumulate) UI.btnToggleAccumulate.addEventListener('click', toggleAccumulateMode);
    if (UI.btnClearFiles) UI.btnClearFiles.addEventListener('click', clearFiles);
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

    async function handlePasteEvent(e) {
        if (e && e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            return;
        }
        try {
            const files = await invoke('get_clipboard_files');
            if (files && files.length > 0) {
                await handleDroppedPaths(files);
            }
        } catch (err) {
            console.log('클립보드 파일 읽기 실패:', err);
        }
    }

    window.addEventListener('paste', handlePasteEvent);
    window.addEventListener('keydown', async (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
            await handlePasteEvent(e);
        }
    });

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

    let dragCounter = 0;
    const dropOverlay = document.getElementById('drop-zone-overlay');

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        dragCounter++;
        if (dropOverlay) dropOverlay.classList.add('active');
    });

    window.addEventListener('dragover', (e) => e.preventDefault(), false);

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter <= 0) {
            dragCounter = 0;
            if (dropOverlay) dropOverlay.classList.remove('active');
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dragCounter = 0;
        if (dropOverlay) dropOverlay.classList.remove('active');
    }, false);

    listen('tauri://drag-enter', () => {
        if (dropOverlay) dropOverlay.classList.add('active');
    });

    listen('tauri://drag-leave', () => {
        if (dropOverlay) dropOverlay.classList.remove('active');
    });

    async function handleDroppedPaths(paths) {
        if (!paths || paths.length === 0) return;
        let filesToAdd = [];
        const includeSub = UI.chkIncludeSub ? UI.chkIncludeSub.checked : false;
        
        for (const path of (Array.isArray(paths) ? paths : [paths])) {
            try {
                const files = await invoke('preview_folder_files', {
                    folderPath: path,
                    includeSub: includeSub
                });
                if (files && files.length > 0) {
                    filesToAdd.push(...files.map(f => ({ path: f, rootPath: path })));
                }
            } catch (e) {
                filesToAdd.push({ path: path, rootPath: "" });
            }
        }
        
        appendFiles(filesToAdd);
    }

    listen('tauri://drag-drop', async (event) => {
        if (dropOverlay) dropOverlay.classList.remove('active');
        dragCounter = 0;
        let paths = [];
        if (event.payload && event.payload.paths) {
            paths = event.payload.paths;
        } else if (Array.isArray(event.payload)) {
            paths = event.payload;
        }
        await handleDroppedPaths(paths);
    });

    listen('tauri://file-drop', async (event) => {
        if (dropOverlay) dropOverlay.classList.remove('active');
        dragCounter = 0;
        let paths = event.payload;
        await handleDroppedPaths(paths);
    });

    listen('single-instance-args', async (event) => {
        if (event.payload && Array.isArray(event.payload) && event.payload.length > 0) {
            await handleDroppedPaths(event.payload);
        }
    });
}

document.addEventListener('DOMContentLoaded', () => {
    UI.init();
    initApp();
});
