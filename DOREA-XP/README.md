<div align="center">

# DOREA–XP

**DOREA–X의 공개판 (Open Edition)**

<p>
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-blue.svg">
  <img alt="Docker" src="https://img.shields.io/badge/docker-%230db7ed.svg?logo=docker&logoColor=white">
  <img alt="Python" src="https://img.shields.io/badge/python-3.11-3670A0?logo=python&logoColor=ffdd54">
</p>

</div>

---

## 🔎 DOREA-XP란

**DOREA-XP**는 [DOREA-X](../)의 핵심 기능을 추려 공개한 버전입니다. Docker만 설치돼 있으면 노트북 한 대에서 바로 띄워 사용할 수 있습니다.

- **문서 기반 RAG 채팅**: PDF / HWP / HWPX / Office 문서를 업로드해 내용에 기반한 대화
- **멀티모달 문서 이해**: 텍스트 + 표 + 이미지가 섞인 비정형 문서의 통합 분석
- **한글(HWPX) 편집기 통합**: 채팅에서 "한글편집기에 ... 넣어줘" 한 줄로 본문 추가
- **MCP 도구 연동**: KISTI ScienceON / NTIS / DataON 등 외부 검색 API 연결
- **간단 설치**: `./install/install.sh` (Linux/macOS) 또는 `.\install\install.ps1` (Windows) 한 줄로 끝

---

## DOREA-X vs DOREA-XP

| 항목 | DOREA-X (Full) | DOREA-XP (Open) |
|---|---|---|
| **공개 여부** | 사내·연구용 비공개 | **오픈소스 (이 레포)** |
| **문서 RAG 채팅** | ✅ | ✅ |
| **멀티모달 분석 (이미지·표 보강)** | ✅ | ✅ |
| **MCP 도구 연동 (ScienceON / NTIS / DataON)** | ✅ | ✅ |
| **HWPX 한글 편집기** | ✅ 표 생성·셀 채움·스타일 등 풍부한 채팅 작성 (154 명령) | ✅ 텍스트 본문 삽입(`insertText`) 한 가지만 |
| **장기 메모리 (Mem0 기반 사용자 맥락)** | ✅ | ❌ |
| **Skills 시스템 (사용자 정의 도구/매크로)** | ✅ | ❌ |
| **브라우저 자동화 ("네이버 검색해줘" 등)** | ✅ (noVNC + Chromium + CDP) | ❌ |
| **별도 문서 레이아웃 서비스 (Docling, Huridocs)** | ✅ | △ (OpenDataLoader 단일) |
| **설치 방식** | 수동 / 사내 배포 | 자동 스크립트 (Docker만 있으면 끝) |
| **권장 사양** | GPU 서버 | 노트북 CPU도 가능 (GPU 있으면 5~10배 가속) |

---

## 🚀 빠른 시작

```bash
# Linux / macOS
git clone https://github.com/leeryong/DOREA-X.git
cd DOREA-X/DOREA-XP
./install/install.sh

# Windows (PowerShell, 관리자 권장)
.\install\install.ps1
```

초기 설치 시 Docker 이미지 빌드 및 임베딩 모델 다운로드(약 5GB)로 **10~20분 정도 소요**됩니다. 완료 후 `http://localhost:8000` 에 admin 계정으로 접속하세요 (초기 비밀번호는 설치 스크립트 마지막에 콘솔에 표시됨).

> **사내 네트워크 주의** — SSL 인터셉션(MITM) 또는 PyPI/npm/Docker Hub 접근 제한이 있는 환경에서는 빌드가 실패할 수 있습니다. 사내 IT 정책을 확인해 신뢰 인증서 추가, 프록시 설정, 또는 외부망 환경에서 1회 빌드 후 이미지 이관 등 우회 방법을 적용해 주세요.

---

## 🛠️ 실행 모드

| 모드 | 명령 | 비고 |
|---|---|---|
| **CPU (기본)** | `docker compose up -d --build` | 모든 OS |
| **Linux + NVIDIA GPU** | `docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build` | `install.sh` 자동 감지 |
| **macOS + Apple Silicon Metal** | (별도 [Ollama 앱](https://ollama.com/download/mac) 설치) | `install.sh` 자동 감지 |

---


## 📁 디렉터리

```
DOREA-XP/
├── backend/                     # FastAPI 백엔드
├── frontend/                    # React + Vite 프론트엔드
├── rhwp-service/                # 한글 편집기 (upstream rhwp + 미니 패치)
├── document-converter/          # 비-PDF → PDF 변환
├── mcp-service/                 # MCP 서버 라우터
├── opendataloader-service/      # PDF 레이아웃 분석
├── install/                     # 설치/시작/중지/업데이트 스크립트
├── docker-compose.yml           # 메인
├── docker-compose.gpu.yml       # Linux NVIDIA 오버라이드
├── .env.example                 # 환경설정 템플릿
└── README.md                    # 이 파일
```

---

## 📞 문의

- 이용 (ryonglee@kisti.re.kr)

## 👨‍💻 개발자 그룹

KISTI **BLUESKY** 팀 — *Harmonizing Human and AI Collaboration* · [github.com/leeryong/KISTI_BLUESKY](https://github.com/leeryong/KISTI_BLUESKY)

- 이용 (ryonglee@kisti.re.kr)
- 장래영 (raezero@kisti.re.kr)
- 구자현 (jahyeongu@kisti.re.kr)

---

## 📚 활용 오픈소스

- [OpenDataLoader](https://github.com/opendataloader-project) — PDF 레이아웃 분석
- [Ollama](https://github.com/ollama/ollama) — 로컬 임베딩 / LLM 추론
- [ChromaDB](https://github.com/chroma-core/chroma) — 벡터 DB
- [rhwp](https://github.com/edwardkim/rhwp) — HWP/HWPX 한글 편집기
