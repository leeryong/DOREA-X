FROM python:3.11-slim

# ── 사내망 SSL 인터셉션 환경 우회 (pip / apt / git) ──
ENV PIP_TRUSTED_HOST="pypi.org files.pythonhosted.org pypi.python.org"
ENV GIT_SSL_NO_VERIFY=1
RUN printf 'Acquire { https::Verify-Peer "false"; https::Verify-Host "false"; }\n' \
      > /etc/apt/apt.conf.d/99-insecure-ssl \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list 2>/dev/null || true \
 && sed -i 's|http://|https://|g' /etc/apt/sources.list.d/*.sources 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
    openjdk-21-jre-headless supervisor \
    libxcb1 libx11-6 libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY supervisord.conf ./
COPY start.sh ./
RUN chmod +x start.sh

EXPOSE 8005

CMD ["./start.sh"]
