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

export async function uploadSingleFileToNotebookLM(path, session, notebookId, authUser) {
    return uploadMultipleFilesToNotebookLM([path], session, notebookId, authUser);
}

export async function uploadMultipleFilesToNotebookLM(paths, session, notebookId, authUser) {
    if (!paths || paths.length === 0) return;
    const { tokens, label: webviewLabel } = session;
    // reset hash before injection
    await invoke('eval_in_webview', { label: webviewLabel, script: "window.location.hash = '#UPLOADING';" });

    const baseConfig = JSON.stringify({ notebookId, authUser, files: [], tokens }).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
    await invoke('eval_in_webview', { label: webviewLabel, script: 'window.__UPLOAD_CONFIG = ' + baseConfig + ';' });

    // Read and push files one by one to avoid IPC payload limits and V8 string limits
    for (const path of paths) {
        const fileName = path.split(/[\\/]/).pop();
        const fileDataBase64 = await invoke('read_file_base64', { path: path });
        
        const fileObjStr = JSON.stringify({ fileName, fileDataBase64 }).replace(/[\u007f-\uffff]/g, c => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
        await invoke('eval_in_webview', { label: webviewLabel, script: `window.__UPLOAD_CONFIG.files.push(${fileObjStr});` });
    }
    await invoke('eval_in_webview', { label: webviewLabel, script: uploadScriptTemplate });
    
    let success = false;
    for (let i = 0; i < 600; i++) {
        await new Promise(r => setTimeout(r, 300));
        await invoke('eval_in_webview', { 
            label: webviewLabel, 
            script: "if (window.__UPLOAD_ERROR) window.location.hash = '#ERROR:' + encodeURIComponent(window.__UPLOAD_ERROR); else if (window.__UPLOAD_SUCCESS) window.location.hash = '#SUCCESS:' + encodeURIComponent(window.__UPLOAD_SUMMARY || 'ok');" 
        });
        const currentUrl = await invoke('get_webview_url', { label: webviewLabel });
        if (currentUrl.includes('#SUCCESS:')) {
            success = true;
            const summary = decodeURIComponent(currentUrl.split('#SUCCESS:')[1] || '');
            await invoke('eval_in_webview', { label: webviewLabel, script: "window.location.hash = ''; window.__UPLOAD_SUCCESS = false;" });
            return summary;
        } else if (currentUrl.includes('#SUCCESS')) {
            success = true;
            await invoke('eval_in_webview', { label: webviewLabel, script: "window.location.hash = ''; window.__UPLOAD_SUCCESS = false;" });
            break;
        } else if (currentUrl.includes('#ERROR:')) {
            throw new Error(decodeURIComponent(currentUrl.split('#ERROR:')[1]));
        }
    }
    if (!success) throw new Error(`upload timeout (${paths.length} files)`);
}

export async function cleanupNotebookLMSession(session) {
    if (session && session.label) {
        try { await invoke('close_webview', { label: session.label }); } catch(e) {}
    }
}
