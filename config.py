# ============================================================
# Smart Bath Guard — 중앙 설정 파일
# ============================================================
# ★ 이 파일 하나만 수정하면 됩니다 ★
#
# ESP32 쪽 설정은 → ESP32_example/config.h 를 함께 수정하세요.
# 환경 변수로도 덮어쓸 수 있습니다:
#   export WIFI_SSID="내 공유기 이름"
#   export ACCESS_CODE="9999"
# ============================================================
import os

# ── 기기 정보 ──────────────────────────────────────────────
DEVICE_NAME    = os.environ.get("DEVICE_NAME",    "Smart Bath Guard #1")
DEVICE_ROOM    = os.environ.get("DEVICE_ROOM",    "욕실")

# ── Flask 서버 ─────────────────────────────────────────────
#   SERVER_PORT: 기본 5000 (변경 시 ESP32 config.h 도 함께 수정)
SERVER_PORT    = int(os.environ.get("SERVER_PORT", 8765))
SECRET_KEY     = os.environ.get("SECRET_KEY",     "change-this-in-production")

# ── 보호자 접근 코드 ───────────────────────────────────────
#   웹 로그인 PIN 번호 (숫자 4자리 권장)
ACCESS_CODE    = os.environ.get("ACCESS_CODE",    "1234")

# ── WiFi 설정 (ESP32에 전달됨) ─────────────────────────────
#   Raspberry Pi 와 ESP32 가 같은 공유기에 연결되어야 합니다.
#   웹 설정 페이지(http://<서버IP>:5000/settings)에서도 변경 가능
WIFI_SSID      = os.environ.get("WIFI_SSID",      "MyWifi")
WIFI_PASSWORD  = os.environ.get("WIFI_PASSWORD",  "password")

# ── ESP32 연결 감시 ────────────────────────────────────────
#   이 시간(초) 동안 데이터가 없으면 "연결 끊김"으로 표시
ESP32_TIMEOUT_S = int(os.environ.get("ESP32_TIMEOUT_S", 15))
