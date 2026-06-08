"""Run opendataloader hybrid backend with Heron-101 layout model."""

import opendataloader_pdf.hybrid_server as hybrid_server


def _create_converter_with_heron101(
    force_full_page_ocr: bool = False,
    ocr_lang: list[str] | None = None,
    enrich_formula: bool = False,
    enrich_picture_description: bool = False,
    picture_description_prompt: str | None = None,
):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.layout_model_specs import DOCLING_LAYOUT_HERON_101
    from docling.datamodel.pipeline_options import (
        EasyOcrOptions,
        LayoutOptions,
        PdfPipelineOptions,
        PictureDescriptionVlmOptions,
        TableFormerMode,
        TableStructureOptions,
    )
    from docling.document_converter import DocumentConverter, PdfFormatOption

    ocr_options = EasyOcrOptions(force_full_page_ocr=force_full_page_ocr)
    if ocr_lang:
        ocr_options.lang = ocr_lang

    picture_description_options = None
    if enrich_picture_description:
        prompt = picture_description_prompt or hybrid_server.DEFAULT_PICTURE_DESCRIPTION_PROMPT
        picture_description_options = PictureDescriptionVlmOptions(
            repo_id="HuggingFaceTB/SmolVLM-256M-Instruct",
            prompt=prompt,
            generation_config={"max_new_tokens": 300, "do_sample": False},
        )

    pipeline_kwargs = {
        "do_ocr": True,
        "do_table_structure": True,
        "ocr_options": ocr_options,
        "table_structure_options": TableStructureOptions(mode=TableFormerMode.ACCURATE),
        "layout_options": LayoutOptions(model_spec=DOCLING_LAYOUT_HERON_101),
        "do_formula_enrichment": enrich_formula,
        "do_picture_description": enrich_picture_description,
        "generate_picture_images": enrich_picture_description,
    }
    if picture_description_options is not None:
        pipeline_kwargs["picture_description_options"] = picture_description_options

    pipeline_options = PdfPipelineOptions(**pipeline_kwargs)
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        }
    )


hybrid_server.create_converter = _create_converter_with_heron101


if __name__ == "__main__":
    hybrid_server.main()
