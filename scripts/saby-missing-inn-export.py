#!/usr/bin/env python3
"""Separate audit XLSX/ZIP for missing-INN evidence; never edit SAT workbook."""
import json
import os
import sys
import zipfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

HEAD = "193457"
INK = "1F2937"
WHITE = "FFFFFF"
WARN = "FFF1D6"


def safe(v):
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        v = json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    v = str(v)
    return "'" + v if v and v[0] in "=+-@\t\r\n" else v


def sheet(wb, title, headers, rows, wide=()):
    ws = wb.create_sheet(title)
    ws.sheet_view.showGridLines = False
    ws.append(headers)
    for row in rows:
        ws.append([safe(value) for value in row])
    ws.row_dimensions[1].height = 36
    for cell in ws[1]:
        cell.fill = PatternFill("solid", fgColor=HEAD)
        cell.font = Font(name="Aptos", bold=True, color=WHITE, size=10)
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    ws.freeze_panes = "D2" if len(headers) >= 4 else "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{ws.max_row}"
    for col, _ in enumerate(headers, 1):
        ws.column_dimensions[get_column_letter(col)].width = (
            58 if col - 1 in wide else 22
        )
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.font = Font(name="Aptos", size=10, color=INK)
            cell.alignment = Alignment(wrap_text=True, vertical="top")
        if title == "Очередь ИНН" and str(row[5].value) != "external_registry_search_required":
            for cell in row:
                cell.fill = PatternFill("solid", fgColor=WARN)
    return ws


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: exporter.py input.json output.xlsx output.zip")
    source, output, bundle = sys.argv[1:]
    with open(source, encoding="utf-8") as handle:
        report = json.load(handle)
    records = report["rows"]
    wb = Workbook()
    wb.remove(wb.active)

    overview = [
        [item["index"], item["section"], item["section_row"],
         item["original_canonical_id"], item["organization"],
         item["decision"], len(item["candidates"]),
         ", ".join(c["inn"] for c in item["candidates"]),
         item["next_action"]]
        for item in records
    ]
    sheet(wb, "Очередь ИНН", [
        "№", "Раздел", "№ в разделе", "Внутренний ID",
        "Исходное название", "Статус", "Кандидатов",
        "ИНН-кандидаты (НЕ подтверждены)", "Следующее действие"
    ], overview, wide=(4, 7, 8))

    candidate_rows = []
    for item in records:
        for candidate in item["candidates"]:
            candidate_rows.append([
                item["index"], item["organization"], candidate["inn"],
                candidate["checksum_valid"], candidate["rejected_claim"],
                len(candidate["existing_owners"]),
                [x["kind"] for x in candidate["sources"]],
                [x["source_url"] for x in candidate["sources"] if x["source_url"]],
                candidate["existing_owners"],
                "НЕ ПРИСВАИВАТЬ БЕЗ НЕЗАВИСИМОЙ ПРОВЕРКИ"
            ])
    sheet(wb, "Кандидаты", [
        "№", "Название", "ИНН-кандидат", "Контрольные цифры",
        "Есть опровержение", "Уже используется у строк",
        "Типы сохранённых доказательств", "Источник/карточка",
        "Наличие в других строках", "Ограничение"
    ], candidate_rows, wide=(1, 6, 7, 8, 9))

    summary = report["summary"]
    metrics = [
        ("Исходных записей", summary["total_source_rows"]),
        ("Без ИНН", summary["missing_inn"]),
        ("С любым ИНН-кандидатом", summary["with_any_inn_hints"]),
        ("С кандидатом, прошедшим проверку цифр", summary["with_valid_candidate"]),
        ("Автоматически присвоено ИНН", summary["auto_filled"]),
        ("Веб-запросов", summary["web_requests"]),
        ("Запросов OpenAI", summary["openai_requests"]),
        ("SHA256 исходного JSON", report["source_sha256"])
    ]
    metrics.extend(
        (f"Раздел: {name}", count) for name, count in summary["groups"].items()
    )
    metrics.extend(
        (f"Статус: {name}", count) for name, count in summary["by_decision"].items()
    )
    sheet(wb, "Статистика", ["Показатель", "Значение"], metrics, wide=(0, 1))

    rules = [
        ("Нет ИНН", "В исходных данных ИНН пустой либо непригодного формата."),
        ("Контрольная сумма", "Корректные контрольные цифры не подтверждают принадлежность юрлицу."),
        ("Заметка", "ИНН из сохранённого текста — только кандидат, включая старые заметки."),
        ("Ссылка Saby", "ИНН в пути карточки может помочь найти юрлицо, но не подтверждает название."),
        ("Занят другим", "Требуется разобрать связь, филиал, алиас либо дубликат."),
        ("Обязательная проверка", "Сопоставить текущие полное название, ИНН, ОГРН и регион/адрес в независимом реестре."),
        ("Никакой записи", "JSON, SQLite и главный SAT Excel не менялись. В этом отчёте нет подтверждённых ИНН.")
    ]
    sheet(wb, "Методика", ["Положение", "Ограничение"], rules, wide=(1,))

    wb.active = 0
    wb.save(output)
    os.chmod(output, 0o600)
    temp = bundle + ".tmp"
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for file in [source, output]:
            archive.write(file, arcname=Path(file).name)
    os.replace(temp, bundle)
    os.chmod(bundle, 0o600)


if __name__ == "__main__":
    main()
