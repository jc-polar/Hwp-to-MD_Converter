export const uploadScriptTemplate = `
(async function() {
    function base64ToUint8Array(base64) {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes;
    }

    try {
        const notebookId = window.__UPLOAD_CONFIG.notebookId;
        const authUser = window.__UPLOAD_CONFIG.authUser;
        const at = window.__UPLOAD_CONFIG.tokens.at;
        const bl = window.__UPLOAD_CONFIG.tokens.bl;
        const files = window.__UPLOAD_CONFIG.files;

        if (!at || at.length < 5) throw new Error("보안 토큰(at) 누락/비정상: " + at);
        if (!bl || bl.length < 5) throw new Error("빌드 토큰(bl) 누락/비정상: " + bl);
        async function safeFetch(url, options, retries = 3) {
            for (let i = 0; i < retries; i++) {
                try {
                    return await new Promise((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.open(options.method || 'GET', url, true);
                        if (options.credentials === 'include') xhr.withCredentials = true;
                        if (options.headers) {
                            for (const key in options.headers) {
                                xhr.setRequestHeader(key, options.headers[key]);
                            }
                        }
                        xhr.onload = () => {
                            resolve({
                                ok: xhr.status >= 200 && xhr.status < 300,
                                status: xhr.status,
                                text: () => Promise.resolve(xhr.responseText),
                                headers: {
                                    get: (name) => {
                                        const val = xhr.getResponseHeader(name);
                                        return val ? val : null;
                                    }
                                }
                            });
                        };
                        xhr.onerror = () => reject(new Error('XHR Network Error: status ' + xhr.status + ', state ' + xhr.readyState + ' on ' + url));
                        
                        let bodyData = options.body;
                        if (bodyData instanceof URLSearchParams) {
                            bodyData = bodyData.toString();
                        }
                        xhr.send(bodyData || null);
                    });
                } catch (e) {
                    if (i === retries - 1) throw e;
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }
        
        // 페이지가 완전히 로드되고 SPA 네비게이션이 끝날 때까지 2초 대기
        await new Promise(r => setTimeout(r, 2000));
        
        window.__UPLOAD_STEP = '1_rLM1Ne';
        const reqId0 = Math.floor(Math.random() * 900000) + 100000;
        const rLM1NePayload = [[["rLM1Ne", JSON.stringify([notebookId, null, [2, null, null, [1, null, null, null, null, null, null, null, null, null, [1]]], null, 1, [[null, null, []]]]), null, "generic"]]];
        const formData0 = new URLSearchParams();
        formData0.append('at', at);
        formData0.append('f.req', JSON.stringify(rLM1NePayload));
        const rLM1NeResp = await safeFetch('/_/LabsTailwindUi/data/batchexecute?rpcids=rLM1Ne&_reqid=' + reqId0 + '&bl=' + bl + '&authuser=' + authUser, {
            method: 'POST',
            credentials: 'include',
            headers: { 
                'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
                'x-same-domain': '1'
            },
            body: formData0
        });
        
        let existingFiles = {};
        if (rLM1NeResp.ok) {
            const rLM1NeText = await rLM1NeResp.text();
            const lines0 = rLM1NeText.split('\\n');
            for (let line of lines0) {
                if (line.startsWith('[')) {
                    try {
                        let parsed = JSON.parse(line);
                        for (let item of parsed) {
                            if (Array.isArray(item) && item.length > 2 && item[0] === 'wrb.fr' && item[1] === 'rLM1Ne') {
                                let innerData = JSON.parse(item[2]);
                                if (innerData && Array.isArray(innerData) && innerData.length > 0) {
                                    let notebookInfo = innerData[0];
                                    if (notebookInfo && Array.isArray(notebookInfo) && notebookInfo.length > 1 && Array.isArray(notebookInfo[1])) {
                                        for (let doc of notebookInfo[1]) {
                                            if (doc && doc[0] && Array.isArray(doc[0]) && doc[1]) {
                                                existingFiles[doc[1]] = doc[0][0]; // name -> id
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        async function processFile(file, retriesCount) {
            const fileName = file.fileName;
            const fileData = base64ToUint8Array(file.fileDataBase64);
            
            window.__UPLOAD_STEP = '2_DeleteOld_' + fileName;
            if (existingFiles[fileName]) {
                const deleteId = existingFiles[fileName];
                const delReqid = Math.floor(Math.random() * 900000) + 100000;
                const delData = [[["tGMBJ", JSON.stringify([[["" + deleteId]],[2,null,null,[1,null,null,null,null,null,null,null,null,null,[1]]]]), null, "generic"]]];
                const delForm = new URLSearchParams();
                delForm.append('at', at);
                delForm.append('f.req', JSON.stringify(delData));
                await safeFetch('/_/LabsTailwindUi/data/batchexecute?rpcids=tGMBJ&_reqid=' + delReqid + '&bl=' + bl + '&authuser=' + authUser, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', 'x-same-domain': '1' },
                    body: delForm
                }, retriesCount);
            }

            window.__UPLOAD_STEP = '3_o4cbdc_' + fileName;
            const reqId1 = Math.floor(Math.random() * 900000) + 100000;
            const initPayload = [[["o4cbdc", JSON.stringify([[[fileName]], notebookId, [2], [1, null, null, null, null, null, null, null, null, null, [1]]]), null, "generic"]]];
            const formData = new URLSearchParams();
            formData.append('at', at);
            formData.append('f.req', JSON.stringify(initPayload));
            
            const rpcResp = await safeFetch('/_/LabsTailwindUi/data/batchexecute?rpcids=o4cbdc&_reqid=' + reqId1 + '&bl=' + bl + '&authuser=' + authUser, {
                method: 'POST',
                credentials: 'include',
                headers: { 
                    'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
                    'x-same-domain': '1'
                },
                body: formData
            }, retriesCount);
            
            if (!rpcResp.ok) {
                const errText = await rpcResp.text();
                throw new Error("RPC 400 에러 상세: " + errText.substring(0, 500));
            }
            const rpcText = await rpcResp.text();
            let fileId = null;
            const lines = rpcText.split('\\n');
            for (let line of lines) {
                if (line.startsWith('[')) {
                    try {
                        let parsed = JSON.parse(line);
                        for (let item of parsed) {
                            if (Array.isArray(item) && item.length > 2 && item[0] === 'wrb.fr' && item[1] === 'o4cbdc') {
                                let innerData = JSON.parse(item[2]);
                                if (Array.isArray(innerData) && Array.isArray(innerData[0])) {
                                    for (let entry of innerData[0]) {
                                        if (Array.isArray(entry) && entry.length >= 2) {
                                            let idPart = entry[0];
                                            if (Array.isArray(idPart) && idPart.length > 0 && typeof idPart[0] === 'string') {
                                                fileId = idPart[0];
                                                break;
                                            }
                                            if (typeof idPart === 'string' && idPart.length > 10) {
                                                fileId = idPart;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {}
                }
            }
            if (!fileId) throw new Error('fileId 발급 실패 | ' + rpcText);
            
            window.__UPLOAD_STEP = '4_UploadStart_' + fileName;
            const startResp = await safeFetch('/upload/_/?authuser=' + authUser, {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'content-type': 'application/json',
                    'x-goog-authuser': authUser,
                    'x-goog-upload-command': 'start',
                    'x-goog-upload-protocol': 'resumable',
                    'x-goog-upload-header-content-length': fileData.length.toString()
                },
                body: JSON.stringify({ "PROJECT_ID": notebookId, "SOURCE_NAME": fileName, "SOURCE_ID": fileId })
            }, retriesCount);
            if (!startResp.ok) {
                const errText = await startResp.text().catch(e => '');
                throw new Error('Start 에러: ' + startResp.status + ' | ' + errText);
            }
            
            const uploadId = startResp.headers.get('x-guploader-uploadid');
            if (!uploadId) throw new Error('uploadId 없음');
            window.__UPLOAD_STEP = '5_UploadFinalize_' + fileName;
            const finalResp = await safeFetch('/upload/_/?authuser=' + authUser + '&upload_id=' + uploadId + '&upload_protocol=resumable', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'content-type': 'text/plain;charset=utf-8',
                    'x-goog-upload-command': 'upload, finalize',
                    'x-goog-upload-offset': '0'
                },
                body: fileData
            }, retriesCount);
            
            if (!finalResp.ok) {
                const errText = await finalResp.text().catch(e => '');
                throw new Error('Finalize 에러: ' + finalResp.status + ' | ' + errText);
            }
        }

        // 병렬 동시성 제어 및 단계별 재시도 업로드 큐 (최대 3개 동시 파이프라인)
        const maxConcurrency = 3;
        const results = [];
        const failedQueue1 = [];
        const failedQueue2 = [];
        let index1 = 0;
        
        async function workerPass1() {
            while (index1 < files.length) {
                const i = index1++;
                const file = files[i];
                try {
                    await processFile(file, 1); // 1차 세트: 단 1회 시도
                    results.push({ fileName: file.fileName, success: true });
                } catch (e) {
                    failedQueue1.push({ file, error: e.message });
                }
            }
        }
        
        const workers1 = [];
        for (let w = 0; w < Math.min(maxConcurrency, files.length); w++) {
            workers1.push(workerPass1());
        }
        await Promise.all(workers1);
        
        // 2차 세트: 3초 대기(서버 쿨다운) 후 1차 실패 파일들 단 1회 재시도
        if (failedQueue1.length > 0) {
            await new Promise(r => setTimeout(r, 3000));
            let index2 = 0;
            async function workerPass2() {
                while (index2 < failedQueue1.length) {
                    const idx = index2++;
                    const { file, error: firstErr } = failedQueue1[idx];
                    try {
                        await processFile(file, 1); // 2차 세트: 단 1회 시도
                        results.push({ fileName: file.fileName, success: true });
                    } catch (e2) {
                        failedQueue2.push({ file, error: e2.message });
                    }
                }
            }
            const workers2 = [];
            for (let w = 0; w < Math.min(maxConcurrency, failedQueue1.length); w++) {
                workers2.push(workerPass2());
            }
            await Promise.all(workers2);
        }

        // 3차 최종 세트: 다시 3초 대기 후 2차 실패 파일들 최종 1회 시도
        if (failedQueue2.length > 0) {
            await new Promise(r => setTimeout(r, 3000));
            let index3 = 0;
            async function workerPass3() {
                while (index3 < failedQueue2.length) {
                    const idx = index3++;
                    const { file, error: secondErr } = failedQueue2[idx];
                    try {
                        await processFile(file, 1); // 3차 최종 세트: 단 1회 시도
                        results.push({ fileName: file.fileName, success: true });
                    } catch (e3) {
                        results.push({ fileName: file.fileName, success: false, error: e3.message });
                    }
                }
            }
            const workers3 = [];
            for (let w = 0; w < Math.min(maxConcurrency, failedQueue2.length); w++) {
                workers3.push(workerPass3());
            }
            await Promise.all(workers3);
        }
        
        const totalCount = files.length;
        const failures = results.filter(r => !r.success);
        if (failures.length > 0) {
            const uniqueFailed = [...new Set(failures.map(f => f.fileName + ' (' + f.error + ')'))];
            window.__UPLOAD_ERROR = "⚠️ 총 " + totalCount + "개 중 " + failures.length + "개 파일 업로드 실패 [실패: " + uniqueFailed.join(', ') + "]";
            window.__UPLOAD_SUCCESS = false;
        } else {
            window.__UPLOAD_SUMMARY = "✨ 총 " + totalCount + "개 중 " + totalCount + "개 파일 업로드 성공!";
            window.__UPLOAD_SUCCESS = true;
            window.__UPLOAD_ERROR = null;
        }
    } catch(e) {
        window.__UPLOAD_ERROR = "[Step: " + (window.__UPLOAD_STEP || 'Init') + "] " + e.message;
        window.__UPLOAD_SUCCESS = false;
    }
})();
`;
