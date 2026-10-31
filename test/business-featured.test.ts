import {describe,it,expect} from 'bun:test'
import {Listings} from '../src/listings.ts'
import {FeaturedBusinesses,calendarMonth} from '../src/business-featured.ts'
import type {BuildInvoicing} from '../src/build-invoice.ts'
import {createApp} from '../src/server.ts'

async function harness() {
  let now = Date.UTC(2026,0,31,12), calls = 0
  const records = new Map<string,any>()
  const proofs: Record<string,string[]> = {}
  const listings = new Listings(':memory:', {txt:async h=>proofs[h]??[],homepage:async()=>null},()=>now)
  const start = listings.startClaim('acme.example')!;proofs[start.txtHost]=[start.token]
  const claimed = await listings.verify(start.claimId);if(!claimed.ok)throw Error('claim failed')
  listings.edit('acme.example',claimed.editKey,{name:'Acme Builders',city:'Gilroy',category:'home',description:'General construction and remodeling'},()=>false)
  const cfg: BuildInvoicing = {payAgentUrl:'https://pay.agent.pit.world',key:'private-test-key',fetch:(async (url:any,init:any)=>{
    if(init.method==='POST'){
      calls++;const b=JSON.parse(init.body);const id=`invoice-${calls}`
      records.set(id,{id,amount_usd:b.amount_usd,description:b.description,status:'sent',url:`https://pay.agent.pit.world/i/${id}`})
      return Response.json(records.get(id))
    }
    if (String(url).endsWith('/api/v1/invoices')) return Response.json({invoices:[...records.values()]})
    return Response.json(records.get(String(url).split('/').pop()!))
  }) as typeof fetch}
  const billing = new FeaturedBusinesses(listings,cfg,()=>now)
  const app = createApp({keys:{},listings,featuredBusinesses:billing})
  return {listings,billing,app,cfg,records,key:claimed.editKey,calls:()=>calls,time:()=>now,setTime:(n:number)=>now=n}
}

describe('paid business features',()=>{
 it('requires ownership and a paid, exact $19 invoice; duplicate sync cannot add time',async()=>{
  const h=await harness()
  await expect(h.billing.start('acme.example','wrong','owner@example.com')).rejects.toThrow('Claim')
  expect(h.calls()).toBe(0)
  const url=await h.billing.start('acme.example',h.key,'owner@example.com')
  expect(url).toEndWith('/invoice-1')
  expect(await h.billing.start('acme.example',h.key,'owner@example.com')).toBe(url)
  expect(h.calls()).toBe(1)
  await h.billing.tick();expect(h.billing.status('acme.example').activeUntil).toBeNull()
  h.records.get('invoice-1').status='paid';h.records.get('invoice-1').amount_usd=1
  await h.billing.tick();expect(h.billing.status('acme.example').activeUntil).toBeNull()
  h.records.get('invoice-1').amount_usd=19
  await h.billing.tick()
  const until=Date.UTC(2026,1,28,12)
  expect(h.billing.status('acme.example').activeUntil).toBe(until)
  await h.billing.tick();expect(h.billing.status('acme.example').activeUntil).toBe(until)
  expect(h.listings.directory().listings[0]!.sponsoredUntil).toBe(until)
  expect(await (await h.app.request('/pros')).text()).toContain('Featured · Paid placement')
  expect(await (await h.app.request('/')).text()).toContain('Acme Builders')
  expect(await (await h.app.request('/pros?near=Nowhere')).text()).not.toContain('Acme Builders')
  h.billing.manage('acme.example',h.key,false)
  h.setTime(until+1);await h.billing.tick()
  expect(h.calls()).toBe(1)
  expect(h.listings.directory().listings[0]!.sponsoredUntil).toBeNull()
  expect(h.billing.status('acme.example').activeUntil).toBeNull()
 })
 it('renews with one invoice, extends only after payment, and supports stopping/resuming',async()=>{
  const h=await harness();await h.billing.start('acme.example',h.key,'owner@example.com')
  h.records.get('invoice-1').status='paid';await h.billing.tick()
  const until=h.billing.status('acme.example').activeUntil!
  h.setTime(until-2*86400000);await h.billing.tick();await h.billing.tick()
  expect(h.calls()).toBe(2)
  expect(h.billing.status('acme.example').activeUntil).toBe(until)
  h.records.get('invoice-2').status='paid';await h.billing.tick()
  expect(h.billing.status('acme.example').activeUntil).toBe(calendarMonth(until))
  h.billing.manage('acme.example',h.key,false);expect(h.billing.status('acme.example').renew).toBe(false)
  h.billing.manage('acme.example',h.key,true);expect(h.billing.status('acme.example').renew).toBe(true)
 })
 it('fails closed on an ambiguous invoice response and rejects cross-origin or unconsented purchases',async()=>{
  const h=await harness()
  const post=(fields:Record<string,string>,origin='https://pit.world')=>h.app.request('/b/acme.example/featured',{method:'POST',headers:{origin},body:new URLSearchParams(fields)},{ip:'203.0.113.1'})
  expect((await post({key:h.key,action:'start',email:'owner@example.com'})).status).toBe(400)
  expect((await post({key:h.key,action:'start',email:'owner@example.com',consent:'monthly'},'https://evil.example')).status).toBe(403)
  expect(h.calls()).toBe(0)
  const bought=await post({key:h.key,action:'start',email:'owner@example.com',consent:'monthly'})
  expect(bought.status).toBe(303)
  expect(bought.headers.get('location')).toEndWith('/invoice-1')
  expect((await post({key:'wrong',action:'cancel'})).status).toBe(403)
  expect((await post({key:h.key,action:'cancel'})).status).toBe(200)
  expect(h.billing.status('acme.example').renew).toBe(false)
  const another=await harness();another.cfg.fetch=(async()=>{throw Error('timeout')}) as unknown as typeof fetch
  await expect(another.billing.start('acme.example',another.key,'owner@example.com')).rejects.toThrow('could not be confirmed')
  await expect(another.billing.start('acme.example',another.key,'owner@example.com')).rejects.toThrow('awaiting confirmation')
  expect(another.billing.status('acme.example').activeUntil).toBeNull()
 })
 it('uses a calendar month even at month end',()=>{
  expect(new Date(calendarMonth(Date.UTC(2026,0,31))).toISOString()).toBe('2026-02-28T00:00:00.000Z')
  expect(new Date(calendarMonth(Date.UTC(2028,0,31))).toISOString()).toBe('2028-02-29T00:00:00.000Z')
 })
})
