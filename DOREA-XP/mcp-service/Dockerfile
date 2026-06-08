FROM python:3.11-slim

# ── 사내망 SSL 인터셉션 환경 우회 ──
#   pip : PIP_TRUSTED_HOST
#   uv/uvx : UV_INSECURE_HOST — 런타임에 uvx 가 MCP 패키지(kisti-mcp 등)를 PyPI에서 받을 때 사용
#   apt : SSL 검증 off
ENV PIP_TRUSTED_HOST="pypi.org files.pythonhosted.org pypi.python.org"
ENV UV_INSECURE_HOST="pypi.org files.pythonhosted.org github.com"
ENV GIT_SSL_NO_VERIFY=1
RUN printf 'Acquire { https::Verify-Peer "false"; https::Verify-Host "false"; }\n' \
      > /etc/apt/apt.conf.d/99-insecure-ssl \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list 2>/dev/null || true \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/*.sources 2>/dev/null || true

# Install uv for uvx support
RUN pip install --no-cache-dir uv

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/

EXPOSE 8002

CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8002"]
