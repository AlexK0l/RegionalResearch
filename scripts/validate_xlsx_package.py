"""Read-only structural validation for every generated five-sheet XLSX.

Excel can prompt for 'repair' even when a ZIP was written successfully. These
checks catch malformed XML, missing relationships, duplicate VML/comment IDs,
and unsupported legacy comment length *before* HTTP sends the workbook.
They do not replace opening it in desktop Microsoft Excel.
"""
import posixpath
import sys
import xml.etree.ElementTree as ET
from zipfile import ZipFile, BadZipFile

REL_NS='{http://schemas.openxmlformats.org/package/2006/relationships}'
MAIN_NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
VML_NS='{urn:schemas-microsoft-com:vml}'
X_NS='{urn:schemas-microsoft-com:office:excel}'


def _relationship_path(rel_name,target):
    if target.startswith('/'):
        return posixpath.normpath(target.lstrip('/'))
    if rel_name=='_rels/.rels':
        base=''
    elif '/_rels/' in rel_name:
        base=rel_name.split('/_rels/',1)[0]
    else:
        raise ValueError('XLSX relationship path is invalid: '+rel_name)
    return posixpath.normpath(posixpath.join(base,target.split('#',1)[0]))


def validate_xlsx_package(path):
    try:
        with ZipFile(path) as archive:
            names=archive.namelist()
            parts=set(names)
            if len(names)!=len(parts):
                raise ValueError('XLSX contains duplicate archive part names')
            required={'[Content_Types].xml','_rels/.rels',
                      'xl/workbook.xml','xl/_rels/workbook.xml.rels'}
            if missing:=required-parts:
                raise ValueError('XLSX is missing: '+', '.join(sorted(missing)))
            bad=archive.testzip()
            if bad:
                raise ValueError('XLSX CRC check failed: '+bad)

            count_comments=0
            count_shapes=0
            for name in names:
                if not name.endswith(('.xml','.rels','.vml')):
                    continue
                try:
                    with archive.open(name) as xml_input:
                        root=ET.parse(xml_input).getroot()
                except ET.ParseError as error:
                    raise ValueError('XLSX malformed XML '+name+': '+str(error)) from error

                if name.endswith('.rels'):
                    for rel in root.findall(REL_NS+'Relationship'):
                        target=rel.get('Target','')
                        if rel.get('TargetMode')=='External':
                            continue
                        part=_relationship_path(name,target)
                        if part not in parts:
                            raise ValueError('XLSX broken link '+name+' -> '+part)
                elif name.startswith('xl/comments/') and name.endswith('.xml'):
                    seen=set()
                    for note in root.findall('.//'+MAIN_NS+'comment'):
                        ref=note.get('ref')
                        if not ref or ref in seen:
                            raise ValueError('XLSX missing/duplicate comment ref in '+name)
                        seen.add(ref)
                        text=''.join(note.itertext())
                        if len(text)>32767:
                            raise ValueError('XLSX comment exceeds Excel limit '+name+':'+ref)
                        count_comments+=1
                elif name.endswith('.vml'):
                    seen=set()
                    for shape in root.iter(VML_NS+'shape'):
                        shape_id=shape.get('id','')
                        if not shape_id or shape_id in seen:
                            raise ValueError('XLSX duplicate/empty VML shape id in '+name)
                        seen.add(shape_id)
                        count_shapes+=1
            if count_comments!=count_shapes:
                # Exported workbook has only old-style cell notes, with one
                # VML shape per comment, and no forms/other drawing objects.
                raise ValueError(
                    f'XLSX comments/VML mismatch: {count_comments}/{count_shapes}')
    except BadZipFile as error:
        raise ValueError('XLSX archive is corrupt') from error
    return True


if __name__=='__main__':
    if len(sys.argv)!=2:
        raise SystemExit('Usage: python validate-xlsx-package.py book.xlsx')
    validate_xlsx_package(sys.argv[1])
    print('XLSX_PACKAGE_OK')
