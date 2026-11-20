import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const root=fileURLToPath(new URL("../",import.meta.url));
const normalize=path.join(root,"scripts","normalize_excel_core.py");
const validator=path.join(root,"scripts","validate_xlsx_package.py");
const run=(script,args)=>spawnSync("python",[script,...args],{
  cwd:root,timeout:35000,encoding:"utf8",maxBuffer:4_000_000
});

test("normalizes invalid +00:00Z core metadata without touching worksheet or comments",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-core-date-"));
  const filename=path.join(dir,"bad-metadata.xlsx");
  try{
    const python=[
      "from openpyxl import Workbook",
      "from openpyxl.comments import Comment",
      "from datetime import datetime",
      "from zipfile import ZipFile",
      "import sys",
      "w=Workbook()",
      "w.active['A1']='\\u041e\\u041e\\u041e \\u0422\\u0435\\u0441\\u0442'",
      "w.active['A1'].comment=Comment('Source: https://example.org','RegionalResearch')",
      "w.active['B1']=123",
      "w.properties.modified=datetime(2026,11,20,5,32,42)",
      "w.save(sys.argv[1])",
      "with ZipFile(sys.argv[1]) as z:",
      "  files=[(info,z.read(info.filename)) for info in z.infolist()]",
      "with ZipFile(sys.argv[1],'w') as z:",
      "  for info,payload in files:",
      "    if info.filename=='docProps/core.xml':",
      "      start=payload.index(b'<dcterms:modified')",
      "      text_start=payload.index(b'>',start)+1",
      "      text_end=payload.index(b'</dcterms:modified>',text_start)",
      "      payload=payload[:text_start]+b'2026-11-20T05:32:42+00:00Z'+payload[text_end:]",
      "    z.writestr(info,payload)"
    ].join("\n");
    const create=run("-c",[python,filename]);
    assert.equal(create.status,0,create.stderr);
    const before=fs.readFileSync(filename);
    const invalid=run(validator,[filename]);
    assert.notEqual(invalid.status,0);
    assert.match(invalid.stderr,/XLSX invalid W3CDTF core timestamp/);

    const updated=run(normalize,[filename]);
    assert.equal(updated.status,0,updated.stderr);
    assert.match(updated.stdout,/CORE_NORMALIZED/);
    const valid=run(validator,[filename]);
    assert.equal(valid.status,0,valid.stderr);
    assert.match(valid.stdout,/XLSX_PACKAGE_OK/);

    const check=[
      "import sys,zipfile,io",
      "from openpyxl import load_workbook",
      "with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as before:",
      "  with zipfile.ZipFile(sys.argv[1]) as after:",
      "    assert before.namelist()==after.namelist()",
      "    changed=[n for n in before.namelist() if before.read(n)!=after.read(n)]",
      "    assert changed==['docProps/core.xml'],changed",
      "    assert b'+00:00Z' not in after.read('docProps/core.xml')",
      "w=load_workbook(sys.argv[1])",
      "assert w.active['A1'].value=='\\u041e\\u041e\\u041e \\u0422\\u0435\\u0441\\u0442'",
      "assert w.active['A1'].comment.text=='Source: https://example.org'",
      "assert w.active['B1'].value==123"
    ].join("\n");
    const inspect=spawnSync("python",["-c",check,filename],{
      cwd:root,input:before,timeout:35000,maxBuffer:4_000_000
    });
    assert.equal(inspect.status,0,String(inspect.stderr));

    const after=fs.readFileSync(filename);
    const repeated=run(normalize,[filename]);
    assert.equal(repeated.status,0,repeated.stderr);
    assert.match(repeated.stdout,/CORE_ALREADY_NORMALIZED/);
    assert.deepEqual(fs.readFileSync(filename),after,"normalization is idempotent");

    const exporter=fs.readFileSync(
      new URL("../scripts/export-reference-xlsx.py",import.meta.url),"utf8");
    assert.match(exporter,/normalize_core_timestamps\(out\)/);
    assert.ok(exporter.indexOf("normalize_core_timestamps(out)")<
      exporter.indexOf("validate_xlsx_package(out)"));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
