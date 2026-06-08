#!/usr/bin/env bash
# DOREA-XP 설치 스크립트 (Linux / macOS)
#
# 사용법:
#   chmod +x install/install.sh
#   ./install/install.sh
#
# 기능:
#   - Docker / docker compose 설치 여부 검증
#   - Linux: NVIDIA GPU 자동 감지 → docker-compose.gpu.yml 자동 사용
#   - macOS: 호스트 Ollama (Apple Silicon Metal) 자동 감지 → 호스트 모드 사용
#   - .env 자동 생성 (랜덤 admin 비밀번호 + JWT 시크릿)
#   - docker compose up -d --build
#   - 헬스체크 후 접속 정보 출력

set -euo pipefail

# 색상
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 프로젝트 루트 (스크립트가 install/ 폴더 안에 있다고 가정)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo -e "${BLUE}=== DOREA-XP 설치 ===${NC}"
echo "프로젝트 경로: $PROJECT_ROOT"
echo ""

# 1. Docker 확인
echo -e "${BLUE}[1/6] Docker 확인...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker가 설치돼 있지 않습니다.${NC}"
    echo "   설치 안내: https://docs.docker.com/get-docker/"
    exit 1
fi
if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker 데몬이 실행되지 않습니다.${NC}"
    echo "   Docker Desktop을 실행하거나 systemctl start docker 를 시도하세요."
    exit 1
fi
echo -e "${GREEN}✓ Docker OK${NC}"

# 2. docker compose 확인
if ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ docker compose v2가 필요합니다. (docker-compose 옛 버전은 미지원)${NC}"
    echo "   Docker Desktop 최신 버전 또는 docker-compose-plugin 패키지를 설치하세요."
    exit 1
fi
echo -e "${GREEN}✓ docker compose OK${NC}"

# 3. 마운트 포인트 미리 생성 (호스트 권한으로 만들어 두면 컨테이너 마운트 시
#    Docker 데몬이 root 소유로 만드는 것보다 안전. 이미 있으면 그대로 둠.)
mkdir -p DATABASE/files DATABASE/attachments DATABASE/myfiles DATABASE/chroma
mkdir -p MODEL/Ollama
mkdir -p config

# 4. OS 감지 + 실행 모드 결정
echo ""
echo -e "${BLUE}[2/6] 실행 모드 결정...${NC}"
OS="$(uname -s)"
COMPOSE_FILES="-f docker-compose.yml"
MODE_LABEL=""

case "$OS" in
    Linux*)
        if command -v nvidia-smi &> /dev/null && nvidia-smi -L &> /dev/null; then
            COMPOSE_FILES="$COMPOSE_FILES -f docker-compose.gpu.yml"
            MODE_LABEL="Linux + NVIDIA GPU"
        else
            MODE_LABEL="Linux CPU (NVIDIA GPU 미감지)"
        fi
        ;;
    Darwin*)
        # macOS — 호스트 Ollama가 돌고 있는지 확인 (Apple Silicon Metal 활용)
        if curl -sf --max-time 2 http://localhost:11434/api/tags > /dev/null 2>&1; then
            COMPOSE_FILES="$COMPOSE_FILES -f install/docker-compose.mac.yml"
            MODE_LABEL="macOS + 호스트 Ollama (Metal GPU)"
        else
            MODE_LABEL="macOS + 컨테이너 Ollama (CPU 전용, 느림)"
            echo -e "${YELLOW}   💡 팁: https://ollama.com 에서 GUI Ollama를 설치 후 실행해두면${NC}"
            echo -e "${YELLOW}      Apple Silicon Metal GPU를 자동으로 활용해 훨씬 빠릅니다.${NC}"
            echo -e "${YELLOW}      나중에 설치 후 install.sh 재실행하면 자동 전환됩니다.${NC}"
        fi
        ;;
    *)
        echo -e "${YELLOW}⚠️  알 수 없는 OS: $OS — Linux CPU 모드로 진행합니다.${NC}"
        MODE_LABEL="Unknown ($OS) — CPU"
        ;;
esac
echo -e "${GREEN}✓ 모드: ${MODE_LABEL}${NC}"
echo -e "   compose 옵션: ${COMPOSE_FILES}"

# 4. .env 자동 생성
# 규칙:
#   - .env 가 이미 있으면 그대로 사용 (기존 동작)
#   - 없으면 .env.example 에서 복사
#   - ADMIN_INITIAL_PASSWORD 가 placeholder("change-me", 빈값) 면 랜덤 생성
#   - 그 외 값이면 .env.example 값을 그대로 사용 (배포 전 .env.example 수정으로 비번 고정 가능)
#   - JWT_SECRET_KEY 도 같은 규칙
echo ""
echo -e "${BLUE}[3/6] .env 파일 확인...${NC}"

_is_placeholder() {
    case "$1" in
        ""|"change-me"|"change-me-to-strong-random-secret"|"your-super-secret-key-change-in-production")
            return 0 ;;
        *) return 1 ;;
    esac
}

if [ -f ".env" ]; then
    echo -e "${GREEN}✓ .env 이미 존재 — 기존 값 유지${NC}"
    # grep -m1: 첫 매치 후 grep이 스스로 종료 (head 파이프 불필요 → SIGPIPE/pipefail 충돌 회피)
    ADMIN_PASS_DISPLAY=$(grep -m1 -E "^ADMIN_INITIAL_PASSWORD=" .env | cut -d'=' -f2- || true)
else
    cp .env.example .env 2>/dev/null || touch .env

    EXAMPLE_ADMIN=$(grep -m1 -E "^ADMIN_INITIAL_PASSWORD=" .env | cut -d'=' -f2- || true)
    EXAMPLE_JWT=$(grep -m1 -E "^JWT_SECRET_KEY=" .env | cut -d'=' -f2- || true)

    if _is_placeholder "$EXAMPLE_ADMIN"; then
        if command -v openssl &> /dev/null; then
            ADMIN_PASS=$(openssl rand -base64 12 | tr -d "/+=" | cut -c1-12)
        else
            ADMIN_PASS=$(head -c 12 /dev/urandom | base64 | tr -d "/+=" | cut -c1-12)
        fi
        ADMIN_SOURCE="(랜덤 생성)"
    else
        ADMIN_PASS="$EXAMPLE_ADMIN"
        ADMIN_SOURCE="(.env.example 사용)"
    fi

    if _is_placeholder "$EXAMPLE_JWT"; then
        if command -v openssl &> /dev/null; then
            JWT_KEY=$(openssl rand -hex 32)
        else
            JWT_KEY=$(head -c 32 /dev/urandom | xxd -p | tr -d '\n')
        fi
    else
        JWT_KEY="$EXAMPLE_JWT"
    fi

    # ADMIN_INITIAL_PASSWORD / JWT_SECRET_KEY 라인 갱신 (없으면 추가)
    if grep -q "^ADMIN_INITIAL_PASSWORD=" .env; then
        sed -i.bak "s|^ADMIN_INITIAL_PASSWORD=.*|ADMIN_INITIAL_PASSWORD=$ADMIN_PASS|" .env
    else
        echo "ADMIN_INITIAL_PASSWORD=$ADMIN_PASS" >> .env
    fi
    if grep -q "^JWT_SECRET_KEY=" .env; then
        sed -i.bak "s|^JWT_SECRET_KEY=.*|JWT_SECRET_KEY=$JWT_KEY|" .env
    else
        echo "JWT_SECRET_KEY=$JWT_KEY" >> .env
    fi
    rm -f .env.bak
    ADMIN_PASS_DISPLAY="$ADMIN_PASS"
    echo -e "${GREEN}✓ .env 생성 — admin 비밀번호 ${ADMIN_SOURCE}${NC}"
fi

# 5. docker compose up
echo ""
echo -e "${BLUE}[4/6] 컨테이너 이미지 빌드 + 시작 (처음 실행 시 ~10분, 이미지 크기 약 5GB)${NC}"
docker compose $COMPOSE_FILES up -d --build

# 6. 헬스체크
echo ""
echo -e "${BLUE}[5/6] 백엔드 헬스체크 (최대 90초 대기)...${NC}"
for i in {1..30}; do
    if curl -sf --max-time 2 http://localhost:8000/ > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 백엔드 응답 OK${NC}"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}❌ 헬스체크 시간 초과. docker compose logs backend 로 확인하세요.${NC}"
        exit 1
    fi
    sleep 3
    echo -n "."
done

# 7. bge-m3 다운로드 진행 안내 (백엔드가 자동 처리)
echo ""
echo -e "${BLUE}[6/6] 임베딩 모델(bge-m3) 자동 다운로드 진행 안내${NC}"
echo "   백엔드가 백그라운드로 자동 다운로드 합니다 (~1.2GB, 처음 1회)."
echo "   진행: docker compose logs -f backend | grep Bootstrap"

# 완료
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║       DOREA-XP가 준비됐습니다!                 ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  접속:     http://localhost:8000              ║${NC}"
echo -e "${GREEN}║  아이디:   admin                              ║${NC}"
printf  "${GREEN}║  비밀번호: %-36s║${NC}\n" "$ADMIN_PASS_DISPLAY"
echo -e "${GREEN}║  모드:     %-36s║${NC}\n" "$MODE_LABEL" | sed -E 's/(.{55}).*/\1/'
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo "운영 명령:"
echo "  install/start.sh    - 시작 (이미 빌드된 경우 빠른 재시작)"
echo "  install/stop.sh     - 중지"
echo "  install/update.sh   - 코드 업데이트 후 재빌드"
echo "  install/uninstall.sh - 완전 제거 (DATABASE 보존 선택 가능)"
echo ""
