'use strict';
// Серверный контур «Мастерской». Пользовательские данные не размещаются на GitHub Pages.
const http = require('node:http');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, createHash, timingSafeEqual, scrypt } = require('node:crypto');
const { promisify } = require('node:util');
const { Pool } = require('pg');

const scryptAsync = promisify(scrypt);
const PORT = Number(process.env.PORT || '3000');
const ORIGIN = String(process.env.APP_ORIGIN || '');
const SETUP_TOKEN = String(process.env.SETUP_TOKEN || '');
const localDev = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(ORIGIN);
if (!ORIGIN || (!ORIGIN.startsWith('https://') && !localDev)) {
  throw new Error('APP_ORIGIN должен быть точным HTTPS-адресом сайта (HTTP разрешён только для localhost).');
}
if (SETUP_TOKEN.length < 32) throw new Error('SETUP_TOKEN должен содержать не менее 32 символов.');
const COOKIE = localDev ? 'ms_session' : '__Host-ms_session';
const MAX_BODY = 6 * 1024 * 1024;
const MAX_STATE = 5 * 1024 * 1024;
const SESSION_DAYS = 30;
const pool = new Pool({
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT || '5432'),
  user: process.env.POSTGRES_USER || 'masterskaya',
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB || 'masterskaya',
  max: 10,
  connectionTimeoutMillis: 6000,
  idleTimeoutMillis: 30000
});

async function initializeDatabase() {
  await pool.query([
    'CREATE TABLE IF NOT EXISTS ms_users (',
    ' id uuid PRIMARY KEY DEFAULT gen_random_uuid(),',
    ' email text NOT NULL UNIQUE,',
    ' password_salt text NOT NULL,',
    ' password_hash text NOT NULL,',
    ' created_at timestamptz NOT NULL DEFAULT now()',
    ')'
  ].join('\n'));
  await pool.query([
    'CREATE TABLE IF NOT EXISTS ms_states (',
    ' user_id uuid PRIMARY KEY REFERENCES ms_users(id) ON DELETE CASCADE,',
    ' revision bigint NOT NULL DEFAULT 0,',
    ' data jsonb,',
    ' updated_at timestamptz NOT NULL DEFAULT now()',
    ')'
  ].join('\n'));
  await pool.query([
    'CREATE TABLE IF NOT EXISTS ms_sessions (',
    ' token_hash char(64) PRIMARY KEY,',
    ' user_id uuid NOT NULL REFERENCES ms_users(id) ON DELETE CASCADE,',
    ' expires_at timestamptz NOT NULL,',
    ' created_at timestamptz NOT NULL DEFAULT now()',
    ')'
  ].join('\n'));
  await pool.query('CREATE INDEX IF NOT EXISTS ms_sessions_user ON ms_sessions(user_id)');
  await pool.query([
    'CREATE TABLE IF NOT EXISTS ms_backups (',
    ' id bigserial PRIMARY KEY,',
    ' user_id uuid NOT NULL REFERENCES ms_users(id) ON DELETE CASCADE,',
    ' revision bigint NOT NULL,',
    ' data jsonb NOT NULL,',
    ' created_at timestamptz NOT NULL DEFAULT now()',
    ')'
  ].join('\n'));
  await pool.query('CREATE INDEX IF NOT EXISTS ms_backups_user_id ON ms_backups(user_id, id DESC)');
}

function respond(res, status, body) {
  const output = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(output) });
  res.end(output);
}
function fail(res, status, code, message) { respond(res, status, { error: code, message }); }
function sessionCookie(token, maxAge) {
  return COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict' +
    (localDev ? '' : '; Secure') + '; Max-Age=' + String(maxAge);
}
function cookies(req) {
  const out = {};
  for (const piece of String(req.headers.cookie || '').split(';')) {
    const cut = piece.indexOf('=');
    if (cut > 0) out[piece.slice(0, cut).trim()] = piece.slice(cut + 1).trim();
  }
  return out;
}
function sha(text) { return createHash('sha256').update(text).digest('hex'); }
function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
function validPassword(password) { return typeof password === 'string' && password.length >= 12 && password.length <= 128; }
async function passwordHash(password, salt) {
  const output = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return output.toString('hex');
}
async function verifyPassword(password, user) {
  const target = user ? user.password_hash : '0'.repeat(128);
  const result = await passwordHash(password, user ? user.password_salt : '0'.repeat(32));
  return timingSafeEqual(Buffer.from(result, 'hex'), Buffer.from(target, 'hex')) && Boolean(user);
}
const rate = new Map();
function limited(req, action, max) {
  const now = Date.now();
  const key = String(req.socket.remoteAddress || 'unknown') + ':' + action;
  if (rate.size > 3000) for (const [id, item] of rate) if (item.until < now) rate.delete(id);
  let current = rate.get(key);
  if (!current || current.until <= now) current = { count: 0, until: now + 15 * 60 * 1000 };
  current.count++;
  rate.set(key, current);
  return current.count > max;
}
async function jsonBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const e = new Error('Ожидался JSON.'); e.status = 415; throw e;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) { const e = new Error('Файл слишком велик.'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const e = new Error('Некорректный JSON.'); e.status = 400; throw e; }
}
function validState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schemaVersion !== 1) return false;
  for (const key of ['materials', 'purchases', 'products', 'calculations']) if (!Array.isArray(data[key])) return false;
  for (const key of ['productionBatches', 'inventoryCounts', 'sales', 'saleReturns', 'equipment', 'materialCategories'])
    if (data[key] !== undefined && !Array.isArray(data[key])) return false;
  return true;
}
async function currentUser(req) {
  let token;
  try { token = decodeURIComponent(cookies(req)[COOKIE] || ''); } catch { return null; }
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const rows = await pool.query([
    'SELECT u.id, u.email FROM ms_sessions s',
    'JOIN ms_users u ON u.id = s.user_id',
    'WHERE s.token_hash = $1 AND s.expires_at > now()'
  ].join(' '), [sha(token)]);
  return rows.rows[0] || null;
}
async function startSession(res, user) {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO ms_sessions(token_hash, user_id, expires_at) VALUES ($1,$2,now()+interval '30 days')",
    [sha(token), user.id]
  );
  res.setHeader('Set-Cookie', sessionCookie(token, SESSION_DAYS * 86400));
}
async function setup(res, input) {
  if (!validEmail(input?.email) || !validPassword(input?.password) ||
      typeof input.setupToken !== 'string' || input.setupToken.length > 512) {
    return fail(res, 400, 'invalid_input', 'Укажи адрес почты, пароль от 12 символов и код первого запуска.');
  }
  const supplied = Buffer.from(sha(input.setupToken), 'hex');
  const expected = Buffer.from(sha(SETUP_TOKEN), 'hex');
  if (!timingSafeEqual(supplied, expected)) return fail(res, 403, 'setup_denied', 'Неверный код первого запуска.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7471102)');
    const exists = await client.query('SELECT 1 FROM ms_users LIMIT 1');
    if (exists.rowCount) { await client.query('ROLLBACK'); return fail(res, 409, 'already_initialized', 'Первый аккаунт уже создан.'); }
    const email = input.email.trim().toLowerCase();
    const salt = randomBytes(16).toString('hex');
    const hashed = await passwordHash(input.password, salt);
    const inserted = await client.query(
      'INSERT INTO ms_users(email,password_salt,password_hash) VALUES ($1,$2,$3) RETURNING id,email',
      [email,salt,hashed]
    );
    const user = inserted.rows[0];
    await client.query('INSERT INTO ms_states(user_id) VALUES ($1)',[user.id]);
    await client.query('COMMIT');
    await startSession(res,user);
    respond(res,201,{user});
  } catch(err) {
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }
}
async function login(res,input) {
  if (!validEmail(input?.email) || !validPassword(input?.password)) {
    return fail(res, 401, 'bad_credentials', 'Неверная почта или пароль.');
  }
  const result = await pool.query(
    'SELECT id,email,password_hash,password_salt FROM ms_users WHERE email=$1',
    [input.email.trim().toLowerCase()]
  );
  const user = result.rows[0];
  if (!await verifyPassword(input.password,user)) return fail(res,401,'bad_credentials','Неверная почта или пароль.');
  await startSession(res,user);
  respond(res,200,{user:{id:user.id,email:user.email}});
}
async function getSnapshot(res,user) {
  const result=await pool.query('SELECT revision,data,updated_at FROM ms_states WHERE user_id=$1',[user.id]);
  const x=result.rows[0];
  if (!x) return fail(res,404,'no_state','Пользовательские данные не найдены.');
  respond(res,200,{revision:Number(x.revision),data:x.data,updatedAt:x.updated_at});
}
async function putSnapshot(res,user,input) {
  const expected = Number(input?.revision);
  if (!Number.isSafeInteger(expected) || expected<0 || !validState(input?.data))
    return fail(res,400,'bad_state','Некорректная версия или структура данных.');
  const serialized=JSON.stringify(input.data);
  if (Buffer.byteLength(serialized)>MAX_STATE)
    return fail(res,413,'state_too_large','Размер базы превышает 5 МБ. Нужен следующий формат хранения.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const locked=await client.query('SELECT revision,data FROM ms_states WHERE user_id=$1 FOR UPDATE',[user.id]);
    if (!locked.rowCount) { await client.query('ROLLBACK'); return fail(res,404,'no_state','Данные аккаунта не найдены.'); }
    const old=locked.rows[0];
    if (Number(old.revision)!==expected) {
      await client.query('ROLLBACK');
      return respond(res,409,{error:'revision_conflict',message:'На другом устройстве уже сохранены новые данные.',revision:Number(old.revision)});
    }
    if(old.data!==null){
      await client.query('INSERT INTO ms_backups(user_id,revision,data) VALUES ($1,$2,$3::jsonb)',[user.id,old.revision,JSON.stringify(old.data)]);
    }
    const saved=await client.query(
      'UPDATE ms_states SET revision=revision+1,data=$2::jsonb,updated_at=now() WHERE user_id=$1 RETURNING revision,updated_at',
      [user.id,serialized]
    );
    await client.query(
      'DELETE FROM ms_backups WHERE user_id=$1 AND id NOT IN (SELECT id FROM ms_backups WHERE user_id=$1 ORDER BY id DESC LIMIT 30)',
      [user.id]
    );
    await client.query('COMMIT');
    respond(res,200,{revision:Number(saved.rows[0].revision),savedAt:saved.rows[0].updated_at});
  }catch(err){try{await client.query('ROLLBACK')}catch{} throw err;}
  finally{client.release();}
}
async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
  const pathname=new URL(req.url,ORIGIN).pathname;
  if(pathname==='/health' && req.method==='GET')return respond(res,200,{ok:true});
  if(pathname==='/sync-client.js' && req.method==='GET'){
    const body=await readFile(path.join(__dirname,'sync-client.js'));
    res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(body);
  }
  if(pathname==='/favicon.svg' && req.method==='GET'){
    const body=await readFile(path.join(__dirname,'public','favicon.svg'));
    res.writeHead(200,{'Content-Type':'image/svg+xml'});return res.end(body);
  }
  if(pathname==='/' && req.method==='GET'){
    let body=await readFile(path.join(__dirname,'public','index.html'),'utf8');
    body=body.replace('</head>','<style>html{visibility:hidden}</style></head>')
      .replace('</body>','<script src="/sync-client.js" defer></script></body>');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(body);
  }
  if(!pathname.startsWith('/api/'))return fail(res,404,'not_found','Страница не найдена.');
  if(req.method==='GET' && pathname==='/api/status'){
    const row=await pool.query('SELECT 1 FROM ms_users LIMIT 1');
    return respond(res,200,{needsSetup:!row.rowCount});
  }
  if(['POST','PUT','PATCH','DELETE'].includes(req.method)){
    if(req.headers.origin!==ORIGIN)return fail(res,403,'bad_origin','Запрос отклонён: неверный источник.');
  }
  if(req.method==='POST'&&pathname==='/api/setup'){
    if(limited(req,'setup',8))return fail(res,429,'rate_limited','Слишком много попыток. Попробуй позже.');
    return setup(res,await jsonBody(req));
  }
  if(req.method==='POST'&&pathname==='/api/login'){
    if(limited(req,'login',12))return fail(res,429,'rate_limited','Слишком много попыток. Попробуй позже.');
    return login(res,await jsonBody(req));
  }
  const user=await currentUser(req);
  if(!user)return fail(res,401,'login_required','Требуется вход в аккаунт.');
  if(req.method==='GET'&&pathname==='/api/me')return respond(res,200,{user});
  if(req.method==='POST'&&pathname==='/api/logout'){
    let token='';try{token=decodeURIComponent(cookies(req)[COOKIE]||'')}catch{}
    if(/^[a-f0-9]{64}$/.test(token))await pool.query('DELETE FROM ms_sessions WHERE token_hash=$1',[sha(token)]);
    res.setHeader('Set-Cookie',sessionCookie('',0));
    return respond(res,200,{ok:true});
  }
  if(req.method==='GET'&&pathname==='/api/state')return getSnapshot(res,user);
  if(req.method==='PUT'&&pathname==='/api/state')return putSnapshot(res,user,await jsonBody(req));
  if(req.method==='GET'&&pathname==='/api/backups'){
    const result=await pool.query('SELECT id,revision,created_at FROM ms_backups WHERE user_id=$1 ORDER BY id DESC LIMIT 30',[user.id]);
    return respond(res,200,{backups:result.rows.map(x=>({id:String(x.id),revision:Number(x.revision),createdAt:x.created_at}))});
  }
  if(req.method==='GET'&&/^\/api\/backups\/[0-9]+$/.test(pathname)){
    const id=pathname.split('/').pop();
    const result=await pool.query('SELECT revision,data FROM ms_backups WHERE user_id=$1 AND id=$2',[user.id,id]);
    if(!result.rowCount)return fail(res,404,'not_found','Резервная версия не найдена.');
    return respond(res,200,{revision:Number(result.rows[0].revision),data:result.rows[0].data});
  }
  return fail(res,404,'not_found','Неизвестная команда.');
}
const server=http.createServer((req,res)=>{
  handler(req,res).catch(err=>{
    console.error('server_error',err && err.message ? err.message : 'unknown');
    if(!res.headersSent)fail(res,err.status||500,err.status?'invalid_request':'internal_error',err.status?err.message:'Не удалось выполнить запрос.');
    else res.destroy();
  });
});
async function main(){
  await initializeDatabase();
  server.listen(PORT,'0.0.0.0',()=>console.log('masterskaya_server_ready port='+PORT));
}
if(require.main===module)main().catch(e=>{console.error('startup_error',e.message);process.exit(1)});
module.exports={validState,validEmail,validPassword,sessionCookie,sha,handler,server};
