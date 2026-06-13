// ============================================================
// Smart Bath Guard — ESP32 통합 펌웨어
// 센서(VL53L1X + mmWave + Door) + WiFi/HTTP + DFPlayer + Pico
// ============================================================
// 라이브러리 설치 (Arduino IDE → 라이브러리 관리):
//   - SparkFun VL53L1X 4m Laser Distance Sensor
//   - DFRobotDFPlayerMini
//   - ArduinoJson
//
// 부품 배선:
//   VL53L1X SDA  → GPIO21      VCC → 3.3V, GND → GND
//   VL53L1X SCL  → GPIO22
//   mmWave OUT   → GPIO4       (HIGH=사람 있음)
//   Door(BL0303) → GPIO15      (INPUT_PULLUP, LOW=닫힘)
//   Button       → GPIO18      (INPUT_PULLUP, LOW=눌림)
//   LED (내장)   → GPIO2
//   DFPlayer RX  → GPIO33,  DFPlayer TX → GPIO32  (UART1)
//
//   [Pico 연결 — pico.ino 기준]
//   ESP32 GPIO17(TX) → Pico GP1(RX)   ESP32 GND → Pico GND
//   Pico GP14 → 서보 PWM(주황)
//   pico.ino: picoSerial.println(angle) 수신 → 서보 이동
// ============================================================

#include "config.h"
#include <Wire.h>
#include "SparkFun_VL53L1X.h"
#include <HardwareSerial.h>
#include <DFRobotDFPlayerMini.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ── 센서 ─────────────────────────────────────────────────────
SFEVL53L1X distanceSensor;

// ── UART ─────────────────────────────────────────────────────
HardwareSerial picoSerial(2);    // UART2: 각도 명령 → Pico
HardwareSerial dfSerial(1);      // UART1: DFPlayer
DFRobotDFPlayerMini dfPlayer;

// ── 타이머 ───────────────────────────────────────────────────
unsigned long lastDataMs   = 0;
unsigned long lastAudioMs  = 0;
unsigned long lastWifiRetry = 0;
const unsigned long WIFI_RETRY_INTERVAL_MS = 30000;  // 30초마다 재시도

// ── 설치 환경 상수 ────────────────────────────────────────────
const float SENSOR_HEIGHT_CM   = 140.0;  // 센서 설치 높이 (cm)
const float COS_45             = 0.7071; // 센서 기울기 보정
const float FALL_DROP_CM       = 30.0;   // 낙상 판단 높이 감소량
const float MIN_FALL_HEIGHT_CM = 5.0;    // 낙상 판단 최소 높이
const float MAX_FALL_HEIGHT_CM = 90.0;   // 낙상 판단 최대 높이

const unsigned long LOW_HOLD_TIME      = 20000; // 낙상 후보 유지 시간 (ms)
const unsigned long RESPONSE_WAIT_TIME = 10000; // 응답 대기 시간 (ms)
const int MIN_CHANGED_ANGLES           = 2;     // 낙상 판단 최소 변화 각도 수

// ── 서보 스캔 각도 ────────────────────────────────────────────
int angles[]         = {20, 35, 50, 65, 80, 95, 110, 125};
const int angleCount = 8;
int angleIndex       = 0;
int direction        = 1;
int lastSentAngle    = -1;

// ── 각도별 측정값 저장 ─────────────────────────────────────────
float baselineHeightByAngle[angleCount];
float currentHeightByAngle[angleCount];
bool  angleChangedByAngle[angleCount];
bool  angleMeasuredByAngle[angleCount];

// ── 시스템 상태 ───────────────────────────────────────────────
bool baselineReady    = false;
bool detectionStarted = false;
bool bathroomWasInUse = false;

bool fallCandidate   = false;
bool waitingResponse = false;
bool fallDetected    = false;

int   candidateAngleIndex  = -1;
float candidateBaseHeight  = -1.0;
unsigned long candidateStartTime = 0;
unsigned long responseStartTime  = 0;


// ════════════════════════════════════════════════════════════
// WiFi
// ════════════════════════════════════════════════════════════
void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  unsigned long now = millis();
  if (now - lastWifiRetry < WIFI_RETRY_INTERVAL_MS) return;  // 30초 쿨다운
  lastWifiRetry = now;

  DBGLN("\n[WiFi] 재연결 시도...");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(500);  // 내부 상태 안정화
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < WIFI_RETRY_MAX) {
    delay(500); DBG("."); retry++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    DBGF("\n[WiFi] 재연결 성공: %s\n", WiFi.localIP().toString().c_str());
    digitalWrite(LED_PIN, HIGH);
  } else {
    DBGLN("\n[WiFi] 재연결 실패 — 30초 후 재시도");
    digitalWrite(LED_PIN, LOW);
  }
}


// ════════════════════════════════════════════════════════════
// 서버 통신
// ════════════════════════════════════════════════════════════

// servo_status 문자열 계산
const char* getServoStatus() {
  if (fallDetected || waitingResponse) return "alert";
  if (fallCandidate)                   return "alert";
  if (bathroomWasInUse && detectionStarted) return "scanning";
  return "stopped";
}

// POST /data
void sendSensorData(float height, int angle, bool mmwave, bool doorClosed) {
  if (WiFi.status() != WL_CONNECTED) return;

  const char* tofStatus;
  if (height <= 0)      tofStatus = "error";
  else if (height < 50) tofStatus = "low";
  else                  tofStatus = "normal";

  StaticJsonDocument<256> doc;
  if (height > 0) doc["height"] = serialized(String(height, 1));  // 유효값
  else            doc["height"] = nullptr;                         // null
  doc["angle"]          = angle;
  doc["tof_status"]     = tofStatus;
  doc["mmwave"]         = mmwave;
  doc["door"]           = doorClosed ? "closed" : "open";
  doc["fall_candidate"] = fallCandidate || waitingResponse;
  doc["fall_detected"]  = fallDetected;
  doc["servo_status"]   = getServoStatus();

  // height를 float로 다시 직렬화 (serialized 방식 대신 정확하게)
  if (height > 0) doc["height"] = (float)((int)(height * 10)) / 10.0;

  String payload;
  serializeJson(doc, payload);

  HTTPClient http;
  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/data";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(2000);

  int code = http.POST(payload);
  if (code == 200) {
    DBGF("[DATA] h=%.1f a=%d %s fall_c=%d fall_d=%d\n",
         height, angle, doorClosed ? "closed" : "open",
         (int)(fallCandidate || waitingResponse), (int)fallDetected);
    digitalWrite(LED_PIN, HIGH);
  } else {
    DBGF("[DATA] 전송 실패: HTTP %d (%s:%d)\n", code, SERVER_IP, SERVER_PORT);
    digitalWrite(LED_PIN, LOW);
  }
  http.end();
}

// GET /esp32/audio-command (500ms 폴링)
void pollAudioCommand() {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/esp32/audio-command";
  http.begin(url);
  http.setTimeout(800);

  int code = http.GET();
  if (code == 200) {
    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, http.getString()) == DeserializationError::Ok) {
      const char* cmd = doc["command"];
      if (cmd && strcmp(cmd, "none") != 0) {
        if (strcmp(cmd, "play") == 0) {
          int track = doc["track"] | 1;
          dfPlayer.play(track);
          DBGF("[AUDIO] 서버 명령: play %d\n", track);
        } else if (strcmp(cmd, "stop") == 0) {
          dfPlayer.stop();
          DBGLN("[AUDIO] 서버 명령: stop");
        } else if (strcmp(cmd, "volume") == 0) {
          int vol = constrain((int)(doc["value"] | 15), 0, 30);
          dfPlayer.volume(vol);
          DBGF("[AUDIO] 서버 명령: volume %d\n", vol);
        }
      }
    }
  }
  http.end();
}

// POST /button/press
void postButtonPress() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String("http://") + SERVER_IP + ":" + SERVER_PORT + "/button/press";
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST("{}");
  DBGF("[BUTTON] 서버 응답: HTTP %d\n", code);
  http.end();
}


// ════════════════════════════════════════════════════════════
// 유틸리티
// ════════════════════════════════════════════════════════════
void sendAngleToPico(int angle) {
  if (angle == lastSentAngle) return;
  picoSerial.println(angle);
  lastSentAngle = angle;
  DBGF("[PICO] 각도 명령: %d°\n", angle);
}

bool isDoorClosed() {
  return digitalRead(DOOR_PIN) == LOW;
}

bool buttonClick() {
  static bool lastState = HIGH;
  bool curr = digitalRead(BUTTON_PIN);
  if (lastState == HIGH && curr == LOW) {
    delay(50);
    lastState = curr;
    return true;
  }
  lastState = curr;
  return false;
}

void clearAngleChangeStates() {
  for (int i = 0; i < angleCount; i++) {
    currentHeightByAngle[i] = -1;
    angleChangedByAngle[i]  = false;
    angleMeasuredByAngle[i] = false;
  }
}

int countChangedAround(int idx) {
  int count = 0;
  for (int i = idx - 1; i <= idx + 1; i++) {
    if (i < 0 || i >= angleCount) continue;
    if (angleMeasuredByAngle[i] && angleChangedByAngle[i]) count++;
  }
  return count;
}

void updateServoIndex() {
  angleIndex += direction;
  if (angleIndex >= angleCount - 1) { angleIndex = angleCount - 1; direction = -1; }
  if (angleIndex <= 0)               { angleIndex = 0;             direction =  1; }
}

void holdCandidateAngle() {
  if (candidateAngleIndex >= 0) sendAngleToPico(angles[candidateAngleIndex]);
}

int safeCandidateAngle() {
  return (candidateAngleIndex >= 0) ? angles[candidateAngleIndex] : 90;
}


// ════════════════════════════════════════════════════════════
// VL53L1X ToF 거리 측정 (중앙값 필터)
// ════════════════════════════════════════════════════════════
float readAverageDistanceCM() {
  const int N = 10;
  float values[N];
  int valid = 0;

  for (int i = 0; i < N; i++) {
    unsigned long t = millis();
    while (!distanceSensor.checkForDataReady()) {
      if (millis() - t > 300) break;
      delay(5);
    }
    if (distanceSensor.checkForDataReady()) {
      float cm = distanceSensor.getDistance() / 10.0;
      distanceSensor.clearInterrupt();
      if (cm > 3.0 && cm < 350.0) values[valid++] = cm;
    }
    delay(50);
  }

  if (valid == 0) return -1.0;

  for (int i = 0; i < valid - 1; i++)
    for (int j = i + 1; j < valid; j++)
      if (values[i] > values[j]) { float t = values[i]; values[i] = values[j]; values[j] = t; }

  return (valid % 2 == 1) ? values[valid / 2]
                           : (values[valid/2 - 1] + values[valid/2]) / 2.0;
}

float getCurrentHeight() {
  float dist = readAverageDistanceCM();
  if (dist < 0) return -1.0;
  float h = SENSOR_HEIGHT_CM - (dist * COS_45);
  return (h < 0) ? 0.0 : h;
}


// ════════════════════════════════════════════════════════════
// DFPlayer 로컬 제어
// ════════════════════════════════════════════════════════════
void playAudioRepeat(int fileNum, int times, int delayMs) {
  for (int i = 0; i < times; i++) {
    dfPlayer.play(fileNum);
    DBGF("[AUDIO] 로컬 재생: %d번 (%d/%d)\n", fileNum, i+1, times);
    delay(delayMs);
  }
}


// ════════════════════════════════════════════════════════════
// 낙상 상태 전환
// ════════════════════════════════════════════════════════════
void resetFallState() {
  fallCandidate = false; waitingResponse = false; fallDetected = false;
  candidateAngleIndex = -1; candidateBaseHeight = -1.0;
  candidateStartTime  = 0;  responseStartTime   = 0;
  clearAngleChangeStates();
  sendAngleToPico(90);
  delay(500);
}

void returnToNormalAndPlayMusic(float h, bool mmwave, bool doorClosed) {
  DBGLN("[STATE] 정상 복귀 → 배경음악");
  resetFallState();
  dfPlayer.stop(); delay(300);
  dfPlayer.volume(15); dfPlayer.loop(3);
  bathroomWasInUse = true;
  angleIndex = 0; direction = 1;
  sendSensorData(h, 90, mmwave, doorClosed);
}


// ════════════════════════════════════════════════════════════
// 초기값 저장
// ════════════════════════════════════════════════════════════
void saveBaseline() {
  DBGLN("===== 초기값 저장 시작 =====");
  for (int i = 0; i < angleCount; i++) {
    sendAngleToPico(angles[i]);
    delay(1500);
    float h = getCurrentHeight();
    baselineHeightByAngle[i] = h;
    if (h < 0) DBGF("각도 %d° 기준높이: 측정 실패\n", angles[i]);
    else        DBGF("각도 %d° 기준높이: %.1f cm\n", angles[i], h);
  }
  baselineReady = true;
  clearAngleChangeStates();
  sendAngleToPico(90);
  DBGLN("===== 초기값 저장 완료 =====");
  DBGLN("버튼을 한 번 더 누르면 감지를 시작합니다.");
}


// ════════════════════════════════════════════════════════════
// setup()
// ════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);
  delay(1000);
  DBGLN("\n========================================");
  DBGLN("  Smart Bath Guard — ESP32 통합 펌웨어");
  DBGLN("========================================");

  pinMode(LED_PIN,    OUTPUT);  digitalWrite(LED_PIN, LOW);
  pinMode(MMWAVE_PIN, INPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(DOOR_PIN,   INPUT_PULLUP);

  // Pico UART (각도 명령 송신)
  picoSerial.begin(PICO_BAUD, SERIAL_8N1, PICO_RX_PIN, PICO_TX_PIN);
  DBGLN("[OK] Pico UART 초기화 (TX=GPIO" + String(PICO_TX_PIN) + ")");

  // DFPlayer
  dfSerial.begin(DFPLAYER_BAUD, SERIAL_8N1, DFPLAYER_RX, DFPLAYER_TX);
  if (!dfPlayer.begin(dfSerial)) {
    DBGLN("[ERROR] DFPlayer 초기화 실패 — SD카드/배선 확인");
  } else {
    DBGLN("[OK] DFPlayer 초기화 완료");
    dfPlayer.volume(15);
  }

  // VL53L1X
  Wire.begin(SDA_PIN, SCL_PIN);
  if (distanceSensor.begin() != 0) {
    DBGLN("[ERROR] VL53L1X 센서를 찾을 수 없습니다. 배선 확인.");
    while (1);
  }
  distanceSensor.setDistanceModeLong();
  distanceSensor.setTimingBudgetInMs(50);
  distanceSensor.setIntermeasurementPeriod(100);
  distanceSensor.startRanging();
  DBGLN("[OK] VL53L1X ToF 초기화 완료");

  // WiFi
  DBGF("[WiFi] SSID: %s\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < WIFI_RETRY_MAX * 2) {
    delay(500); DBG("."); retry++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    DBGF("\n[WiFi] 연결됨: %s\n", WiFi.localIP().toString().c_str());
    DBGF("[Server] http://%s:%d\n", SERVER_IP, SERVER_PORT);
    digitalWrite(LED_PIN, HIGH);
  } else {
    DBGLN("\n[WiFi] 연결 실패 — 오프라인 모드 (센서는 정상 동작)");
  }

  clearAngleChangeStates();
  sendAngleToPico(90);

  DBGLN("========================================");
  DBGLN("버튼 1회 → 초기값 저장");
  DBGLN("버튼 2회 → 감지 시작");
}


// ════════════════════════════════════════════════════════════
// loop()
// ════════════════════════════════════════════════════════════
void loop() {
  ensureWiFi();

  bool doorClosed     = isDoorClosed();
  bool personDetected = digitalRead(MMWAVE_PIN) == HIGH;
  unsigned long now   = millis();

  // 오디오 명령 폴링 (500ms마다)
  if (now - lastAudioMs >= AUDIO_INTERVAL_MS) {
    lastAudioMs = now;
    pollAudioCommand();
  }

  // ── 1단계: 초기값 저장 대기 ──────────────────────────────
  if (!baselineReady) {
    if (buttonClick()) saveBaseline();
    delay(100);
    return;
  }

  // ── 2단계: 감지 시작 대기 ────────────────────────────────
  if (!detectionStarted) {
    if (buttonClick()) {
      detectionStarted = true;
      DBGLN("[STATE] 낙상 감지 시작");
      dfPlayer.volume(15);
      dfPlayer.loop(3);
      bathroomWasInUse = true;
      angleIndex = 0;
      direction  = 1;
      clearAngleChangeStates();
    }
    delay(100);
    return;
  }

  // ── 사람 없음 → 대기 ─────────────────────────────────────
  if (!personDetected && !fallCandidate && !waitingResponse && !fallDetected) {
    if (bathroomWasInUse) {
      DBGF("[STATE] 사람 없음 → 대기 | 문: %s\n", doorClosed ? "닫힘" : "열림");
      dfPlayer.stop();
      sendAngleToPico(90);
      bathroomWasInUse = false;
      clearAngleChangeStates();
      sendSensorData(0.0, 90, false, doorClosed);
      lastDataMs = now;
    }
    // 주기적으로 서버에 상태 전송 (연결 유지)
    if (now - lastDataMs >= DATA_INTERVAL_MS) {
      lastDataMs = now;
      sendSensorData(0.0, 90, false, doorClosed);
    }
    delay(1000);
    return;
  }

  // ── 사람 재감지 → 배경음악 재생 ──────────────────────────
  if (personDetected && !bathroomWasInUse && !fallCandidate && !waitingResponse && !fallDetected) {
    DBGLN("[STATE] 사람 감지 → 배경음악");
    dfPlayer.volume(15);
    dfPlayer.loop(3);
    bathroomWasInUse = true;
    clearAngleChangeStates();
  }

  // ── 응답 대기 상태 (낙상 의심 → 10초 안에 버튼 응답) ─────
  if (waitingResponse) {
    holdCandidateAngle();
    unsigned long dur = millis() - responseStartTime;
    DBGF("[STATE] 응답 대기: %lu초\n", dur / 1000);

    if (buttonClick()) {
      DBGLN("[STATE] 버튼 응답 확인 → 정상 복귀");
      postButtonPress();
      float h = getCurrentHeight();
      returnToNormalAndPlayMusic(h, personDetected, doorClosed);
      delay(500);
      return;
    }

    if (dur >= RESPONSE_WAIT_TIME) {
      waitingResponse = false;
      fallDetected    = true;
      DBGLN("[STATE] 응답 없음 → FALL DETECTED");
      dfPlayer.stop();
      delay(300);
      dfPlayer.volume(25);
      playAudioRepeat(2, 3, 6500);
      // 서버에 즉시 전송
      sendSensorData(getCurrentHeight(), safeCandidateAngle(), personDetected, doorClosed);
      lastDataMs = now;
    }

    if (now - lastDataMs >= DATA_INTERVAL_MS) {
      lastDataMs = now;
      sendSensorData(getCurrentHeight(), safeCandidateAngle(), personDetected, doorClosed);
    }
    delay(500);
    return;
  }

  // ── FALL 확정 상태 ────────────────────────────────────────
  if (fallDetected) {
    holdCandidateAngle();
    DBGLN("[STATE] FALL DETECTED 유지");

    if (buttonClick()) {
      DBGLN("[STATE] FALL 버튼 응답 → 정상 복귀");
      postButtonPress();
      float h = getCurrentHeight();
      returnToNormalAndPlayMusic(h, personDetected, doorClosed);
      delay(500);
      return;
    }

    if (now - lastDataMs >= DATA_INTERVAL_MS) {
      lastDataMs = now;
      sendSensorData(getCurrentHeight(), safeCandidateAngle(), personDetected, doorClosed);
    }
    delay(1000);
    return;
  }

  // ── 낙상 후보 확인 ────────────────────────────────────────
  if (fallCandidate) {
    holdCandidateAngle();
    float h = getCurrentHeight();

    if (h < 0) {
      DBGLN("[STATE] 후보 확인 | ToF 실패");
      delay(500);
      return;
    }

    bool validLow = (h >= MIN_FALL_HEIGHT_CM && h <= MAX_FALL_HEIGHT_CM);
    DBGF("[STATE] 낙상 후보 | 각도:%d° 높이:%.1f mmWave:%s\n",
         angles[candidateAngleIndex], h, personDetected ? "있음" : "없음");

    if (validLow && h <= candidateBaseHeight - FALL_DROP_CM) {
      unsigned long dur = millis() - candidateStartTime;
      DBGF("[STATE] 낮은상태 유지: %lu초\n", dur / 1000);

      if (dur >= LOW_HOLD_TIME) {
        if (personDetected) {
          DBGLN("[STATE] 낙상 의심 → 안내 3회 재생");
          dfPlayer.stop();
          delay(300);
          dfPlayer.volume(25);
          playAudioRepeat(1, 3, 4500);
          waitingResponse   = true;
          responseStartTime = millis();
          sendSensorData(h, angles[candidateAngleIndex], personDetected, doorClosed);
          lastDataMs = now;
        } else {
          DBGLN("[STATE] 사람 없음 → 오탐 복귀");
          resetFallState();
        }
      }
    } else {
      DBGLN("[STATE] 낮은상태 아님 → 정상 복귀");
      resetFallState();
      dfPlayer.volume(15);
      dfPlayer.loop(3);
      sendSensorData(h, angles[angleIndex], personDetected, doorClosed);
      lastDataMs = now;
    }

    if (now - lastDataMs >= DATA_INTERVAL_MS) {
      lastDataMs = now;
      sendSensorData(h, angles[candidateAngleIndex], personDetected, doorClosed);
    }
    delay(500);
    return;
  }

  // ── 평상시 ToF 다각도 스캔 ────────────────────────────────
  int currAngle = angles[angleIndex];
  sendAngleToPico(currAngle);
  delay(1200);   // 서보 안정화 대기

  float h = getCurrentHeight();

  // 주기적 서버 전송 (3초마다)
  if (now - lastDataMs >= DATA_INTERVAL_MS) {
    lastDataMs = now;
    sendSensorData(h > 0 ? h : 0.0, currAngle, personDetected, doorClosed);
  }

  if (h < 0) {
    DBGF("[SCAN] 각도:%d° | ToF 실패\n", currAngle);
    updateServoIndex();
    delay(300);
    return;
  }

  float drop       = baselineHeightByAngle[angleIndex] - h;
  bool  validFall  = (h >= MIN_FALL_HEIGHT_CM && h <= MAX_FALL_HEIGHT_CM);

  currentHeightByAngle[angleIndex] = h;
  angleMeasuredByAngle[angleIndex] = true;
  angleChangedByAngle[angleIndex]  = (drop >= FALL_DROP_CM && validFall);

  int changedAround = countChangedAround(angleIndex);

  DBGF("[SCAN] 각도:%d° 기준:%.1f 현재:%.1f 감소:%.1f 변화:%d mmWave:%s 문:%s\n",
       currAngle,
       baselineHeightByAngle[angleIndex], h, drop, changedAround,
       personDetected ? "있음" : "없음",
       doorClosed ? "닫힘" : "열림");

  // 낙상 후보 감지
  if (angleChangedByAngle[angleIndex] && changedAround >= MIN_CHANGED_ANGLES && personDetected) {
    fallCandidate       = true;
    candidateAngleIndex = angleIndex;
    candidateBaseHeight = baselineHeightByAngle[angleIndex];
    candidateStartTime  = millis();
    dfPlayer.stop();
    DBGLN("[SCAN] ★ 낙상 후보 감지 → 서보 각도 고정");
    sendSensorData(h, currAngle, personDetected, doorClosed);
    lastDataMs = now;
    return;
  }

  DBGLN("[SCAN] 정상");
  updateServoIndex();
  delay(300);
}
