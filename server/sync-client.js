'use strict';
// Подключается только в серверной версии приложения. Никакой автоматической отправки до выбора пользователем.
(() => {
 const KEY='masterskaya-prototype-v1';
 let me=null,remote=null,active=false,busy=false,pending=false,muted=false,notice='';
 const css=document.createElement('link');css.rel='stylesheet';css.href='/sync.css';document.head.append(css);
 const trigger=document.createElement('button');trigger.className='ms-sync-trigger';trigger.type='button';trigger.textContent='Синхронизация';
 const shade=document.createElement('div');shade.className='ms-sync-shade';shade.hidden=true;
 shade.innerHTML='<section class="ms-sync-panel" role="dialog" aria-modal="true" aria-labelledby="ms-sync-title"><button type="button" class="ms-sync-close" aria-label="Закрыть">×</button><h2 id="ms-sync-title">Мастерская · облачные данные</h2><div id="ms-sync-body"></div></section>';
 document.body.append(trigger,shade);
 const body=shade.querySelector('#ms-sync-body');
 const safe=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const show=()=>{shade.hidden=false;draw()};
 const hide=()=>{shade.hidden=true};
 trigger.addEventListener('click',show);shade.querySelector('.ms-sync-close').addEventListener('click',hide);
 shade.addEventListener('click',e=>{if(e.target===shade)hide()});
 function message(text,warn=false){
   notice=String(text);
   trigger.textContent=warn?'Проверь синхронизацию':active?'Данные синхронизируются':'Синхронизация';
   trigger.classList.toggle('ms-warning',warn);
   if(!shade.hidden)draw();
 }
 async function api(path,method='GET',data){
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),20000);
   try{
     const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:controller.signal,
       headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
     const result=await response.json().catch(()=>({message:'Нет ответа сервера.'}));
     if(!response.ok){const err=new Error(result.message||'Ошибка сервера.');err.status=response.status;err.code=result.error;throw err}
     return result;
   }finally{clearTimeout(timer)}
 }
 function localCopy(){
   const raw=localStorage.getItem(KEY);
   if(!raw)throw new Error('На устройстве пока нет локальной базы.');
   let data;try{data=JSON.parse(raw)}catch{throw new Error('Локальный JSON повреждён. Не отправляй его на сервер.')}
   if(typeof validImport!=='function'||!validImport(data))throw new Error('Локальная база не прошла проверку структуры.');
   return data;
 }
 function exportJSON(data,name){
   const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
   const url=URL.createObjectURL(blob),link=document.createElement('a');
   link.href=url;link.download='masterskaya-'+name+'-'+new Date().toISOString().slice(0,10)+'.json';
   document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
 }
 function draw(){
   if(!me){
     const setup=Boolean(window.msFirstSetup);
     body.innerHTML='<p class="ms-message">'+safe(notice||'Подключение к серверу…')+'</p>'+
       '<form id="ms-sync-auth"><label>Почта<input name="email" type="email" autocomplete="username" maxlength="254" required></label>'+
       '<label>Пароль<input name="password" type="password" autocomplete="'+(setup?'new-password':'current-password')+'" minlength="12" maxlength="128" required></label>'+
       (setup?'<label>Установочный код сервера<input name="setupToken" type="password" required autocomplete="off"></label>':'')+
       '<div class="ms-sync-actions"><button class="primary" type="submit">'+(setup?'Создать первый аккаунт':'Войти')+'</button></div></form>'+
       '<p class="ms-hint">Вход не отправляет локальные материалы, закупки и продажи на сервер автоматически.</p>';
     body.querySelector('form').addEventListener('submit',login);
     return;
   }
   body.innerHTML='<p>Аккаунт: <strong>'+safe(me.email)+'</strong></p>'+
     '<p class="ms-message">'+safe((remote?(remote.data===null?'На сервере нет базы.':'Серверная ревизия: '+remote.revision):'Серверная база неизвестна.')+
       '\n'+(active?'Автоматическая отправка включена в этой вкладке.':'Локальная работа пока не отправляется на сервер.')+
       (notice?'\n'+notice:''))+'</p>'+
     '<p>Выбери исходную копию. Перед заменой локальной базы приложение скачает её резервную JSON-копию.</p>'+
     '<div class="ms-sync-actions">'+
     '<button class="primary" data-ms="pull" type="button" '+(!remote?.data?'disabled':'')+'>Открыть серверную базу</button>'+
     '<button data-ms="push" type="button">Отправить локальную базу</button>'+
     '<button data-ms="refresh" type="button">Проверить сервер</button>'+
     '<button data-ms="backup" type="button">Скачать локальный JSON</button>'+
     '<button data-ms="logout" type="button" class="danger">Выйти</button></div>'+
     '<p class="ms-hint">Если другое устройство изменило базу, сервер отклонит старую ревизию. Копии нельзя объединить автоматически — выбери правильную вручную.</p>';
   body.querySelectorAll('[data-ms]').forEach(btn=>btn.addEventListener('click',()=>action(btn.dataset.ms)));
 }
 async function fetchRemote(){remote=await api('/api/state');return remote}
 async function login(event){
   event.preventDefault();
   const params=Object.fromEntries(new FormData(event.currentTarget).entries());
   try{
     const result=await api(window.msFirstSetup?'/api/setup':'/api/login','POST',params);
     me=result.user;active=false;await fetchRemote();message('Вход выполнен. Выбери исходную базу.');
   }catch(e){message('Ошибка входа: '+e.message,true)}
 }
 async function action(op){
   if(busy){message('Сначала заверши предыдущую операцию.');return}
   try{
     if(op==='backup'){exportJSON(localCopy(),'local');message('Резервная копия скачана.');return}
     if(op==='logout'){
       pending=false;
       if(!confirm('Выйти из аккаунта? Локальные данные останутся на устройстве.'))return;
       active=false;await api('/api/logout','POST',{});
       me=null;remote=null;message('Выход выполнен.');return;
     }
     if(op==='refresh'){active=false;pending=false;await fetchRemote();message('Сведения с сервера обновлены. Выбери нужную базу.');return}
     if(op==='pull'){
       await fetchRemote();
       if(!remote?.data)return;
       if(!validImport(remote.data))throw new Error('Серверная база не прошла проверку и не была загружена.');
       const old=localStorage.getItem(KEY),previousState=state;
       const previousLoadError=typeof dataLoadError!=='undefined'?dataLoadError:'';
       if(old&&!confirm('Заменить локальные данные серверной базой? Прежде будет скачана резервная JSON-копия.'))return;
       if(old){
         try{exportJSON(localCopy(),'local-before-pull');}
         catch{
           const blob=new Blob([old],{type:'application/json;charset=utf-8'});
           const url=URL.createObjectURL(blob),link=document.createElement('a');
           link.href=url;link.download='masterskaya-local-unreadable-'+new Date().toISOString().slice(0,10)+'.json';
           document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
         }
       }
       muted=true;
       try{
         const candidate=initializeCategories(JSON.parse(JSON.stringify(remote.data)));
         state=candidate;
         const audit=fifoPool();
         state=previousState;
         if(audit.error)throw new Error('Серверная база не согласуется с историей склада: '+audit.error);
         localStorage.setItem(KEY,JSON.stringify(candidate));
         state=candidate;
         if(typeof dataLoadError!=='undefined')dataLoadError='';
         if(typeof render==='function')render();
         active=true;message('Серверная база открыта. Последующие сохранения отправляются на сервер.');
       }catch(e){
         state=previousState;
         if(typeof dataLoadError!=='undefined')dataLoadError=previousLoadError;
         if(old!==null)localStorage.setItem(KEY,old);else localStorage.removeItem(KEY);
         throw e;
       }finally{muted=false}
       return;
     }
     if(op==='push'){
       const snapshot=localCopy();
       if(!remote)await fetchRemote();
       if(!confirm(remote.data===null?
         'Сделать первую серверную копию из локальной базы?':
         'Заменить данные сервера локальной базой? Предыдущая версия останется в резервных ревизиях.'))return;
       exportJSON(snapshot,'local-before-push');
       busy=true;
       try{
         const saved=await api('/api/state','PUT',{revision:remote.revision,data:snapshot});
         remote={revision:saved.revision,data:snapshot};active=true;message('База записана. Автоматическая отправка активна.');
       }finally{busy=false}
     }
   }catch(e){active=false;message('Синхронизация остановлена: '+e.message+'. Локальные данные сохранены. Сверь версии перед повторной отправкой.',true)}
 }
 const originalSet=Storage.prototype.setItem;
 Storage.prototype.setItem=function(key,value){
   const result=originalSet.call(this,key,value);
   if(this===localStorage&&key===KEY&&active&&!muted){pending=true;if(!busy)void flush()}
   return result;
 };
 async function flush(){
   if(!active||busy||!pending)return;
   busy=true;pending=false;
   try{
     const snapshot=localCopy();
     const saved=await api('/api/state','PUT',{revision:remote.revision,data:snapshot});
     remote={revision:saved.revision,data:snapshot};
     message('Изменения сохранены на сервере.');
   }catch(e){
     active=false;
     message(e.status===409?
       'Конфликт: другая вкладка или устройство изменили серверную базу. Локальные данные сохранены. Скачать JSON, затем выбери нужную версию.':
       'Не удалось отправить изменения: '+e.message+'. Они остались на устройстве.',true);
   }finally{busy=false;if(active&&pending)void flush()}
 }
 async function init(){
   try{
     const status=await api('/api/status');window.msFirstSetup=status.needsSetup;
     try{
       const loginInfo=await api('/api/me');me=loginInfo.user;
       await fetchRemote();message('Сессия подтверждена. Выбери исходную базу.');
     }catch{me=null;message(status.needsSetup?'Создай первый аккаунт.':'Войди в аккаунт для синхронизации.')}
   }catch(e){message('Сервер недоступен: '+e.message+'. Локальная Мастерская остаётся рабочей.',true)}
 }
 void init();
})();
