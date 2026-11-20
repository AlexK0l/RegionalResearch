import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root=fileURLToPath(new URL("../",import.meta.url));
const script=path.join(root,"scripts","saby-smoke.js");
const run=args=>spawnSync(process.execPath,[script,...args],{
  cwd:root,encoding:"utf8",timeout:15000,maxBuffer:2_000_000,
  env:{...process.env,OPENAI_API_KEY:"",SABY_LOGIN:"",SABY_PASSWORD:""}
});

test("one-company finance-only smoke is advertised and requires explicit limit=1",()=>{
  const help=run(["--help"]);
  assert.equal(help.status,0,help.stderr);
  assert.match(help.stdout,/--finance-only/);

  const rejected=run([
    "--inn=4718000935","--name=Волховское, АО",
    "--limit=2","--finance-only"
  ]);
  assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/--finance-only допускается только с --limit=1/);
  assert.doesNotMatch(rejected.stdout,/Тестирую Saby без OpenAI/);
});
