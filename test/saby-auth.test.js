import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { authenticateSaby, sabyCredentials, trustedSabyLoginUrl,
  sabyProfileSessionReady, waitForSabySession, SabyAuthError } from "../src/sabyAuth.js";
import { sabyBrowserSettings } from "../src/sabyBrowser.js";

const LOGIN="researcher@example.org";
const PASSWORD="S3CRET#with spaces";
const PROFILE="https://profile.saby.ru/page/company-list-prof";
const AUTH="https://online.saby.ru/auth/";

function locator(count, onFill=()=>{}, onPress=()=>{}) {
  return {
    async count(){return count;},
    nth(){return {
      async isVisible(){return true;},
      async fill(value){onFill(value);},
      async press(key){onPress(key);}
    };}
  };
}
function stubPage({signedIn=false, redirectHost=false, otp=false,
  profileRedirectToSso=false}={}) {
  let current=PROFILE, state="anonymous_profile";
  const values={login:null,password:null,profileNavigations:0,authNavigations:0};
  const page={
    values,
    url(){return current;},
    async goto(url) {
      if(url===PROFILE) {
        values.profileNavigations++;
        current=profileRedirectToSso&&!signedIn
          ?"https://sso.sbis.ru/auth-online/?ret=profile.saby.ru%2Fpage%2Fcompany-list-prof"
          :PROFILE;
        state=signedIn?"ready_profile":
          profileRedirectToSso?"login_form":"anonymous_profile";
      }else if(url===AUTH) {
        values.authNavigations++;
        current=redirectHost?"https://evil.example/auth/":AUTH;
        state=redirectHost?"evil":"login_form";
      } else throw Error("Unexpected navigation");
    },
    locator(selector) {
      if(selector.includes('input[type="search"]')) {
        return locator(state==="ready_profile"?1:0);
      }
      if(selector.includes('autocomplete="username"')) {
        return locator(state==="login_form"?1:0,
          value=>{values.login=value;},
          key=>{if(key==="Enter")state="password_form";});
      }
      if(selector.includes('type="password"')) {
        return locator(state==="password_form"?1:0,
          value=>{values.password=value;},
          key=>{if(key==="Enter"){
            if(otp){state="otp";}
            else {
              signedIn=true;state="cabinet";
              current="https://online.saby.ru/page/dashboard";
            }
          }});
      }
      if(selector.includes('autocomplete="one-time-code"')) {
        return locator(state==="otp"?1:0);
      }
      return locator(0);
    },
    getByRole(){return locator(0);},
    getByText(){return locator(0);}
  };
  return page;
}
const settings={login:LOGIN,password:PASSWORD,timeoutMs:15000};

test("both Saby credential fields are optional together but never one alone",()=>{
  assert.deepEqual(sabyCredentials({}),{login:"",password:"",configured:false});
  assert.deepEqual(sabyCredentials({SABY_LOGIN:" user ",SABY_PASSWORD:" pass "}),
    {login:"user",password:" pass ",configured:true});
  assert.throws(()=>sabyCredentials({SABY_LOGIN:"user"}),SabyAuthError);
  assert.throws(()=>sabyCredentials({SABY_PASSWORD:"pass"}),SabyAuthError);
  const browser=sabyBrowserSettings({
    SABY_LOGIN:LOGIN,SABY_PASSWORD:PASSWORD, SABY_PROFILE_DIR:"data/test-saby"
  });
  assert.equal(browser.login,LOGIN);
  assert.equal(browser.password,PASSWORD);
});

test("Saby password is sent only on the canonical HTTPS login page",()=>{
  assert.equal(trustedSabyLoginUrl(AUTH),true);
  assert.equal(trustedSabyLoginUrl("https://online.saby.ru/auth/reset"),true);
  for(const url of ["http://online.saby.ru/auth/",
    "https://online.saby.ru.evil.example/auth/",
    "https://evil.example/auth/","https://online.saby.ru/other"]) {
    assert.equal(trustedSabyLoginUrl(url),false,url);
  }
});

test("official SBIS and Saby SSO domains are trusted only under their auth paths",()=>{
  for(const url of [
    "https://sso.sbis.ru/auth-online/?ret=profile.saby.ru%2F",
    "https://sso.saby.ru/auth-online/","https://online.saby.ru/auth/"
  ]) assert.equal(trustedSabyLoginUrl(url),true,url);
  for(const url of [
    "https://sso.sbis.ru/auth-other/",
    "http://sso.sbis.ru/auth-online/",
    "https://sso.sbis.ru.evil.example/auth-online/"
  ]) assert.equal(trustedSabyLoginUrl(url),false,url);
});

test("profile SSO redirect retains return URL without visiting another login page",async()=>{
  const page=stubPage({profileRedirectToSso:true});
  const stages=[];
  const result=await authenticateSaby(page,settings,{
    onPhase:stage=>stages.push(stage)
  });
  assert.equal(result.status,"authenticated");
  assert.equal(page.values.authNavigations,0);
  assert.equal(page.values.login,LOGIN);
  assert.equal(page.values.password,PASSWORD);
  assert.ok(stages.includes("password_field_found"));
  assert.ok(!JSON.stringify(stages).includes(PASSWORD));
});

test("existing Saby profile uses zero credential submissions",async()=>{
  const page=stubPage({signedIn:true});
  const auth=await authenticateSaby(page,settings);
  assert.equal(auth.status,"existing_session");
  assert.equal(page.values.authNavigations,0);
  assert.equal(page.values.login,null);
  assert.equal(page.values.password,null);
});

test("redirect outside official Saby domain never receives login/password",async()=>{
  const page=stubPage({redirectHost:true});
  const auth=await authenticateSaby(page,settings,{allowManual:true});
  assert.equal(auth.status,"manual_required");
  assert.equal(page.values.login,null);
  assert.equal(page.values.password,null);
  assert.ok(!JSON.stringify(auth).includes(PASSWORD));
});

test("two-step Saby login uses .env credentials and confirms the profile",async()=>{
  const page=stubPage();
  const auth=await authenticateSaby(page,settings);
  assert.equal(auth.status,"authenticated");
  assert.equal(page.values.login,LOGIN);
  assert.equal(page.values.password,PASSWORD);
  assert.ok(page.values.profileNavigations>=2);
  assert.ok(!JSON.stringify(auth).includes(PASSWORD));
});

test("Saby OTP is never bypassed or retried, and logged errors contain no password",async()=>{
  const page=stubPage({otp:true});
  const auth=await authenticateSaby(page,settings,{allowManual:true});
  assert.equal(auth.status,"manual_required");
  assert.match(auth.message,/подтверждения/);
  assert.ok(!JSON.stringify(auth).includes(PASSWORD));
  await assert.rejects(authenticateSaby(stubPage({otp:true}),settings),
    error => error instanceof SabyAuthError && !error.message.includes(PASSWORD));
});

test("new company-list UI with no input[type=search] confirms the logged-in session",async()=>{
  const page=stubPage();
  const original=page.locator.bind(page);
  page.locator=selector=>selector.includes('input[type="search"]')
    ?locator(0):original(selector);
  // The fallback is only consulted on the first-party company-list URL.
  page.evaluate=async()=>page.url()===PROFILE &&
    page.values.password===PASSWORD;
  const result=await authenticateSaby(page,settings);
  assert.equal(result.status,"authenticated");
  assert.equal(await sabyProfileSessionReady(page),true);
  const phases=[];
  const wait=await waitForSabySession(page,{
    timeoutMs:150,pollMs:20,onPhase:p=>phases.push(p)
  });
  assert.equal(wait.status,"authenticated");
  assert.deepEqual(phases,["authenticated"]);
});

test("an SSO/login page never passes company-list readiness check",async()=>{
  const page=stubPage();
  await page.goto(AUTH);
  page.evaluate=async()=>true;
  assert.equal(await sabyProfileSessionReady(page),false);
  const result=await waitForSabySession(page,{timeoutMs:120,pollMs:20});
  assert.equal(result.status,"timeout");
});

test("Windows login smoke does not request terminal Enter and waits for the session",()=>{
  const script=fs.readFileSync(new URL("../scripts/saby-smoke.js",import.meta.url),"utf8");
  assert.match(script,/waitForSabySession/);
  assert.doesNotMatch(script,/createInterface|Готово\\? Нажмите Enter/);
});

test("Windows smoke command loads the private .env without passing credentials on CLI",()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url)));
  assert.match(pkg.scripts["saby:smoke"],/--env-file-if-exists=\.env/);
  assert.doesNotMatch(pkg.scripts["saby:smoke"],/SABY_PASSWORD=/);
  const gitignore=fs.readFileSync(new URL("../.gitignore",import.meta.url),"utf8");
  assert.match(gitignore,/(?:^|\r?\n)\.env(?:\r?\n|$)/);
  const example=fs.readFileSync(new URL("../.env.example",import.meta.url),"utf8");
  assert.match(example,/(?:^|\r?\n)SABY_LOGIN=/);
  assert.match(example,/(?:^|\r?\n)SABY_PASSWORD=/);
});
