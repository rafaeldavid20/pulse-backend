import test from 'node:test';
import assert from 'node:assert/strict';
import { findPendingRunnerJob } from './pending-runner-job';

const now = Date.now();
const job = (id: string, overrides = {}) => ({ id, runnerId: 'runner-a', status: 'pending', issuedAt: new Date(now-1000).toISOString(), expiresAt: new Date(now+60_000).toISOString(), ...overrides });
function fakeDb(rows: any[]) {
  const filtered = rows.filter(x => x.runnerId === 'runner-a' && x.status === 'pending');
  let reads = 0;
  const query = (offset=0): any => ({
    async get() { reads++; const docs = filtered.slice(offset,offset+20).map((value,index) => ({index:offset+index,data:()=>value})); return {docs,size:docs.length}; },
    startAfter(doc: any) { return query(doc.index+1); },
  });
  const db: any = {collection(name: string) {
    assert.equal(name,'runner_jobs'); return {where(field: string, op: string, value: string) {
      assert.deepEqual([field,op,value],['runnerId','==','runner-a']);return {where(field: string,op: string,value: string) {
        assert.deepEqual([field,op,value],['status','==','pending']); return {limit(value: number) {assert.equal(value,20);return query();}};
      }};
    }};
  }};
  return {db,reads:()=>reads};
}
test('terminal and expired history cannot hide a later pending job',async()=>{
  const rows = Array.from({length:45},(_,i)=>job('terminal-'+i,{status:'completed'}));
  rows.push(...Array.from({length:45},(_,i)=>job('expired-'+i,{expiresAt:new Date(now-1).toISOString()})));
  rows.push(job('foreign',{runnerId:'runner-b'}),job('valid'));
  const f=fakeDb(rows); assert.equal((await findPendingRunnerJob(f.db,'runner-a',now))?.id,'valid'); assert.equal(f.reads(),3);
});
test('oldest unexpired pending job is selected across page boundaries',async()=>{
  const rows=Array.from({length:21},(_,i)=>job('new-'+i)); rows.push(job('oldest',{issuedAt:new Date(now-5000).toISOString()}));
  const f=fakeDb(rows);assert.equal((await findPendingRunnerJob(f.db,'runner-a',now))?.id,'oldest');
});
test('empty, expired and malformed expiration queues return no job',async()=>{
  const f=fakeDb([job('expired',{expiresAt:new Date(now).toISOString()}),job('malformed',{expiresAt:'invalid'})]);
  assert.equal(await findPendingRunnerJob(f.db,'runner-a',now),null);
});
