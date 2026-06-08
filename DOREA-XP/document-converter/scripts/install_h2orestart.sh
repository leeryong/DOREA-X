#!/usr/bin/env bash
# H2Orestart 설치 — LibreOffice가 HWP/HWPX 파일을 읽을 수 있게 하는 확장.
#
# 설치 우선순위:
#   1) 번들된 로컬 .oxt 파일 (H2ORESTART_OXT_PATH) — 오프라인/사내망에서 가장 확실
#   2) apt 패키지 (libreoffice-h2orestart)
#   3) URL 다운로드 (H2ORESTART_OXT_URL)
#
# 모두 실패해도 빌드를 깨지 않는다 (exit 0). HWP 변환만 비활성화되고
# PDF / Word / Excel / PPT 등 나머지 형식 변환은 정상 동작한다.
set -uo pipefail

install_oxt() {
  local oxt="$1"
  local profile_dir
  profile_dir="$(mktemp -d)"
  HOME="${profile_dir}" unopkg add --shared --verbose "${oxt}"
  local rc=$?
  rm -rf "${profile_dir}"
  return $rc
}

# 1) 번들된 로컬 .oxt 우선
if [[ -n "${H2ORESTART_OXT_PATH:-}" && -f "${H2ORESTART_OXT_PATH}" ]]; then
  echo "[install_h2orestart] using bundled extension: ${H2ORESTART_OXT_PATH}"
  if install_oxt "${H2ORESTART_OXT_PATH}"; then
    echo "[install_h2orestart] installed from bundled .oxt"
    exit 0
  fi
  echo "[install_h2orestart] bundled .oxt install failed — trying other methods"
fi

# 2) apt 패키지
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  if apt-get update && apt-get install -y --no-install-recommends libreoffice-h2orestart; then
    exit 0
  fi
  if apt-get update && apt-get install -y --no-install-recommends h2orestart; then
    exit 0
  fi
  echo "[install_h2orestart] apt package not available"
fi

# 3) URL 다운로드
if [[ -n "${H2ORESTART_OXT_URL:-}" ]]; then
  tmp_dir="$(mktemp -d)"
  oxt_path="${tmp_dir}/h2orestart.oxt"
  # -k: 사내망 SSL 인터셉션 환경 우회
  if curl -fsSLk --max-time 60 "${H2ORESTART_OXT_URL}" -o "${oxt_path}" && install_oxt "${oxt_path}"; then
    rm -rf "${tmp_dir}"
    echo "[install_h2orestart] installed from URL"
    exit 0
  fi
  rm -rf "${tmp_dir}"
  echo "[install_h2orestart] URL download/install failed"
fi

# 모두 실패 — 빌드는 계속 (HWP 변환만 비활성화)
echo "[install_h2orestart] WARNING: H2Orestart not installed. HWP/HWPX conversion will be unavailable; other formats work normally."
exit 0
