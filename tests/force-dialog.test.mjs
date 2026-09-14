import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../app/static/force-remove.js',import.meta.url),'utf8');
function setup(fetch){
 const input={value:'',focus(){}},form={elements:{confirmation:input}},submit={},close={},message={},summary={};
 const nodes={'form':form,'[type=submit]':submit,'[data-close]':close,'[data-status]':message,'[data-summary]':summary};
 const dialog={open:false,setAttribute(){},querySelector:s=>nodes[s],addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},remove(){}};
 const window={};let present=false;
 vm.runInNewContext(source,{window,document:{getElementById:()=>present?dialog:null,createElement:()=>dialog,body:{append(){present=true;}}},fetch,AbortSignal,setTimeout,clearTimeout});
 let removed=0;window.forceRemoveDialog('/api/jobs/force-remove',['one'],()=>{removed++;});
 return {window,input,form,submit,close,message,dialog,removed:()=>removed,send:()=>form.onsubmit({preventDefault(){}})};
}
test('confirmation visibly rejects incorrect input and accepts normalized explicit text',async()=>{
 let calls=0;const e=setup(async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({removed:1,skippedPaths:[]})};});
 e.input.value='yes';await e.send();assert.equal(calls,0);assert.match(e.message.textContent,/Intet er slettet/);assert.ok(e.dialog.open);
 e.input.value=' force   slet ';await e.send();assert.equal(calls,1);assert.equal(e.removed(),1);assert.match(e.message.textContent,/færdig/);assert.equal(e.submit.hidden,true);
});
test('backend errors stay visible inside the dialog and selection is retained',async()=>{
 const e=setup(async()=>({ok:false,status:400,text:async()=>JSON.stringify({error:'Vent til det øvrige aktive arbejde er færdigt.'})}));
 e.input.value='FORCE SLET';await e.send();assert.match(e.message.textContent,/mislykkedes: Vent/);assert.equal(e.removed(),0);assert.ok(e.dialog.open);assert.equal(e.submit.disabled,false);
});
test('pending request is visible, cannot be duplicated or closed, then refreshes on success',async()=>{
 let resolve,calls=0;const e=setup(()=>{calls++;return new Promise(r=>resolve=r);});e.input.value='FORCE SLET';
 const request=e.send();assert.match(e.message.textContent,/Sender/);assert.equal(e.close.disabled,true);await e.send();assert.equal(calls,1);
 e.close.onclick();assert.ok(e.dialog.open);
 resolve({ok:true,status:200,text:async()=>'{"removed":1,"skippedPaths":[]}'});await request;assert.equal(e.removed(),1);assert.equal(e.close.disabled,false);
});
test('proxy HTML and timeout produce actionable errors instead of silent or false success',async()=>{
 for(const failure of ['proxy','timeout']){
  const e=setup(async()=>{if(failure==='timeout')throw Object.assign(new Error('timeout'),{name:'TimeoutError'});return {status:502,ok:false,text:async()=>'<html>Bad Gateway</html>'};});
  e.input.value='FORCE SLET';await e.send();assert.equal(e.removed(),0);assert.match(e.message.textContent,failure==='proxy'?/HTTP 502/:/Oprydningen kan stadig køre/);
 }
});
