/* ════════════════════════════════════════════════════════════════════
   js/counsellor-ui.js
   AI Counsellor page UI — particles, staggered reveal, waveform typing,
   context chip, reactions, copy, markdown renderer, report panel.
   Extracted from inline <script> in index.html.
   Reads CSRF + APP_TOKEN from <meta> tags injected server-side.
════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════
   AI COUNSELLOR v4 — full UI logic
   Particles · Staggered reveal · Waveform typing
   Context chip · Mobile chips · Reactions · Copy · Markdown
══════════════════════════════════════════════════════════ */
(function(){
'use strict';

/* ── Particles ── */
function _ncParticles(){
  var cv=document.getElementById('nc-particles'); if(!cv) return;
  var ctx=cv.getContext('2d'), W, H, pts=[];
  function resize(){ W=cv.width=cv.offsetWidth; H=cv.height=cv.offsetHeight; }
  resize(); window.addEventListener('resize',resize);
  for(var i=0;i<55;i++) pts.push({x:Math.random()*1400,y:Math.random()*900,vx:(Math.random()-.5)*.2,vy:(Math.random()-.5)*.2,r:Math.random()*1.4+.3,a:Math.random()*.5+.12});
  var raf;
  function draw(){
    ctx.clearRect(0,0,W,H);
    pts.forEach(function(p){ p.x+=p.vx; p.y+=p.vy; if(p.x<0)p.x=W; if(p.x>W)p.x=0; if(p.y<0)p.y=H; if(p.y>H)p.y=0; ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2); ctx.fillStyle='rgba(139,92,246,'+p.a+')'; ctx.fill(); });
    for(var i=0;i<pts.length;i++) for(var j=i+1;j<pts.length;j++){ var dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy); if(d<82){ ctx.beginPath(); ctx.moveTo(pts[i].x,pts[i].y); ctx.lineTo(pts[j].x,pts[j].y); ctx.strokeStyle='rgba(139,92,246,'+(0.065*(1-d/82))+')'; ctx.lineWidth=.5; ctx.stroke(); } }
    raf=requestAnimationFrame(draw);
  }
  draw();
  var ob=new MutationObserver(function(){ var lk=document.getElementById('acp-lock'); if(lk&&lk.style.display==='none') cancelAnimationFrame(raf); });
  var lk=document.getElementById('acp-lock'); if(lk) ob.observe(lk,{attributes:true,attributeFilter:['style']});
}

/* ── Staggered welcome reveal ── */
function _ncReveal(){
  document.querySelectorAll('.nc-reveal').forEach(function(el){
    el.style.animationPlayState='running';
  });
}

/* ── Waveform typing — 5 bars ── */
window._acAddTyping=function(containerId){
  var el=document.getElementById(containerId); if(!el) return null;
  var id='ac-typing-'+Date.now();
  var wrap=document.createElement('div'); wrap.className='ac-msg ac-msg-assistant'; wrap.id=id;
  wrap.innerHTML='<div class="acp-msg-av">✦</div><div class="ac-bubble ac-typing"><span></span><span></span><span></span><span></span><span></span></div>';
  el.appendChild(wrap); el.scrollTop=el.scrollHeight; return id;
};

/* ── Context chip ── */
function _ncSetCtxChip(text){
  var chip=document.getElementById('nc-ctx-chip'); if(!chip) return;
  chip.textContent=text; chip.style.display='flex';
}

/* ── Follow-up chips ── */
var _bank={
  career:['Which colleges offer this?','What entrance exams apply?','What does it pay?','Skills to build now?','What does a typical day look like?','How competitive is this field?','What if I change my mind later?','Any internships I should try?','What is the growth path over 10 years?','Which subjects matter most for this?'],
  stream:['What subjects are compulsory?','Can I switch later?','Better for entrepreneurs?','Will it limit options?','How hard is the workload?','What do toppers in this stream do after?','Is this stream right for my scores?','What electives should I pick?'],
  aptitude:['How do I improve weak areas?','What careers use this?','How does it compare to average?','Should I be worried about this score?','What does this mean for my stream choice?','How can I build on my strengths?'],
  scholarship:['How do I apply?','What documents do I need?','What is the income limit?','Are there state-specific options?','When are the deadlines?','Do grades affect eligibility?'],
  wellbeing:['How do I handle exam stress?','Best study technique for me?','Daily routine tips?','How do I talk to my parents about this?','What if I feel behind my friends?','How do I stay motivated?'],
  default:['Tell me more','Give me examples','What should I do next?','How does this link to my scores?','Can you explain that differently?','What should I focus on this month?']
};
var _ncLastChips=[];
function _ncGetChips(t){
  t=t.toLowerCase();
  if(t.includes('career')||t.includes('job')||t.includes('profession')) return _bank.career;
  if(t.includes('stream')||t.includes('science')||t.includes('commerce')||t.includes('arts')) return _bank.stream;
  if(t.includes('aptitude')||t.includes('stanine')||t.includes('score')) return _bank.aptitude;
  if(t.includes('scholarship')||t.includes('funding')) return _bank.scholarship;
  if(t.includes('stress')||t.includes('wellbeing')||t.includes('mental')) return _bank.wellbeing;
  return _bank.default;
}
function _ncShowChips(content){
  var row=document.getElementById('nc-chip-row'); if(!row) return;
  row.innerHTML='';
  var pool=_ncGetChips(content);
  /* exclude chips shown last turn so the set actually feels fresh, unless pool is too small to allow it */
  var fresh=pool.filter(function(q){return _ncLastChips.indexOf(q)===-1;});
  var usable=(fresh.length>=3)?fresh:pool;
  var picks=usable.slice().sort(function(){return Math.random()-.5;}).slice(0,3);
  _ncLastChips=picks;
  picks.forEach(function(q){
    var b=document.createElement('button'); b.className='nc-chip'; b.textContent=q;
    b.addEventListener('click',function(){ _ncHideChips(); var inp=document.getElementById('acp-input'); if(inp){inp.value=q; _acResizeTextarea(inp);} if(typeof window.acSend==='function') window.acSend(); });
    row.appendChild(b);
  });
  row.style.display='flex';
}
function _ncHideChips(){ var row=document.getElementById('nc-chip-row'); if(row){row.innerHTML=''; row.style.display='none';} }

/* ── Scroll pin ── */
window._ncScrollBottom=function(){ var el=document.getElementById('acp-messages'); if(el) el.scrollTo({top:el.scrollHeight,behavior:'smooth'}); var pin=document.getElementById('nc-scroll-pin'); if(pin) pin.style.display='none'; };
function _ncWireScroll(){
  var msgs=document.getElementById('acp-messages'), pin=document.getElementById('nc-scroll-pin');
  if(!msgs||!pin) return;
  msgs.addEventListener('scroll',function(){ pin.style.display=(msgs.scrollHeight-msgs.scrollTop-msgs.clientHeight>160)?'flex':'none'; });
}

/* ── Char counter ── */
window._ncCount=function(el){
  var cc=document.getElementById('nc-cc'); if(!cc) return;
  var n=el.value.length,max=4000;
  cc.textContent=n?(n+'/'+max):'';
  cc.className='nc-cc'+(n>3800?' nc-danger':n>3500?' nc-warn':'');
};

/* ── Markdown renderer ── */
function _ncNormalize(text){
  return String(text||'')
    /* break inline numbered items "...sentence. 1. **Foo**: bar 2. **Baz**: qux" onto their own lines */
    .replace(/([^\n])\s+(\d+\.\s+\*\*)/g,'$1\n$2')
    .replace(/([^\n])\s+(\d+\.\s+(?=[A-Z]))/g,'$1\n$2')
    /* break inline bullet items "...sentence. - **Foo**: bar - **Baz**: qux" onto their own lines */
    .replace(/([^\n])\s+([\-\*\•]\s+\*\*)/g,'$1\n$2');
}
function _ncMd(text){
  text=_ncNormalize(text);
  function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function il(s){
    return s
      .replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.+?)\*/g,'<em>$1</em>')
      .replace(/`([^`]+)`/g,'<code>$1</code>')
      .replace(/~~(.+?)~~/g,'<del>$1</del>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  var lines=text.split('\n'),out=[],i=0;
  while(i<lines.length){
    var ln=lines[i];
    var hm=ln.match(/^(#{1,3}) (.+)/);
    if(hm){out.push('<h'+hm[1].length+'>'+il(esc(hm[2]))+'</h'+hm[1].length+'>');i++;continue;}
    if(/^---+$/.test(ln.trim())){out.push('<hr>');i++;continue;}
    if(/^```/.test(ln)){var lang=ln.slice(3).trim(),code=[];i++;while(i<lines.length&&!/^```/.test(lines[i])){code.push(esc(lines[i]));i++;}i++;out.push('<pre><code'+(lang?' class="lang-'+lang+'"':'')+'>'+code.join('\n')+'</code></pre>');continue;}
    if(/^> /.test(ln)){var bq=[];while(i<lines.length&&/^> /.test(lines[i])){bq.push(il(esc(lines[i].slice(2))));i++;}out.push('<blockquote>'+bq.join('<br>')+'</blockquote>');continue;}
    if(/\|/.test(ln)&&i+1<lines.length&&/^\|?[-|: ]+\|?$/.test(lines[i+1])){
      var th=ln.split('|').filter(function(c,x,a){return x>0&&x<a.length-1||c.trim();}).map(function(c){return'<th>'+il(esc(c.trim()))+'</th>';});
      i+=2;var rows=[];
      while(i<lines.length&&/\|/.test(lines[i])){var td=lines[i].split('|').filter(function(c,x,a){return x>0&&x<a.length-1||c.trim();}).map(function(c){return'<td>'+il(esc(c.trim()))+'</td>';});rows.push('<tr>'+td.join('')+'</tr>');i++;}
      out.push('<table><thead><tr>'+th.join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table>');continue;
    }
    if(/^[\-\*\•] /.test(ln.trim())){var ul=[];while(i<lines.length&&/^[\-\*\•] /.test(lines[i].trim())){ul.push('<li>'+il(esc(lines[i].trim().replace(/^[\-\*\•] /,'')))+' </li>');i++;}out.push('<ul>'+ul.join('')+'</ul>');continue;}
    if(/^\d+\. /.test(ln.trim())){var ol=[];while(i<lines.length&&/^\d+\. /.test(lines[i].trim())){ol.push('<li>'+il(esc(lines[i].trim().replace(/^\d+\. /,'')))+' </li>');i++;}out.push('<ol>'+ol.join('')+'</ol>');continue;}
    if(!ln.trim()){i++;continue;}
    var para=[];
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,3} |---+|```|> |\d+\. |[\-\*\•] )/.test(lines[i])&&!/\|/.test(lines[i])){para.push(il(esc(lines[i])));i++;}
    if(para.length) out.push('<p>'+para.join('<br>')+'</p>');
  }
  return out.join('');
}
window._acRenderMarkdown=function(text){
  var d=document.createDocumentFragment(), w=document.createElement('div');
  w.innerHTML=_ncMd(String(text||'')); d.appendChild(w); return d;
};

/* ── Append message ── */
function _appendMsg(role,content,reactions){
  var el=document.getElementById('acp-messages'); if(!el) return null;
  var wrap=document.createElement('div'); wrap.className='ac-msg ac-msg-'+role;
  var av=document.createElement('div'); av.className='acp-msg-av';
  av.textContent=role==='assistant'?'✦':((window._AC&&window._AC.name)?window._AC.name.charAt(0).toUpperCase():'U');
  var bubble=document.createElement('div'); bubble.className='ac-bubble';
  if(role==='assistant') bubble.appendChild(window._acRenderMarkdown(content));
  else bubble.textContent=content;
  wrap.appendChild(av); wrap.appendChild(bubble);
  if(role==='assistant'&&reactions!==false){
    var rx=document.createElement('div'); rx.className='nc-rx';
    [['👍','Like'],['💡','Insightful'],['🔖','Save'],['📋','Copy']].forEach(function(p){
      var b=document.createElement('button'); b.className='nc-rx-btn'; b.title=p[1]; b.textContent=p[0];
      b.addEventListener('click',function(){
        if(p[1]==='Copy'){navigator.clipboard&&navigator.clipboard.writeText(content); b.textContent='✓'; setTimeout(function(){b.textContent='📋';},1600);}
        else b.classList.toggle('nc-on');
      });
      rx.appendChild(b);
    });
    wrap.appendChild(rx);
  }
  el.appendChild(wrap); el.scrollTop=el.scrollHeight;
  return{element:wrap,bubble:bubble,
    setContent:function(t){bubble.innerHTML='';bubble.appendChild(window._acRenderMarkdown(t));el.scrollTop=el.scrollHeight;},
    setStreamingContent:function(t){bubble.innerHTML='';bubble.appendChild(window._acRenderMarkdown(t));bubble.classList.add('ac-streaming');el.scrollTop=el.scrollHeight;},
    addClass:function(c){bubble.classList.add(c);},
    remove:function(){wrap.remove();},
    classList:{remove:function(c){bubble.classList.remove(c);}}
  };
}
window._acAppendMessage=function(role,content,reactions){ return _appendMsg(role,content,reactions!==false); };

/* ── Sessions ── */
var _sessions=[],_activeSess=null;

/* Build the counsellor-session token header (same source as _acHeaders in ai-counsellor.js) */
function _ncCtok(){
  try{
    return (window._AC && window._AC.counsellorToken) || (typeof localStorage!=='undefined' && localStorage.getItem('nmind_ac_ctok')) || '';
  }catch(_){ return ''; }
}

/* Load conversations from server and populate sidebar */
async function _loadConversationsFromServer(email){
  try{
    var _csrfM=document.querySelector('meta[name="csrf-token"]');
    var _appM=document.querySelector('meta[name="app-token"]');
    var h={'Content-Type':'application/json'};
    var _tok=_appM?(_appM.getAttribute('content')||''):(window._APP_TOKEN||'');
    if(_tok)h['X-App-Token']=_tok;
    if(_csrfM)h['X-CSRF-Token']=_csrfM.getAttribute('content')||'';
    var _ctok=_ncCtok(); if(_ctok)h['X-Counsellor-Token']=_ctok;
    var res=await fetch('/api/counsellor-conversations?email='+encodeURIComponent(email),{headers:h});
    if(!res.ok) return;
    var data=await res.json();
    var convs=data.conversations||[];
    _sessions=[];
    convs.forEach(function(c){
      _sessions.push({
        id:       c.conversation_id,
        title:    c.title||'Conversation',
        messages: [],           // loaded lazily on click
        ts:       new Date(c.last_at||0).getTime()||Date.now(),
        loaded:   false,
        serverConv: true,
        messageCount: c.message_count||0,
      });
    });
    _renderSessList();
  }catch(e){ console.warn('[AC] loadConversations failed:',e.message); }
}

/* Load messages for a specific conversation from server */
async function _loadConvMessages(email, convId){
  try{
    var _csrfM=document.querySelector('meta[name="csrf-token"]');
    var _appM=document.querySelector('meta[name="app-token"]');
    var h={'Content-Type':'application/json'};
    var _tok=_appM?(_appM.getAttribute('content')||''):(window._APP_TOKEN||'');
    if(_tok)h['X-App-Token']=_tok;
    if(_csrfM)h['X-CSRF-Token']=_csrfM.getAttribute('content')||'';
    var _ctok=_ncCtok(); if(_ctok)h['X-Counsellor-Token']=_ctok;
    var res=await fetch('/api/counsellor-history?email='+encodeURIComponent(email)+'&conversationId='+encodeURIComponent(convId),{headers:h});
    if(!res.ok) return [];
    var data=await res.json();
    return (data.messages||[]).map(function(m){return{role:m.role,content:m.content};});
  }catch(e){ return []; }
}

function _initSession(name, messages, existingConvId){
  /* If an existing conversation already loaded — don't duplicate it */
  if(existingConvId){
    var existing=_sessions.find(function(s){return s.id===existingConvId;});
    if(existing){ _activeSess=existing; existing.messages=messages||[]; _renderSessList(); return; }
  }
  var first=(messages||[]).find(function(m){return m.role==='user';});
  var title=first?first.content.substring(0,42)+(first.content.length>42?'…':''):'New conversation';
  var convId=existingConvId||((function(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');})());
  var s={id:convId,title:title,messages:messages||[],ts:Date.now(),loaded:true,serverConv:false};
  _sessions.unshift(s); _activeSess=s; _renderSessList();
}

window._acNewChat=function(){
  /* Generate a fresh conversation ID so server can group these messages */
  var convId=(function(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');})();
  var s={id:convId,title:'New conversation',messages:[],ts:Date.now(),loaded:true,serverConv:false};
  _sessions.unshift(s); _activeSess=s;
  if(window._AC){ window._AC.messages=[]; window._AC.conversationId=convId; }
  _renderSessList(); _resetUI(); _ncHideChips(); _acCloseSidebar();
  /* Fire greeting for new conversation */
  _fireGreeting(convId);
};

/* Fire AI greeting for a new conversation */
async function _fireGreeting(convId){
  var AC=window._AC; if(!AC||!AC.email||!AC.unlocked) return;
  var msgs=document.getElementById('acp-messages');
  var welc=document.getElementById('acp-welcome');
  try{
    var _csrfM=document.querySelector('meta[name="csrf-token"]');
    var _appM=document.querySelector('meta[name="app-token"]');
    var h={'Content-Type':'application/json'};
    var _tok=_appM?(_appM.getAttribute('content')||''):(window._APP_TOKEN||'');
    if(_tok)h['X-App-Token']=_tok;
    if(_csrfM)h['X-CSRF-Token']=_csrfM.getAttribute('content')||'';
    var _ctok=_ncCtok(); if(_ctok)h['X-Counsellor-Token']=_ctok;
    var res=await fetch('/api/counsellor-greeting',{
      method:'POST',headers:h,
      body:JSON.stringify({email:AC.email,conversationId:convId})
    });
    if(!res.ok) return;
    /* Show chat area, hide welcome */
    if(welc) welc.style.display='none';
    if(msgs){ msgs.style.display='flex'; }
    var reader=res.body.getReader(), dec=new TextDecoder(), fullText='';
    var msgEl=window._acAppendMessage('assistant','','acp-messages');
    if(msgEl&&msgEl.setStreamingContent) msgEl.setStreamingContent('');
    while(true){
      var chunk=await reader.read(); if(chunk.done) break;
      fullText+=dec.decode(chunk.value,{stream:true});
      if(msgEl&&msgEl.setStreamingContent) msgEl.setStreamingContent(fullText);
    }
    if(msgEl&&msgEl.classList) msgEl.classList.remove('ac-streaming');
    if(fullText.trim()){
      AC.messages.push({role:'assistant',content:fullText});
      if(_activeSess&&_activeSess.id===convId) _activeSess.messages=AC.messages.slice();
    }
  }catch(e){ console.warn('[AC] greeting failed:',e.message); }
}
function _resetUI(){
  var msgs=document.getElementById('acp-messages'),welc=document.getElementById('acp-welcome');
  if(msgs){msgs.innerHTML='';msgs.style.display='none';}
  if(welc){welc.style.display='';_ncReveal();}
  var pin=document.getElementById('nc-scroll-pin'); if(pin) pin.style.display='none';
}
function _renderSessList(){
  var list=document.getElementById('acp-sess-list'),label=document.getElementById('acp-sess-label');
  if(!list) return; list.innerHTML='';
  if(!_sessions.length){if(label)label.style.display='none';return;}
  if(label) label.style.display='';
  _sessions.forEach(function(s){
    var el=document.createElement('div'); el.className='acp-sess-item'+(s===_activeSess?' active':'');
    el.innerHTML='<div class="acp-sess-item-icon"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div><div style="flex:1;min-width:0"><div class="acp-sess-item-title">'+_esc(s.title)+'</div><div class="acp-sess-item-meta">'+_relTime(s.ts)+'</div></div>';
    (function(sess){
      el.addEventListener('click',async function(){
        _activeSess=sess; _renderSessList(); _acCloseSidebar();
        /* Load messages lazily from server if not already loaded */
        if(sess.serverConv&&!sess.loaded){
          var AC=window._AC; if(!AC||!AC.email) return;
          var loaded=await _loadConvMessages(AC.email,sess.id);
          sess.messages=loaded; sess.loaded=true;
          if(AC) AC.conversationId=sess.id;
        }
        if(window._AC){ window._AC.messages=sess.messages.slice(); window._AC.conversationId=sess.id; }
        _loadSession(sess);
      });
    })(s);
    list.appendChild(el);
  });
}
function _loadSession(s){
  var msgs=document.getElementById('acp-messages'),welc=document.getElementById('acp-welcome');
  _ncHideChips(); if(!msgs) return; msgs.innerHTML='';
  if(!s.messages||!s.messages.length){msgs.style.display='none';if(welc){welc.style.display='';_ncReveal();}return;}
  if(welc) welc.style.display='none'; msgs.style.display='flex';
  s.messages.forEach(function(m){_appendMsg(m.role,m.content,false);});
  setTimeout(function(){msgs.scrollTop=msgs.scrollHeight;},10);
}
function _esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function _relTime(ts){var d=Date.now()-ts;if(d<60000)return'Just now';if(d<3600000)return Math.floor(d/60000)+'m ago';if(d<86400000)return Math.floor(d/3600000)+'h ago';return new Date(ts).toLocaleDateString();}

/* ── Sidebar ── */
window._acOpenSidebar=function(){var sb=document.getElementById('acp-sidebar'),ov=document.getElementById('nc-overlay');if(sb)sb.classList.add('open');if(ov)ov.classList.add('open');};
window._acCloseSidebar=function(){var sb=document.getElementById('acp-sidebar'),ov=document.getElementById('nc-overlay');if(sb)sb.classList.remove('open');if(ov)ov.classList.remove('open');};

/* ── Quick start ── */
window._acQuickStart=function(btn){
  var q=btn.getAttribute('data-q'); if(!q) return;
  var inp=document.getElementById('acp-input');
  if(inp){inp.value=q;if(typeof _acResizeTextarea==='function')_acResizeTextarea(inp);}
  var welc=document.getElementById('acp-welcome'),msgs=document.getElementById('acp-messages');
  if(welc)welc.style.display='none'; if(msgs)msgs.style.display='flex';
  if(typeof acSend==='function') acSend();
};

/* ── localStorage ── */
var KEY='nmind_ac_s4';
function _save(e,n){try{localStorage.setItem(KEY,JSON.stringify({email:e,name:n}));}catch(_){}}
function _load(){try{return JSON.parse(localStorage.getItem(KEY)||'null');}catch(_){return null;}}
function _clear(){try{localStorage.removeItem(KEY);}catch(_){}}

/* ── Apply unlocked UI ── */
function _applyUnlocked(name,messages){
  /* topbar */
  var sub=document.getElementById('acp-topbar-sub'),chip=document.getElementById('acp-report-chip'),mid=document.getElementById('acp-mobile-id'),uname=document.getElementById('acp-user-name');
  if(sub) sub.textContent='Chatting as '+name;
  if(chip) chip.style.display='flex';
  if(mid){mid.textContent=name;mid.style.display='flex';}
  if(uname) uname.textContent=name;

  /* back btn */
  var bb=document.getElementById('acp-back-btn'),sbl=document.getElementById('acp-sb-back-label');
  var S=window.S,hr=S&&S.cpi&&S.cpi.scores!==null&&S.nmap&&S.nmap.scores!==null;
  var arrSvg='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>';
  if(bb) bb.innerHTML=arrSvg+(hr?' View Report':' Home');
  if(sbl) sbl.textContent=hr?'Back to report':'Back to home';

  /* context chip — NuMind-specific top trait */
  (function(){
    var AC=window._AC,_S=window.S;
    function e2(s){return String(s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
    var trait=null;
    if(_S&&_S.nmap&&_S.nmap.scores){try{var en=Object.entries(_S.nmap.scores).sort(function(a,b){return b[1]-a[1];});if(en.length)trait=en[0][0];}catch(_){}}
    if(!trait&&AC&&AC.reportSummary&&AC.reportSummary.top_personality_traits&&AC.reportSummary.top_personality_traits.length) trait=AC.reportSummary.top_personality_traits[0].name;
    if(trait) _ncSetCtxChip(e2(trait));
  })();

  /* report strip */
  (function(){
    var strip=document.getElementById('acp-report-strip'); if(!strip) return;
    var chips=[],AC=window._AC,_S=window.S;
    function es(s){return String(s||'').replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
    if(_S&&_S.cpi&&_S.cpi.scores){try{var ec=Object.entries(_S.cpi.scores).sort(function(a,b){return b[1]-a[1];});if(ec.length)chips.push('Top interest: '+es(ec[0][0]));}catch(_){}}
    if(_S&&_S.nmap&&_S.nmap.scores){try{var en2=Object.entries(_S.nmap.scores).sort(function(a,b){return b[1]-a[1];});if(en2.length)chips.push('Strongest: '+es(en2[0][0]));}catch(_){}}
    if(!chips.length&&AC&&AC.reportSummary){try{var rs=AC.reportSummary;if(rs.top3_interests&&rs.top3_interests.length)chips.push('Top interest: '+es(rs.top3_interests[0].label));if(rs.top_personality_traits&&rs.top_personality_traits.length)chips.push('Strongest: '+es(rs.top_personality_traits[0].name));if(rs.fit_tier)chips.push(es(rs.fit_tier));}catch(_){}}
    if(chips.length){strip.innerHTML=chips.map(function(c){return'<span>'+c+'</span>';}).join('');strip.style.display='flex';}
  })();

  /* sidebar */
  var card=document.getElementById('acp-user-card'),av=document.getElementById('acp-sb-av'),nm=document.getElementById('acp-sb-name'),clr=document.getElementById('acp-sb-clear');
  if(card)card.style.display='';if(av)av.textContent=name.charAt(0).toUpperCase();if(nm)nm.textContent=name;if(clr)clr.style.display='';

  /* show chat */
  _initSession(name,messages||[]);
  _loadSession(_activeSess);
  var chat=document.getElementById('acp-chat'),lock=document.getElementById('acp-lock');
  if(lock)lock.style.display='none';
  if(chat)chat.style.cssText='display:flex!important;flex:1;flex-direction:column;min-height:0';
}
window._acSetPageView=function(view){
  var lock=document.getElementById('acp-lock'),chat=document.getElementById('acp-chat');
  if(lock)lock.style.display=view==='lock'?'':'none';
  if(chat){if(view==='chat'){chat.style.cssText='display:flex!important;flex:1;flex-direction:column;min-height:0';}else{chat.style.display='none';}}
};

/* ── _acWhenReady ── */
function _acWhenReady(cb){
  var dead=Date.now()+5000;
  (function poll(){if(typeof window.acUnlock==='function'&&window._AC){cb();return;}if(Date.now()>dead){console.warn('[AC] module not loaded');return;}setTimeout(poll,20);})();
}
_acWhenReady(function(){

  /* Post-unlock UI: _acApplySession() (ai-counsellor.js) finalizes every
     successful unlock path (email, PIN, OTP, first-time set-pin) and
     dispatches 'ac:unlocked'. Listening for that event here dismisses the
     lock screen for all paths in one place — do not hook individual flows. */
  var _unlockUiHandled = false; // guards against double-fire (e.g. same event re-dispatched)

  document.addEventListener('ac:unlocked', async function(){
    if (_unlockUiHandled) return;
    var AC = window._AC; if (!AC || !AC.unlocked) return;
    _unlockUiHandled = true;
    try {
      _save(AC.email, AC.name||'Student');
      /* Build sessions from server conversations */
      var convs=(typeof AC._serverConvs!=='undefined')?AC._serverConvs:[];
      _sessions=[];
      (convs||[]).forEach(function(c){
        _sessions.push({id:c.conversation_id,title:c.title||'Conversation',messages:[],ts:new Date(c.last_at||0).getTime()||Date.now(),loaded:false,serverConv:true,messageCount:c.message_count||0});
      });
      var msgs=AC.messages||[];
      /* Create active session */
      var convId=(function(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');})();
      if(msgs.length>0){
        /* Returning user with history — show most recent conversation */
        var latestConv=convs&&convs[0];
        if(latestConv){
          /* Load latest conversation messages */
          var latestMsgs=await _loadConvMessages(AC.email,latestConv.conversation_id);
          var s=_sessions[0]; s.messages=latestMsgs; s.loaded=true;
          _activeSess=s; AC.messages=latestMsgs; AC.conversationId=latestConv.conversation_id;
          _applyUnlocked(AC.name||'Student',latestMsgs);
        } else {
          /* Has history but no conversation_id grouping (legacy) — show flat */
          var s={id:convId,title:(msgs.find(function(m){return m.role==='user';})||{}).content||'Conversation',messages:msgs,ts:Date.now(),loaded:true};
          _sessions.unshift(s); _activeSess=s; AC.conversationId=convId;
          _applyUnlocked(AC.name||'Student',msgs);
        }
        _renderSessList();
      } else {
        /* First-time user — new conversation with AI greeting */
        AC.conversationId=convId;
        var s={id:convId,title:'New conversation',messages:[],ts:Date.now(),loaded:true,serverConv:false};
        _sessions.unshift(s); _activeSess=s;
        _applyUnlocked(AC.name||'Student',[]);
        _renderSessList();
        _fireGreeting(convId);
      }
    } finally {
      _unlockUiHandled = false; // ready for the next login (e.g. after logout)
    }
  });

  /* patch send */
  var os=window.acSend;
  window.acSend=async function(){
    var welc=document.getElementById('acp-welcome'),msgs=document.getElementById('acp-messages');
    if(welc)welc.style.display='none'; if(msgs)msgs.style.display='flex';
    _ncHideChips();
    var pin=document.getElementById('nc-scroll-pin'); if(pin)pin.style.display='none';
    /* ensure conversationId is set on _AC before send */
    var AC=window._AC;
    if(AC&&!AC.conversationId&&_activeSess) AC.conversationId=_activeSess.id;
    await os();
    var AC=window._AC;
    if(_activeSess&&_activeSess.title==='New conversation'&&AC&&AC.messages.length){
      var first=AC.messages.find(function(m){return m.role==='user';});
      if(first){_activeSess.title=first.content.substring(0,38)+(first.content.length>38?'…':'');_activeSess.messages=AC.messages.slice();_renderSessList();}
    }
    var last=AC&&AC.messages[AC.messages.length-1];
    if(last&&last.role==='assistant') _ncShowChips(last.content);
  };

  /* patch clear */
  var oc=window.acClearHistory;
  window.acClearHistory=async function(){await oc();if(window._AC&&!window._AC.messages.length)_clear();_ncHideChips();};

  /* auto-restore */
  var stored=_load();
  if(stored&&stored.email){
    (async function(){
      try{
        var _csrfM=document.querySelector('meta[name="csrf-token"]');
    var _appM=document.querySelector('meta[name="app-token"]');
    var h={'Content-Type':'application/json'};
    var _tok=_appM?(_appM.getAttribute('content')||''):(window._APP_TOKEN||'');
    if(_tok)h['X-App-Token']=_tok;
    if(_csrfM)h['X-CSRF-Token']=_csrfM.getAttribute('content')||'';
        var res=await fetch('/api/counsellor-unlock',{method:'POST',headers:h,body:JSON.stringify({email:stored.email})});
        if(!res.ok){_clear();return;}
        var data=await res.json(); if(!data.unlocked){_clear();return;}
        var AC=window._AC; if(!AC) return;
        AC.email=stored.email; AC.name=data.name||stored.name||'Student';
        AC.unlocked=true; AC.messages=(data.history||[]).map(function(h){return{role:h.role,content:h.content};});
        AC.reportSummary=data.reportSummary||null;
        AC._serverConvs=data.conversations||[];
        /* Build sessions from server */
        _sessions=[];
        (data.conversations||[]).forEach(function(c){
          _sessions.push({id:c.conversation_id,title:c.title||'Conversation',messages:[],ts:new Date(c.last_at||0).getTime()||Date.now(),loaded:false,serverConv:true,messageCount:c.message_count||0});
        });
        var msgs=AC.messages||[];
        var latestConv=(data.conversations||[])[0];
        if(latestConv){
          var s=_sessions[0]; s.messages=msgs; s.loaded=true;
          _activeSess=s; AC.conversationId=latestConv.conversation_id;
          _applyUnlocked(AC.name,msgs);
          _renderSessList();
        } else if(msgs.length>0){
          var convId=(function(){var a=new Uint8Array(16);crypto.getRandomValues(a);return Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');})();
          var s={id:convId,title:(msgs.find(function(m){return m.role==='user';})||{}).content||'Conversation',messages:msgs,ts:Date.now(),loaded:true};
          _sessions.unshift(s); _activeSess=s; AC.conversationId=convId;
          _applyUnlocked(AC.name,msgs); _renderSessList();
        } else {
          _applyUnlocked(AC.name,[]);
        }
        /* resume toast */
        (function(){
          if(document.getElementById('ac-resume-chip')) return;
          var cp=document.getElementById('page-counsellor'); if(cp&&cp.classList.contains('active')) return;
          var chip=document.createElement('div'); chip.id='ac-resume-chip';
          chip.style.cssText='position:fixed;bottom:24px;right:24px;z-index:9000;background:linear-gradient(135deg,#0b4650,#157d8c);color:rgba(255,255,255,0.94);border:1px solid rgba(255,255,255,0.18);border-radius:12px;padding:11px 14px 11px 15px;font-family:Inter,system-ui,sans-serif;font-size:13px;font-weight:600;display:flex;align-items:center;gap:10px;box-shadow:0 10px 32px rgba(0,0,0,0.38);cursor:pointer';
          var inner=document.createElement('div'); inner.style.cssText='display:flex;align-items:center;gap:8px;flex:1';
          inner.innerHTML='<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" fill="#fbbf4d"/></svg> Resume AI Counsellor';
          inner.addEventListener('click',function(){chip.remove();if(typeof window.goPage==='function')window.goPage('counsellor');});
          var close=document.createElement('button'); close.innerHTML='&times;';
          close.style.cssText='background:rgba(255,255,255,.07);border:none;color:rgba(255,255,255,.45);width:22px;height:22px;border-radius:50%;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;padding:0;transition:background .12s';
          close.addEventListener('click',function(e){e.stopPropagation();chip.remove();});
          chip.appendChild(inner);chip.appendChild(close);document.body.appendChild(chip);
          setTimeout(function(){if(chip.parentNode)chip.remove();},9000);
        })();
      }catch(e){console.warn('[AC] auto-restore:',e.message);}
    })();
  }
});

/* ── DOM ready ── */
document.addEventListener('DOMContentLoaded',function(){
  _ncParticles();
  _ncWireScroll();
  /* trigger staggered reveal if welcome is visible */
  var welc=document.getElementById('acp-welcome');
  if(welc&&welc.style.display!=='none') _ncReveal();
});

})();
