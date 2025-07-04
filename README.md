# Homebridge SmartThings ACs (v1.0.0)

[![npm version](https://badge.fury.io/js/homebridge-smartthings-acs.svg)](https://badge.fury.io/js/homebridge-smartthings-acs)

`homebridge-smartthings-acs`는 SmartThings에 연결된 삼성 에어컨을 HomeKit에 연동하기 위한 고성능 Homebridge 플러그인입니다. **웹훅(Webhook)을 통한 실시간 상태 업데이트**를 지원하여, SmartThings 앱이나 다른 방법으로 기기 상태를 변경했을 때 거의 즉시 HomeKit에 반영됩니다.

## ✨ 주요 기능

* **실시간 상태 동기화 (웹훅)**: SmartThings의 웹훅을 사용하여, 에어컨 상태가 변경되는 즉시 HomeKit에 반영됩니다. 자동화가 지연 없이 실행되고, 항상 최신 상태를 확인할 수 있습니다.
* **안전하고 영구적인 OAuth 2.0 인증**: 한 번의 설정으로 토큰이 자동 갱신되는 안정적인 인증 방식을 사용합니다.
* **다중 에어컨 지원**: 여러 대의 에어컨을 `config.json`에 등록하여 한 번에 관리할 수 있습니다.
* **고유 기능 커스텀 매핑**:
    * **무풍 모드**: HomeKit의 '스윙' 기능으로 켜고 끌 수 있습니다.
    * **자동 건조 모드**: HomeKit의 '물리 제어 잠금' 기능으로 켜고 끌 수 있습니다.
* **GUI 설정 지원**: Homebridge UI의 GUI 환경에서 설정을 쉽게 입력하고 관리할 수 있습니다.

## ❗ 사전 준비

플러그인을 설치하기 전, 아래 항목들이 반드시 준비되어야 합니다.

1.  **Homebridge 서버**: [Homebridge](https://homebridge.io/)가 설치되어 있어야 합니다. (Homebridge UI 사용을 권장합니다.)
2.  **Node.js**: **v18.0.0 이상** 버전이 필요합니다.
3.  **공개 접속 가능 주소 (Public URL)**: SmartThings 서버가 외부 인터넷을 통해 Homebridge 서버에 접속할 수 있는 **고정된 공개 주소**가 필요합니다. (예: DuckDNS, Synology DDNS를 이용한 `https://your-domain.com`)
4.  **SmartThings CLI**: 아래 설치 과정에서 사용됩니다.

## 🛠️ 설치 및 설정

### 1단계: SmartThings OAuth App 생성 및 Webhook 설정

Homebridge 설정에 필요한 `clientId`와 `clientSecret`을 발급받고, 웹훅을 등록하기 위해 최초 1회 아래 절차를 따릅니다.

1.  **SmartThings CLI 설치**
    터미널 앱을 열고 아래 명령어를 실행하여 SmartThings CLI를 설치합니다.
    ```shell
    npm install -g @smartthings/cli
    ```

2.  **개인용 액세스 토큰(PAT) 발급**
    CLI 인증을 위해 임시 토큰이 필요합니다.
    * [SmartThings 개인용 액세스 토큰 페이지](https://account.smartthings.com/tokens)에 접속하여 로그인합니다.
    * **'Generate new token'** 버튼을 클릭합니다.
    * 토큰 이름(예: `Homebridge Setup`)을 입력하고, **'Authorized scopes'** 아래의 모든 권한을 체크합니다.
    * 토큰을 생성하고, 표시되는 토큰 값을 **반드시 복사**하여 임시로 보관하세요.

3.  **터미널에서 CLI 인증**
    다시 터미널로 돌아와, 아래 명령어를 실행하여 방금 발급받은 PAT를 환경 변수로 등록합니다.
    ```shell
    # "YOUR_PAT_TOKEN" 부분을 위에서 복사한 토큰 값으로 변경
    export SMARTTHINGS_TOKEN="YOUR_PAT_TOKEN"
    ```
    > Windows의 PowerShell에서는 `$env:SMARTTHINGS_TOKEN="YOUR_PAT_TOKEN"` 을 사용하세요.

4.  **OAuth App 생성 및 Client ID/Secret 발급**
    아래 명령어를 터미널에 입력하여 절차를 시작합니다.
    ```shell
    smartthings apps:create --json
    ```
    * `Display Name`: 앱의 이름입니다. (예: `Homebridge ACs`)
    * `Description`: 앱의 설명입니다. (예: `Homebridge ACs Control`)
    * `App Type`: **`WEBHOOK_SMART_APP`** 을 선택합니다.
    * `Target URL`: **config.json에 입력할 Webhook URL을 정확히 입력**합니다. (예: `https://your-domain.com/st-webhook`)
    * `Select Scopes`: 스페이스바를 눌러 아래 **2가지 권한**을 모두 선택하고 엔터를 누릅니다.
        * `r:devices:*` (장치 읽기)
        * `x:devices:*` (장치 제어)

    모든 절차가 완료되면, 터미널에 **`oauthClientId`**와 **`oauthClientSecret`** 값이 포함된 JSON 결과가 출력됩니다. 이 두 값을 복사하여 다음 단계에서 사용합니다.
