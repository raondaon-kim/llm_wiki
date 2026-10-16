# Fork notes: LLM Wiki for GenOffice

Based on nashsu/llm_wiki v0.4.12 (GPL-3.0). Changes in this fork:

- Managed mode (`LLM_WIKI_MANAGED=1`): the main window starts hidden and closing it hides it;
  no update check; own identifier `com.opengenoffice.llmwiki`.
- Ports from `LLM_WIKI_API_PORT` / `LLM_WIKI_CLIP_PORT`; frontend reads them through
  `runtime_info`.
- `POST /api/v1/app/show` and `/api/v1/app/quit` (same token auth as the other routes).
- PDF text fallback (pymupdf, OCRmyPDF) finds its tools on PATH (`TESSERACT_DIR` for
  Tesseract) and runs without a console window; ingest splits long sources into chunks.
- Scanned PDFs: pages are rendered with pdfium and read with the Tesseract shipped next to the
  program (`tesseract/`, or `LLM_WIKI_TESSERACT_DIR`), Korean and English, before the
  pymupdf/OCRmyPDF fallback.
