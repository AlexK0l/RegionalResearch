import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";

const root=fileURLToPath(new URL("../",import.meta.url));
const normalize=path.join(root,"scripts","normalize_excel_vml.py");
const validator=path.join(root,"scripts","validate_xlsx_package.py");
const run=(script,args,{cwd=root}={})=>spawnSync("python",[script,...args],{
  cwd,timeout:35000,encoding:"utf8",maxBuffer:4_000_000
});
const hash=buffer=>crypto.createHash("sha256").update(buffer).digest("hex");

test("openpyxl duplicate VML clusters across sheets are normalized without losing comments",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rr-vml-regression-"));
  const filename=path.join(dir,"multi-sheet.xlsx");
  try{
    const create=[
      "from openpyxl import Workbook",
      "from openpyxl.comments import Comment",
      "import sys",
      "wb=Workbook()",
      "ws=wb.active",
      "ws.title='Прямые покупатели'",
      "for k in range(1060):",
      "  c=ws.cell(k+2,2,'ООО Компания '+str(k))",
      "  c.comment=Comment('Данные по компании '+str(k)+'\\nИсточник: https://example.org/'+str(k),'RegionalResearch')",
      "for name,amount in [('Лизинг',5),('Посредники',3)]:",
      "  sh=wb.create_sheet(name)",
      "  for k in range(amount):",
      "    c=sh.cell(k+2,3,'ООО Пример '+str(k))",
      "    c.comment=Comment('Контракт на перевозку '+str(k),'RegionalResearch')",
      "wb.create_sheet('Статистика')",
      "wb.create_sheet('Легенда цветов')",
      "wb.save(sys.argv[1])"
    ].join("\n");
    const generated=run("-c",[create,filename]);
    assert.equal(generated.status,0,generated.stderr);
    const original=fs.readFileSync(filename);
    const preflight=run(validator,[filename]);
    assert.notEqual(preflight.status,0,
      "strict validator must catch openpyxl duplicated shape clusters");
    assert.match(preflight.stderr,/VML (?:idmap does not cover|cross-sheet duplicate|1024-ID block shared)/);

    const updated=run(normalize,[filename]);
    assert.equal(updated.status,0,updated.stderr);
    assert.match(updated.stdout,/VML_NORMALIZED/);
    const repaired=fs.readFileSync(filename);
    assert.notEqual(hash(original),hash(repaired));
    const verified=run(validator,[filename]);
    assert.equal(verified.status,0,verified.stderr);
    assert.match(verified.stdout,/XLSX_PACKAGE_OK/);

    const verifySource=[
      "from openpyxl import load_workbook",
      "import io,sys,json,zipfile",
      "p=load_workbook(io.BytesIO(sys.stdin.buffer.read()))",
      "f=load_workbook(sys.argv[1])",
      "assert p.sheetnames==f.sheetnames",
      "out={}",
      "for a,b in zip(p.worksheets,f.worksheets):",
      "  assert a.max_row==b.max_row",
      "  for row in a:",
      "    for cell in row:",
      "      t=b[cell.coordinate]",
      "      assert cell.value==t.value",
      "      assert (cell.comment.text if cell.comment else None)==(t.comment.text if t.comment else None)",
      "  out[a.title]=sum(bool(c.comment) for row in b for c in row)",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      "  out['idmap1']='data=\"1,2\"' in z.read('xl/drawings/commentsDrawing1.vml').decode('utf-8')",
      "  out['idmap2']='data=\"3\"' in z.read('xl/drawings/commentsDrawing2.vml').decode('utf-8')",
      "  out['idmap3']='data=\"4\"' in z.read('xl/drawings/commentsDrawing3.vml').decode('utf-8')",
      "sys.stdout.buffer.write(json.dumps(out,ensure_ascii=False).encode('utf-8'))"
    ].join("\n");
    const compare=spawnSync("python",["-c",verifySource,filename],{
      cwd:root,input:original,timeout:35000,maxBuffer:2_000_000
    });
    assert.equal(compare.status,0,String(compare.stderr));
    const x=JSON.parse(compare.stdout.toString("utf8"));
    assert.deepEqual(x,{
      "Прямые покупатели":1060,"Лизинг":5,"Посредники":3,
      "Статистика":0,"Легенда цветов":0,
      idmap1:true,idmap2:true,idmap3:true
    });
    const repeated=run(normalize,[filename]);
    assert.equal(repeated.status,0,repeated.stderr);
    assert.match(repeated.stdout,/VML_ALREADY_NORMALIZED/);
    assert.equal(hash(repaired),hash(fs.readFileSync(filename)));
  }finally{
    fs.rmSync(dir,{recursive:true,force:true});
  }
});

test("all Excel export paths normalize before serving old stored results",()=>{
  const exporter=fs.readFileSync(
    new URL("../scripts/export-reference-xlsx.py",import.meta.url),"utf8");
  const validatorSource=fs.readFileSync(
    new URL("../scripts/validate_xlsx_package.py",import.meta.url),"utf8");
  assert.match(exporter,/normalize_comment_vml_ids\(out\)/);
  assert.ok(exporter.indexOf("normalize_comment_vml_ids(out)")<
    exporter.indexOf("validate_xlsx_package(out)"));
  assert.match(validatorSource,/global_shapes=\{\}/);
  assert.match(validatorSource,/global_blocks=\{\}/);
});
