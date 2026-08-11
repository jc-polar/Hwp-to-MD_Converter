// /kordoc-engine/kordoc_worker.js
// Node.js 사이드카 스크립트: kordoc 엔진을 통한 문서 파싱 및 범용 원본 보존 후처리 담당

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parse } = require('kordoc'); 
const cheerio = require('cheerio');



/**
 * [원칙 1] 꺾쇠괄호(<...>) 용어의 범용 이스케이프 보정:
 * 마크다운 뷰어, LLM Sanitizer, Cheerio DOM 파서가 본문 내 꺾쇠 용어(<...>)를
 * 무효한 HTML 커스텀 태그로 오인하여 본문 텍스트를 소거(Strip)하거나 강제 닫는 태그를 생성하는 현상을 방지합니다.
 * 표준 HTML 태그(sup, sub, br, table, tr, td 등) 이외의 모든 <...>를 &lt;...&gt;로 변환하여 100% 원본 텍스트 구조를 보존합니다.
 */
function escapeNonHtmlBrackets(text) {
    if (!text) return text;
    const allowedTags = [
        'sup', '/sup', 'sub', '/sub', 'br', 'br/',
        'table', '/table', 'tbody', '/tbody', 'thead', '/thead', 'tr', '/tr', 'td', '/td', 'th', '/th',
        'p', '/p', 'div', '/div', 'span', '/span', 'font', '/font', 'b', '/b', 'i', '/i', 'u', '/u',
        'nobr', '/nobr', 'a', '/a', 'li', '/li', 'ul', '/ul', 'ol', '/ol',
        'h1', '/h1', 'h2', '/h2', 'h3', '/h3', 'h4', '/h4', 'h5', '/h5', 'h6', '/h6'
    ];
    return text.replace(/<([^>]+)>/g, (match, content) => {
        const tagName = content.trim().toLowerCase().split(/\s+/)[0];
        if (allowedTags.includes(tagName)) {
            return match;
        }
        return `&lt;${content}&gt;`;
    });
}

/**
 * [원칙 2] DOM 구조 기반 셀 내부 문단/줄바꿈 경계 자연 분리:
 * HWP 단일 셀 내부에서 엔터(Enter)나 문단(Paragraph), span 태그로 나뉜 복수의 수치/문장들이 공백 없이 뭉개지는 현상을 방지하기 위해,
 * DOM 요소(span, font, b, p, div, br 등)의 모든 경계에 개행(\n)을 삽입한 후 마크다운 표 표준 <br> 태그로 안전하게 변환합니다.
 */
function cleanCellDomText(cellElement, $) {
    const clone = $(cellElement).clone();

    // 1) 셀 내부 br 태그를 개행 문자로 치환
    clone.find('br').replaceWith('\n');

    // 2) 셀 내부 인라인 태그(span, font, b, i, u 등) 경계에 개행 추가하여 문단/단락 수치 엉킴 원천 방지
    clone.find('span, font, b, i, u, nobr, a').each((_, el) => {
        $(el).append('\n');
    });

    // 3) 셀 내부 블록 태그(p, div, li, h1~h6, tr) 경계에 개행 문자 추가
    clone.find('p, div, li, h1, h2, h3, h4, h5, h6, tr').each((_, el) => {
        $(el).append('\n');
    });

    // 4) 셀 내부 개행 문자를 마크다운 표 표준 <br> 태그로 치환하고 공백 정제 (슬래시 / 대신 <br> 적용)
    let text = clone.text()
        .replace(/\r\n|\r|\n|\u000A|\u000D/g, '<br>')
        .replace(/(?:\s*<br>\s*)+/g, '<br>')
        .replace(/^<br>|<br>$/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim();

    return text;
}

/**
 * [원칙 3] HTML <sup>/<sub> 첨자 태그 수식 정보 표준 보존
 */
function preserveSupSubAndEquations(text) {
    if (!text) return text;

    // 1) HTML <sup>태그를 LaTeX 상첨자($^{text}$)로 변환
    text = text.replace(/<sup[^>]*>(.*?)<\/sup>/gi, '^{$1}');
    
    // 2) HTML <sub>태그를 LaTeX 하첨자($_{text}$)로 변환
    text = text.replace(/<sub[^>]*>(.*?)<\/sub>/gi, '_{$1}');

    // 3) 연속된 상/하첨자 표기를 마크다운 LaTeX 블록으로 래핑
    text = text.replace(/([\delta\alpha\beta\gamma\w]*)([\^\_]\{[^\}]+\})/g, (match, prefix, script) => {
        if (prefix && prefix.trim()) {
            return `${prefix}$${script}$`;
        } else {
            return `$${script}$`;
        }
    });

    return text;
}

/**
 * [원칙 4] 체크박스 서식 마크다운 표준화 (- [x] / - [ ])
 * 한컴 기호(■, ☑, □, ☐)를 LLM 표준 Boolean 인터페이스 서식으로 범용 통합
 */
function normalizeCheckboxesAndBoxes(text) {
    if (!text) return text;

    // 1) HTML 체크박스 태그 변환
    text = text.replace(/<input[^>]*checked[^>]*type=["']?checkbox["']?[^>]*>/gi, '- [x] ');
    text = text.replace(/<input[^>]*type=["']?checkbox["']?\s*checked[^>]*>/gi, '- [x] ');
    text = text.replace(/<input[^>]*type=["']?checkbox["']?[^>]*>/gi, '- [ ] ');
    
    // 2) 유니코드 체크박스 및 변형 기호 일대일 정규화
    text = text.replace(/\[v\]|\[V\]|\[x\]|\[X\]/gi, '- [x]');
    text = text.replace(/☒|☑/g, '- [x]');
    text = text.replace(/☐|▫/g, '- [ ]');

    // 3) HWP 선택/미선택 기호 (■ / □) 표준 마크다운 체크박스로 치환
    text = text.replace(/■\s*/g, '- [x] ');
    text = text.replace(/□\s*/g, '- [ ] ');

    // 4) 이중 중복 정리
    text = text.replace(/-\s*\[[ x]\]\s*-\s*\[([ x])\]/g, '- [$1]');

    return text;
}

/**
 * [원칙 5] NotebookLM 및 LLM 전처리 마크다운 범용 무결성 정제
 */
function sanitizeMdForNotebookLM(text) {
    if (!text) return text;


    // 1) 마크다운 취소선 오작동 방지를 위해 물결표 전각 치환
    text = text.replace(/~/g, "～");

    // 2) 코드블록 오작동을 유발하는 탭(\t) 문자를 공백 4칸으로 변경
    text = text.replace(/\t/g, "    ");
    
    // 3) 유령 공백(&nbsp;, \xa0)을 일반 공백으로 치환
    text = text.replace(/\xa0/g, " ");
    
    // 4) 안전한 HTML 엔티티 디코딩 (&lt;/&gt; 이스케이프는 보존)
    text = text.replace(/&amp;/gi, '&');
    text = text.replace(/&quot;/gi, '"');
    text = text.replace(/&#39;/gi, "'");
    text = text.replace(/&nbsp;/gi, ' ');

    // 5) NotebookLM 보안 링크 소거 방지를 위한 하이퍼링크 텍스트 보정 ([anchor](URL) -> anchor (URL))
    text = text.replace(/(?<!\!)\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
    
    // 7) 의미 없는 연속된 빈 줄(3줄 이상) 2줄로 정제
    text = text.replace(/\n{3,}/g, '\n\n');
    
    // 8) 범용 꺾쇠 이스케이프 (Non-HTML Brackets -> &lt;...&gt;)
    text = escapeNonHtmlBrackets(text);
    
    // 9) 전각 물결표 앞 백슬래시(\～) 최종 범용 청소
    text = text.replace(/\\～/g, '～');
    text = text.replace(/\\~/g, '～');

    return text;
}

/**
 * 파이썬의 flatten_html_tables_to_md 함수 이식 + 중첩 표 스마트 평탄화(Inside-Out Flattening)
 * HTML table을 순수 Markdown table 포맷으로 평탄화하며 수치/예산/통계 표는 2D Grid(|---|)를 보존합니다.
 */
function flattenHtmlTablesToMd(mdText, isNotebookLMMode) {
    // [원칙 1]: Cheerio DOM 트리 생성 직전에 모든 비-HTML 꺾쇠를 사전 이스케이프하여
    // Cheerio가 커스텀 HTML 태그로 오인하고 문서 말단에 닫는 태그를 강제로 덧붙이는 현상 원천 차단
    mdText = escapeNonHtmlBrackets(mdText);

    const $ = cheerio.load(mdText);
    
    while (true) {
        const leafTables = $('table').filter((i, el) => $(el).find('table').length === 0);
        if (leafTables.length === 0) break;

        leafTables.each((i, table) => {
            const isInnerTable = $(table).parents('table').length > 0;

            if (isInnerTable) {
                let innerLines = [];
                $(table).find('> tr, > tbody > tr, > thead > tr').each((j, row) => {
                    let rowCells = [];
                    $(row).children('td, th').each((k, cell) => {
                        let text = cleanCellDomText(cell, $);
                        if (text) rowCells.push(text);
                    });
                    if (rowCells.length > 0) {
                        innerLines.push(rowCells.join(': '));
                    }
                });
                const flatText = innerLines.length > 0 ? ` [${innerLines.join(' / ')}] ` : '';
                $(table).replaceWith(flatText);
            } else {
                const rows = $(table).find('> tr, > tbody > tr, > thead > tr');
                const numRows = rows.length;
                if (numRows === 0) return;

                let maxCols = 0;
                rows.each((j, row) => {
                    let cols = 0;
                    $(row).children('td, th').each((k, cell) => {
                        const colspan = parseInt($(cell).attr('colspan') || '1', 10);
                        cols += (isNaN(colspan) || colspan < 1) ? 1 : colspan;
                    });
                    if (cols > maxCols) maxCols = cols;
                });

                const grid = Array.from({ length: numRows }, () => Array(maxCols).fill(null));

                rows.each((r, row) => {
                    let c = 0;
                    $(row).children('td, th').each((k, cell) => {
                        while (c < maxCols && grid[r][c] !== null) c++;
                        if (c >= maxCols) return;

                        // [원론적 해결책]: DOM 구조 기반 셀 내부 텍스트 추출
                        let cellText = cleanCellDomText(cell, $);

                        if (isNotebookLMMode && maxCols === 1) {
                            cellText = cellText.replace(/[ \t]+/g, ' ').trim();
                        } else {
                            cellText = cellText
                                .replace(/\r\n|\r|\n/g, '<br>')
                                .replace(/\|/g, '\\|')
                                .replace(/[ \t]+/g, ' ')
                                .trim();
                        }

                        const rowspan = parseInt($(cell).attr('rowspan') || '1', 10);
                        const colspan = parseInt($(cell).attr('colspan') || '1', 10);
                        const rs = (isNaN(rowspan) || rowspan < 1) ? 1 : rowspan;
                        const cs = (isNaN(colspan) || colspan < 1) ? 1 : colspan;

                        for (let dr = 0; dr < rs; dr++) {
                            for (let dc = 0; dc < cs; dc++) {
                                if (r + dr < numRows && c + dc < maxCols) {
                                    // [원론적 해결책]: 세로 병합 셀(Rowspan) 하위 행에 상위 셀 값 승계 (Value Inheritance)
                                    grid[r + dr][c + dc] = cellText;
                                }
                            }
                        }
                        c += cs;
                    });
                });

                // [다차원 수치 데이터 표 판별]: 셀 내부 수치 밀도로 판단
                const cellTextContent = grid.flat().filter(Boolean).join(' ');
                const numericMatches = cellTextContent.match(/\b\d+([.,]\d+)?%?|\d{1,3}(,\d{3})+/g) || [];
                const isNumericOrBudgetTable = numericMatches.length >= 4;

                let mdTable = '\n';
                if (isNotebookLMMode) {
                    if (maxCols >= 3 || isNumericOrBudgetTable) {
                        // 수치 데이터 표는 1차원으로 풀지 않고 2D Grid 마크다운 표(|---|) 구조 보존
                        for (let r = 0; r < numRows; r++) {
                            const rowCols = grid[r].map(val => val === null ? '' : val);
                            mdTable += '| ' + rowCols.join(' | ') + ' |\n';
                            if (r === 0) {
                                mdTable += '|' + Array(maxCols).fill('---').join('|') + '|\n';
                            }
                        }
                    } else if (maxCols === 1) {
                        mdTable += '\n';
                        for (let r = 0; r < numRows; r++) {
                            const val = grid[r][0] === null ? '' : grid[r][0].trim();
                            if (val) {
                                mdTable += val + '\n\n';
                            }
                        }
                    } else if (maxCols === 2) {
                        mdTable += '\n';
                        for (let r = 0; r < numRows; r++) {
                            const key = grid[r][0] === null ? '' : grid[r][0].trim();
                            const val = grid[r][1] === null ? '' : grid[r][1].trim();
                            if (key || val) {
                                mdTable += `**${key || '항목'}**: ${val}\n\n`;
                            }
                        }
                    }
                } else {
                    for (let r = 0; r < numRows; r++) {
                        const rowCols = grid[r].map(val => val === null ? '' : val);
                        mdTable += '| ' + rowCols.join(' | ') + ' |\n';
                        if (r === 0) {
                            mdTable += '|' + Array(maxCols).fill('---').join('|') + '|\n';
                        }
                    }
                }

                $(table).replaceWith(mdTable);
            }
        });
    }

    // [HTML 태그 껍데기 전량 소거]: Cheerio가 자동 생성한 <html><head></head><body>...</body></html> 껍데기 완전 제거하여 순수 마크다운 정제
    let cleanOutput = $('body').length > 0 ? $('body').html() : $.html();
    cleanOutput = cleanOutput
        .replace(/^<html><head><\/head><body>/i, '')
        .replace(/<\/body><\/html>$/i, '')
        .replace(/<\/?html[^>]*>/gi, '')
        .replace(/<head>[\s\S]*?<\/head>/gi, '')
        .replace(/<\/?body[^>]*>/gi, '')
        .trim();

    return cleanOutput;
}

/**
 * 커스텀 !image 플레이스홀더를 RAG 인식 가능 표준 마크다운 캡션 태그(![그림: filename](path))로 보정
 */
function normalizeImagePlaceholders(text) {
    if (!text) return text;
    // 1) !image (image_001.bmp) / !image (image_001.png) -> ![그림: image_001.bmp](image_001.bmp)
    text = text.replace(/!image\s*\(([^)]+)\)/gi, (match, imgPath) => {
        const cleanPath = imgPath.trim();
        const baseName = path.basename(cleanPath);
        return `![그림: ${baseName}](${cleanPath})`;
    });
    // 2) ![image](image_001.png) -> ![그림: image_001.png](image_001.png)
    text = text.replace(/!\[\s*image\s*\]\(([^)]+)\)/gi, (match, imgPath) => {
        const cleanPath = imgPath.trim();
        const baseName = path.basename(cleanPath);
        return `![그림: ${baseName}](${cleanPath})`;
    });
    return text;
}

/**
 * [상대 경로 추출 및 태그 생성]
 * 최상위 폴더명을 포함한 상대 경로 트리(#폴더명/하위폴더)를 생성합니다.
 */
function createFolderTags(filePath, rootPath) {
    if (!filePath) return '';
    
    let tagParts = [];
    
    if (rootPath) {
        // 폴더 모드 (rootPath가 주어짐)
        let rootName = path.basename(rootPath);
        if (!rootName) {
            rootName = rootPath.replace(/[\\/]+$/, '') || 'Root';
        }
        let relativeDir = path.relative(rootPath, path.dirname(filePath));
        
        if (rootName) {
            tagParts.push(rootName);
        }
        
        if (relativeDir && relativeDir !== '.') {
            const subDirs = relativeDir.replace(/\\/g, '/').split('/');
            tagParts = tagParts.concat(subDirs);
        }
    } else {
        // 파일 모드 (rootPath가 없음) - 스마트 무제한 추출
        const stopWords = ['desktop', '바탕 화면', 'documents', '문서', 'downloads', '다운로드', 'users', '사용자', 'workspace', '바탕화면'];
        const dirPath = path.dirname(filePath);
        const parts = dirPath.replace(/\\/g, '/').split('/');
        
        for (let i = parts.length - 1; i >= 0; i--) {
            const part = parts[i];
            if (!part) continue; // 빈 문자열 무시
            
            // 정지 조건: 시스템 폴더이거나 드라이브 문자(C:)인 경우
            if (stopWords.includes(part.toLowerCase()) || /^[a-zA-Z]:$/.test(part)) {
                break;
            }
            tagParts.unshift(part); // 거꾸로 올라가므로 배열의 앞에 추가
        }
    }
    
    if (tagParts.length === 0) return '';
    
    // 태그 내에서 마크다운이 깨지지 않도록 공백 및 허용되지 않은 특수문자를 언더스코어로 치환
    const cleanTags = tagParts
        .map(t => t.replace(/[^\w\uAC00-\uD7A30-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''))
        .filter(t => t.length > 0);
    
    const tagString = `#${cleanTags.join('/')}`;
    
    return `> **📁 Tags:** ${tagString}\n\n`;
}

/**
 * 메인 변환 작업 파이프라인
 */
async function processDocument(filePath, origFilePath, outputDir, isNotebookLMMode, rootPath) {
    const fileName = path.basename(origFilePath || filePath);
    let baseStem = fileName.substring(0, fileName.lastIndexOf('.'));
    const mdName = baseStem + ".md";

    try {
        const finalPath = path.join(outputDir, mdName);
        
        // 1. kordoc을 이용한 문서 -> 마크다운 텍스트 파싱
        let parsedResult = await parse(filePath);
        if (!parsedResult.success) {
            throw new Error(parsedResult.error || "파싱 실패");
        }
        let parsedText = parsedResult.markdown;
        
        if (isNotebookLMMode) {
            // [거시적 원칙 3] 위/아래 첨자 수식 정보 보존
            parsedText = preserveSupSubAndEquations(parsedText);

            // [거시적 원칙 4] 체크박스 정규화 (- [x] / - [ ])
            parsedText = normalizeCheckboxesAndBoxes(parsedText);

            // [거시적 원칙 2] 표 평탄화 및 DOM 기반 셀 텍스트 분리 (2D Grid 보존 포함)
            parsedText = flattenHtmlTablesToMd(parsedText, isNotebookLMMode);

            // 이미지 커스텀 플레이스홀더(!image) 표준 마크다운 캡션 태그(![그림: ...](...))로 변환
            parsedText = normalizeImagePlaceholders(parsedText);
            
            parsedText = sanitizeMdForNotebookLM(parsedText);
            
            // 상대 경로 태그 주입
            const tagStr = createFolderTags(origFilePath || filePath, rootPath);
            if (tagStr) {
                parsedText = tagStr + parsedText;
            }
        }
        
        fs.writeFileSync(finalPath, parsedText, 'utf-8');
        
        process.stdout.write(`RESULT|SUCCESS|${filePath}|${finalPath}\n`);
    } catch (error) {
        try {
            if (outputDir && fs.existsSync(outputDir)) {
                const fileName = path.basename(filePath);
                const destPath = path.join(outputDir, mdName);
                fs.copyFileSync(filePath, destPath);
                process.stdout.write(`RESULT|COPIED|${filePath}|${destPath}\n`);
            } else {
                process.stdout.write(`RESULT|ERROR|${filePath}|${error.message}\n`);
            }
        } catch (copyErr) {
            process.stdout.write(`RESULT|ERROR|${filePath}|${error.message}\n`);
        }
    }
}

const args = process.argv.slice(2);
const taskJsonPath = args[0];

if (taskJsonPath && fs.existsSync(taskJsonPath)) {
    const jsonStr = fs.readFileSync(taskJsonPath, 'utf-8').replace(/^\uFEFF/, '');
    const tasks = JSON.parse(jsonStr);
    
    (async () => {
        try {
            const CONCURRENCY = Math.max(1, os.cpus().length);
            for (let i = 0; i < tasks.length; i += CONCURRENCY) {
                const chunk = tasks.slice(i, i + CONCURRENCY);
                await Promise.all(chunk.map(task => 
                    processDocument(task.filePath, task.origFilePath, task.outputDir, task.isNotebookLMMode, task.rootPath)
                ));
            }
        } catch (err) {
            process.stdout.write(`RESULT|FATAL|${err.message}\n`);
        }
    })();
}
