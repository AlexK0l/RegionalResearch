import test from "node:test";
import assert from "node:assert/strict";
import {
  sabyPublicProfileRoute,canonicalSabyPublicRoute,
  extractSabyPublicRequisites,compareSabyPublicRequisites,
  verifyPublicSabyIdentity,safeSabyPublicLoadDiagnostic,
  safeSabyVisibleRequisitesText,diagnoseSabyPublicRequisiteLayout
} from "../src/sabyPublicRegisteredIdentity.js";

const inn="7725104641",kpp="504301001",ogrn="1027739058258";
const source="АО «ДСК «Автобан»";
const short='ДСК "Автобан", АО';
const full='АКЦИОНЕРНОЕ ОБЩЕСТВО "ДОРОЖНО-СТРОИТЕЛЬНАЯ КОМПАНИЯ "АВТОБАН"';
const route="https://saby.ru/profile/"+inn+"-"+kpp;
const text=[
  "Компания, ИНН или руководитель","Реквизиты:",
  "О компании","Название: "+short,
  "ИНН: "+inn,"КПП: "+kpp,
  "Контакты","Телефоны","Связанные компании",
  "Реквизиты","Название",full,
  "ИНН",inn,"КПП",kpp,"ОГРН",ogrn,
  "ОКПО","51115503","Регистрация компании"
].join("\n");

test("Saby public profile address uses only observed exact INN and KPP",()=>{
  assert.equal(sabyPublicProfileRoute(inn,kpp),route);
  assert.equal(sabyPublicProfileRoute(inn,"50430100"),"");
  assert.equal(canonicalSabyPublicRoute(route,inn,kpp),true);
  for(const url of [
    "http://saby.ru/profile/"+inn+"-"+kpp,
    "https://saby.ru.evil.test/profile/"+inn+"-"+kpp,
    "https://evil.test/profile/"+inn+"-"+kpp,
    "https://user:pw@saby.ru/profile/"+inn+"-"+kpp,
    "https://saby.ru/profile/"+inn+"-504301002",
    "https://saby.ru/profile/"+inn+"-"+kpp+"/related"
  ])assert.equal(canonicalSabyPublicRoute(url,inn,kpp),false,url);
});

test("public requisites extract full official name from labelled registered block",()=>{
  assert.deepEqual(extractSabyPublicRequisites(text),[
    {name:full,inn,kpp,ogrn}
  ]);
  assert.deepEqual(extractSabyPublicRequisites(
    "О компании\nНазвание: "+short+"\nРеквизиты:\n- ИНН: "+inn+
    "\n- КПП: "+kpp),[]);
  assert.deepEqual(extractSabyPublicRequisites(
    "Связанные компании\nНазвание\n"+full+"\nИНН\n"+inn+"\nКПП\n"+kpp),[]);
  assert.deepEqual(extractSabyPublicRequisites(
    "Реквизиты\nО компании\nНазвание\n"+short+
    "\nИНН\n"+inn+"\nКПП\n"+kpp),[]);
  assert.deepEqual(extractSabyPublicRequisites(
    "Реквизиты\nНазвание\n"+full+"\nИНН\n7700000000\nКПП\n"+kpp),
    [{name:full,inn:"7700000000",kpp,ogrn:""}]);
});

test("source shortened title can be verified only via same public registered record",()=>{
  const observed={
    expectedInn:inn,expectedKpp:kpp,expectedName:source,
    publicTitle:short,records:extractSabyPublicRequisites(text),url:route
  };
  const verified=compareSabyPublicRequisites(observed);
  assert.equal(verified.status,"verified");
  assert.equal(verified.match_type,"short_title_registered_alias");
  assert.equal(verified.official_name,full);
  assert.equal(verified.official_inn,inn);
  assert.equal(verified.official_kpp,kpp);
  assert.equal(compareSabyPublicRequisites({
    ...observed,expectedName:full,publicTitle:"не важно"
  }).match_type,"registered_full_name");
});

test("source display mismatch and legal-form conflict remain review",()=>{
  const basics={
    expectedInn:inn,expectedKpp:kpp,publicTitle:short,
    records:extractSabyPublicRequisites(text),url:route
  };
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:"ООО «НЕО ТРАНС»"
  }).reason,"legal_form_conflict");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:"АО «Другая компания»"
  }).reason,"name_not_matched_to_registered_entity");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:source,publicTitle:""
  }).status,"review");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:source,
    records:[{...basics.records[0],kpp:"504301002"}]
  }).reason,"inn_kpp_conflict");
  assert.equal(compareSabyPublicRequisites({
    ...basics,expectedName:source,url:"https://evil.example"
  }).reason,"public_route_untrusted");
});

function fakeBrowser({
  body=text,title=short,
  landed=route
}={}) {
  let opened=0,closed=0,requested="";
  return {
    page:{
      context:()=>({newPage:async()=>{
        opened++;
        return {
          goto:async url=>{requested=url;},
          url:()=>landed,
          evaluate:async()=>({body,title}),
          waitForTimeout:async()=>{},
          close:async()=>{closed++;}
        };
      }})
    },
    stats:()=>({opened,closed,requested})
  };
}

test("public browser verified request preserves original tab and closes child tab",async()=>{
  const {page,stats}=fakeBrowser();
  const result=await verifyPublicSabyIdentity(page,inn,kpp,source);
  assert.equal(result.status,"verified");
  assert.deepEqual(stats(),{opened:1,closed:1,requested:route});
});

test("public browser redirects and missing registered records never verify",async()=>{
  for(const obj of [
    {landed:"https://attacker.test/profile/"+inn+"-"+kpp},
    {body:"О компании\nНазвание: "+short+"\nИНН: "+inn,
      title:short}
  ]) {
    const {page,stats}=fakeBrowser(obj);
    const result=await verifyPublicSabyIdentity(page,inn,kpp,source);
    assert.equal(result.status,"review");
    assert.equal(stats().closed,1);
  }
});


test("safe public diagnostic exposes no arbitrary content and distinguishes missing UI",()=>{
  const metrics=safeSabyPublicLoadDiagnostic({
    body:"Тест\nИНН\n7725104641\nРеквизиты\nКонтакты\nemail@example.com",
    bodyChars:68,domTextChars:500,h1Count:1,title:"",
  },200);
  assert.equal(metrics.http_status,200);
  assert.equal(metrics.h1_has_text,false);
  assert.equal(metrics.requisites_heading_visible,true);
  assert.equal(metrics.registered_name_label_visible,false);
  assert.equal(metrics.inn_label_visible,true);
  assert.equal(metrics.kpp_label_visible,false);
  assert.equal(JSON.stringify(metrics).includes("7725104641"),false);
  assert.equal(JSON.stringify(metrics).includes("email@example.com"),false);
});

test("large Saby profile preserves terminal registered requisites instead of truncating",()=>{
  const huge="Статистика\n"+"Данные компании\n".repeat(18000)+text;
  assert.ok(huge.length>190000);
  assert.deepEqual(extractSabyPublicRequisites(
    safeSabyVisibleRequisitesText(huge)),[{name:full,inn,kpp,ogrn}]);
});

test("public Saby profile waits for lazy-loaded requisites after DOMContentLoaded",async()=>{
  let opened=0,closed=0,calls=0,waits=0;
  const page={context:()=>({newPage:async()=>{
    opened++;
    return {
      goto:async()=>({status:()=>200}),
      url:()=>route,
      evaluate:async()=>{
        calls++;
        return {
          body:calls<=2?"Загрузка данных компании\n":
            "ДСК Автобан\n"+text,
          title:calls<=2?"":short,
          bodyChars:calls<=2?23:500,
          h1Count:calls<=2?0:1
        };
      },
      waitForTimeout:async()=>{waits++;},
      close:async()=>{closed++;}
    };
  }})};
  const result=await verifyPublicSabyIdentity(page,inn,kpp,source);
  assert.equal(result.status,"verified");
  assert.equal(result.official_inn,inn);
  assert.equal(result.diagnostic.h1_has_text,true);
  assert.equal(calls,3);
  assert.equal(waits,2);
  assert.equal(opened,1);
  assert.equal(closed,1);
});

test("public Saby page lacking DOM text reports load failure with no false verification",async()=>{
  let closed=0;
  const page={context:()=>({newPage:async()=>({
    goto:async()=>({status:()=>200}),
    url:()=>route,
    evaluate:async()=>({body:"",title:"",bodyChars:0,
      domTextChars:300,h1Count:0}),
    waitForTimeout:async()=>{},
    close:async()=>{closed++;}
  })})};
  const result=await verifyPublicSabyIdentity(page,inn,kpp,source,
    {timeoutMs:3000});
  assert.equal(result.status,"review");
  assert.equal(result.reason,"public_body_empty");
  assert.equal(result.diagnostic.dom_text_chars,300);
  assert.equal(result.diagnostic.visible_text_chars,0);
  assert.equal(closed,1);
});

test("public Saby page with HTTP error or challenge never verifies",async()=>{
  for(const [status,body,reason] of [
    [403,"", "http_status_not_ok"],
    [200,"Проверка, что вы не робот. captcha","public_page_challenge"]
  ]) {
    let closed=0;
    const page={context:()=>({newPage:async()=>({
      goto:async()=>({status:()=>status}),
      url:()=>route,
      evaluate:async()=>({body,title:"",bodyChars:body.length}),
      waitForTimeout:async()=>{},
      close:async()=>{closed++;}
    })})};
    const result=await verifyPublicSabyIdentity(page,inn,kpp,source,
      {timeoutMs:3000});
    assert.equal(result.status,"review");
    assert.equal(result.reason,reason);
    assert.equal(closed,1);
  }
});

test("public Saby missing registered name label is reported separately",async()=>{
  let closed=0;
  const body="ДСК Автобан\nРеквизиты\nИНН\n"+inn+
    "\nКПП\n"+kpp+"\nОГРН\n"+ogrn;
  const page={context:()=>({newPage:async()=>({
    goto:async()=>({status:()=>200}),
    url:()=>route,
    evaluate:async()=>({body,title:short,bodyChars:body.length}),
    waitForTimeout:async()=>{},
    close:async()=>{closed++;}
  })})};
  const result=await verifyPublicSabyIdentity(page,inn,kpp,source,
    {timeoutMs:3000});
  assert.equal(result.status,"review");
  assert.equal(result.reason,"registered_name_not_rendered");
  assert.equal(result.diagnostic.requisites_heading_visible,true);
  assert.equal(result.diagnostic.inn_label_visible,true);
  assert.equal(result.diagnostic.kpp_label_visible,true);
  assert.equal(closed,1);
});


test("real-world public requisites with intervening sublabels and punctuation",()=>{
  const cases=[
    "Реквизиты\nОсновная информация\nПолное наименование: "+full+
      "\nИНН: "+inn+";\nКПП: "+kpp+";\nОГРН: "+ogrn+".\nРегистрация компании",
    "Реквизиты\nКПП\n"+kpp+"\nИНН\n"+inn+
      "\nНазвание\n"+full+"\nОГРН\n"+ogrn+"\nКонтакты",
    "Реквизиты:\nНаименование организации "+full+
      "\nИНН "+inn+"\nКПП "+kpp+"\nОГРН "+ogrn,
    "Реквизиты\nНазвание\n"+full+"\nИНН: "+inn+";\nКПП: "+kpp+";"
  ];
  for(const value of cases){
    const result=extractSabyPublicRequisites(value);
    assert.equal(result.length,1,value.slice(0,100));
    assert.equal(result[0].name,full);
    assert.equal(result[0].inn,inn);
    assert.equal(result[0].kpp,kpp);
  }
});

test("name and INN/KPP separated by unrelated company section never join",()=>{
  const cases=[
    "Реквизиты\nНазвание\n"+full+"\nКонтакты\nИНН\n"+inn+"\nКПП\n"+kpp,
    "Реквизиты\nНазвание\n"+full+"\nИНН\n"+inn+
      "\nСвязанные компании\nКПП\n"+kpp,
    "Реквизиты\nНазвание\n"+full+"\nИНН\n"+inn+
      "\nКПП\n"+kpp+"\nНазвание\nООО ЧУЖАЯ КОМПАНИЯ",
    "Реквизиты\nНазвание\n"+full+"\nИНН\n"+inn+
      "\nКПП\n"+kpp+"\nИНН\n7707083893",
    "Реквизиты\nО компании\nНазвание\n"+full+
      "\nИНН\n"+inn+"\nКПП\n"+kpp,
    "Реквизиты:\n- ИНН: "+inn+";\n- КПП: "+kpp+";\nО компании\nНазвание: "+full,
  ];
  for(const value of cases)
    assert.deepEqual(extractSabyPublicRequisites(value),[],value.slice(0,120));
});

test("requisite-layout diagnostics show field offsets, never INN or company name",()=>{
  const input="Меню\nРеквизиты\nО компании\nРеквизиты\n" +
    "Информация\nПолное наименование\n"+full+
    "\nИНН\n"+inn+"\nКПП\n"+kpp;
  const layout=diagnoseSabyPublicRequisiteLayout(input);
  assert.equal(layout.anchors,2);
  assert.equal(layout.field_layouts[0].name_values,0);
  assert.equal(layout.field_layouts[1].name_values,1);
  assert.equal(layout.field_layouts[1].inn_values,1);
  assert.equal(layout.field_layouts[1].kpp_values,1);
  assert.equal(JSON.stringify(layout).includes(full),false);
  assert.equal(JSON.stringify(layout).includes(inn),false);
  assert.equal(JSON.stringify(layout).includes(kpp),false);
});

test("public verifier embeds safe registered-label offsets on unavailable result",async()=>{
  let closed=0;
  const body="Реквизиты\nО компании\nНазвание: "+short+
    "\nИНН: "+inn+"\nКПП: "+kpp;
  const page={context:()=>({newPage:async()=>({
    goto:async()=>({status:()=>200}),
    url:()=>route,
    evaluate:async()=>({body,title:short,bodyChars:body.length}),
    waitForTimeout:async()=>{},
    close:async()=>{closed++;}
  })})};
  const result=await verifyPublicSabyIdentity(page,inn,kpp,source,{timeoutMs:3000});
  assert.equal(result.status,"review");
  assert.equal(result.diagnostic.requisite_layout.anchors,1);
  assert.equal(result.diagnostic.requisite_layout.field_layouts[0].name_values,0);
  assert.equal(closed,1);
});
