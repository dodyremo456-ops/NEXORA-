'use strict';
// NEXORA backend: serves the site and proxies AI requests so API keys never reach the browser.
// Run: ANTHROPIC_API_KEY=... OPENAI_API_KEY=... node server.js   (Node 18+, no dependencies)
const http=require('http'),fs=require('fs'),path=require('path');
const env=process.env,PORT=+env.PORT||8080,HOST=env.HOST||'127.0.0.1',TRUST=env.TRUST_PROXY==='1';
const RATE=+env.RATE_LIMIT_PER_MIN||10,MAX_PROMPT=4000,MAX_BODY=16384,MAX_INFLIGHT=20;
const FILES={'/':'index.html','/index.html':'index.html','/manifest.json':'manifest.json','/sw.js':'sw.js','/icon.svg':'icon.svg'};
const TYPES={'.html':'text/html; charset=utf-8','.json':'application/json','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml'};
const idx=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
const m=idx.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
const SEC={'Content-Security-Policy':(m?m[1]:"default-src 'self'")+"; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), geolocation=(), payment=(), usb=(), microphone=(self)','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Resource-Policy':'same-origin'};
const base=(k,d)=>(env[k]||d).replace(/\/+$/,'');
const PROV={
 anthropic:{label:'Anthropic (Claude)',key:env.ANTHROPIC_API_KEY,model:env.ANTHROPIC_MODEL||'claude-sonnet-5-5',url:base('ANTHROPIC_BASE_URL','https://api.anthropic.com')+'/v1/messages',
  build:(p,mod)=>({headers:{'x-api-key':PROV.anthropic.key,'anthropic-version':'2023-06-01'},body:{model:mod,max_tokens:1000,messages:[{role:'user',content:p}]}}),
  parse:j=>Array.isArray(j.content)?j.content.filter(b=>b&&b.type==='text').map(b=>b.text).join('\n'):''},
 openai:{label:'OpenAI',key:env.OPENAI_API_KEY,model:env.OPENAI_MODEL||'gpt-4o-mini',url:base('OPENAI_BASE_URL','https://api.openai.com')+'/v1/chat/completions',
  build:(p,mod)=>({headers:{Authorization:'Bearer '+PROV.openai.key},body:{model:mod,max_completion_tokens:1000,messages:[{role:'user',content:p}]}}),
  parse:j=>(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||''}
};
const hits=new Map();let inflight=0;
const limited=ip=>{const now=Date.now(),a=(hits.get(ip)||[]).filter(t=>now-t<60000);if(a.length>=RATE){hits.set(ip,a);return true}a.push(now);hits.set(ip,a);return false};
setInterval(()=>{const n=Date.now();for(const[k,v]of hits)if(!v.some(t=>n-t<60000))hits.delete(k)},60000).unref();
const send=(res,code,obj,extra)=>{const b=JSON.stringify(obj);res.writeHead(code,{...SEC,'Content-Type':'application/json','Cache-Control':'no-store','Content-Length':Buffer.byteLength(b),...extra});res.end(b)};
const clientIp=req=>TRUST&&req.headers['x-forwarded-for']?String(req.headers['x-forwarded-for']).split(',')[0].trim():req.socket.remoteAddress;
const readBody=req=>new Promise((ok,no)=>{let n=0;const c=[];req.on('data',d=>{n+=d.length;if(n>MAX_BODY){if(n-d.length<=MAX_BODY)no(Object.assign(new Error('big'),{code:413}));return}c.push(d)});req.on('end',()=>ok(Buffer.concat(c).toString('utf8')));req.on('error',no)});
async function ask(req,res){
 const o=req.headers.origin;
 if(o){const ok=env.ALLOWED_ORIGIN?env.ALLOWED_ORIGIN.split(',').map(s=>s.trim()):['http://'+req.headers.host,'https://'+req.headers.host];if(!ok.includes(o))return send(res,403,{error:'Origin not allowed.'})}
 if(!/^application\/json/i.test(req.headers['content-type']||''))return send(res,415,{error:'Send JSON.'});
 if(limited(clientIp(req)))return send(res,429,{error:'Too many requests. Try again in a minute.'},{'Retry-After':'60'});
 if(inflight>=MAX_INFLIGHT)return send(res,503,{error:'Busy. Try again shortly.'});
 let j;try{j=JSON.parse(await readBody(req))}catch(e){if(e.code===413){res.on('finish',()=>req.destroy());return send(res,413,{error:'Request too large.'},{Connection:'close'})}return send(res,400,{error:'Invalid JSON.'})}
 if(!j||j.consent!==true)return send(res,400,{error:'Consent is required to send data to a provider.'});
 const p=typeof j.provider==='string'&&Object.prototype.hasOwnProperty.call(PROV,j.provider)?PROV[j.provider]:null;
 if(!p||!p.key)return send(res,400,{error:'Unknown or unconfigured provider.'});
 const prompt=typeof j.prompt==='string'?j.prompt.trim():'';
 if(!prompt||prompt.length>MAX_PROMPT)return send(res,400,{error:'Prompt must be 1 to '+MAX_PROMPT+' characters.'});
 const r=p.build(prompt,p.model),ac=new AbortController(),t=setTimeout(()=>ac.abort(),30000);inflight++;
 try{
  const up=await fetch(p.url,{method:'POST',headers:{'Content-Type':'application/json',...r.headers},body:JSON.stringify(r.body),signal:ac.signal});
  if(!up.ok){console.error('upstream status',j.provider,up.status);return send(res,502,{error:'The provider returned an error ('+up.status+').'})}
  const data=await up.json().catch(()=>({})),text=String(p.parse(data)||'').slice(0,20000);
  if(!text)return send(res,502,{error:'Empty answer from the provider.'});
  return send(res,200,{text,provider:p.label,model:p.model});
 }catch(e){return send(res,504,{error:'The provider did not respond in time.'})}
 finally{clearTimeout(t);inflight--}
}
http.createServer(async(req,res)=>{
 try{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname==='/api/status'){if(req.method!=='GET')return send(res,405,{error:'Method not allowed.'});return send(res,200,{providers:Object.entries(PROV).filter(([,p])=>p.key).map(([id,p])=>({id,label:p.label,model:p.model})),maxPromptChars:MAX_PROMPT})}
  if(u.pathname==='/api/ask'){if(req.method!=='POST')return send(res,405,{error:'Method not allowed.'});return await ask(req,res)}
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,SEC);return res.end()}
  const f=Object.prototype.hasOwnProperty.call(FILES,u.pathname)?FILES[u.pathname]:null;
  if(!f){res.writeHead(404,{...SEC,'Content-Type':'text/plain'});return res.end('Not found')}
  const h={...SEC,'Content-Type':TYPES[path.extname(f)],'Cache-Control':f==='sw.js'?'no-cache':'no-store'};
  if(TRUST&&req.headers['x-forwarded-proto']==='https')h['Strict-Transport-Security']='max-age=63072000; includeSubDomains';
  fs.readFile(path.join(__dirname,f),(e,b)=>{if(e){res.writeHead(500,SEC);return res.end('Error')}res.writeHead(200,h);res.end(req.method==='HEAD'?undefined:b)});
 }catch(e){try{send(res,500,{error:'Server error.'})}catch(x){}}
}).listen(PORT,HOST,()=>{const on=Object.entries(PROV).filter(([,p])=>p.key).map(([id])=>id);console.log(`NEXORA on http://${HOST}:${PORT} | providers: ${on.join(', ')||'none (live AI stays off)'}`)});
