#!/usr/bin/env python3
"""Separate identity-audit workbook and portable ZIP.

This is NOT the five-sheet SAT reference workbook. It is an independent audit
artifact; the production research XLSX template and source JSON are untouched.
"""
import json
import os
import sys
import zipfile
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

NAVY = "193457"
MID_BLUE = "294F80"
WHITE = "FFFFFF"
GREEN = "DDF2E2"
ORANGE = "FFF0CC"
RED = "FBE4E7"
GRAY = "ECEFF4"
PURPLE = "E8E1F8"

FIELD_MAP = [
    ("index", "№"),
    ("group", "Исходный лист"),
    ("group_row", "№ на листе"),
    ("source_inn", "ИНН в исследовании"),
    ("source_name", "Название в исследовании"),
    ("saby_search_inn", "ИНН в поиске Saby"),
    ("saby_search_name", "Название в поиске Saby"),
    ("saby_title_name", "Заголовок карточки Saby"),
    ("saby_detail_inn", "ИНН в карточке Saby"),
    ("saby_requisites_name", "Название в реквизитах Saby"),
    ("saby_requisites_inn", "ИНН в реквизитах Saby"),
    ("saby_requisites_kpp", "КПП в реквизитах Saby"),
    ("search_name_relation", "Совпадение поиска"),
    ("title_relation", "Совпадение заголовка"),
    ("requisites_relation", "Совпадение реквизитов"),
    ("detail_inn_relation", "Проверка ИНН карточки"),
    ("requisites_inn_relation", "Проверка ИНН реквизитов"),
    ("result", "Итог"),
    ("reason", "Причина"),
    ("saby_search_count", "Результатов по ИНН"),
    ("saby_search_selection", "Выбор результата"),
    ("requisites_surface", "Где найдены реквизиты"),
    ("saby_search_names", "Другие варианты в поиске"),
    ("saby_title_candidates", "Кандидаты заголовка"),
    ("saby_requisites_candidates", "Кандидаты реквизитов"),
    ("audited_at", "Когда проверено"),
]


def safe(value):
    """Render website-derived material as literal cell text, never formulas."""
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return value
    value = str(value)
    if value and (value[0] in "=+-@" or value[0] in "\t\r\n"):
        return "'" + value
    return value


def header_style(ws, width):
    ws.sheet_view.showGridLines = False
    ws.freeze_panes = "F2" if width >= 6 else "A2"
    ws.row_dimensions[1].height = 42
    for cell in ws[1][:width]:
        cell.fill = PatternFill("solid", fgColor=NAVY)
        cell.font = Font(name="Aptos", size=10, bold=True, color=WHITE)
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    ws.auto_filter.ref = f"A1:{get_column_letter(width)}{ws.max_row}"


def fill_rows(ws, fields, rows):
    ws.append([header for _, header in fields])
    for item in rows:
        ws.append([safe(item.get(key, "")) for key, _ in fields])
    header_style(ws, len(fields))
    for row_idx in range(2, ws.max_row + 1):
        ws.row_dimensions[row_idx].height = 32
        for cell in ws[row_idx]:
            cell.font = Font(name="Aptos", size=10, color="202A36")
            cell.alignment = Alignment(vertical="top", wrap_text=True)
        result = str(rows[row_idx - 2].get("result", "") or "")
        color = {
            "verified": GREEN,
            "review": ORANGE,
            "ambiguous": ORANGE,
            "conflict": RED,
            "error": RED,
            "not_found": GRAY,
            "source_invalid": GRAY,
        }.get(result)
        if color:
            for cell in ws[row_idx]:
                cell.fill = PatternFill("solid", fgColor=color)
    for idx, (field, _) in enumerate(fields, 1):
        width = 18
        if field in {"source_name", "saby_title_name", "saby_requisites_name",
                     "saby_search_name", "short_title", "official_requisites"}:
            width = 45
        elif field in {"reason", "title_relation", "requisites_relation"}:
            width = 28
        elif field in {"saby_search_names", "saby_requisites_candidates",
                       "saby_title_candidates"}:
            width = 55
        elif field in {"source_inn", "saby_detail_inn", "saby_requisites_inn"}:
            width = 19
        elif field in {"group", "requisites_surface"}:
            width = 23
        ws.column_dimensions[get_column_letter(idx)].width = width


def create_audit(comparison, summary, workbook_path):
    records = comparison["records"]
    wb = Workbook()
    detail = wb.active
    detail.title = "Сопоставление"
    fill_rows(detail, FIELD_MAP, records)

    stats = wb.create_sheet("Статистика")
    stats.append(["Показатель", "Значение"])
    stats_rows = [
        ("Всего исходных компаний", summary.get("total", 0)),
        ("Проверено / занесено в журнал", summary.get("recorded", 0)),
        ("Осталось", summary.get("remaining", 0)),
        ("Полный проход завершен", summary.get("completed", False)),
        ("SHA256 исходного JSON", summary.get("source_sha256", "")),
        ("Дата формирования", summary.get("generated_at", "")),
    ]
    for group, count in summary.get("group_counts", {}).items():
        stats_rows.append(("Исходных записей: " + group, count))
    for result, count in sorted(summary.get("results", {}).items()):
        stats_rows.append(("Статус: " + result, count))
    for reason, count in sorted(summary.get("reasons", {}).items()):
        stats_rows.append(("Причина: " + reason, count))
    for key, value in stats_rows:
        stats.append([safe(key), safe(value)])
    header_style(stats, 2)
    stats.column_dimensions["A"].width = 53
    stats.column_dimensions["B"].width = 75

    cases = wb.create_sheet("Короткие названия")
    candidate_fields = [
        ("index", "№ исходной записи"),
        ("source_inn", "ИНН"),
        ("source_name", "Исходное полное название"),
        ("short_title", "Заголовок Saby"),
        ("official_requisites", "Название по реквизитам Saby"),
        ("requisites_inn", "ИНН в реквизитах"),
        ("title_relation", "Категория сопоставления"),
        ("status", "Статус проверки"),
        ("reason", "Причина"),
    ]
    fill_rows(cases, candidate_fields,
              comparison.get("unapproved_title_name_candidates", []))

    rules = wb.create_sheet("Методика")
    rules.append(["Статус", "Значение и действие"])
    examples = [
        ("normalized_equal",
         "Слова ядра названия совпадают после удаления организационно-правовой формы, кавычек, регистра и пунктуации; требуется также проверить правовую форму."),
        ("initials_candidate",
         "Краткое название похоже на аббревиатуру; это только повод для проверки, не основание объединять организации."),
        ("short_name_candidate",
         "Короткое название Saby отличается от исходного; принимать его можно только после независимой сверки полного юридического названия и ИНН в реквизитах."),
        ("legal_form_conflict",
         "Конфликт организационно-правовой формы; автоматическое совпадение запрещено."),
        ("not_available",
         "Поле не удалось получить из Saby; это не утверждение, что такого значения нет."),
        ("verified",
         "Сопоставлены точный ИНН из карточки, точный ИНН и полное название из реквизитов. Этот отчёт не выполняет обогащение CRM."),
        ("review / conflict",
         "Сведения требуют проверки, исходные записи не меняются."),
    ]
    for key, desc in examples:
        rules.append([key, desc])
    header_style(rules, 2)
    rules.column_dimensions["A"].width = 29
    rules.column_dimensions["B"].width = 105
    for i in range(2, rules.max_row + 1):
        rules.row_dimensions[i].height = 38
        rules[f"B{i}"].alignment = Alignment(vertical="top", wrap_text=True)

    wb.active = 0
    out = Path(workbook_path)
    wb.save(str(out))
    os.chmod(str(out), 0o600)


def main():
    if len(sys.argv) != 7:
        raise SystemExit("usage: exporter.py comparison summary journal meta xlsx zip")
    _, comparison_path, summary_path, journal_path, meta_path, xlsx_path, bundle_path = sys.argv
    with open(comparison_path, encoding="utf-8") as handle:
        comparison = json.load(handle)
    with open(summary_path, encoding="utf-8") as handle:
        summary = json.load(handle)
    create_audit(comparison, summary, xlsx_path)
    temp = bundle_path + ".tmp"
    with zipfile.ZipFile(temp, "w", compression=zipfile.ZIP_DEFLATED,
                         compresslevel=6) as archive:
        for source in [comparison_path, summary_path, journal_path,
                       meta_path, xlsx_path]:
            archive.write(source, arcname=Path(source).name)
    os.replace(temp, bundle_path)
    os.chmod(bundle_path, 0o600)


if __name__ == "__main__":
    main()
