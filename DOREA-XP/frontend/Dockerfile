# Frontend Dockerfile

FROM node:18-alpine as builder

WORKDIR /app

# ── 사내망 SSL 인터셉션 환경 우회 ──
#   npm  : strict-ssl off
#   git  : http.sslVerify off (npm 의존성에 git+https 가 있을 때 대비)
#   node : NODE_TLS_REJECT_UNAUTHORIZED=0 (빌드 중 https 요청 전반)
#   apk  : --no-check-certificate (Alpine 패키지 매니저)
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV GIT_SSL_NO_VERIFY=1
RUN npm config set strict-ssl false \
 && git config --global http.sslVerify false 2>/dev/null || true

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
