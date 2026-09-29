import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { uploadScriptTemplate } from './notebooklm_inject.js';

function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export async function getNotebookLMTokens(url) {
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
        url = 'https://' + url;
    }
    let targetHostname = '';
    try {
        targetHostname = new URL(url).hostname.replace(/^www\./, '');
    } catch(e) {
        throw new Error("유효하지 않은 G-Notebook URL입니다.");
    }

    return new Promise(async (resolve) => {
        const uniqueLabel = `authWindow_${Date.now()}`;
        const webview = new WebviewWindow(uniqueLabel, {
            url: url,
            visible: true, 
            width: 540,
            height: 640,
            title: "Gemini Notebook 구글 로그인"
        });

        try {
            await webview.show();
            await webview.setFocus();
        } catch(e) {}

        let extractScript = `(function() {
    const target = '${targetHostname}';
    if (!target) return;
    if (!window.location.hostname.endsWith(target)) return;
    if (document.title.includes('#TOKENS:')) return;
    try {
        let at = null;
        let bl = null;
        let au = new URLSearchParams(window.location.search).get('authuser') || '0';

        if (window.WIZ_global_data) {
            at = window.WIZ_global_data.SNlM0e || window.WIZ_global_data['SNlM0e'];
            bl = window.WIZ_global_data.cfb2h || window.WIZ_global_data['cfb2h'];
        }

        if (!at || !bl) {
            const scripts = document.getElementsByTagName('script');
            for (let i = 0; i < scripts.length; i++) {
                const text = scripts[i].textContent || '';
                if (!at && text.includes('SNlM0e')) {
                    const mAt = text.match(/SNlM0e["'\\s:,=\\[\\]]+([a-zA-Z0-9_\\-]{15,})/);
                    if (mAt) at = mAt[1];
                }
                if (!bl && text.includes('cfb2h')) {
                    const mBl = text.match(/cfb2h["'\\s:,=\\[\\]]+([a-zA-Z0-9_\\-]{15,})/);
                    if (mBl) bl = mBl[1];
                }
                if (at && bl) break;
            }
        }

        if (at && !bl) {
            bl = 'boq_labs-tailwind-ui_20250101.00_p0';
        }

        if (at) {
            window.location.hash = '#TOKENS:at=' + encodeURIComponent(at) + '&bl=' + encodeURIComponent(bl) + '&au=' + encodeURIComponent(au);
        }
    } catch(e) {}
})();`;

        let checkInterval;
        let timeoutId;
        setTimeout(() => {
            checkInterval = setInterval(async () => {
                try {
                    const currentUrl = await invoke('get_webview_url', { label: uniqueLabel });
                    const statusEl = document.querySelector('.status-text-total');
                    if (statusEl && !currentUrl.includes('#TOKENS:')) statusEl.innerText = `[1/3] 구글 로그인 세션 연결 중...`;
                    
                    if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin') || currentUrl.includes('ServiceLogin')) {
                        try { await webview.show(); await webview.setFocus(); } catch(e) {}
                    }

                    await invoke('eval_in_webview', { label: uniqueLabel, script: extractScript });
                    
                    const hashParams = currentUrl.split('#TOKENS:')[1];
                    if (hashParams) {
                        clearInterval(checkInterval);
                        clearTimeout(timeoutId);
                        try { await invoke('hide_webview', { label: uniqueLabel }); } catch(e) {}
                        const params = new URLSearchParams(hashParams);
                        const extractedAt = params.get('at') || '';
                        const extractedBl = params.get('bl') || '';
                        const extractedAu = params.get('au') || '0';
                        await invoke('eval_in_webview', { label: uniqueLabel, script: "window.location.hash = '';" });
                        resolve({ tokens: { at: extractedAt, bl: extractedBl }, authUser: extractedAu, webview, label: uniqueLabel });
                    }
                } catch(e) {}
            }, 300);

            timeoutId = setTimeout(() => {
                clearInterval(checkInterval);
                try { invoke('close_webview', { label: uniqueLabel }); } catch(e) {}
                resolve(null);
            }, 300000);
        }, 500);
        
        webview.once('tauri://error', async function (e) {
            clearTimeout(timeoutId);
            resolve(null);
        });
    });
}

export async function uploadSingleFileToNotebookLM(path, session, notebookId, authUser, onProgress) {
    return uploadMultipleFilesToNotebookLM([path], session, notebookId, authUser, onProgress);
}

export async function uploadMultipleFilesToNotebookLM(paths, session, notebookId, authUser, onProgress) {
    if (!paths || paths.length === 0) return;
    const { tokens, label: webviewLabel } = session;
    // reset hash before injection
    await invoke('eval_in_webview', { label: webviewLabel, script: "window.location.hash = '#UPLOADING';" });

    const baseConfig = JSON.stringify({ notebookId, authUser, files: [], tokens }).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
    await invoke('eval_in_webview', { label: webviewLabel, script: 'window.__UPLOAD_CONFIG = ' + baseConfig + ';' });

    // Read and push files one by one to avoid IPC payload limits and V8 string limits
    for (let fIdx = 0; fIdx < paths.length; fIdx++) {
        const path = paths[fIdx];
        const fileName = path.split(/[\\/]/).pop();
        const fileDataBase64 = await invoke('read_file_base64', { path: path });
        
        const fileObjStr = JSON.stringify({ fileName, fileDataBase64 }).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
        await invoke('eval_in_webview', { label: webviewLabel, script: `window.__UPLOAD_CONFIG.files.push(${fileObjStr});` });
        if (onProgress && paths.length > 20 && (fIdx % 10 === 0 || fIdx === paths.length - 1)) {
            onProgress(0, paths.length, `전송 준비 중 (${fIdx + 1}/${paths.length})...`);
        }
    }
    await invoke('eval_in_webview', { label: webviewLabel, script: uploadScriptTemplate });
    
    let lastActivityTime = Date.now();
    let lastReportedDone = 0;
    const IDLE_TIMEOUT_MS = 60000; // 60초 동안 구글 서버/웹뷰 응답이나 진행이 전혀 없을 때만 타임아웃
    const MAX_TOTAL_TIME_MS = Math.max(1800000, paths.length * 60000); // 파일 개수에 비례하는 넉넉한 전체 제한 (최소 30분)
    const startTime = Date.now();
    
    while (Date.now() - startTime < MAX_TOTAL_TIME_MS) {
        await new Promise(r => setTimeout(r, 300));
        
        try {
            await invoke('eval_in_webview', { 
                label: webviewLabel, 
                script: "if (window.__UPLOAD_ERROR) window.location.hash = '#ERROR:' + encodeURIComponent(window.__UPLOAD_ERROR); else if (window.__UPLOAD_SUCCESS) window.location.hash = '#SUCCESS:' + encodeURIComponent(window.__UPLOAD_SUMMARY || 'ok'); else if (window.__UPLOAD_PROGRESS) { var p = window.__UPLOAD_PROGRESS; var act = window.__UPLOAD_LAST_ACTIVITY || Date.now(); window.location.hash = '#PROGRESS:' + p.done + ':' + p.total + ':' + act + ':' + encodeURIComponent(p.currentFile || ''); }" 
            });
        } catch(e) {
            throw new Error(`웹뷰 통신 실패 또는 브라우저 종료 (${e})`);
        }

        const currentUrl = await invoke('get_webview_url', { label: webviewLabel });
        if (currentUrl.includes('#SUCCESS:')) {
            const summary = decodeURIComponent(currentUrl.split('#SUCCESS:')[1] || '');
            await invoke('eval_in_webview', { label: webviewLabel, script: "window.location.hash = ''; window.__UPLOAD_SUCCESS = false;" });
            return summary;
        } else if (currentUrl.includes('#SUCCESS')) {
            await invoke('eval_in_webview', { label: webviewLabel, script: "window.location.hash = ''; window.__UPLOAD_SUCCESS = false;" });
            return "업로드 완료";
        } else if (currentUrl.includes('#ERROR:')) {
            throw new Error(decodeURIComponent(currentUrl.split('#ERROR:')[1]));
        } else if (currentUrl.includes('#PROGRESS:')) {
            const progressData = currentUrl.split('#PROGRESS:')[1];
            const parts = progressData.split(':');
            const done = parseInt(parts[0], 10) || 0;
            const total = parseInt(parts[1], 10) || paths.length;
            const remoteLastAct = parseInt(parts[2], 10) || 0;
            const curFile = decodeURIComponent(parts.slice(3).join(':') || '');
            
            if (done > lastReportedDone || remoteLastAct > lastActivityTime) {
                lastActivityTime = Math.max(Date.now(), remoteLastAct);
                lastReportedDone = done;
            }
            
            if (onProgress) {
                onProgress(done, total, curFile);
            }
        }

        // 60초 이상 아무런 활동이나 진행이 없으면 Idle Timeout 발생
        if (Date.now() - lastActivityTime > IDLE_TIMEOUT_MS) {
            throw new Error(`업로드 중단 (60초 동안 구글 서버 응답 없음 - ${lastReportedDone}/${paths.length}개 완료 시점)`);
        }
    }

    throw new Error(`업로드 전체 제한시간 초과 (${paths.length}개 파일, ${Math.round(MAX_TOTAL_TIME_MS / 60000)}분 경과)`);
}

export async function cleanupNotebookLMSession(session) {
    if (session && session.label) {
        try { await invoke('close_webview', { label: session.label }); } catch(e) {}
    }
}
