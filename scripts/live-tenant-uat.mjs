// Real delegated tenant checks. Creates only uniquely named disposable objects.
// Never enables DLP or auto-label enforcement. Reports remote hosting separately.
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { powershell } from '../src/powershell.js';
import { executeCapability } from '../src/dispatch/execute.js';
import * as auto from '../src/auto-labels.js';
import { createDeletionConfirmation } from '../src/mcp/deletion-confirmation.js';

const tag = `ZZZ_MCP_UAT_${randomUUID().slice(0,8)}`;
const report = { run: tag, started: new Date().toISOString(), checks: [], cleanup: [], limitations: ['No deployed endpoint supplied; remote authentication and proxy behavior are not tested.', 'Auto-label activation is not tested without a dedicated synthetic content scope.'] };
const owned = [];
const autoOnly = process.env.PURVIEW_UAT_AUTO_ONLY === '1';
const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
async function check(name, fn) {
  const start = Date.now();
  try { const evidence = await fn(); report.checks.push({name,status:'passed',elapsed_ms:Date.now()-start,evidence}); console.log(JSON.stringify({name,status:'passed',elapsed_ms:Date.now()-start})); return evidence; }
  catch(e) { report.checks.push({name,status:'failed',elapsed_ms:Date.now()-start,error:e.message,code:e.code}); console.log(JSON.stringify({name,status:'failed',error:e.message,code:e.code})); }
}
async function read(cmdlet, identity) {
  return arr(await powershell.invoke(cmdlet,{Identity:identity})).find(x => x.Name===identity || String(x.Guid).toLowerCase()===identity.toLowerCase());
}
async function create(kind,name,args) {
  owned.push({kind,name}); // Also reconcile a write whose readback fails.
  await executeCapability(`create_${kind}`,args);
  const native = kind==='auto_label_policy'?'AutoSensitivityLabelPolicy':kind==='auto_label_rule'?'AutoSensitivityLabelRule':kind==='dlp_policy'?'DlpCompliancePolicy':'DlpComplianceRule';
  const object = await read(`Get-${native}`,name); assert.ok(object?.Guid,'Created object must be readable with a GUID'); return object;
}
async function guardedRemove(kind,object) {
  const confirmDeletion = createDeletionConfirmation({principal:'local-live-uat-operator',client:tag});
  const args = {identity:object.Guid};
  const context = action => ({clientCapabilities:{elicitation:{form:{}}},mcpReq:{elicitInput:async()=>({action,content:{confirm:action==='accept'}})}});
  for(const action of ['decline','cancel']) {
    await executeCapability(`remove_${kind}`,args,undefined,undefined,undefined,{confirmDeletion,context:context(action)});
    const native = kind==='auto_label_policy'?'AutoSensitivityLabelPolicy':kind==='auto_label_rule'?'AutoSensitivityLabelRule':kind==='dlp_policy'?'DlpCompliancePolicy':'DlpComplianceRule';
    assert.ok(await read(`Get-${native}`,object.Guid),`${action} must preserve the object`);
  }
  await executeCapability(`remove_${kind}`,args,undefined,undefined,undefined,{confirmDeletion,context:context('accept')});
  return {decline_preserved:true,cancel_preserved:true,accepted_removal_submitted:true,identity_source:'local harness; not a deployed caller identity'};
}
try {
  const auth = await check('authenticated_security_compliance_read',async()=>({visible_policies:arr(await powershell.invoke('Get-DlpCompliancePolicy',{},['Guid'])).length}));
  if(!auth) throw Error('Authentication failed; no objects created.');
  for(const capability of ['list_sensitivity_labels','list_label_policies','list_dlp_policies','list_dlp_rules','list_auto_label_policies','list_auto_label_rules']) {
    await check(capability,async()=>{ await executeCapability(capability,{}); return {backend_returned:true}; });
  }
  const dlp = autoOnly ? undefined : await check('dlp_create_test_policy',async()=>{
    const p=await create('dlp_policy',`${tag}_DLP`,{name:`${tag}_DLP`,mode:'TestWithoutNotifications',exchange_location:['All'],comment:'Disposable UAT; never enable.'});
    assert.equal(p.Mode,'TestWithoutNotifications'); return p;
  });
  if(dlp) {
    const rule=await check('dlp_create_rule',()=>create('dlp_rule',`${tag}_DLP_Rule`,{name:`${tag}_DLP_Rule`,policy:dlp.Guid,sensitive_information_types:['Credit Card Number'],block_access:true}));
    if(rule) {
      await check('dlp_current_setter_and_readback',async()=>{
        await executeCapability('set_dlp_rule',{identity:rule.Guid,disabled:true});
        const r=await read('Get-DlpComplianceRule',rule.Guid); assert.equal(r.Disabled,true); return {disabled_readback:true};
      });
      await check('dlp_rule_live_legacy_deletion_confirmation',()=>guardedRemove('dlp_rule',rule));
    }
  }
  const label=await check('published_leaf_label_selection',async()=>{
    const labels=arr(await powershell.invoke('Get-Label',{}));
    const policies=arr(await powershell.invoke('Get-LabelPolicy',{}));
    const refs=policies.flatMap(p=>arr(p.Labels)).map(x=>String(x?.Guid??x?.Name??x).toLowerCase());
    const found=labels.find(l=>l.Guid && l.IsLabelGroup!==true && !labels.some(c=>String(c.ParentId?.Guid??c.ParentId).toLowerCase()===String(l.Guid).toLowerCase()) && refs.some(r=>[l.Name,l.Guid].some(v=>String(v).toLowerCase()===r)));
    assert.ok(found,'An existing published leaf label is required'); return {identity:found.Guid};
  });
  if(label) {
    const copilot=autoOnly ? undefined : await check('copilot_create_test_policy',async()=>{
      const name=`${tag}_Copilot`; owned.push({kind:'dlp_policy',name});
      await executeCapability('create_copilot_dlp_policy',{name,mode:'TestWithoutNotifications'});
      const p=await read('Get-DlpCompliancePolicy',name); assert.equal(p?.Mode,'TestWithoutNotifications'); return p;
    });
    if(copilot) await check('copilot_label_condition_current_implementation',async()=>{
      const name=`${tag}_Copilot_Rule`; owned.push({kind:'dlp_rule',name});
      await executeCapability('create_copilot_dlp_rule',{name,policy:copilot.Guid,sensitivity_labels:[label.identity],action:'block_processing'});
      const r=await read('Get-DlpComplianceRule',name); assert.ok(JSON.stringify(r?.ContentContainsSensitiveInformation).toLowerCase().includes(label.identity.toLowerCase())); return {condition_readback:true};
    });
    const policy=await check('auto_label_create_disabled',async()=>{
      const p=await create('auto_label_policy',`${tag}_Auto`,{name:`${tag}_Auto`,behaviour:'apply',label_identity:label.identity,locations:{exchange:{selection:'all'},sharepoint:{selection:'none'},onedrive:{selection:'none'}},description:'Disposable UAT; match unique synthetic subject only; never enable.'});
      assert.equal(p.Mode,'Disable'); return p;
    });
    if(policy) {
      await check('auto_label_policy_diagnostics',async()=>{ const p=await auto.getPolicy(policy.Guid,{include_simulation_status:true,include_progress:true,include_distribution_detail:true}); return p; });
      await check('auto_label_revision_conflict',async()=>{await assert.rejects(()=>auto.setPolicy({identity:policy.Guid,description:'Must not write',expected_revision:'invalid'}),e=>e.code==='REVISION_CONFLICT');return {blocked:true};});
      await check('auto_label_activation_without_simulation',async()=>{const p=await auto.getPolicy(policy.Guid);await assert.rejects(()=>auto.setPolicy({identity:p.Guid,mode:'Enable',expected_revision:p.revision}),e=>e.code==='SIMULATION_REQUIRED');assert.equal((await auto.getPolicy(p.Guid)).Mode,'Disable');return {blocked:true,remains_disabled:true};});
      const sit=await check('resolve_credit_card_sit_guid',async()=>{
        const matches=arr(await powershell.invoke('Get-DlpSensitiveInformationType',{},['Name','Id'])).filter(x=>x.Name==='Credit Card Number');
        assert.equal(matches.length,1);const identity=matches[0].Id??matches[0].Guid??matches[0].Identity;assert.match(String(identity),/^[a-f0-9-]{36}$/i);return {identity:String(identity)};
      });
      const rule=sit && await check('auto_label_create_synthetic_subject_rule_with_sit_guid',()=>create('auto_label_rule',`${tag}_Auto_Rule`,{name:`${tag}_Auto_Rule`,policy_identity:policy.Guid,workload:'Exchange',conditions:{subject_matches_patterns:[tag],sensitive_information:{operator:'any',groups:[{name:'Synthetic',operator:'any',detectors:[{kind:'sit',identity:sit.identity,min_count:1}]}]}}}));
      if(rule) {
        await check('auto_label_rule_set_and_readback',async()=>{const before=await auto.getRule(rule.Guid);await executeCapability('set_auto_label_rule',{identity:rule.Guid,description:'Updated disposable UAT',expected_revision:before.revision});const after=await auto.getRule(rule.Guid);assert.equal(after.Comment,'Updated disposable UAT');return {comment_readback:true};});
        await check('auto_label_simulation_submission',async()=>{const p=await auto.getPolicy(policy.Guid);return auto.setPolicy({identity:p.Guid,mode:'TestWithoutNotifications',restart_simulation:true,expected_revision:p.revision});});
        await check('auto_label_simulation_status_readback',()=>auto.getPolicy(policy.Guid,{include_simulation_status:true,include_progress:true}));
        await check('auto_label_rule_live_legacy_deletion_confirmation',()=>guardedRemove('auto_label_rule',rule));
      }
      await check('auto_label_policy_live_legacy_deletion_confirmation',()=>guardedRemove('auto_label_policy',policy));
    }
  }
} catch(e) {report.error=e.message;console.error(e.message);}
finally {
  for(const target of owned.reverse()) {
    const native={dlp_rule:'DlpComplianceRule',dlp_policy:'DlpCompliancePolicy',auto_label_rule:'AutoSensitivityLabelRule',auto_label_policy:'AutoSensitivityLabelPolicy'}[target.kind];
    try {
      assert.ok(target.name.startsWith(`${tag}_`));
      const obj=await read(`Get-${native}`,target.name);
      if(!obj) {report.cleanup.push({name:target.name,status:'not_found'});continue;}
      assert.equal(obj.Name,target.name);assert.ok(obj.Guid);
      if(obj.Mode==='PendingDeletion') {report.cleanup.push({name:target.name,status:'pending_deletion'});continue;}
      if(obj.Mode==='Enable') throw Error('Unexpected enabled object; stop cleanup and inspect.');
      await powershell.invoke(`Remove-${native}`,{Identity:obj.Guid,Confirm:false});
      let after;
      try {after=await read(`Get-${native}`,obj.Guid);} catch(e) {if(!/not found|couldn.t be found|does not exist|ObjectNotFound/i.test(e.message)) throw e;}
      report.cleanup.push({name:target.name,status:after?'removal_submitted_still_visible':'absence_verified',mode:after?.Mode});
    } catch(e) {report.cleanup.push({name:target.name,status:/not found|couldn.t be found|does not exist|ObjectNotFound/i.test(e.message)?'absence_verified':'failed',error:e.message});}
  }
  report.finished=new Date().toISOString();await mkdir('artifacts',{recursive:true});
  const path=`artifacts/${tag}.json`;await writeFile(path,JSON.stringify(report,null,2));
  console.log(JSON.stringify({report:path,checks:report.checks.map(c=>({name:c.name,status:c.status})),cleanup:report.cleanup}));
  powershell.proc?.kill();
  if(process.env.PURVIEW_UAT_KEEP_SESSION!=='1') process.exit(report.error || report.checks.some(c=>c.status==='failed') || report.cleanup.some(c=>c.status==='failed')?1:0);
}
