# backend/Dockerfile
#
# 호스트 backend/src/services/ 안 보호 대상 15개는 이미 .so 로 갈아 끼워진 상태로
# git 에 올라가 있다 (.py 원본은 호스트/저장소에 없음). 그래서 이 Dockerfile 은
# cythonize 단계 없이 src 트리를 그대로 이미지에 복사만 한다.
#
# 만약 보호 대상 모듈을 수정해서 .so 를 재생성해야 한다면:
#   1) /work/_backup/dorea-xp-backend-py-*.tar.gz 에서 원본 .py 복원
#   2) 수정 후 install/build_so.sh (별도 헬퍼) 로 .so 재생성 → 호스트 갱신
#   3) 다시 .py 삭제 후 commit
#
# 사내망 SSL 인터셉션(중간자 프록시) 대응:
#   pip   : PIP_TRUSTED_HOST 로 신뢰 호스트 지정
#   apt   : SSL 검증 off
#   git   : http.sslVerify off (requirements 에 git+https 있을 때 대비)

FROM python:3.11-slim

ENV PIP_TRUSTED_HOST="pypi.org files.pythonhosted.org pypi.python.org"
ENV GIT_SSL_NO_VERIFY=1
RUN printf 'Acquire { https::Verify-Peer "false"; https::Verify-Host "false"; }\n' \
      > /etc/apt/apt.conf.d/99-insecure-ssl \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list 2>/dev/null || true \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/*.sources 2>/dev/null || true

WORKDIR /app

# 런타임 의존성. docker.io / docker-compose 는 sidecar_runtime 이 호스트
# docker 소켓을 통해 사이드카 자동 기동할 때 필요.
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    postgresql-client \
    curl \
    docker.io \
    docker-compose \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# src 트리 그대로 복사 — .so 와 비변환 .py 가 섞여 있는 상태.
COPY src/ ./src/
COPY templates/ ./templates/

RUN mkdir -p /app/DATABASE

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--app-dir", "/app/src", "--host", "0.0.0.0", "--port", "8000"]
