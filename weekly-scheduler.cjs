'use strict';
// External clock only. Free Render services sleep, so no in-process timer is used.
const {createHash, timingSafeEqual} = require('node:crypto');
const {weekRange, weeklySlot, formatWeeklyMessages} = require('./weekly-format.cjs');
const PHASES = ['실사','배선','조명설치','SW세팅','검수인계'];
const CALENDAR_URL = 'https://calanderv2.vercel.app/';
function check(value, code){ if(!value) throw Object.assign(new Error(code),{safeCode:code}); }
function statusCode(error){ return Number(error?.response?.status || error?.status) || 0; }
function sameName(a,b){ return String(a).normalize('NFC').replace(/\s+/g,'') === String(b).normalize('NFC').replace(/\s+/g,''); }
function dateValid(value){
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value+'T00:00:00Z')) && new Date(value+'T00:00:00Z').toISOString().slice(0,10) === value;
}
function configuration(env, people){
  check(env.GCHAT_WEEKLY_TIMEZONE === 'Asia/Seoul' && env.GCHAT_WEEKLY_CRON === '0 8 * * 1','invalid_schedule');
  check(/^spaces\/[A-Za-z0-9_-]+$/.test(env.GCHAT_WEEKLY_TEAM_SPACE || ''),'invalid_team_space');
  check(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit$/.test(env.GCHAT_WEEKLY_SHEET_URL || ''),'invalid_sheet_link');
  for(const key of ['GCHAT_WEEKLY_ENABLED','GCHAT_WEEKLY_PERSONAL_ENABLED','GCHAT_WEEKLY_TEAM_ENABLED']){
    check(['true','false'].includes(env[key]),'invalid_switch');
  }
  check(Array.isArray(people) && people.length >= 1 && people.length <= 5 && people.filter(p=>p?.owner === true).length === 1,'invalid_roster');
  const names = new Set(), emails = new Set();
  for(const person of people){
    check(person && typeof person.name === 'string' && person.name.trim() && person.name.length <= 80 &&
      !/[\u0000-\u001f\u007f]/.test(person.name) && typeof person.email === 'string' &&
      /^[a-z0-9][a-z0-9._+-]*@aqara\.kr$/.test(person.email) && person.email.length <= 254 &&
      typeof person.owner === 'boolean','invalid_roster');
    const name = person.name.normalize('NFC').replace(/\s+/g,'');
    check(!names.has(name) && !emails.has(person.email),'duplicate_roster');
    names.add(name); emails.add(person.email);
  }
  if(env.GCHAT_WEEKLY_EXPECTED_PEOPLE != null) check(String(people.length) === env.GCHAT_WEEKLY_EXPECTED_PEOPLE,'incomplete_roster');
  return {enabled:env.GCHAT_WEEKLY_ENABLED === 'true',personal:env.GCHAT_WEEKLY_PERSONAL_ENABLED === 'true',
    team:env.GCHAT_WEEKLY_TEAM_ENABLED === 'true',space:env.GCHAT_WEEKLY_TEAM_SPACE};
}
function weeklyMessageId(range, space, part){
  // Never include mutable text, event count or process startup time in an idempotency key.
  return 'client-weekly-'+createHash('sha256').update(range.from+'|'+space).digest('hex').slice(0,32)+'-'+part;
}
function loadWeeklyPeople(raw){
  const owner = {name:'전준규',email:'jungyu@aqara.kr',owner:true};
  const staff = raw == null ? [] : JSON.parse(raw);
  check(Array.isArray(staff) && staff.length <= 4,'invalid_roster');
  return [owner,...staff.map(person=>{
    check(person && typeof person === 'object' && !Array.isArray(person) && Object.keys(person).length === 2 &&
      Object.keys(person).every(key=>key === 'name' || key === 'email'),'invalid_roster');
    return {...person,owner:false};
  })];
}
function createWeeklyNotifier({people,chat,gas,env=process.env,now=()=>new Date(),logger=console}){
  people = people || loadWeeklyPeople(env.GCHAT_TEAM_MEMBERS);
  let inFlight = false;
  const delivered = new Map();
  const read = async(resource,params)=>{
    const response = await chat('GET',resource,undefined,params);
    check(response && response.data && typeof response.data === 'object','chat_unavailable');
    return response.data;
  };
  async function joined(space,person,expectedUser){
    const result = await read(space+'/members/'+person.email);
    check(result.state === 'JOINED' && result.member?.type === 'HUMAN' && /^users\/\d+$/.test(result.member.name) &&
      (!expectedUser || result.member.name === expectedUser),'recipient_not_verified');
    return result.member.name;
  }
  async function directMessages(){
    const spaces = [], names = new Set(), tokens = new Set();
    let pageToken = '';
    do{
      const data = await read('spaces',{pageSize:100,filter:'spaceType = "DIRECT_MESSAGE"',...(pageToken?{pageToken}:{})});
      check(data.spaces == null || Array.isArray(data.spaces),'invalid_spaces');
      for(const space of data.spaces || []){
        check(space.spaceType === 'DIRECT_MESSAGE' && /^spaces\/[A-Za-z0-9_-]+$/.test(space.name) && !names.has(space.name),'invalid_spaces');
        names.add(space.name); spaces.push(space.name);
      }
      pageToken = data.nextPageToken || '';
      check(typeof pageToken === 'string' && (!pageToken || !tokens.has(pageToken)) && tokens.size < 100,'invalid_space_pagination');
      tokens.add(pageToken);
    }while(pageToken);
    return spaces;
  }
  async function verifyTarget(target){
    if(target.kind === 'personal') return joined(target.space,target.person,target.user);
    check(target.space === env.GCHAT_WEEKLY_TEAM_SPACE,'invalid_team_space');
    const space = await read(target.space);
    check(space.name === target.space && space.spaceType === 'SPACE','team_not_connected');
  }
  async function targets(config){
    const result = [];
    if(config.personal){
      const spaces = await directMessages();
      for(const person of people){
        const matches = [];
        let failed = false;
        for(const space of spaces){
          try{ matches.push({space,user:await joined(space,person)}); }
          catch(error){ if(![403,404].includes(statusCode(error))) failed = true; }
        }
        result.push({kind:'personal',manager:person.name,person,
          ...(matches.length === 1 && !failed ? {...matches[0],status:'ready'} :
            {status:failed ? 'membership_unverified' : matches.length ? 'ambiguous_dm' : 'dm_not_connected'})});
      }
    }
    if(config.team){
      const target = {kind:'team',manager:'',space:config.space,status:'ready'};
      try{ await verifyTarget(target); }catch{ target.status = 'team_not_connected'; }
      result.push(target);
    }
    const verified = result.filter(t=>t.status === 'ready');
    // One destination must never receive another person's filtered report.
    for(const target of verified){
      if(verified.some(other=>other !== target && (other.space === target.space ||
        (target.user && other.user === target.user)))) target.status = 'ambiguous_recipient';
    }
    return result;
  }
  async function schedules(range,manager){
    let first;
    const items = [];
    for(let page=1;page<=100;page++){
      const data = await gas({action:'site_schedule_list',...range,manager,role:'either',statusScope:'active',page:String(page)}, {timeout:30000});
      const r = data?.result;
      check(data?.scheduleListApiVersion === 1 && !data.error && r && !r.error && r.source === 'checklist','invalid_schedule_response');
      check(r.from === range.from && r.to === range.to && r.manager === manager && r.role === 'either' && r.statusScope === 'active' &&
        r.page === page && r.pageSize === 12 && (!r.query) && (!r.phase),'schedule_filter_mismatch');
      check(Number.isSafeInteger(r.count) && r.count >= 0 && Number.isSafeInteger(r.siteCount) && r.siteCount >= 0 && r.siteCount <= r.count &&
        r.totalPages === Math.max(1,Math.ceil(r.count/12)) && r.totalPages <= 100 && Array.isArray(r.items),'invalid_schedule_count');
      if(!first) first = r;
      check(r.count === first.count && r.siteCount === first.siteCount && r.totalPages === first.totalPages,'schedule_changed_during_read');
      check(r.items.length === Math.min(12,Math.max(0,r.count-(page-1)*12)),'incomplete_schedule_page');
      for(const item of r.items){
        check(item && ['site','vendor','phase','date','status','mgr','mgrSub'].every(key=>typeof item[key] === 'string') && item.site.trim() &&
          PHASES.includes(item.phase) && dateValid(item.date) && item.date >= range.from && item.date <= range.to &&
          item.status.trim() && !/제안|취소/.test(item.status) && (!manager || sameName(item.mgr,manager) || sameName(item.mgrSub,manager)),
          'invalid_schedule_item');
        items.push(item);
      }
      if(page === r.totalPages) return {count:r.count,siteCount:r.siteCount,items};
    }
    throw Object.assign(new Error('schedule_too_large'),{safeCode:'schedule_too_large'});
  }
  async function plan(range,config){
    const list = await targets(config);
    for(const target of list){
      if(target.status !== 'ready') continue;
      try{
        const result = await schedules(range,target.manager);
        target.messages = formatWeeklyMessages(range,result,{manager:target.manager || null,sheetUrl:env.GCHAT_WEEKLY_SHEET_URL || '',calendarUrl:CALENDAR_URL});
        check(Array.isArray(target.messages) && target.messages.length > 0 && target.messages.every(text=>typeof text === 'string' && Buffer.byteLength(text,'utf8') < 28000),'invalid_messages');
        target.messageCount = target.messages.length;
      }catch(error){ target.status = 'read_failed'; target.error = error.safeCode || 'schedule_read_failed'; }
    }
    return list;
  }
  async function existingMessage(resource,space){
    try{
      const data = await read(resource);
      check(data.space?.name === space && typeof data.text === 'string','unexpected_message');
      return data;
    }catch(error){
      // Google can hide a not-yet-created app-auth message behind 403.
      if([403,404].includes(statusCode(error))) return null;
      throw error;
    }
  }
  async function deliver(range,target){
    const key = range.from+'|'+target.space;
    if(delivered.has(key)) return {status:'already_sent',sent:0};
    const messages = target.messages;
    const resources = messages.map((text,index)=>target.space+'/messages/'+weeklyMessageId(range,target.space,index+1));
    // Inspect all old parts before writing. Never combine a new snapshot with old parts.
    const existing = [];
    for(const resource of resources) existing.push(await existingMessage(resource,target.space));
    if(existing.every(Boolean)){
      delivered.set(key,true); return {status:'already_sent',sent:0};
    }
    if(existing.some((message,index)=>message && message.text !== messages[index])) return {status:'previous_snapshot_changed',sent:0};
    let sent = 0;
    const canSend = ()=>env.GCHAT_WEEKLY_ENABLED === 'true' &&
      env[target.kind === 'personal' ? 'GCHAT_WEEKLY_PERSONAL_ENABLED' : 'GCHAT_WEEKLY_TEAM_ENABLED'] === 'true' &&
      weeklySlot(now())?.from === range.from;
    for(let index=0;index<messages.length;index++){
      if(existing[index]) continue;
      // The off switch and Monday window apply immediately before EVERY message.
      if(!canSend()) return {status:'stopped',sent};
      await verifyTarget(target);
      if(!canSend()) return {status:'stopped',sent};
      const messageId = weeklyMessageId(range,target.space,index+1);
      try{
        const response = await chat('POST',target.space+'/messages',{text:messages[index]},{messageId});
        check(response && response.data,'chat_unavailable');
      }catch(error){
        // A timeout may have committed. Only read this same id; never create an alternative id.
        if(statusCode(error) && statusCode(error) !== 409) throw error;
      }
      const verified = await existingMessage(resources[index],target.space);
      check(verified && verified.text === messages[index],'delivery_unconfirmed');
      sent++;
    }
    delivered.set(key,true);
    return {status:'sent',sent};
  }
  function publicTarget(target){
    return {kind:target.kind,manager:target.manager,status:target.status,...(target.space?{space:target.space}:{}),
      ...(target.messageCount?{messageCount:target.messageCount}:{}),...(target.sent != null?{sent:target.sent}:{}),...(target.error?{error:target.error}:{})};
  }
  async function preview(options={}){
    const config = configuration(env,people), range = weekRange(options.now || now());
    return {range,enabled:config.enabled,targets:(await plan(range,config)).map(publicTarget),sent:0};
  }
  async function tick(){
    if(env.GCHAT_WEEKLY_ENABLED !== 'true') return {status:'disabled',sent:0};
    if(!weeklySlot(now())) return {status:'outside_window',sent:0};
    if(inFlight) return {status:'running',sent:0};
    inFlight = true;
    try{
      const config = configuration(env,people), range = weeklySlot(now());
      for(const key of delivered.keys()) if(!key.startsWith(range.from+'|')) delivered.delete(key);
      const list = await plan(range,config);
      for(const target of list){
        if(target.status !== 'ready') continue;
        try{ Object.assign(target,await deliver(range,target)); }
        catch(error){ target.status = 'delivery_unconfirmed'; target.error = error.safeCode || 'chat_delivery_failed'; }
      }
      const result = {status:list.every(t=>['sent','already_sent'].includes(t.status)) ? 'complete' : 'partial',range,
        sent:list.reduce((sum,t)=>sum+(t.sent || 0),0),targets:list.map(publicTarget)};
      logger?.log?.('[weekly] '+JSON.stringify({status:result.status,sent:result.sent,targets:result.targets.map(t=>({kind:t.kind,status:t.status}))}));
      return result;
    }catch(error){
      logger?.warn?.('[weekly] '+(error.safeCode || 'job_failed'));
      return {status:'partial',sent:0,error:error.safeCode || 'job_failed'};
    }finally{ inFlight = false; }
  }
  return {tick,preview};
}
function authorized(request,env){
  const secret = env.GCHAT_WEEKLY_JOB_TOKEN;
  const header = request.headers?.authorization;
  if(typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret) || typeof header !== 'string') return false;
  const token = /^Bearer ([a-f0-9]{64})$/.exec(header)?.[1];
  return !!token && timingSafeEqual(Buffer.from(secret),Buffer.from(token));
}
function installWeeklyRoutes(app,options){
  const env = options.env || process.env;
  const notifier = createWeeklyNotifier({...options,env});
  app.post('/internal/weekly-notifications/run',async(req,res)=>{
    if(!authorized(req,env)) return res.status(401).json({error:'unauthorized'});
    const result = await notifier.tick();
    // Expose no roster, addresses or messages to the clock provider.
    return res.status(result.status === 'partial' ? 503 : result.status === 'running' ? 409 : 200)
      .json({status:result.status,sent:result.sent || 0});
  });
  app.get('/internal/weekly-notifications/status',(req,res)=>{
    if(!authorized(req,env)) return res.status(401).json({error:'unauthorized'});
    return res.json({enabled:env.GCHAT_WEEKLY_ENABLED === 'true',timeZone:env.GCHAT_WEEKLY_TIMEZONE,cron:env.GCHAT_WEEKLY_CRON});
  });
  return notifier;
}
module.exports = {createWeeklyNotifier,weeklyMessageId,installWeeklyRoutes,loadWeeklyPeople};
