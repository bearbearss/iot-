# 🚿 Smart Bath Guard — 욕실 낙상 감지 AI 대시보드

> **ESP32 → Raspberry Pi 5 Flask 서버 → Cloudflare Tunnel → 보호자 외부 접속**

---

## 시스템 구조

```
[욕실 내부]                    [Raspberry Pi 5]              [인터넷]
┌──────────────────┐  HTTP     ┌──────────────────┐  Tunnel  ┌─────────────────────┐
│  ESP32           │ ──POST──▶ │  Flask (port 5000)│ ───────▶ │  Cloudflare Edge    │
│  · ToF 센서       │           │                  │           │  (자동 HTTPS)        │
│  · mmWave        │           │  · 데이터 수신    │           └──────────┬──────────┘
│  · BL0303 문센서 │           │  · 12-상태 판단   │                      │ HTTPS
│  · DFPlayer Mini │           │  · 이벤트 로그    │                      ▼
│  · 아케이드 버튼  │           │  · 웹 대시보드    │           ┌─────────────────────┐
└──────────────────┘           └──────────────────┘           │   보호자 스마트폰    │
         ↑                                                     │  https://xxxx.xxx   │
    같은 WiFi                                                  └─────────────────────┘
```

---

## 빠른 시작 (Raspberry Pi 5)

### 1. 저장소 클론 & 환경 설정

```bash
git clone https://github.com/bearbearss/iot.git smart_bathroom_dashboard
cd smart_bathroom_dashboard

# 가상환경 생성 및 패키지 설치
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. 접근 코드(PIN) 설정

```bash
cp .env.example .env   # .env.example 이 없으면 직접 생성
nano .env
```

`.env` 파일 내용:
```
ACCESS_CODE=1234
SECRET_KEY=긴랜덤문자열   # python3 -c "import secrets; print(secrets.token_hex(32))"
```

### 3-A. Flask + Cloudflare Tunnel 한 번에 시작 (권장)

```bash
chmod +x start.sh
./start.sh
```

실행 후 자동으로 터널 URL이 출력됩니다:
```
╔════════════════════════════════════════════════════════╗
║           🌐 외부 접속 링크 (보호자 공유용)             ║
║                                                        ║
║  https://xxxx-xxxx.trycloudflare.com                  ║
║                                                        ║
║  위 링크를 보호자 스마트폰에 공유하세요.                 ║
╚════════════════════════════════════════════════════════╝
```

### 3-B. Flask만 실행 (로컬 테스트용)

```bash
./start.sh --no-tunnel
# 또는
source venv/bin/activate
python app.py
```

---

## Cloudflare Tunnel 상세 가이드

### cloudflared 설치 (Raspberry Pi 5 / ARM64)

```bash
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb
cloudflared --version   # 설치 확인
```

### 임시 터널 (수동 실행)

```bash
# 방법 1: start.sh 사용 (권장)
./start.sh

# 방법 2: 별도 터미널에서 직접 실행
cloudflared tunnel --url http://localhost:5000
```

출력 예시:
```
2024-01-01T00:00:00Z INF |  https://abc123-def456.trycloudflare.com  |
```
→ 이 URL을 보호자에게 공유하면 됩니다.

### 외부 접속 흐름

```
보호자 스마트폰 브라우저
  → https://xxxx.trycloudflare.com/login   (접근 코드 입력)
  → https://xxxx.trycloudflare.com/        (실시간 대시보드)
  → 1초마다 자동 갱신 · 낙상 감지 시 즉시 알림
```

> **주의**: `trycloudflare.com` 임시 터널은 재시작마다 URL이 바뀝니다.
> 고정 URL이 필요하면 Cloudflare Zero Trust → Networks → Tunnels 에서 Named Tunnel을 설정하세요.

---

## ESP32 연결 설정

`ESP32_example/config.h` 파일만 수정하면 됩니다:

```cpp
#define WIFI_SSID       "공유기이름"      // ← 수정
#define WIFI_PASSWORD   "WiFi비밀번호"   // ← 수정
#define SERVER_IP       "192.168.0.15"  // ← Raspberry Pi IP (hostname -I 로 확인)
#define SERVER_PORT     5000
```

**Raspberry Pi IP 확인:**
```bash
hostname -I
# 예: 192.168.0.15
```

ESP32는 **같은 WiFi** 안에서 `http://192.168.0.15:5000/data` 로 POST합니다.
Cloudflare Tunnel은 외부 보호자의 접속용이며, ESP32는 터널을 거치지 않아도 됩니다.

---

## 폴더 구조

```
smart_bathroom_dashboard/
├── app.py                    # Flask 서버 (API + 로그인 + 상태 머신)
├── config.py                 # 기본 설정 (환경변수 오버라이드 지원)
├── start.sh                  # 통합 시작 스크립트 (Flask + cloudflared)
├── requirements.txt          # pip 패키지 목록
├── .env.example              # 환경변수 예시
├── templates/
│   ├── login.html            # 보호자 로그인 페이지
│   ├── index.html            # 메인 대시보드
│   ├── settings.html         # 시스템 설정 페이지
│   └── dev_console.html      # 개발자 디버그 콘솔
├── static/
│   ├── style.css             # 다크 IoT 테마 스타일
│   └── script.js             # 실시간 폴링 + 상태 머신 UI
└── ESP32_example/
    ├── config.h              # ★ WiFi/서버 설정 (여기만 수정)
    ├── ESP32_dfplayer.ino    # ESP32 메인 펌웨어
    └── ESP32_setup_ap.ino    # 최초 설정용 AP 모드 펌웨어
```

---

## 주요 기능

| 기능 | 설명 |
|------|------|
| 12-상태 AI 상태 머신 | EMPTY → DOOR_OPEN → ENTERING → OCCUPIED → … → GUARDIAN_ALERTED |
| 실시간 센서 대시보드 | 1초 간격 갱신 · 욕실 캔버스 맵 · 레이더 차트 |
| 낙상 응답 대기 | 60초 카운트다운 · LED 아케이드 버튼 연동 |
| DFPlayer Mini | SD카드 5개 트랙 자동 재생 (입실/낙상/음성 안내) |
| BL0303 문센서 | 입실/퇴실 자동 판단 + 장시간 체류 경고 |
| Cloudflare Tunnel | start.sh 실행 시 외부 링크 자동 생성 + 대시보드 표시 |
| 개발자 콘솔 | 실시간 JSON 뷰 · API 직접 테스트 · 하드웨어 체크리스트 |

---

## API 엔드포인트

| 경로 | 메서드 | 인증 | 설명 |
|------|--------|------|------|
| `/login` | GET/POST | 불필요 | 보호자 로그인 |
| `/` | GET | **필요** | 메인 대시보드 |
| `/settings` | GET | **필요** | 시스템 설정 |
| `/dev-console` | GET | **필요** | 개발자 콘솔 |
| `/api/latest` | GET | **필요** | 최신 센서+상태 |
| `/api/logs` | GET | **필요** | 최근 로그 20개 |
| `/api/events` | GET | **필요** | 실시간 이벤트 |
| `/api/settings` | GET/POST | **필요** | 설정 읽기/저장 |
| `/api/tunnel-url` | GET/POST | 불필요 | 터널 URL 조회/등록 |
| `/data` | POST | 불필요 | ESP32 센서 데이터 수신 |
| `/esp32/audio-command` | GET | 불필요 | ESP32 오디오 명령 폴링 |
| `/button/press` | POST | 불필요 | 아케이드 버튼 눌림 |
| `/test/*` | POST | **필요** | 시나리오 시뮬레이션 |

---

## curl 테스트

```bash
# ESP32 역할 — 센서 데이터 전송
curl -X POST http://localhost:5000/data \
  -H "Content-Type: application/json" \
  -d '{"height":165,"angle":88,"tof_status":"normal","mmwave":true,"door":"closed","fall_candidate":false,"fall_detected":false,"servo_status":"stopped"}'

# 터널 URL 조회
curl http://localhost:5000/api/tunnel-url

# 터널 URL 수동 등록 (start.sh 없이 직접 설정)
curl -X POST http://localhost:5000/api/tunnel-url \
  -H "Content-Type: application/json" \
  -d '{"url":"https://xxxx.trycloudflare.com"}'
```

---

## 오류 체크리스트

| 증상 | 확인 사항 |
|------|-----------|
| 페이지가 안 열림 | `python app.py` 또는 `./start.sh` 실행 중인지 확인 |
| 로그인 실패 | `.env`의 `ACCESS_CODE` 확인 |
| ESP32 전송 실패 | `SERVER_IP`가 Raspberry Pi IP와 일치하는지, 같은 WiFi인지 확인 |
| cloudflared 없음 | 위 설치 명령어로 설치 후 `./start.sh` 재실행 |
| 터널 URL이 대시보드에 안 보임 | `start.sh`를 사용해야 자동 등록됨. 수동 실행 시 curl로 등록 |
| 세션이 자꾸 끊김 | `.env`의 `SECRET_KEY`가 고정값인지 확인 |

---

## 코드 업데이트 후 GitHub 푸시

```bash
git add .
git commit -m "update: 기능 추가 내용"
git push origin main
```
