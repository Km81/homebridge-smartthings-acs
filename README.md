# Homebridge SmartThings ACs

[![npm version](https://badge.fury.io/js/homebridge-smartthings-acs.svg)](https://badge.fury.io/js/homebridge-smartthings-acs)

`homebridge-smartthings-acs`는 SmartThings 에어컨을 HomeKit에 연동하고, **웹훅(Webhook)을 통한 실시간 상태 업데이트**를 지원하는 고성능 Homebridge 플러그인입니다.

## 핵심 기능

* **실시간 상태 동기화 (웹훅)**: SmartThings 앱이나 다른 방법으로 에어컨 상태를 변경하면, 웹훅을 통해 거의 즉시 HomeKit에 상태가 반영됩니다. 이를 통해 자동화가 지연 없이 실행되고, 항상 최신 상태를 확인할 수 있습니다.
* **안전하고 영구적인 인증 (OAuth 2.0)**: 한 번의 설정으로 토큰이 자동 갱신되는 안정적인 인증 방식을 사용합니다.
* **다중 디바이스 지원**: 여러 대의 에어컨을 `config.json`에 등록하여 한 번에 관리할 수 있습니다.
* **커스텀 기능 매핑**:
    * **무풍 모드**: HomeKit의 '스윙' 기능으로 켜고 끌 수 있습니다.
    * **자동 건조 모드**: HomeKit의 '물리 제어 잠금' 기능으로 켜고 끌 수 있습니다.
* **안정적인 API 통신**: API 요청 재시도 및 동시성 제어 로직이 포함되어 안정적인 통신을 보장합니다.
* **GUI 설정 지원**: Homebridge UI 환경에서 설정을 쉽게 입력하고 관리할 수 있습니다.

## 사전 준비

1.  **Homebridge**: [Homebridge](https://homebridge.io/)가 설치되어 있어야 합니다. (Homebridge UI 사용을 권장합니다.)
2.  **Node.js**: **v18.0.0 이상** 버전이 필요합니다.
3.  **공개 접속 가능 주소 (Publicly Accessible URL)**: **(필수)** SmartThings 서버가 외부에서 Homebridge 서버로 접속할 수 있는 공개 주소가 필요합니다. (예: DuckDNS, Synology DDNS 등을 이용한 `https://your-domain.com:port`)
4.  **SmartThings CLI**: 아래 설치 과정에서 필요합니다.

## 설치

Homebridge UI의 '플러그인' 탭에서 `homebridge-smartthings-acs`를 검색하여 설치하거나, 터미널에서 아래 명령어를 직접 실행합니다.

```sh
npm install -g homebridge-smartthings-acs
```

## 설정 가이드

### 1단계: SmartThings OAuth App 및 Webhook 생성

플러그인 설정에 필요한 `clientId`와 `clientSecret`을 발급받고, 실시간 업데이트를 위한 Webhook을 설정합니다. **이 과정은 최초 한 번만 필요합니다.**

#### 1. SmartThings CLI 설치
터미널 앱을 열고 아래 명령어를 실행하여 SmartThings CLI를 설치합니다.
```sh
npm install -g @smartthings/cli
```

#### 2. 개인용 액세스 토큰(PAT) 발급
CLI를 인증하기 위해 임시 토큰이 필요합니다.
1.  [SmartThings 개인용 액세스 토큰 페이지](https://account.smartthings.com/tokens)에 접속하여 로그인합니다.
2.  **'Generate new token'** 버튼을 클릭합니다.
3.  토큰 이름을 입력하고, **모든 권한을 체크**합니다.
4.  토큰을 생성하고, 표시되는 토큰 값을 **반드시 복사**하여 임시로 보관하세요.

#### 3. CLI 인증
터미널로 돌아와, 아래 명령어를 실행하여 방금 발급받은 PAT를 환경 변수로 등록합니다.
```sh
# "YOUR_PAT_TOKEN" 부분을 위에서 복사한 토큰 값으로 변경
export SMARTTHINGS_TOKEN="YOUR_PAT_TOKEN"
```
> Windows의 PowerShell에서는 `$env:SMARTTHINGS_TOKEN="YOUR_PAT_TOKEN"` 을 사용하세요.

#### 4. OAuth App 생성 및 Webhook 설정
아래 명령어를 터미널에 입력하여 `clientId`와 `clientSecret` 발급 절차를 시작합니다.
```sh
smartthings apps:create --webhook
```
명령어를 실행하면 몇 가지 질문이 나타납니다.

* `Display Name`: 앱의 이름입니다. (예: `Homebridge ACs`)
* `Description`: 앱의 설명입니다. (예: `Homebridge Realtime AC Control`)
* `Target URL`: **(매우 중요)** SmartThings가 상태 변경을 알려줄 공개 주소를 입력합니다. 사전 준비에서 마련한 **`webhookUrl`**을 입력해주세요. (예: `https://your-id.duckdns.org/st-webhook`)
* `Select Scopes`: 스페이스바를 눌러 아래 **2가지 권한**을 모두 선택하고 엔터를 누릅니다.
    * `r:devices:*` (장치 읽기)
    * `x:devices:*` (장치 제어)
* `Add or edit Redirect URIs`: **'Add Redirect URI'**를 선택합니다.
* `Redirect URI`: **최초 인증**에 사용할 주소를 입력합니다. 위에서 입력한 `Target URL` 뒤에 `/oauth/callback`을 붙여서 입력하는 것을 권장합니다.
    * 예: `https://your-id.duckdns.org/st-webhook/oauth/callback`
    * 이 값은 다음 `config.json` 설정의 `webhookUrl`과 경로가 일치해야 합니다.
* `Add or edit Redirect URIs`: **'Finish editing Redirect URIs'**를 선택하고 엔터를 누릅니다.

모든 절차가 완료되면, 터미널에 **OAuth Client Id**와 **OAuth Client Secret** 값이 출력됩니다. 이 값을 복사하여 다음 단계에서 사용합니다.

### 2단계: Homebridge `config.json` 설정

Homebridge UI의 설정 화면 또는 `config.json` 파일을 직접 수정하여 아래 내용을 추가합니다.

```json
{
  "platform": "SmartThingsACs",
  "name": "SmartThings ACs",
  "clientId": "YOUR_CLIENT_ID",
  "clientSecret": "YOUR_CLIENT_SECRET",
  "webhookUrl": "[https://your-id.duckdns.org/st-webhook](https://your-id.duckdns.org/st-webhook)",
  "devices": [
    {
      "deviceLabel": "거실 에어컨"
    },
    {
      "deviceLabel": "안방 에어컨"
    }
  ]
}
```
* **`platform`**: `SmartThingsACs` 로 고정합니다.
* **`clientId`, `clientSecret`**: 1단계에서 발급받은 값을 입력합니다.
* **`webhookUrl`**: 1단계에서 `Target URL`로 입력한 공개 주소를 정확히 입력합니다.
* **`devices`**: HomeKit에 추가할 에어컨 목록입니다.
    * **`deviceLabel`**: SmartThings 앱에 표시되는 에어컨의 이름과 **정확히 일치**해야 합니다.

### 3단계: 플러그인 최초 인증

1.  설정 저장이 완료되면 Homebridge를 **재시작**합니다.
2.  Homebridge 로그(Log)를 확인하면, **`[스마트싱스 인증 필요]`** 라는 문구와 함께 인증 URL이 나타납니다.
3.  로그에 표시된 **인증 URL** 전체를 복사하여 웹 브라우저 주소창에 붙여넣고 접속합니다.
4.  SmartThings 계정으로 로그인하고, 생성한 앱에 대한 권한을 **'허용(Authorize)'** 합니다.
5.  "인증 성공!" 메시지가 브라우저에 표시되면 정상적으로 완료된 것입니다.
6.  다시 Homebridge를 **재시작**하면 플러그인이 자동으로 Webhook을 등록하고 에어컨 장치를 인식합니다.

## 문제 해결 (Troubleshooting)

* **"장치를 찾지 못했습니다" 로그가 표시될 경우:**
    * `config.json`의 `deviceLabel`이 SmartThings 앱의 장치 이름과 **완전히 동일한지** 확인하세요.
* **인증이 실패하거나 "invalid_grant" 오류가 발생할 경우:**
    * `config.json`의 `clientId`, `clientSecret`, `webhookUrl` 값이 올바르게 입력되었는지 다시 한번 확인하세요.
* **실시간 업데이트가 동작하지 않을 경우:**
    * `webhookUrl`이 외부에서 실제로 접속 가능한 주소인지 확인하세요.
    * 공유기의 **포트 포워딩** 설정이 올바르게 되어 있는지 확인하세요. (외부 포트 → Homebridge 서버 IP 및 포트)
