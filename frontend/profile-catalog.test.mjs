import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const result=await build({entryPoints:[fileURLToPath(new URL('./src/profile-catalog.ts',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {profileFacetOptions,chooseProfileFacet,profileVariants,profileFacetValue,preserveProfileSelection,effectiveProfileMemory,UNKNOWN_FACET}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].contents).toString('base64'));
const profile=(id,patch={})=>({id,name:id,deviceType:'mobile',imageFlavor:'google_apis',androidVersion:'15',abi:'x86_64',gpuMode:'software',enabled:true,...patch});
const profiles=[profile('phone15'),profile('phone15-16kb'),profile('phone17',{androidVersion:'17 (API 37.0)'}),profile('phone15-arm',{abi:'arm64-v8a'}),profile('tv14',{deviceType:'tv',androidVersion:'14'}),profile('aosp14',{imageFlavor:'aosp',androidVersion:'14'}),profile('custom',{deviceType:null,imageFlavor:null,androidVersion:null,abi:null})];
test('cascading dropdowns only offer existing combinations, including declared device families',()=>{
 assert.deepEqual(profileFacetOptions(profiles,profiles[0],'androidVersion').map(x=>x.value),['17','15']);
 assert.deepEqual(profileFacetOptions(profiles,profiles[4],'androidVersion').map(x=>x.value),['14']);
 assert.deepEqual(profileFacetOptions(profiles,profiles[0],'abi').map(x=>x.value),['arm64-v8a','x86_64']);
 assert.equal(profileFacetValue(profiles[2],'androidVersion'),'17');
 assert.ok(profileFacetOptions(profiles,profiles[0],'deviceType').some(x=>x.value===UNKNOWN_FACET));
});
test('explicit upstream changes choose a deterministic compatible profile and never nonexistent combinations',()=>{
 assert.equal(chooseProfileFacet(profiles,profiles[0],'deviceType','tv')?.id,'tv14');
 assert.equal(chooseProfileFacet(profiles,profiles[0],'imageFlavor','aosp')?.id,'aosp14');
 assert.equal(chooseProfileFacet([...profiles].reverse(),profiles[4],'deviceType','mobile',p=>p.abi==='x86_64')?.id,'aosp14');
 assert.equal(chooseProfileFacet(profiles,profiles[0],'androidVersion','99'),undefined);
});
test('matching environment variants remain selectable separately',()=>{
 assert.deepEqual(profileVariants(profiles,profiles[0]).map(p=>p.id),['phone15','phone15-16kb']);
 assert.equal(chooseProfileFacet(profiles,profiles[1],'abi','x86_64')?.id,'phone15-16kb');
});
test('refresh and loss of a profile preserve selection; custom missing metadata remains explicit',()=>{
 assert.equal(preserveProfileSelection('gone',profiles),'gone');
 assert.equal(preserveProfileSelection('phone17',[]),'phone17');
 assert.equal(profileFacetOptions(profiles,profiles[6],'abi')[0].label,'Не указан');
});
test('preparation state does not hide SDK environments but blocks readiness',()=>{
 assert.ok(profileFacetOptions(profiles,profiles[0],'androidVersion').some(x=>x.value==='17'));
});
test('explicit SDK tags distinguish TV and ATD; known mobile image families group page-size variants',()=>{
 assert.equal(profileFacetOptions([profile('tv',{deviceType:'tv',imageFlavor:null,imageTag:'google-tv'})],undefined,'imageFlavor')[0].label,'Google TV');
 assert.equal(profileFacetValue(profile('atd',{imageFlavor:null,imageTag:'aosp_atd'}),'imageFlavor'),'aosp_atd');
 assert.equal(profileFacetValue(profile('16k',{imageFlavor:'google_play',imageTag:'google_apis_playstore_ps16k'}),'imageFlavor'),'google_play');
 assert.equal(profileFacetValue(profile('custom',{imageFlavor:null}),'imageFlavor'),UNKNOWN_FACET);
});

test('GPU selection keeps the same memory limit and ignores legacy overrides',()=>{
 const both=profile('both',{gpuSupport:'cuda',cpu:4,memoryMb:4096,gpuMemoryMb:6144});
 assert.equal(effectiveProfileMemory(both,'software'),4096);
 assert.equal(effectiveProfileMemory(both,'nvidia'),4096);
});
