import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const read=path=>fs.readFileSync(new URL("../"+path,import.meta.url),"utf8");
const index=read("public/index.html"),login=read("public/login.html"),css=read("public/styles.css");
const script=html=>html.match(/<script id="themeBootstrap">([\s\S]*?)<\/script>/)?.[1];
const key="sat_theme_preference";
function boot({saved=null,dark=false,blocked=false,ready="loading",mediaMode="modern",noPicker=false,sharedStore=null}={}){
  const store=sharedStore||new Map(saved===null?[]:[[key,saved]]);
  const writes=[],windowEvents={},docEvents={},pickerEvents={};
  const picker={value:"",addEventListener(type,fn){pickerEvents[type]=fn;}};
  const media={matches:dark};
  let mediaListener;
  if(mediaMode==="modern")media.addEventListener=(type,fn)=>{assert.equal(type,"change");mediaListener=fn;};
  if(mediaMode==="legacy")media.addListener=fn=>{mediaListener=fn;};
  const localStorage={
    getItem(k){if(blocked)throw Error("storage denied");return store.get(k)??null;},
    setItem(k,v){if(blocked)throw Error("storage denied");writes.push([k,v]);store.set(k,v);}
  };
  const document={documentElement:{dataset:{}},readyState:ready,
    addEventListener(type,fn){docEvents[type]=fn;},
    getElementById(id){assert.equal(id,"themePreference");return noPicker?null:picker;}
  };
  const window={localStorage,addEventListener(type,fn){windowEvents[type]=fn;}};
  if(mediaMode!=="none")window.matchMedia=query=>{assert.equal(query,"(prefers-color-scheme: dark)");return media;};
  vm.runInNewContext(script(index),{window,document});
  const result={store,writes,localStorage,picker,theme:()=>document.documentElement.dataset.theme,
    loaded:()=>docEvents.DOMContentLoaded?.(),change(value){picker.value=value;pickerEvents.change();},
    system(value){media.matches=value;mediaListener?.();},
    storage(event){windowEvents.storage(event);}};
  return result;
}
test("both pages initialize before first paint and expose the same labelled theme choice",()=>{
  assert.ok(script(index));assert.equal(script(index),script(login));
  for(const html of [index,login]){
    assert.ok(html.indexOf('id="themeBootstrap"')<html.indexOf("<body>"));
    assert.equal((html.match(/id="themePreference"/g)||[]).length,1);
    assert.match(html,/<label class="theme-picker" for="themePreference">/);
    for(const value of ["system","light","dark"])assert.match(html,new RegExp('<option value="'+value+'">'));
  }
  assert.ok(index.indexOf('id="themeBootstrap"')<index.indexOf('rel="stylesheet"'));
  assert.ok(login.indexOf('id="themeBootstrap"')<login.indexOf("<style>"));
  assert.doesNotMatch(script(index),/\b(?:fetch|XMLHttpRequest|location|cookie)\b/);
  assert.match(login,/<input id="password" type="password" autocomplete="current-password" required autofocus>/);
  assert.match(login,/fetch\("\/api\/auth\/login"/);
  assert.match(index,/app\.js\?v=20261126-billing-durability/);
});
test("system preference is applied immediately and follows system changes",()=>{
  const b=boot({dark:true});
  assert.equal(b.theme(),"dark");
  b.loaded();assert.equal(b.picker.value,"system");
  b.system(false);assert.equal(b.theme(),"light");
  b.system(true);assert.equal(b.theme(),"dark");
  assert.deepEqual(b.writes,[]);
});
test("manual choice persists across pages and overrides system until switched back",()=>{
  const b=boot({dark:true});b.loaded();b.change("light");
  assert.equal(b.theme(),"light");assert.deepEqual(b.writes,[[key,"light"]]);
  b.system(false);b.system(true);assert.equal(b.theme(),"light");
  const next=boot({dark:true,sharedStore:b.store,ready:"complete"});
  assert.equal(next.theme(),"light");assert.equal(next.picker.value,"light");
  next.change("dark");next.system(false);assert.equal(next.theme(),"dark");
  next.change("system");assert.equal(next.theme(),"light");
  assert.equal(next.store.get(key),"system");
});
test("cross-tab changes are synchronized without storage writes or unrelated key changes",()=>{
  const b=boot({saved:"dark",dark:false});b.loaded();
  b.storage({key:"sat_current_job",newValue:"light",storageArea:b.localStorage});
  assert.equal(b.theme(),"dark");
  b.storage({key,newValue:"light",storageArea:{}});assert.equal(b.theme(),"dark");
  b.storage({key,newValue:"light",storageArea:b.localStorage});
  assert.equal(b.theme(),"light");assert.equal(b.picker.value,"light");
  b.storage({key:null,newValue:null,storageArea:b.localStorage});
  assert.equal(b.picker.value,"system");
  b.system(true);assert.equal(b.theme(),"dark");
  assert.deepEqual(b.writes,[]);
});
test("storage failure, invalid preferences and older media API degrade safely",()=>{
  const blocked=boot({blocked:true,dark:true,mediaMode:"legacy"});
  blocked.loaded();assert.equal(blocked.theme(),"dark");
  blocked.change("light");assert.equal(blocked.theme(),"light");
  blocked.system(true);assert.equal(blocked.theme(),"light");
  blocked.change("system");blocked.system(false);assert.equal(blocked.theme(),"light");
  const invalid=boot({saved:"<script>",dark:true,ready:"complete"});
  assert.equal(invalid.picker.value,"system");assert.equal(invalid.theme(),"dark");
  const older=boot({mediaMode:"none",ready:"complete"});
  assert.equal(older.theme(),"light");older.change("dark");assert.equal(older.theme(),"dark");
  const absent=boot({noPicker:true,dark:true});absent.loaded();assert.equal(absent.theme(),"dark");
});
function palette(source,theme){
  const re=theme==="dark"?/:root\[data-theme="dark"\]\{([^}]+)\}/:/:root\{([^}]+)\}/;
  const block=source.match(re)?.[1]||"";
  return Object.fromEntries([...block.matchAll(/--([\w-]+):([^;]+);/g)].map(m=>[m[1],m[2].trim()]));
}
function luminance(hex){
  assert.match(hex,/^#[0-9a-f]{6}$/i);
  const channels=hex.slice(1).match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
  return .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
}
function contrast(a,b){const v=[luminance(a),luminance(b)].sort((x,y)=>y-x);return (v[0]+.05)/(v[1]+.05);}
test("both palettes define all used variables and maintain readable status, controls and input text",()=>{
  const loginCss=login.match(/<style>([\s\S]*?)<\/style>/)[1];
  for(const source of [css,loginCss]){
    const a=palette(source,"light"),b=palette(source,"dark");
    assert.deepEqual(Object.keys(a).sort(),Object.keys(b).sort());
    for(const match of source.matchAll(/var\(--([\w-]+)\)/g)){
      assert.ok(a[match[1]]&&b[match[1]],match[1]);
    }
    assert.match(source,/:root\[data-theme="dark"\]\{\s*color-scheme:dark;/);
    assert.match(source,/button:focus-visible/);
    for(const p of [a,b]){
      for(const [fg,bg] of [["text","surface"],["text","page"],["subtle","surface"],["primary-text","primary"]])
        assert.ok(contrast(p[fg],p[bg])>=4.5,fg+"/"+bg);
      assert.ok(contrast(p.focus,p.surface)>=3);
      if(p.panel){
        for(const [fg,bg] of [["text","panel"],["subtle","panel"],["subtle","selected"],["text","secondary"],["text","active"],
          ["success","panel"],["success","success-bg"],["error","error-bg"],["selected-text","selected"],["muted","grade-c"],["detail","panel"]])
          assert.ok(contrast(p[fg],p[bg])>=4.5,fg+"/"+bg);
      }else assert.ok(contrast(p.error,p.surface)>=4.5);
    }
  }
  for(const selector of [".jobs-item.selected",".eta-panel",".steps li.done",".error",".grade-A",".grade-B",".grade-C","#progressBar"]){
    const start=css.indexOf(selector+"{");
    assert.ok(start>=0,selector);assert.match(css.slice(start,css.indexOf("}",start)),/var\(--/);
  }
  assert.match(css,/\.hero \.theme-picker\{order:-1;align-self:flex-end\}/);
});
