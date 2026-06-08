from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .converter import ConversionError, convert_to_pdf


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="document-converter",
        description="Convert office/HWP/HWPX documents to PDF using headless LibreOffice.",
    )
    parser.add_argument("input_file", type=Path, help="Input document path (.hwp/.hwpx/.docx/...) ")
    parser.add_argument("output_dir", type=Path, help="Output directory path")
    parser.add_argument(
        "--timeout",
        type=float,
        default=120.0,
        help="Conversion timeout seconds (default: 120)",
    )
    parser.add_argument(
        "--soffice-bin",
        type=str,
        default="soffice",
        help="LibreOffice soffice binary path (default: soffice)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        result = convert_to_pdf(
            args.input_file,
            args.output_dir,
            timeout_seconds=args.timeout,
            soffice_bin=args.soffice_bin,
        )
    except ConversionError as exc:
        print(f"[document-converter] ERROR: {exc}", file=sys.stderr)
        return exc.exit_code

    print(str(result.output_pdf))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
