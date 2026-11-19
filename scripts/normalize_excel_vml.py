"""Normalize legacy Excel-comment VML shape IDs across all five-sheet tabs.

openpyxl starts every commentsDrawingN.vml at _x0000_s1026 with idmap=1,
even when another sheet already uses that cluster. With thousands of notes,
one drawing can also extend into multiple 1024-ID clusters while still
claiming only block 1. This is not the Office shape ID allocation scheme.

Patch ONLY comment VML parts, preserving every cell, note, style, relationship
and other OOXML part byte-for-byte. The transformation is deterministic and
idempotent. It uses only Python's standard library and no browser/paid calls.
"""
import os
import re
import tempfile
from pathlib import Path
from xml.etree import ElementTree as ET
from zipfile import ZipFile

VML_NS = '{urn:schemas-microsoft-com:vml}'
OFFICE_NS = '{urn:schemas-microsoft-com:office:office}'
SHAPE_RE = re.compile(rb'\bid="_x0000_s([0-9]+)"')
IDMAP_RE = re.compile(
    rb'(<(?:[a-zA-Z_][\w.-]*:)?idmap\b[^>]*?\bdata=")[^"]*(")'
)
VML_NAME_RE = re.compile(r'^xl/drawings/commentsDrawing(\d+)\.vml$')
BLOCK_SIZE = 1024


def _normalize_vml_parts(parts):
    next_block = 1
    updated = {}
    for filename in sorted(parts, key=lambda n: int(VML_NAME_RE.fullmatch(n).group(1))):
        raw = parts[filename]
        root = ET.fromstring(raw)
        shapes = list(root.iter(VML_NS+'shape'))
        found_ids = list(SHAPE_RE.finditer(raw))
        idmap = list(root.iter(OFFICE_NS+'idmap'))
        if len(shapes) != len(found_ids) or len(idmap) != 1:
            raise ValueError('Unsupported comment VML structure: '+filename)
        if not shapes:
            raise ValueError('Empty legacy comment drawing: '+filename)

        first = next_block*BLOCK_SIZE+1
        ids = iter(range(first,first+len(shapes)))
        patched,count = SHAPE_RE.subn(
            lambda m: b'id="_x0000_s'+str(next(ids)).encode('ascii')+b'"',raw
        )
        if count!=len(shapes):
            raise ValueError('Failed to normalize comment shapes: '+filename)

        last = first+len(shapes)-1
        blocks = range(next_block,(last-1)//BLOCK_SIZE+1)
        idmap_value = b','.join(str(block).encode('ascii') for block in blocks)
        patched,matched = IDMAP_RE.subn(
            lambda m:m.group(1)+idmap_value+m.group(2),patched,count=1
        )
        if matched!=1:
            raise ValueError('Comment drawing has no editable idmap: '+filename)
        ET.fromstring(patched)
        updated[filename] = patched
        next_block=(last-1)//BLOCK_SIZE+1
    return updated


def normalize_comment_vml_ids(path):
    """Rewrite invalid per-sheet legacy VML ID reuse without touching data.

    The generated workbook is replaced atomically. Do not call this on
    arbitrary macro-enabled Office documents: it is for this strict xlsx
    exporter and its commentsDrawingN.vml parts only.
    """
    path = Path(path)
    with ZipFile(path,'r') as source:
        names=source.namelist()
        if len(names)!=len(set(names)):
            raise ValueError('Duplicate OOXML package part names')
        drawings=[name for name in names if VML_NAME_RE.fullmatch(name)]
        unexpected=[name for name in names if name.endswith('.vml') and name not in drawings]
        if unexpected:
            raise ValueError('Unsupported non-comment VML drawing: '+unexpected[0])
        if not drawings:
            return False
        parts={name:source.read(name) for name in drawings}
        modified=_normalize_vml_parts(parts)
        if all(parts[name]==modified[name] for name in drawings):
            return False

        descriptor,temp_path=tempfile.mkstemp(
            suffix='.xlsx',prefix='.rr-vml-',dir=str(path.parent))
        os.close(descriptor)
        try:
            with ZipFile(temp_path,'w') as dest:
                dest.comment=source.comment
                for info in source.infolist():
                    dest.writestr(info,modified.get(info.filename,source.read(info.filename)))
            # Atomic rename in same directory. If the process dies before
            # this point the original complete workbook remains available.
            os.replace(temp_path,path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
    return True


if __name__=='__main__':
    import sys
    if len(sys.argv)!=2:
        raise SystemExit('Usage: python normalize_excel_vml.py export.xlsx')
    print('VML_NORMALIZED' if normalize_comment_vml_ids(sys.argv[1])
          else 'VML_ALREADY_NORMALIZED')
