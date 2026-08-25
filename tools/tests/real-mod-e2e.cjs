#!/usr/bin/env node
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),{spawn}=require('child_process'),{pathToFileURL}=require('url');
const ROOT=path.resolve(__dirname,'../..');
const MOD=process.argv[2]||'C:/Users/eddy/Documents/Paradox Interactive/Stellaris/mod/mymod/KuatAncientEmpire';
const GAME=process.argv[3]||'C:/Program Files (x86)/Steam/steamapps/common/Stellaris';
const RULES=process.argv[4]||path.join(ROOT,'submodules/cwtools-stellaris-config/config');
const SERVER=process.argv[5]||path.join(ROOT,'rust/target/release/cwtools-lsp.exe');
const target=path.join(MOD,'events/kuat_shipyard_events.txt'),text=fs.readFileSync(target,'utf8'),uri=pathToFileURL(target).href,rootUri=pathToFileURL(MOD).href;
function frame(msg){const body=Buffer.from(JSON.stringify(msg));return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`),body]);}
class Client{constructor(){this.id=1;this.pending=new Map;this.buf=Buffer.alloc(0);this.notes=[];this.stderr='';}
 start(){this.p=spawn(SERVER,['--stdio'],{cwd:ROOT,stdio:['pipe','pipe','pipe'],windowsHide:true});this.p.stdout.on('data',c=>this.read(c));this.p.stderr.on('data',c=>this.stderr=(this.stderr+c).slice(-65536));}
 read(c){this.buf=Buffer.concat([this.buf,c]);while(true){const end=this.buf.indexOf('\r\n\r\n');if(end<0)return;const m=/Content-Length:\s*(\d+)/i.exec(this.buf.subarray(0,end).toString());if(!m)throw Error('frame');const n=+m[1],s=end+4;if(this.buf.length<s+n)return;const msg=JSON.parse(this.buf.subarray(s,s+n));this.buf=this.buf.subarray(s+n);if(msg.id!==undefined&&this.pending.has(String(msg.id))){this.pending.get(String(msg.id))(msg);this.pending.delete(String(msg.id));}else if(msg.id!==undefined&&msg.method)this.p.stdin.write(frame({jsonrpc:'2.0',id:msg.id,result:null}));else this.notes.push(msg);}}
 req(method,params,timeout=600000){const id=this.id++;return new Promise((resolve,reject)=>{const t=setTimeout(()=>{this.pending.delete(String(id));reject(Error('timeout '+method));},timeout);this.pending.set(String(id),m=>{clearTimeout(t);resolve(m)});this.p.stdin.write(frame({jsonrpc:'2.0',id,method,params}));});}
 note(method,params){this.p.stdin.write(frame({jsonrpc:'2.0',method,params}));}
 async stop(){try{await this.req('shutdown',null,10000)}catch{}this.note('exit',null);await new Promise(r=>setTimeout(r,200));if(!this.p.killed)this.p.kill();}}
function ok(r,name){assert(!r.error,`${name}: ${JSON.stringify(r.error)}`);return r.result;}
(async()=>{assert(fs.existsSync(MOD)&&fs.existsSync(GAME)&&fs.existsSync(RULES)&&fs.existsSync(SERVER));const c=new Client;c.start();const checks={};
 const caps=ok(await c.req('initialize',{processId:null,rootUri,workspaceFolders:[{uri:rootUri,name:path.basename(MOD)}],capabilities:{},initializationOptions:{language:'stellaris',uiLanguage:'zh-cn',isVanillaFolder:false,rulesCache:path.join(require('os').tmpdir(),'cwtools-real-mod-cache'),bundledRulesPath:RULES,vanillaGamePath:GAME,vanillaCachePath:path.join(MOD,'.cwtools/stl.cwb'),rules_version:'manual',diagnosticLogging:false}}),'initialize').capabilities;assert(caps.hoverProvider&&caps.completionProvider&&caps.signatureHelpProvider);checks.initialize=true;c.note('initialized',{});
 const status=ok(await c.req('workspace/executeCommand',{command:'cwtools.ai.getValidationStatus',arguments:[{}]}),'status');assert(status.ready&&status.sourceCount>=500,status);assert(String(status.lastCacheStatus).startsWith('rebuilt_from_game:'),status);checks.validationStatus={sources:status.sourceCount,definitions:status.definitionCount,references:status.referenceCount,cache:status.lastCacheStatus};
 c.note('textDocument/didOpen',{textDocument:{uri,languageId:'stellaris',version:1,text}});
 const parse=ok(await c.req('workspace/executeCommand',{command:'cwtools.ai.parseFragment',arguments:[{file:uri,text:'country_event = { id = kuat_test.1 is_triggered_only = yes }'}]}),'parse');assert(parse.ok===true&&parse.rootCount===1);checks.parse=true;
 const bad=ok(await c.req('workspace/executeCommand',{command:'cwtools.ai.parseFragment',arguments:[{file:uri,text:'broken = {'}]}),'bad parse');assert(bad.ok===false&&bad.diagnostics.length>0);checks.invalidParse=true;
 const completion=ok(await c.req('textDocument/completion',{textDocument:{uri},position:{line:3,character:21}}),'completion');assert(Array.isArray(completion.items)&&completion.items.length>0);checks.completion=completion.items.length;
 const hover=ok(await c.req('textDocument/hover',{textDocument:{uri},position:{line:3,character:12}}),'hover');assert(hover&&hover.contents);checks.hover=true;
 const sig=ok(await c.req('textDocument/signatureHelp',{textDocument:{uri},position:{line:3,character:21}}),'signature');assert(sig&&Array.isArray(sig.signatures)&&sig.signatures.length>0);checks.signature=true;
 const defs=ok(await c.req('textDocument/definition',{textDocument:{uri},position:{line:3,character:12}}),'definition');assert(Array.isArray(defs));checks.definitions=defs.length;
 const refs=ok(await c.req('textDocument/references',{textDocument:{uri},position:{line:3,character:12},context:{includeDeclaration:true}}),'references');assert(Array.isArray(refs));checks.references=refs.length;
 const scope=ok(await c.req('workspace/executeCommand',{command:'cwtools.ai.getScopeAtPosition',arguments:[{file:uri,line:16,character:8}]}),'scope');assert(scope.resolved&&scope.scope==='stellaris');checks.scope=scope.scope;
 const ctx=ok(await c.req('workspace/executeCommand',{command:'cwtools.ai.getCompletionContext',arguments:[{prefix:'kuat_shipyard'}]}),'context');assert(Array.isArray(ctx.items));checks.completionContext=ctx.items.length;
 const graph=ok(await c.req('workspace/executeCommand',{command:'cwtools.ai.exploreProject',arguments:[{query:'kuat_shipyard',file:uri,depth:2,maxNodes:100,maxEdges:300,includeMetadata:true}]}),'graph');assert(graph&&typeof graph==='object');checks.projectGraph={nodes:(graph.nodes||[]).length,edges:(graph.edges||[]).length};
 checks.notifications=c.notes.map(n=>n.method).filter(Boolean);await c.stop();process.stdout.write(JSON.stringify({ok:true,mode:path.resolve(RULES).includes('release')?'bundled':'remote-or-manual',checks,stderr:c.stderr.slice(-1000)},null,2));
})().catch(async e=>{console.error(e.stack||e);try{for(const process of require('child_process').execFileSync('tasklist').toString().matchAll(/cwtools-lsp\.exe\s+(\d+)/gi))require('child_process').execFileSync('taskkill',['/PID',process[1],'/T','/F']);}catch{}process.exitCode=1});
