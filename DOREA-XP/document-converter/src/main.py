from __future__ import annotations

import os
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import PlainTextResponse, Response

from .converter import ConversionError, convert_to_pdf

app = FastAPI(title="Document Converter Service")


def _extract_hwpx_text(hwpx_path: Path) -> str:
    parts: list[str] = []
    with zipfile.ZipFile(hwpx_path, "r") as archive:
        names = set(archive.namelist())
        if "Preview/PrvText.txt" in names:
            raw = archive.read("Preview/PrvText.txt")
            for encoding in ("utf-16-le", "utf-16", "utf-8", "cp949", "euc-kr"):
                try:
                    text = raw.decode(encoding)
                except Exception:
                    continue
                if text.strip():
                    parts.append(text)
                    break

        for name in sorted(names):
            if not (name.startswith("Contents/section") and name.endswith(".xml")):
                continue
            xml_text = archive.read(name).decode("utf-8", errors="replace")
            items = re.findall(r"<(?:hp:)?t[^>]*>([^<]*)</(?:hp:)?t>", xml_text)
            if items:
                parts.append("\n".join(items))

    merged = "\n\n".join([x for x in parts if x.strip()]).strip()
    if not merged:
        raise ConversionError("HWPX fallback text extraction returned empty content", exit_code=3)
    return merged


def _hwpx_text_to_html(content: str, title: str) -> str:
    safe_title = title.replace("<", "").replace(">", "")
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    body = "\n".join(f"<p>{line}</p>" for line in lines)
    return (
        "<!doctype html><html lang='ko'><head><meta charset='utf-8'>"
        f"<title>{safe_title}</title>"
        "<style>body{font-family:'Noto Sans CJK KR','Nanum Gothic',sans-serif;font-size:11pt;line-height:1.6;}"
        "p{margin:0 0 8px 0;}</style></head><body>"
        f"<h1>{safe_title}</h1>{body}</body></html>"
    )


def _is_hwpx(path: Path) -> bool:
    return path.suffix.lower() == ".hwpx"


@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "document-converter"}


@app.post("/convert")
async def convert_document(file: UploadFile = File(...)):
    work_id = str(uuid.uuid4())
    work_dir = Path(tempfile.mkdtemp(prefix=f"converter-{work_id[:8]}-", dir="/tmp"))

    try:
        original_filename = (file.filename or "document").strip() or "document"
        safe_name = Path(original_filename).name
        if not Path(safe_name).suffix:
            safe_name = f"{safe_name}.bin"

        input_path = work_dir / safe_name
        content = await file.read()
        input_path.write_bytes(content)

        timeout_seconds = float(os.getenv("CONVERSION_TIMEOUT_SECONDS", "120"))
        fallback_used = False
        try:
            result = convert_to_pdf(
                input_path,
                work_dir,
                timeout_seconds=timeout_seconds,
            )
        except ConversionError as exc:
            allow_fallback = os.getenv("ALLOW_HWPX_TEXT_FALLBACK", "true").lower() in {"1", "true", "yes", "on"}
            if not (_is_hwpx(input_path) and allow_fallback):
                raise

            text = _extract_hwpx_text(input_path)
            html_path = work_dir / f"{input_path.stem}.html"
            html_path.write_text(_hwpx_text_to_html(text, Path(safe_name).stem), encoding="utf-8")
            result = convert_to_pdf(
                html_path,
                work_dir,
                timeout_seconds=timeout_seconds,
            )
            fallback_used = True

            if not result.output_pdf.exists():
                raise exc

        pdf_bytes = result.output_pdf.read_bytes()
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename={Path(safe_name).stem}.pdf",
                "X-Converter-Profile": result.profile_uri,
                "X-Fallback-Used": "true" if fallback_used else "false",
            },
        )
    except ConversionError as exc:
        return PlainTextResponse(content=f"변환 실패: {exc}", status_code=500)
    except Exception as exc:
        return PlainTextResponse(content=f"변환 실패: {exc}", status_code=500)
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8003)
