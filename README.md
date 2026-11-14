# BackDo

**지나친 실행 위치로 돌아가, 디버깅을 이어가는 JavaScript 디버거입니다.**

<p align="center">
  <a href="https://landing.backdo.site/">
    <img src="https://raw.githubusercontent.com/hong7ya/backdo-landing/main/src/assets/BackDo.png" width="160" alt="BackDo 로고" />
  </a>
</p>

여러 함수와 모듈을 따라가다 확인하려던 코드를 지나쳤다면, BackDo의 거꾸로가기 버튼으로 이전 실행 위치를 다시 살펴볼 수 있습니다. Console에 입력한 JavaScript부터 화면을 보며 조작하는 DOM, Node 프로그램까지 지원합니다.

[시작하기](https://landing.backdo.site/) · [디버거 프론트엔드](https://github.com/hong7ya/backdo-devtools-frontend) · [로컬 서버](https://github.com/hong7ya/backdo-server) · [랜딩 페이지](https://github.com/hong7ya/backdo-landing)

## 시연

![반복문에서 이전 위치로 돌아가는 BackDo 시연](https://github.com/user-attachments/assets/7cbbb28e-a626-4951-b8e6-64b76f41bb44)

초기 버전에서 촬영한 시연입니다.

<details>
<summary>조건문·중첩 함수·콜백 함수 시연 더 보기</summary>

![초기 버전의 조건문 시연](https://github.com/user-attachments/assets/1625cb7e-54c8-42fa-8a66-23c7f6a2f89f)

![초기 버전의 중첩 함수 시연](https://github.com/user-attachments/assets/e1313daa-f32d-497d-9301-d2f1b8dab41a)

![초기 버전의 콜백 함수 시연](https://github.com/user-attachments/assets/4e7cbccb-1847-45dc-82e6-df46b815d95a)

</details>

## 제작 배경과 주요 기능

디버깅하다 Step을 한 번 더 누르면, 지나친 위치를 찾기 위해 프로그램을 다시 실행하고 중단점을 옮기곤 합니다. **앞으로 이동하듯 이전 위치로도 돌아갈 수 있으면 좋겠다**는 생각에서 BackDo를 만들었습니다.

- **지나온 순서로 이동합니다.** 반복문에서 같은 줄을 여러 번 방문한 경우를 구분하고, 조건문에서는 실제로 실행한 분기를 따라갑니다.
- **함수와 모듈을 넘나듭니다.** 기록이 남아 있다면 실행을 마친 함수나 다른 모듈의 이전 위치로 돌아갑니다. 여러 함수를 거치는 CLI 로직이나 Console 재현 코드를 살펴볼 때 활용할 수 있습니다.
- **빈 페이지에서 DOM을 만들고, 시각적으로 확인하며 거꾸로갑니다.** Console에서 JavaScript·Web API로 DOM을 만들고 조작합니다. 미리보기에서 변화를 확인하고, 거꾸로가기로 이전 실행 위치의 DOM 상태로 돌아갈 수 있습니다.
- **개발 중인 프로젝트에서도 거꾸로갑니다.** DOM 모드의 주소창에 실행 중인 프로젝트 주소를 입력하면 됩니다. 미리보기에서 페이지를 조작하며 디버깅하다가, 거꾸로가기로 해당 시점의 URL과 실행 위치로 돌아갈 수 있습니다.
- **디버깅 중 Console 조작도 되돌립니다.** 멈춘 상태에서 Console 명령으로 값을 바꾸거나 DOM을 조작했다면, 같은 줄에서 입력 전 상태로 돌아갈 수 있습니다. Console·DOM·Node 모드에 공통으로 적용합니다.
- **돌아온 뒤에도 디버깅을 계속합니다.** 같은 탭과 중단점 설정을 유지하며 Step·Resume으로 다음 실행을 탐색합니다.

## 시작하기

디버깅 화면은 웹에서 열고, 실행 대상을 관리할 서버는 내 컴퓨터에서 실행합니다. **Node.js 22.11.0**을 기준으로 합니다.

**1. 로컬 서버를 설치합니다.**

```sh
git clone https://github.com/hong7ya/backdo-server.git
cd backdo-server
npm ci
```

**2. 디버깅할 대상에 맞는 명령 하나를 실행합니다.**

| 대상 | 서버 저장소에서 실행 | 기본 디버깅 포트 | 준비할 코드 |
| --- | --- | --- | --- |
| Console | `npm run start:console` | `9222` | 연결 후 Console에 JavaScript 입력 |
| DOM | `npm run start:dom` | `9222` | Console로 DOM 구성 또는 디버깅할 페이지 주소 입력 |
| Node.js | `npm run start:node` | `9229` | 별도 터미널에서 사용자 프로그램 실행 |

Console·DOM 모드는 서버가 전용 Chrome을 준비합니다. Node 모드는 **별도 터미널의 사용자 프로젝트에서** 다음 명령도 실행합니다. `your-file.js`를 디버깅할 파일로 바꿉니다.

```sh
node --inspect-brk=127.0.0.1:9229 ./your-file.js
```

**3. [랜딩 페이지](https://landing.backdo.site/)에서 같은 모드를 선택하고, 터미널에 안내된 포트로 연결합니다.**

**DOM 모드는 `about:blank`에서 시작합니다.** Console에 JavaScript·Web API로 DOM을 만드는 코드를 입력하면 왼쪽 미리보기에서 결과를 볼 수 있습니다. 개발 중인 프로젝트를 디버깅하려면 미리보기 위 주소창에 `http://localhost:5174/`처럼 실행 중인 프로젝트 주소를 입력합니다. 페이지를 조작할 때는 미리보기를 사용합니다.

중단점이나 `debugger`에서 멈춘 뒤 Step·Resume으로 진행하고 거꾸로가기 버튼을 누릅니다. 사용을 마치면 로컬 서버 터미널에서 `Ctrl+C`를 누릅니다.

## 저장소와 핵심 흐름

**랜딩은 연결을 안내하고, 프론트엔드는 실행을 기록하며, 서버는 실행 대상을 다시 시작합니다.**

| 저장소                                                                   | 담당 역할                                      | 주요 기술                          |
| ------------------------------------------------------------------------ | ---------------------------------------------- | ---------------------------------- |
| [landing](https://github.com/hong7ya/backdo-landing)                     | 모드별 준비 안내, 포트 입력, 디버거 화면 열기  | React, Vite, Tailwind CSS, daisyUI |
| [devtools-frontend](https://github.com/hong7ya/backdo-devtools-frontend) | 대상 연결, 방문 기록, 거꾸로가기와 후속 디버깅 | TypeScript, Chrome DevTools, CDP   |
| [server](https://github.com/hong7ya/backdo-server)                       | 실행 조건 보관, Node·전용 Chrome의 재시작      | Node.js, Express, Puppeteer        |

아래는 준비된 대상에 연결한 뒤 거꾸로가는 흐름입니다. 핵심 함수와 저장소 경계만 표시하고, 중간 HTTP 처리와 내부 호출은 생략했습니다. CDP는 디버거와 실행 대상이 명령·이벤트를 주고받는 통신 규약입니다.

```mermaid
%%{init: {"sequence": {"mirrorActors": false, "messageMargin": 24}}}%%
sequenceDiagram
    box landing
        participant L as ConnectionForm<br/>연결 폼
    end
    box devtools-frontend
        participant F as 디버거 화면<br/>연결·기록·재실행
    end
    box server
        participant S as ProcessManager<br/>실행 대상 관리
    end
    participant T as Node 또는<br/>전용 Chrome

    Note over L,T: 1. 사용자가 모드·포트를 선택해 연결
    L->>F: URL로 디버거 화면 열기<br/>handleSubmit()
    F->>F: ReplayConnection.initialize()
    F->>S: 대상 등록 · HTTP<br/>register()
    S-->>F: 세션 ID·WebSocket 주소
    F->>T: CDP 연결
    T-->>F: 정지 이벤트
    F->>F: 선택한 소스의 방문·입력 기록<br/>ReplayController

    Note over F,T: 2. 사용자가 거꾸로가기 클릭
    F->>F: ReplayController.reverse()
    F->>S: 재시작 요청 · HTTP<br/>restart()
    S->>T: 기존 대상 종료·새 대상 생성
    S-->>F: 새 WebSocket 주소
    F->>T: 새 대상에 재연결·처음부터 실행<br/>페이지 이동·Console·미리보기 입력 재생
    T-->>F: 다시 방문한 위치
    F->>F: 기록 순서 대조<br/>ReplayPlan.accept()
    Note over F: 직전 위치에서 정지·중단점 재적용<br/>Step·Resume으로 디버깅 계속
```

## 거꾸로가기의 원리

**실제로 방문한 위치를 기록하고, 실행 대상을 새로 시작해 돌아갈 위치까지 다시 실행합니다.** 반복문에서 같은 줄을 여러 번 지나도 각각의 방문을 구분합니다.

기록이 남아 있는 범위에서, 거꾸로가기 한 번의 도착점은 직전 조작에 따라 달라집니다.

| 직전 조작 | 거꾸로가기를 누르면 |
| --- | --- |
| Resume | 다음 정지 직전의 기록 위치로 돌아갑니다. |
| Step Into | Step Into를 시작한 위치로 돌아갑니다. |
| Step Over | Step Over를 시작한 위치로 돌아갑니다. 건너뛴 함수 내부로 들어가지 않습니다. |
| Step Out | 빠져나온 함수의 마지막 기록 위치로 돌아갑니다. |

Node는 보관한 인자·환경변수·작업 폴더 등 실행 조건으로 다시 실행합니다. Console은 기록한 명령을 같은 순서와 실행 위치에서 다시 제출합니다. DOM은 페이지 주소와 미리보기에서 보낸 입력도 재생합니다. 프로세스를 새로 만들면서 함수 밖의 변수와 모듈 상태도 다시 구성합니다. BackDo 화면과 로컬 서버는 계속 실행됩니다.

프론트엔드는 최초 기록 위치부터 목표까지 소스와 방문 순서를 대조합니다. 경로가 달라지면 이동을 중단하고, 목표에 도착하면 그 이후 기록을 버린 뒤 새로 진행한 경로를 기록합니다. 변수 값은 다시 실행하면서 계산합니다.

### 중단점과 Step 진입을 기준으로 기록합니다

별도 파일 목록을 설정하지 않아도, 활성 중단점을 둔 소스, `debugger`가 있는 소스와 실제 디버깅 정지·Step으로 진입한 소스를 기록합니다. **Resume만으로 범위를 넓히지 않으며, 선택한 소스는 Resume 중에도 기록합니다.** 소스맵이 있으면 원본 파일 단위로 구분합니다.

`debugger`가 있는 소스는 실행 직전에 선택합니다. 첫 정지 앞의 초기화도 기록하므로, 첫 `debugger`에서 거꾸로가면 바로 앞의 기록 위치로 돌아갈 수 있습니다.

소스가 기록 범위에 추가된 시점도 재생하므로 원래 기록하지 않았던 이전 실행이 섞이지 않습니다. 개발 서버나 라이브러리 코드도 직접 진입하면 기록 대상이 됩니다.

멈춘 상태의 **Console 명령은 조회·수정 모두 완료할 때 한 단계로 기록합니다.** 같은 줄에서 거꾸로가면 해당 입력 전 상태로 돌아가며, 이후 Step·Resume으로 진행한 뒤에도 다시 되돌릴 수 있습니다.

### 기록량은 CDP 통신 비용으로 제한합니다

기록이 늘면 다시 실행할 때 처리할 위치도 늘어납니다. 사용자 코드와 분리된 프로세스에서 **CDP 요청 한 번의 왕복 시간**을 측정하고 다음 기준을 적용합니다.

```text
예상 CDP 처리 시간 = 측정한 왕복 시간 × 기록된 단계 수
기록 유지 조건 = 예상 CDP 처리 시간 < 3초
```

3초는 CDP 통신에 배정한 예산입니다. Console 입력 단계도 이 예산에 포함합니다. 코드 계산·대기·프로세스 시작 시간까지 포함한 복원 완료 시간을 보장하지는 않습니다. 한도에 도달하면 전체 기록을 해제하며, 일반 디버깅은 계속할 수 있습니다. 거꾸로가기로 버린 미래 기록만큼 예상 비용도 줄어듭니다.

## 확인한 범위와 한계

| 구분 | 범위 |
| --- | --- |
| 실행 위치 검증 | 반복문·분기·`break`, 간단한 `async/await`, 완료된 함수·Console 코드, Node의 CJS·ESM과 `import`·`import()` 모듈 이동, 첫 정지 이전 초기화 복원, 모듈 간 Step Over·Step Out 후 거꾸로가기, 복원 후 Step·Resume·중단점 유지 |
| 입력·기록 범위 검증 | DOM 미리보기 입력·페이지 이동 재생, 여러 번 거꾸로가기, 파일 진입·소스맵 원본별 기록 범위, Console 입력 전 상태 복원과 이후 Step·Resume·재역행 |
| 추가 검증 필요 | 여러 비동기 작업의 실행 순서, 비동기 경계를 지나는 Step, 다양한 Node 실행 옵션·개발 서버·브라우저 입력 유형 |
| 지원하지 않음 | Worker·여러 프로세스의 동시 되돌리기, 터미널 입력을 기다리는 프로그램, Inspector 밖의 일반 Chrome 창 조작 기록, 서버나 디버거 탭을 다시 연 뒤 이전 기록 복구 |

- **파일·DB 등 외부 상태는 과거로 되돌리지 않습니다.** 재실행 중 요청·로그·파일 쓰기가 반복될 수 있고, 시간·난수·외부 응답이 달라지면 계산 결과도 달라질 수 있습니다.
- **기록은 현재 세션에서만 유지됩니다.** Inspector 전체 새로고침·종료·기록 한도 도달이나 중단점 전체 비활성화로 기록이 해제될 수 있습니다. DOM 미리보기 안에서 페이지를 이동하거나 새로고침하는 것은 기록에 포함합니다. Console 명령으로 남기지 않은 수동 변경과 열린 파일·소켓은 복구하지 않습니다.
