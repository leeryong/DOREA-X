# document-converter/Dockerfile

FROM python:3.11-slim

# ── 사내망 SSL 인터셉션 환경 우회 (pip / apt / git / curl) ──
ENV PIP_TRUSTED_HOST="pypi.org files.pythonhosted.org pypi.python.org"
ENV GIT_SSL_NO_VERIFY=1
RUN printf 'Acquire { https::Verify-Peer "false"; https::Verify-Host "false"; }\n' \
      > /etc/apt/apt.conf.d/99-insecure-ssl \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list 2>/dev/null || true \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/*.sources 2>/dev/null || true

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    default-jre-headless \
    fonts-noto-cjk \
    fonts-nanum \
    curl \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/install_h2orestart.sh /usr/local/bin/install_h2orestart
# 번들된 .oxt 를 우선 사용 (오프라인/사내망 대비). 다운로드는 폴백 전용.
COPY vendor/H2Orestart.oxt /opt/h2orestart/H2Orestart.oxt
ENV H2ORESTART_OXT_PATH=/opt/h2orestart/H2Orestart.oxt
ARG H2ORESTART_OXT_URL="https://github.com/ebandal/H2Orestart/releases/download/v0.7.12/H2Orestart.oxt"
ENV H2ORESTART_OXT_URL=${H2ORESTART_OXT_URL}
RUN chmod +x /usr/local/bin/install_h2orestart && /usr/local/bin/install_h2orestart

RUN fc-cache -fv || true

COPY src/ ./src/
COPY tests/ ./tests/
COPY scripts/entrypoint.sh /usr/local/bin/document-converter-entrypoint
COPY scripts/document-converter /usr/local/bin/document-converter
RUN chmod +x /usr/local/bin/document-converter-entrypoint /usr/local/bin/document-converter

ENV PYTHONUNBUFFERED=1
ENV HOME=/tmp
ENV CONVERSION_TIMEOUT_SECONDS=120
ENV PYTHONPATH=/app

EXPOSE 8003

ENTRYPOINT ["/usr/local/bin/document-converter-entrypoint"]
CMD ["serve"]
