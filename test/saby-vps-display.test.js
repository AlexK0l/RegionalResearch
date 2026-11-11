import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";

const deploy=name=>readFileSync(new URL(
  "../deploy/time4vps/"+name,import.meta.url),"utf8");

test("optional headed Saby virtual display is isolated from the core service",()=>{
  const base=deploy("regionalresearch.service");
  const xvfb=deploy("regionalresearch-saby-xvfb.service");
  const override=deploy("regionalresearch-saby-xvfb.conf.example");
  assert.match(xvfb,/^User=regionalresearch$/m);
  assert.match(xvfb,/^ExecStart=\/usr\/bin\/Xvfb :99 .* -nolisten tcp /m);
  assert.match(xvfb,/^Restart=always$/m);
  assert.match(override,/^Requires=regionalresearch-saby-xvfb\.service$/m);
  assert.match(override,/^After=regionalresearch-saby-xvfb\.service$/m);
  assert.match(override,/^Environment=DISPLAY=:99$/m);
  assert.match(override,/^Environment=SABY_HEADLESS=false$/m);
  assert.match(override,/^Environment=PLAYWRIGHT_BROWSERS_PATH=/m);
  assert.match(override,/^Environment=XDG_CONFIG_HOME=\/home\/regionalresearch\/\.config\/regionalresearch-saby$/m);
  assert.match(override,/^Environment=XDG_CACHE_HOME=\/home\/regionalresearch\/\.cache\/regionalresearch-saby$/m);
  // No extra X11 dependency or graphical browser required by default.
  assert.doesNotMatch(base,/Xvfb|DISPLAY=|SABY_HEADLESS=/);
  assert.doesNotMatch(xvfb,/5901|x11vnc|nopw|SABY_PASSWORD/);
});
