#!/usr/bin/env node
'use strict';
const fs=require('fs');
const path=require('path');
const root=path.resolve(__dirname,'..','..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'contracts','lsp-manifest.json'),'utf8'));
const rust=['lib.rs','local.rs','main.rs'].map(file=>fs.readFileSync(path.join(root,'rust','cwtools-lsp','src',file),'utf8')).join(String.fromCharCode(10));
const extension=fs.readFileSync(path.join(root,'client','extension','extension.ts'),'utf8');
const failures=[];
const duplicate=values=>values.filter((value,index)=>values.indexOf(value)!==index);
const commands=manifest.commands.map(command=>command.name);
const notifications=manifest.notifications.map(notification=>notification.direction+':'+notification.name);
for(const value of duplicate(commands)) failures.push('duplicate command: '+value);
for(const value of duplicate(notifications)) failures.push('duplicate notification: '+value);
for(const command of manifest.commands){if(command.advertised&&command.handler!==true)failures.push('advertised command lacks Rust handler: '+command.name);}
if(manifest.schemaVersion!==1) failures.push('schemaVersion must be 1');
if(manifest.protocol.transport!=='stdio'||manifest.protocol.positionEncoding!=='utf-16') failures.push('protocol drift');
if(!rust.includes('include_str!("../../../contracts/lsp-manifest.json")')) failures.push('Rust server must embed the command manifest');
for(const option of manifest.initialization.options){if(!extension.includes(option+':'))failures.push('client initialize option missing: '+option);}
if(!rust.includes('completionTriggerCharacters')) failures.push('manifest completion triggers are not exposed');
if(!rust.includes('semanticTokens')) failures.push('manifest semantic token ABI is not exposed');
for(const notification of manifest.notifications){if(!rust.includes(notification.name)&&!extension.includes(notification.name))failures.push('notification endpoint missing: '+notification.name);}
if(failures.length){console.error(['LSP contract check failed:',...failures.map(value=>'- '+value)].join(String.fromCharCode(10)));process.exit(1);}
console.log('LSP contract OK: '+commands.length+' commands, '+manifest.notifications.length+' notifications.');
