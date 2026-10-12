"use strict";
const { join, resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require("node:fs");
const root = resolve(__dirname, "..");
const output = join(root, "artifacts/library-filter-choices");

if (!process.versions.electron) {
  mkdirSync(output, { recursive: true });
  require("esbuild").buildSync({ entryPoints: [join(root, "src/renderer/libraryFilterChoices.ts")], bundle: true, format: "iife", globalName: "Choices", outfile: join(output, "fixture.js") });
  const env = { ...process.env, FILTER_CHOICES_PROFILE: mkdtempSync(join(output, "profile-")) };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = require("node:child_process").spawnSync(require("electron"), [__filename], { env, windowsHide: true, stdio: "inherit", timeout: 45000 });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    const profile = resolve(env.FILTER_CHOICES_PROFILE);
    if (!profile.startsWith(output + sep + "profile-")) throw Error("Unexpected fixture cleanup path");
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
} else {
  void main().catch(error => { console.error(error); require("electron").app.exit(1); });
}

async function main() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.FILTER_CHOICES_PROFILE);
  app.disableHardwareAcceleration();
  await app.whenReady();
  const window = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, callback) => callback({ cancel: true }));
  writeFileSync(join(output, "fixture.html"), `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(root, "src/renderer/styles.css"))}"></head><body style="padding:20px;overflow:auto"><h1>Library filters</h1><main id="fixture"></main></body></html>`);
  await window.loadFile(join(output, "fixture.html"));
  await window.webContents.executeJavaScript(readFileSync(join(output, "fixture.js"), "utf8"));
  const checks = await window.webContents.executeJavaScript(`(async () => {
    const checks=[]; const check=(value,label)=>{if(!value)throw Error(label);checks.push(label);};
    const settle=ms=>new Promise(resolve=>setTimeout(resolve,ms));
    const until=async predicate=>{for(let i=0;i<100;i++){if(predicate())return;await settle(10);}throw Error('Fixture condition timed out');};
    const requests=[]; const selected=[]; const known=new Map(); let failMore=true; let releaseOld;
    const page=(items,nextStartIndex=null)=>({items,hasMore:nextStartIndex!==null,nextStartIndex});
    const first={value:'off-page-person',label:'An actor outside the current page'};
    const control=Choices.createLibraryFilterChoices({label:'People',known,selected:()=>selected,
      change:(value,checked)=>{const index=selected.indexOf(value);if(checked&&index<0)selected.push(value);if(!checked&&index>=0)selected.splice(index,1);},
      load:async(query,startIndex)=>{
        requests.push({query,startIndex});
        if(query==='old')return new Promise(resolve=>{releaseOld=resolve;});
        if(query==='new'){await settle(40);return page([{value:'new-person',label:'New search result'}]);}
        if(startIndex===50&&failMore){failMore=false;throw {code:'REQUEST_FAILED',message:'Network interrupted',retryable:true};}
        if(startIndex===50)return page([first,{value:'other-person',label:'Another actor'}]);
        return page([first],50);
      }});
    control.element.classList.add('filter-section-body'); document.getElementById('fixture').append(control.element);
    check(requests.length===0,'Collapsed choices do not request metadata');
    control.activate();control.activate();await until(()=>control.element.querySelector('input[type=checkbox]'));
    check(requests.length===1,'Opening a choice list coalesces its initial request');
    const firstBox=control.element.querySelector('input[type=checkbox]');firstBox.focus();firstBox.click();
    check(selected[0]===first.value&&document.activeElement===firstBox&&firstBox.isConnected,'Selecting a library-wide choice preserves the active checkbox');
    check(!control.element.querySelector('.filter-option-count'),'Unknown library counts are not replaced with current-page counts');
    const more=control.element.querySelector('[aria-label="Load more people"]');more.focus();more.click();
    await until(()=>control.element.textContent.includes('Could not load'));
    check(firstBox.isConnected&&firstBox.checked,'Failed pagination preserves loaded choices and selection');
    check(control.element.textContent.includes('Network interrupted'),'Public IPC errors retain actionable explanations');
    const retry=[...control.element.querySelectorAll('button')].find(button=>button.textContent==='Try again');
    check(document.activeElement===retry&&!retry.hidden,'Failed pagination offers a focused retry');retry.click();
    await until(()=>control.element.querySelectorAll('.filter-option-list input').length===2);
    check(requests.at(-1).startIndex===50,'Retry resumes the failed page');
    check(firstBox.isConnected&&control.element.querySelectorAll('[data-filter-value="off-page-person"]').length===1,'Additional pages preserve controls and deduplicate overlap');
    check(more.hidden&&getComputedStyle(more).display==='none','Exhausted pagination hides Load more');
    const search=control.element.querySelector('input[type=search]');
    const query=value=>{search.value=value;search.dispatchEvent(new Event('input'));};
    query('old');await until(()=>requests.some(request=>request.query==='old'));
    check(control.element.querySelector('.filter-choice-selection input')?.checked,'Selected choices remain available during a different search');
    query('new');const retainedBox=control.element.querySelector('.filter-choice-selection input');retainedBox.focus();await until(()=>control.element.textContent.includes('New search result'));
    check(retainedBox.isConnected&&document.activeElement===retainedBox,'Search responses preserve focused retained selections');
    releaseOld(page([{value:'stale-person',label:'Stale search result'}]));await settle(30);
    check(!control.element.textContent.includes('Stale search result'),'Late search results cannot replace the latest query');
    const pinned=control.element.querySelector('.filter-choice-selection input');pinned.focus();pinned.click();
    check(selected.length===0&&document.activeElement===search&&!control.element.querySelector('.filter-choice-selection input'),'Removing a retained selection restores search focus');
    const before=requests.length;query('cancelled');control.dispose();await settle(300);
    check(requests.length===before,'Closing the drawer cancels a pending search debounce');
    check(document.documentElement.scrollWidth<=innerWidth,'Remote filter choices fit a narrow window');
    return checks;
  })()`);
  writeFileSync(join(output, "choices-420.png"), (await window.webContents.capturePage()).toPNG());
  writeFileSync(join(output, "result.json"), JSON.stringify({ passed: checks.length, checks }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
  app.exit(0);
}
