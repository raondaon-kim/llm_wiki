"""
extract_pdf.py — pymupdf 기반 PDF 텍스트 추출 스크립트.

Usage:
    python extract_pdf.py <pdf_path>

stdout: 추출된 Markdown 텍스트 (## Page N 헤더 포함, UTF-8)
stderr: 진행 로그
exit 0: 성공
exit 1: 실패 (stderr에 오류 메시지)
"""
import sys
import os

def main():
    if len(sys.argv) < 2:
        print("Usage: extract_pdf.py <pdf_path>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]

    if not os.path.exists(pdf_path):
        print(f"[extract_pdf] file not found: {pdf_path}", file=sys.stderr)
        sys.exit(1)

    try:
        import fitz  # pymupdf
    except ImportError:
        print("[extract_pdf] pymupdf not installed: pip install pymupdf", file=sys.stderr)
        sys.exit(1)

    # stdout을 UTF-8으로 강제 (Windows cp949 환경 대응)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        print(f"[extract_pdf] failed to open PDF: {e}", file=sys.stderr)
        sys.exit(1)

    page_count = len(doc)
    print(f"[extract_pdf] '{pdf_path}': {page_count} page(s)", file=sys.stderr)

    parts = []
    total_chars = 0

    for i, page in enumerate(doc):
        page_num = i + 1
        try:
            text = page.get_text()
        except Exception as e:
            print(f"[extract_pdf] page {page_num} failed: {e}", file=sys.stderr)
            text = ""

        chars = len([c for c in text if not c.isspace()])
        total_chars += chars
        parts.append(f"## Page {page_num}\n\n{text.rstrip()}\n")

    avg = total_chars // page_count if page_count > 0 else 0
    print(f"[extract_pdf] done — avg {avg} chars/page", file=sys.stderr)

    print("\n\n".join(parts))

if __name__ == "__main__":
    main()
