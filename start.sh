#!/usr/bin/env bash
# ============================================================
# Smart Bath Guard — 통합 실행 스크립트
# Flask 서버 + Cloudflare Tunnel 을 한 번에 시작합니다.
#
# 사용법:
#   chmod +x start.sh
#   ./start.sh
#
# 옵션:
#   ./start.sh --no-tunnel   Cloudflare Tunnel 없이 Flask만 실행
#   ./start.sh --port 8080   다른 포트로 실행 (기본: 5000)
# ============================================================

set -euo pipefail

# ── 설정 ─────────────────────────────────────────────────
FLASK_PORT=5000
START_TUNNEL=true
LOG_FILE="/tmp/cloudflared_sbg.log"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 인자 파싱 ──────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --no-tunnel) START_TUNNEL=false; shift ;;
    --port)      FLASK_PORT="$2";    shift 2 ;;
    *)           echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── 터미널 색상 ────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; NC='\033[0m'

echo -e "${BOLD}${CYAN}"
echo "╔══════════════════════════════════════════════════════╗"
echo "║        🚿 Smart Bath Guard — 시작 스크립트          ║"
echo "╚══════════════════════════════════════════════════════╝"
echo -e "${NC}"

cd "$SCRIPT_DIR"

# ── 가상환경 활성화 ────────────────────────────────────────
if [ -f "venv/bin/activate" ]; then
  source venv/bin/activate
  echo -e "${GREEN}[OK]${NC} 가상환경 활성화됨"
elif [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
  echo -e "${GREEN}[OK]${NC} 가상환경 활성화됨"
else
  echo -e "${YELLOW}[WARN]${NC} 가상환경 없음 — 시스템 Python 사용"
fi

# ── Flask 서버 백그라운드 시작 ─────────────────────────────
echo -e "${CYAN}[Flask]${NC} 서버 시작 중 (포트 ${FLASK_PORT})…"
FLASK_PORT=$FLASK_PORT python app.py &
FLASK_PID=$!

# Flask가 완전히 뜰 때까지 대기
sleep 2
if ! kill -0 "$FLASK_PID" 2>/dev/null; then
  echo -e "${RED}[ERROR]${NC} Flask 서버 시작 실패. app.py 오류 확인"
  exit 1
fi
echo -e "${GREEN}[OK]${NC} Flask 서버 실행 중 (PID: ${FLASK_PID})"
echo -e "       로컬 접속: ${CYAN}http://localhost:${FLASK_PORT}${NC}"

# ── Cloudflare Tunnel ─────────────────────────────────────
if [ "$START_TUNNEL" = false ]; then
  echo -e "${YELLOW}[INFO]${NC} --no-tunnel 옵션 — Cloudflare 터널 건너뜀"
  echo ""
  echo -e "${GREEN}서버가 실행 중입니다.${NC} Ctrl+C 로 종료."
  wait "$FLASK_PID"
  exit 0
fi

# cloudflared 설치 확인
if ! command -v cloudflared &>/dev/null; then
  echo -e "${YELLOW}[WARN]${NC} cloudflared 미설치 — Tunnel 건너뜀"
  echo ""
  echo -e "  cloudflared 설치 방법 (Raspberry Pi 5 / ARM64):"
  echo -e "  ${CYAN}wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb${NC}"
  echo -e "  ${CYAN}sudo dpkg -i cloudflared-linux-arm64.deb${NC}"
  echo ""
  echo -e "${GREEN}Flask만 실행 중입니다.${NC} Ctrl+C 로 종료."
  wait "$FLASK_PID"
  exit 0
fi

# cloudflared 실행 + 로그 캡처
echo ""
echo -e "${CYAN}[Tunnel]${NC} Cloudflare Tunnel 시작 중…"
rm -f "$LOG_FILE"
cloudflared tunnel --url "http://localhost:${FLASK_PORT}" \
  --no-autoupdate 2>&1 | tee "$LOG_FILE" &
CF_PID=$!

# ── 터널 URL 추출 (최대 30초) ──────────────────────────────
TUNNEL_URL=""
echo -ne "${CYAN}[Tunnel]${NC} URL 대기 중"
for i in $(seq 1 30); do
  sleep 1
  echo -n "."
  TUNNEL_URL=$(grep -oP 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$LOG_FILE" 2>/dev/null | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
done
echo ""

if [ -n "$TUNNEL_URL" ]; then
  # Flask에 터널 URL 전달
  sleep 1
  curl -s -X POST "http://localhost:${FLASK_PORT}/api/tunnel-url" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"${TUNNEL_URL}\"}" > /dev/null 2>&1 || true

  echo ""
  echo -e "${BOLD}${GREEN}"
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║           🌐 외부 접속 링크 (보호자 공유용)              ║"
  echo "║                                                          ║"
  echo -e "║  ${CYAN}${TUNNEL_URL}${GREEN}"
  echo "║                                                          ║"
  echo "║  위 링크를 보호자 스마트폰에 공유하세요.                  ║"
  echo "║  Flask 재시작 없이 터널만 변경해도 대시보드에 자동 반영됩니다. ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo -e "${NC}"
else
  echo -e "${YELLOW}[WARN]${NC} 터널 URL 자동 감지 실패 — ${LOG_FILE} 확인"
  echo -e "       수동으로 실행: ${CYAN}cloudflared tunnel --url http://localhost:${FLASK_PORT}${NC}"
fi

echo -e "${GREEN}시스템 실행 중입니다.${NC} Ctrl+C 로 전체 종료."

# ── 종료 핸들러 ────────────────────────────────────────────
cleanup() {
  echo ""
  echo -e "${YELLOW}[종료]${NC} Flask + Cloudflare Tunnel 종료 중…"
  kill "$FLASK_PID" 2>/dev/null || true
  kill "$CF_PID"    2>/dev/null || true
  echo -e "${GREEN}[완료]${NC} 모든 프로세스 종료됨."
}
trap cleanup INT TERM

wait "$FLASK_PID"
