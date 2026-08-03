# waifu-agent

waifu-agent는 데스크톱 위를 돌아다니는 VRM 캐릭터를 에이전트의 인터페이스로 쓰는
프로젝트다. 캐릭터는 사용자의 말과 마우스 입력, 에이전트의 작업 상태에 반응하며 음성이나
채팅으로 요청을 받는다.

캐릭터 뒤에서는 로그인된 Claude Code와 Codex CLI 세션이 파일 조사, 코드 수정, PC 작업을
수행한다. 앱은 작업을 기억하고 위험한 동작 전에 승인을 요청하며, 완료 결과를 데스크톱이나
Discord로 알려준다. LLM API 키는 사용하지 않는다.

## License

현재 프로젝트 작성 코드와 자체 제작 VRMA 에셋은
[MateEngine Pro License v2.1](LICENSE)에 따라 공개된다. 비상업 코드 호스팅에서만 소스를
배포할 수 있으며 판매, 수익화, 유료 접근 및 Steam·itch.io·Microsoft Store 같은
상업·바이너리 플랫폼 배포를 금지한다.

MIT License로 공개된 마지막 리비전은
`d1b09c8ce52d3d85ec80643149199a145a5581bc`다. 해당 리비전과 이전 리비전에 이미 부여한
MIT 권리는 유지된다.

Mate-Engine 출처, 코드 반입 기록, 에셋 제외 및 서드파티 라이선스 경계는
[NOTICE](NOTICE)에 기록한다.
