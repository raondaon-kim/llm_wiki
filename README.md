# LLM Wiki for Open GenOffice

[Open GenOffice](https://github.com/raondaon-kim/open-genoffice)에 함께 설치되는 LLM Wiki 수정본입니다. 사용자가 넣은 문서를 LLM이 읽어 위키 페이지(자료 요약, 인물·기관, 개념)로 정리하고, Open GenOffice의 AI 도우미가 문서를 쓸 때 그 위키를 검색해 참고합니다.

원본은 [nashsu/llm_wiki](https://github.com/nashsu/llm_wiki)(GPL-3.0) v0.4.12입니다. 기능과 사용법 전반은 [원본 README](https://github.com/nashsu/llm_wiki#readme)를 보세요. 이 저장소는 Open GenOffice가 LLM Wiki를 화면 없이 띄우고 끄기 위해 필요한 부분만 고쳤습니다. Open GenOffice 설치 파일의 `resources/llm-wiki/SOURCE.txt`가 이 저장소와 빌드에 쓴 커밋을 가리킵니다.

## 무엇을 바꿨나

- **관리 모드**: `LLM_WIKI_MANAGED=1`로 실행하면 창이 숨겨진 채 시작하고, 창을 닫아도 숨기기만 합니다. 업데이트 확인을 하지 않습니다.
- **자체 식별자**: `com.opengenoffice.llmwiki`를 써서, 따로 설치한 원본 LLM Wiki의 설정과 데이터를 건드리지 않습니다.
- **포트 지정**: `LLM_WIKI_API_PORT`, `LLM_WIKI_CLIP_PORT`로 로컬 API와 웹 클리퍼 포트를 정하고, 화면 쪽도 그 포트를 따릅니다.
- **창 열기·종료 API**: `POST /api/v1/app/show`(창을 앞으로)와 `POST /api/v1/app/quit`(종료). 다른 API와 같은 토큰으로 인증합니다.
- **PDF 처리**: 텍스트 추출이 안 되는 PDF는 pymupdf와 OCRmyPDF로 읽습니다. 도구는 PATH에서 찾고(Tesseract는 `TESSERACT_DIR`), 콘솔 창을 띄우지 않습니다. 긴 자료는 나눠서 학습합니다.
- **스캔 PDF 인식**: 글자가 없는 스캔 PDF는 pdfium으로 페이지를 그려 프로그램 옆 `tesseract/` 폴더의 Tesseract(한국어·영어)로 읽습니다. Open GenOffice 설치 파일에 함께 들어 있어 따로 설치할 것이 없습니다.

자세한 목록은 [MODIFICATIONS.md](MODIFICATIONS.md)에 있습니다.

## Open GenOffice가 쓰는 방식

Open GenOffice는 업무 위키를 켜면 다음 순서로 LLM Wiki를 다룹니다.

1. 위키 폴더와 AI 설정(LiteLLM, 직접 입력한 API 키, 또는 Codex 연결 어댑터)을 LLM Wiki 설정 파일에 미리 써 둡니다.
2. 사용할 포트와 토큰(`LLM_WIKI_API_TOKEN`)을 환경변수로 주고 관리 모드로 실행한 뒤, `/health`가 응답할 때까지 기다립니다.
3. 사용자가 넣은 자료는 위키 폴더의 `raw/sources/`에 들어가고, LLM Wiki가 감지해 `wiki/` 아래에 페이지를 만듭니다.
4. AI 도우미의 위키 검색은 `POST /api/v1/projects/{id}/search`로 이 위키도 함께 찾습니다.
5. Open GenOffice가 꺼질 때 `/api/v1/app/quit`로 끝내고, 응답이 없으면 프로세스를 정리합니다.

관리 모드가 아닐 때는 원본처럼 일반 데스크톱 앱으로 동작합니다.

## 빌드

필요한 것: Node.js 22, Rust, `protoc`.

```bash
npm ci
npx tauri build --no-bundle    # src-tauri/target/release/llm-wiki.exe
```

Open GenOffice에서는 `tools/fetch-llm-wiki.mjs`가 이 저장소를 고정된 커밋으로 빌드해 설치 파일에 넣습니다.

## 라이선스

[GPL-3.0](LICENSE). 원본 저작권은 nashsu(Yong Su)에게 있으며, 이 수정본도 같은 라이선스를 따릅니다. 이 저장소는 원본 프로젝트와 관계가 없습니다.
