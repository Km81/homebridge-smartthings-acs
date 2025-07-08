# 사용 하지 말 것 - 아직 테스트 중 (Don't Use - Testing)

# Homebridge SmartThings ACs

[![npm version](https://badge.fury.io/js/homebridge-smartthings-acs.svg)](https://badge.fury.io/js/homebridge-smartthings-acs)

`homebridge-smartthings-acs`는 SmartThings 에어컨을 HomeKit에 연동하고, **웹훅(Webhook)을 통한 실시간 상태 업데이트**를 지원하는 고성능 Homebridge 플러그인입니다.

## 핵심 기능

* **실시간 상태 동기화 (웹훅)**: SmartThings 앱이나 다른 방법으로 에어컨 상태를 변경하면, 웹훅을 통해 거의 즉시 HomeKit에 상태가 반영됩니다.
* **안전하고 영구적인 인증 (OAuth 2.0)**: 한 번의 설정으로 토큰이 자동 갱신되는 안정적인 인증 방식을 사용합니다.
* **다중 디바이스 지원**: 여러 대의 에어컨을 `config.json`에 등록하여 한 번에 관리할 수 있습니다.
* **장치별 기능 선택**: `config.json`에서 각 에어컨 모델이 지원하는 부가 기능(무풍, 자동 건조 등)을 선택적으로 활성화할 수 있습니다.
* **안정적인 API 통신**: API 요청 재시도 및 동시성 제어 로직이 포함되어 안정적인 통신을 보장합니다.
* **GUI 설정 지원**: Homebridge UI 환경에서 설정을 쉽게 입력하고 관리할 수 있습니다.

## 사전 준비

1.  **Homebridge**: [Homebridge](https://homebridge.io/)가 설치되어 있어야 합니다.
2.  **Node.js**: **v18.0.0 이상** 버전이 필요합니다.
3.  **공개 접속 가능 주소 및 리버스 프록시**: **(필수)** SmartThings 서버가 외부에서 Homebridge 서버로 접속할 수 있는 `https` 기반의 공개 주소가 필요하며, 이 주소를 내부 `http` 서버로 전달해 줄 리버스 프록시(Reverse Proxy) 설정이 완료되어 있어야 합니다.
4.  **SmartThings CLI**: 아래 설치 과정에서 필요합니다.

## 설치

Homebridge UI의 '플러그인' 탭에서 `homebridge-smartthings-acs`를 검색하여 설치하거나, 터미널에서 아래 명령어를 직접 실행합니다.

```sh
npm install -g homebridge-smartthings-acs
```

---
## 설정 가이드 (리버스 프록시 필수)

이 플러그인은 리버스 프록시 사용을 전제로 설계되었습니다.

* **외부 주소 (리버스 프록시 Source)**: `https://<나의도메인>:<외부포트>`
* **내부 주소 (리버스 프록시 Destination)**: `http://<홈브릿지IP>:8999`

플러그인은 내부적으로 항상 **8999 포트**에서만 요청을 기다립니다.

### 1단계: SmartThings OAuth App 생성

플러그인 설정에 필요한 `clientId`와 `clientSecret`을 발급받습니다. **이 과정은 최초 한 번만 필요합니다.**

#### 1. SmartThings CLI 설치 및 인증
* 터미널에서 `npm install -g @smartthings/cli`를 실행하여 CLI를 설치합니다.
* [SmartThings 개인용 액세스 토큰 페이지](https://account.smartthings.com/tokens)에서 모든 권한을 가진 PAT를 발급받습니다.
* 터미널에서 `export SMARTTHINGS_TOKEN="YOUR_PAT_TOKEN"` 명령어로 인증합니다.

#### 2. OAuth App 생성
* 터미널에서 `smartthings apps:create`를 실행하고 대화형 프롬프트를 따릅니다.
* **`Choose an app type`**: `WEBHOOK_SMART_APP`을 선택합니다.
* **`Display Name`**: 앱의 이름입니다. (예: `Homebridge ACs`)
* **`Target URL`**: **(중요)** 리버스 프록시로 설정한 **외부 `https` 주소**를 입력합니다. 이 주소는 웹훅 수신에 사용됩니다.
    * **예시**: `https://myhome.myds.me:9001` (경로가 있다면 경로까지 포함)
* **`Select Scopes`**: 스페이스바를 눌러 `r:devices:*` 와 `x:devices:*` 권한을 모두 선택하고 엔터를 누릅니다.
* **`Add or edit Redirect URIs`**: `Add Redirect URI`를 선택하고, **위 `Target URL`과 동일한 주소**를 입력합니다.

모든 절차가 완료되면, 터미널에 **OAuth Client Id**와 **OAuth Client Secret** 값이 출력됩니다. 이 값을 복사하여 다음 단계에서 사용합니다.

### 2단계: Homebridge `config.json` 설정

```json
{
  "platform": "SmartThingsACs",
  "name": "SmartThings ACs",
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "redirectUri": "[https://myhome.myds.me:9001](https://myhome.myds.me:9001)",
  "devices": [
    {
      "deviceLabel": "거실 에어컨",
      "model": "AF19B7934WZT",
      "serialNumber": "AC-SERIAL-001",
      "enableWindFree": false,
      "enableAutoClean": false
    },
    {
      "deviceLabel": "안방 에어컨",
      "enableWindFree": true,
      "enableAutoClean": true
    }
  ]
}
```
* **`redirectUri`**: 1단계에서 `Target URL` 및 `Redirect URI`로 등록한 **외부 `https` 공개 주소**를 정확히 동일하게 입력합니다.
* **`devices`**: 홈킷에 추가할 에어컨 목록입니다.
    * `deviceLabel`: SmartThings 앱에 표시되는 에어컨의 이름과 정확히 일치해야 합니다.
    * `model`, `serialNumber`: 홈 앱에 표시할 모델명과 일련번호 (선택 사항).
    * `enableWindFree`, `enableAutoClean`: 해당 에어컨 모델이 API를 통해 무풍, 자동건조 기능을 지원하는 경우에만 체크(`true`)합니다.

### 3단계: 플러그인 최초 인증

1.  설정 저장 후 Homebridge를 **재시작**합니다.
2.  로그에 표시된 **`[스마트싱스 인증 필요]`** 메시지와 인증 URL을 확인합니다.
3.  인증 URL 전체를 복사하여 웹 브라우저에 붙여넣고 접속합니다.
4.  SmartThings 계정으로 로그인하고, 생성한 앱에 대한 권한을 **'허용(Authorize)'** 합니다.
5.  "인증 성공!" 메시지 확인 후 Homebridge를 **다시 한번 재시작**하면 모든 설정이 완료됩니다.
