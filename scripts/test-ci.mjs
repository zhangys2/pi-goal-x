import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {needsRuntimeChecks,changedFiles} from './ci-scope.mjs';
import {runChecks} from './ci-checks.mjs';
const ciChecks=readFileSync(new URL('./ci-checks.mjs',import.meta.url),'utf8');
const publishWorkflow=readFileSync(new URL('../.github/workflows/publish.yml',import.meta.url),'utf8');

test('CI and publish execute tests separately from manifest self-check',()=>{
 assert.match(ciChecks,/name:'tests',args:\['scripts\/run-unit-tests\.mjs','all'\],noSkippedTests:true/);
 assert.match(ciChecks,/name:'manifest-selfcheck',args:\['scripts\/run-unit-tests\.mjs','all','--selfcheck'\]/);
 assert.match(publishWorkflow,/run: npm run test:all\n\s+- run: npm run test:selfcheck/);
 assert.doesNotMatch(ciChecks,/args:\['scripts\/run-unit-tests\.mjs','all','--selfcheck'\],noSkippedTests:true/);
});

test('only known prose/assets skip runtime checks; uncertainty and mixed changes run them',()=>{
 assert.equal(needsRuntimeChecks(['README.md','docs/controls.md','specs/feature/TECH.md','assets/ranking.json']),false);
 for(const file of ['extensions/goal.ts','tests/goal-controls.test.ts','package-lock.json','.github/workflows/ci.yml','scripts/ci-scope.mjs','unknown.file']) {
  assert.equal(needsRuntimeChecks(['docs/controls.md',file]),true,file);
 }
 assert.equal(needsRuntimeChecks([]),true);
 assert.equal(changedFiles('0'.repeat(40)),undefined);
 assert.equal(changedFiles('not-a-sha'),undefined);
});

test('change detection includes deleted runtime files and compares actual commit trees',()=>{
 const cwd=mkdtempSync(path.join(tmpdir(),'pi-ci-diff-'));
 const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 try {
  git('init','--quiet'); git('config','user.name','CI test'); git('config','user.email','ci@example.invalid');
  writeFileSync(path.join(cwd,'README.md'),'Before\n');mkdirSync(path.join(cwd,'extensions'));writeFileSync(path.join(cwd,'extensions/goal.ts'),'export {};\n');
  git('add','.');git('commit','--quiet','-m','Initial');const base=git('rev-parse','HEAD');
  writeFileSync(path.join(cwd,'README.md'),'After\n');git('add','.');git('commit','--quiet','-m','Docs');
  assert.equal(needsRuntimeChecks(changedFiles(base,cwd)),false);
  rmSync(path.join(cwd,'extensions/goal.ts'));git('add','.');git('commit','--quiet','-m','Delete runtime');
  assert.equal(needsRuntimeChecks(changedFiles(base,cwd)),true);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('parallel checks collect all results, retain logs and propagate a failure',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'pi-ci-checks-'));
 try {
  const results=await runChecks([
   {name:'failed',args:['-e','console.error("expected failure");process.exit(7)']},
   {name:'passed',args:['-e','setTimeout(()=>console.log("finished"),100)']},
   {name:'later',args:['-e','console.log("also ran")']},
  ],{directory,quiet:true});
  assert.deepEqual(results.map(result=>result.passed),[false,true,true]);
  assert.equal(results[0].code,7);
  assert.match(readFileSync(results[0].log,'utf8'),/expected failure/);
  assert.match(readFileSync(results[1].log,'utf8'),/finished/);
  assert.equal(JSON.parse(readFileSync(path.join(directory,'results.json'),'utf8')).length,3);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('direct validation finds local executables without requiring a global CLI',async()=>{
 const cwd=mkdtempSync(path.join(tmpdir(),'pi-ci-path-'));
 try {
  const bin=path.join(cwd,'node_modules','.bin');mkdirSync(bin,{recursive:true});
  writeFileSync(path.join(bin,'pi-goal-ci-probe'),'#!/bin/sh\nprintf "local-tool-found\\n"\n',{mode:0o755});
  const results=await runChecks([{name:'local-cli',args:['-e','console.log(require("node:child_process").execFileSync("pi-goal-ci-probe",{encoding:"utf8"}))']}],{directory:path.join(cwd,'logs'),cwd,quiet:true});
  assert.equal(results[0].passed,true);
  assert.match(readFileSync(results[0].log,'utf8'),/local-tool-found/);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('full-suite checks reject skipped tests and missing summaries',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'pi-ci-skips-'));
 try {
  const results=await runChecks([
   {name:'skipped',args:['-e','console.log("ℹ skipped 2")'],noSkippedTests:true},
   {name:'missing',args:['-e','console.log("no summary")'],noSkippedTests:true},
   {name:'complete',args:['-e','console.log("ℹ skipped 0")'],noSkippedTests:true},
  ],{directory,quiet:true});
  assert.deepEqual(results.map(result=>result.passed),[false,false,true]);
  assert.match(results[0].error,/skipped 2/);
  assert.match(results[1].error,/skip count/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('full-suite checks permit only explicitly named platform skips',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'pi-ci-platform-skips-'));
 try {
  const allowed=await runChecks([
   {name:'windows-only',args:['-e','console.log("﹣ a real .cmd receives its arguments unchanged (0.1ms) # requires Windows cmd.exe\\nℹ skipped 1")'],noSkippedTests:true,allowedSkips:[/﹣\s+a real \.cmd receives its arguments unchanged .*# requires Windows cmd\.exe/i]},
   {name:'unexpected',args:['-e','console.log("﹣ another test (0.1ms) # SKIP\\nℹ skipped 1")'],noSkippedTests:true,allowedSkips:[/﹣\s+a real \.cmd receives its arguments unchanged .*# requires Windows cmd\.exe/i]},
  ],{directory,quiet:true});
  assert.deepEqual(allowed.map(result=>result.passed),[true,false]);
  assert.match(allowed[1].error,/only 0 explicitly allowed platform skips/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
