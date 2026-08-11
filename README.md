<div align="center">
  <h1>🚀 Hwp-to-MD_Converter v1.0 (MD / PDF 통합 변환기)</h1>
  <p><strong>문서를 MD / PDF 로 변환하는 데스크톱 애플리케이션</strong></p>
  <p><em>(Tauri v2 기반 포터블 데스크톱 버전)</em></p>
</div>

<br>

### 📥 바로 실행하기 (Download Portable)

별도의 복잡한 설치 과정 없이 다운로드 후 즉시 실행 가능한 포터블 단독 실행 파일입니다.
👉 **[최신 버전 실행 파일 다운로드 (Releases)](https://github.com/jc-polar/Hwp-to-MD_Converter/releases/latest)**

---

### 🛡️ Windows PC 보호(SmartScreen) 창이 뜰 경우

오픈소스 포터블 프로그램 특성상 최초 실행 시 파란색 경고 창이 뜰 수 있습니다. **바이러스나 악성코드가 아니므로 아래처럼 단 1회만 허용해 주세요.**

1. 좌측 상단의 **`추가 정보`** 클릭
2. 우측 하단의 **`실행`** 클릭

---

## ✨ 주요 기능 (Features)

이 애플리케이션은 오픈소스 파싱 라이브러리인 [`kordoc`](https://github.com/chrisryugj/kordoc) 엔진과 한컴 OLE 자동화 제어 기법을 결합하여, 문서의 서식과 수치 정합성을 보존하며 마크다운(MD) 및 PDF로 변환합니다.

- **🇰🇷 한글 문서(HWP/HWPX) 완벽 대응**: HWP, HWPX를 비롯해 PDF, Word, Excel 등 실무에서 자주 쓰이는 다양한 문서를 지원하며 문서 서식과 수치 정합성을 100% 보존합니다.
- **🤖 목적에 따른 두 가지 MD 변환 모드**:
  - `G-Notebook 최적화`: 구글 AI 서비스인 Gemini Notebook(NotebookLM)이 내용을 가장 잘 이해할 수 있도록 표를 평탄화하고 텍스트를 최적 정제합니다.
  - `기본 모드`: 후처리를 거치지 않고 KORDOC 엔진의 순수 원본 마크다운을 보존합니다.
- **📂 대용량 문서 일괄 변환**: 단일 파일뿐만 아니라 폴더 단위 변환을 지원하며, 하위 폴더까지 탐색하여 수백 개의 문서도 한 번의 클릭으로 일괄 처리합니다.
- **☁️ Gemini Notebook 다이렉트 업로드**: 지정한 Gemini Notebook (NotebookLM)으로 문서를 자동 업로드(최대 3개 동시 병렬)하여 작업 효율을 극대화합니다.
  - `스마트 덮어쓰기 (중복 방지)`: 이미 Gemini Notebook에 동일한 이름의 소스 문서가 존재할 경우, 기존 소스를 자동으로 지우고 최신 내용으로 업데이트합니다.
  - `자동 재시도`: 네트워크 문제 등으로 업로드 실패 시 최대 3회 자동 재시도하여 안정성을 보장합니다.

---

## 💡 사용 방법 (How to Use)

1. **폴더/파일 선택**: 변환할 HWP, HWPX 문서를 선택하거나 앱 화면으로 드래그 앤 드롭합니다.
2. **변환 형식 설정**:
   - `PDF/MD 통합 변환`: 문서를 한 번에 MD(마크다운)와 PDF 형식 두 가지로 동시에 변환
   - `PDF 전용 변환`: 한컴 OLE 엔진 기반 3배속 병렬 PDF 변환
   - `MD 전용 변환`: 마크다운 변환 (G-Notebook 최적화 모드 또는 기본 모드 선택)
3. **옵션 설정**:
   - `MD 변환 모드`: AI 분석용(G-Notebook 최적화) 또는 무가공 원본(기본 모드) 중 하나를 선택합니다.
   - `하위 폴더 포함`: 폴더를 선택했을 때, 내부의 모든 하위 폴더까지 샅샅이 스캔하여 변환할지 결정합니다.
   - `완료 후 폴더 열기`: 모든 작업이 끝난 직후 결과물이 저장된 폴더를 자동으로 열어줍니다.
   - `변환파일 로컬 저장`: 변환된 파일들을 원본 파일 위치에 생성되는 변환 폴더에 안전하게 저장합니다.
   - `G-Notebook 자동 업로드`: 대상 노트북의 URL 주소를 입력하면, 문서 변환 후 업로드가 자동 진행됩니다.
4. **변환 시작**: `[변환 시작]` 버튼을 누르면 즉시 작업이 시작됩니다.

---

## 🛠 사용 기술 (Tech Stack)

- **Frontend**: HTML5, Vanilla JavaScript, CSS3 (`Pretendard` Font, Sleek Dark Mode UI)
- **Backend (Desktop Framework)**: [Tauri v2](https://tauri.app/) (Rust 기반 멀티스레드 지원) + 포터블 Node.js
- **Document Parsing**: [kordoc](https://github.com/chrisryugj/kordoc) (`kordoc_worker.cjs` 기반 HWP/HWPX → Markdown 정제 파이프라인)
- **PDF Engine**: C# (.NET Core) OLE COM Controller (`pdf_worker.exe`)
- **Build & Bundling Tools**: Vite, ESBuild (워커 단일 파일 번들링)

---

## ⚙️ 빌드 가이드 (Build Guide)

> 아래 가이드는 소스코드를 받아 직접 실행 파일을 빌드하는 방법입니다.

### 사전 준비 (Prerequisites)

| 도구 | 설명 | 다운로드 |
|---|---|---|
| **Node.js** (v18+) | npm, Vite 및 ESBuild 실행용 | [nodejs.org](https://nodejs.org/) |
| **Rust** | Tauri 백엔드 컴파일 | [rustup.rs](https://rustup.rs/) |
| **Visual Studio C++ Build Tools** | Rust 및 C# 컴파일 의존성 (Windows) | [visualstudio.microsoft.com](https://visualstudio.microsoft.com/) |

---

### Step 1. 저장소 복제 및 의존성 설치

```bash
git clone https://github.com/jc-polar/Hwp-to-MD_Converter.git
cd Hwp-to-MD_Converter

# 프론트엔드 및 Tauri 의존성 설치
npm install

# kordoc 파싱 엔진 의존성 설치
cd src-tauri/core
npm install --omit=dev --omit=optional
cd ../..
```

---

### Step 2. 워커 번들링 (`worker_bundle.cjs`)

`kordoc` 파싱 엔진과 의존성 모듈들을 단일 파일(`worker_bundle.cjs`, 약 8.2MB)로 ESBuild 병합 및 압축하여 배포 용량을 최적화합니다.

```bash
npm run build:worker --prefix src-tauri/core
```

---

### Step 3. 포터블 실행 엔진 준비 (`node.exe`, `pdf_worker.exe`)

사용자 PC 환경에 구애받지 않고 독립 실행할 수 있도록 순정 **Node.js 실행 엔진**과 **C# PDF 워커**를 준비합니다.

```
src-tauri/
└── core/
    ├── node.exe          ← 순정 Node.js 실행 엔진
    ├── worker_bundle.cjs ← Step 2에서 생성된 ESBuild 번들 워커
    ├── pdf_worker.exe    ← C# OLE COM PDF 변환 워커
    └── kordoc_worker.cjs ← 마크다운 정제 소스 스크립트
```

---

### Step 4. 단독 포터블 실행 파일 빌드 (`--no-bundle`)

설치 파일(`.msi`, `.setup.exe`)을 생성하지 않고, 휴대용(Portable) 단독 실행 파일(`.exe`)만을 빠르고 깔끔하게 컴파일합니다.

```bash
npm run build:portable
# (내부 명령: tauri build --no-bundle)
```

빌드 완료 후 `src-tauri/target/release/Hwp-to-MD_Converter.exe` 가 생성됩니다.

---

### Step 5. 최종 배포 패키지 구성 (`Hwp-to-MD_Converter_v1.0`)

배포 시에는 불필요한 `node_modules` 없이 아래 핵심 파일만 모아서 배포합니다.

```
(실행기) Hwp-to-MD_Converter_v1.0/
├── Hwp-to-MD_Converter.exe     ── Tauri v2 Rust 데스크톱 포터블 앱
└── core/
    ├── node.exe                  ── 순정 Node.js 실행 엔진
    ├── worker_bundle.cjs         ── ESBuild 초압축 단일 번들 워커
    └── pdf_worker.exe            ── C# OLE COM PDF 변환 워커
```

---

## 🏗 아키텍처 개요 (Architecture)

```
[사용자 드래그 앤 드롭 / 폴더 선택]
        ↓
[main.js] ── 파일 목록 수집 ──→ [Rust: process_documents]
                                        ↓
                         ┌──────────────┴──────────────┐
                         ↓                             ↓
          [node.exe + worker_bundle.cjs]      [pdf_worker.exe (3개 병렬)]
          HWP/HWPX → MD (NotebookLM 정제)     HWP/HWPX → PDF (보안 자동 해제)
                         └──────────────┬──────────────┘
                                        ↓
                            [변환 결과 완료 즉시 저장]
```

---

## 🌟 Special Thanks & Bundled Libraries (오픈소스 출처 고지)

이 프로그램은 아래와 같은 훌륭한 오픈소스 프로젝트들의 지원을 받아 제작되었습니다. 원작자분들의 노고에 깊은 감사를 표합니다.

| Library | Purpose | License |
|---|---|---|
| **[kordoc](https://github.com/chrisryugj/kordoc)** | HWP / HWPX / DOCX / XLSX / PDF 파싱 코어 엔진 | MIT |
| **Tauri v2** | Rust 기반 고성능 데스크톱 앱 프레임워크 | MIT / Apache-2.0 |
| **Cheerio** | HTML / XML 서버사이드 돔 파싱 & 표 구조 정제 | MIT |
| **JSZip** | HWPX / DOCX (ZIP 기반) 압축 해제 및 패키징 | MIT |
| **js-cfb** | 구형 HWP (OLE / CFB) 컨테이너 파싱 | Apache-2.0 |
| **@xmldom/xmldom** | XML 구조 파싱 | MIT |

---

## 📄 라이선스 (License)
이 프로젝트는 MIT 라이선스를 따릅니다. 누구나 자유롭게 활용하고 수정할 수 있습니다.
