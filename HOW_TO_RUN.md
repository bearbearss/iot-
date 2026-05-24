# Smart Bath Guard — 실행 가이드

## 전체 흐름 요약

```
ESP32 (같은 WiFi)
  └─ POST /data → Raspberry Pi 5 (Flask :5000)
                       └─ Cloudflare Tunnel → 외부 URL → 보호자 스마트폰
```

---

## 1. 최초 설치 (1회만)

```bash
# 프로젝트 폴더로 이동
cd smart_bathroom_dashboard

# 가상환경 생성
python3 -m venv venv
source venv/bin/activate

# 패키지 설치
pip install -r requirements.txt

# 접근 코드 설정
cp .env.example .env      # 없으면: echo "ACCESS_CODE=1234" > .env
nano .env                  # ACCESS_CODE 값 변경
```

---

## 2. 서버 + 터널 시작 (매번)

### 방법 A: 통합 스크립트 (권장)

```bash
./start.sh
```

- Flask 서버 자동 시작 (포트 5000)
- Cloudflare Tunnel 자동 시작 + URL 캡처
- 터널 URL을 대시보드에 자동 등록
- Ctrl+C 시 Flask + cloudflared 모두 종료

### 방법 B: Flask만 (cloudflared 미설치 시)

```bash
source venv/bin/activate
python app.py
```

---

## 3. cloudflared 설치 (미설치 시)

```bash
# Raspberry Pi 5 (ARM64)
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i cloudflared-linux-arm64.deb

# 설치 확인
cloudflared --version
```

---

## 4. Raspberry Pi IP 확인 (ESP32 config.h 에 입력)

```bash
hostname -I
# 예: 192.168.0.15  ← 이 값을 ESP32 config.h 의 SERVER_IP 에 입력
```

---

## 5. 접속 주소

| 접속 위치 | 주소 |
|-----------|------|
| Raspberry Pi 로컬 | http://localhost:5000 |
| 같은 WiFi 기기 | http://192.168.0.15:5000 |
| 외부 (보호자) | https://xxxx.trycloudflare.com (start.sh 실행 후 출력됨) |

---

## 6. ESP32 없이 테스트

브라우저에서 대시보드 접속 → 하단 **🧪 시연 테스트** 버튼 클릭:

- ✅ 정상 상태
- 📉 높이 급감
- ⚠️ 낙상 의심
- 🆘 낙상 감지
- 🚶 입실 / 🚪 퇴실 / ⏱ 장시간 체류

또는 curl:
```bash
curl -X POST http://localhost:5000/test/fall
curl -X POST http://localhost:5000/test/normal
```

---

## 7. 오류 체크리스트

| 증상 | 해결 |
|------|------|
| 포트 5000 이미 사용 중 | `lsof -i :5000` 으로 PID 확인 후 `kill <PID>` |
| cloudflared URL 안 나옴 | `/tmp/cloudflared_sbg.log` 확인 |
| ESP32 전송 실패 | `SERVER_IP` = Raspberry Pi IP, 같은 WiFi 확인 |
| 로그인 안 됨 | `.env` 의 `ACCESS_CODE` 확인 |
| pip 오류 | `source venv/bin/activate` 후 재시도 |
