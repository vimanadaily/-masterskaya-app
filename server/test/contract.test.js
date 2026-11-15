'use strict';
process.env.APP_ORIGIN='http://localhost:3000';
process.env.SETUP_TOKEN='local-test-token-0123456789-abcdefghijklmnopqrstuvwxyz';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validState,validEmail,validPassword,sessionCookie,sha}=require('../server.js');
const empty={schemaVersion:1,materials:[],purchases:[],products:[],calculations:[]};
const base={...empty,
  materials:[{id:'paper',name:'Фотобумага',unit:'лист'}],
  purchases:[{id:'p1',date:'2026-11-15',delivery:0,lines:[{materialId:'paper',packs:1,packSize:50,price:450}]}]
};
test('историческая структура локального JSON принимается',()=>assert.equal(validState(base),true));
test('история общей инвентаризации сохраняет совместимость',()=>{
  const data={...base,inventoryCounts:[{id:'i1',date:'2026-11-15',createdAt:'2026-11-15T11:00:00Z',materialId:'paper',
    reason:'Контрольный пересчёт',before:50,actual:48,delta:-2,unitCost:9,valueChange:-18,
    lotAllocations:[{lotId:'p1:0',quantity:2,unitCost:9,cost:18}]}]};
  assert.equal(validState(data),true);
});
test('сервер отклоняет отрицательную закупку',()=>{
  assert.equal(validState({...base,purchases:[{...base.purchases[0],lines:[{materialId:'paper',packs:-1,packSize:50,price:450}]}]}),false);
});
test('неполная карточка изделия отклоняется',()=>{
  assert.equal(validState({...base,products:[{id:'x',name:'Тест'}]}),false);
});
test('некорректные возвраты и списания отклоняются',()=>{
  assert.equal(validState({...base,sales:[{id:'sale',productId:'p',quantity:1,cogs:10,allocations:[{batchId:'b',qty:-1,unitCost:10}]}]}),false);
  assert.equal(validState({...base,inventoryCounts:[{id:'i1',materialId:'paper',date:'2026-11-15',createdAt:'2026-11-15T11:00:00Z',
    reason:'Пересчёт',before:20,actual:-2,delta:-22,unitCost:9,valueChange:-198,lotAllocations:[]}]}),false);
});
test('корректные пароль и адрес, слабые пароли отклонены',()=>{
  assert.equal(validEmail('master@example.ru'),true);
  assert.equal(validEmail('bad email'),false);
  assert.equal(validPassword('Long-Example-2026!'),true);
  assert.equal(validPassword('12345'),false);
});
test('сессия HttpOnly, SameSite Strict, с установленным временем жизни',()=>{
  const cookie=sessionCookie('token',3600);
  assert.match(cookie,/HttpOnly/);
  assert.match(cookie,/SameSite=Strict/);
  assert.match(cookie,/Max-Age=3600/);
  assert.equal(sha('check').length,64);
});
