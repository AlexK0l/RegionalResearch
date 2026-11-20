"""Normalize XLSX core-property timestamps to valid UTC W3CDTF.

Some Python serializers can output an offset timestamp with an extra trailing
Z (for example 2026-11-20T05:32:42+00:00Z). This is an invalid date,
even though the XML, ZIP, cells and comments are otherwise valid.
Desktop Excel then shows a generic file-recovery prompt with no details.

Only docProps/core.xml is rewritten. All cells, styles, formulas, comments
and other OOXML parts remain byte-for-byte unchanged.
"""
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import xml.etree.ElementTree as ET
from zipfile import ZipFile

TERMS_NS = '{http://purl.org/dc/terms/}'
# The original xsi:type="dcterms:W3CDTF" is a QName, so its lexical
# dcterms prefix MUST survive ElementTree serialization.
ET.register_namespace('cp', 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties')
ET.register_namespace('dc', 'http://purl.org/dc/elements/1.1/')
ET.register_namespace('dcterms', 'http://purl.org/dc/terms/')
ET.register_namespace('xsi', 'http://www.w3.org/2001/XMLSchema-instance')


def canonical_utc(value):
    text = str(value).strip()
    if text.endswith('Z'):
        text = text[:-1]
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as error:
        raise ValueError('Invalid XLSX core timestamp: ' + str(value)) from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    timespec = 'microseconds' if parsed.microsecond else 'seconds'
    return parsed.isoformat(timespec=timespec) + 'Z'


def normalize_core_timestamps(filename):
    """Atomically normalize metadata dates; preserve every other ZIP part."""
    filename = Path(filename)
    with ZipFile(filename) as reader:
        part = 'docProps/core.xml'
        if part not in reader.namelist():
            raise ValueError('Missing XLSX core properties: ' + part)
        root = ET.fromstring(reader.read(part))
        modified = False
        for name in ('created', 'modified'):
            element = root.find(TERMS_NS + name)
            if element is None or not element.text:
                continue
            updated = canonical_utc(element.text)
            if element.text != updated:
                element.text = updated
                modified = True
        if not modified:
            return False
        xml = ET.tostring(root, encoding='utf-8', xml_declaration=True)
        handle, temp = tempfile.mkstemp(
            dir=str(filename.parent), prefix='.rr-core-', suffix='.xlsx')
        os.close(handle)
        try:
            with ZipFile(temp, 'w') as writer:
                writer.comment = reader.comment
                for info in reader.infolist():
                    payload = xml if info.filename == part else reader.read(info.filename)
                    writer.writestr(info, payload)
            reader.close()
            os.replace(temp, filename)
        finally:
            if os.path.exists(temp):
                os.unlink(temp)
    return True


if __name__ == '__main__':
    import sys
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python normalize_excel_core.py FILE.xlsx')
    print('CORE_NORMALIZED' if normalize_core_timestamps(sys.argv[1])
          else 'CORE_ALREADY_NORMALIZED')
