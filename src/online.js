/* Painel de Cargas · modo online (Supabase)
   Projeto próprio no Supabase: contas, perfis, cargas, ocorrências e histórico só do Painel de Cargas.
   window.PAINEL_ONLINE.conectar() → {db, user, nome, perfil, master, ...}
   window.PAINEL_EXT → abas Histórico, Ocorrências e Cadastro (montadas dentro do painel). */
(function(){
"use strict";
const CFG=window.PAINEL_SUPABASE||{};
const CHAVE_CFG={"config/geral":"geral","meta/base":"meta_base"};
const PERFIL_NOME={master:"Administrador Master",admin:"Administrador",leitura:"Visualizador"};
const PERFIL_PODE={master:"Tudo: regras, perfis, cadastros, e-mails e código do time",admin:"Carregar base e WMS, mudar status e agenda, ocorrências",leitura:"Só visualiza, busca, baixa a base e copia o resumo"};
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const brA=s=>{if(!s)return "—";const [y,m,d]=String(s).slice(0,10).split("-");return d+"/"+m+"/"+y;};
const dtHora=s=>{if(!s)return "—";const d=new Date(s);return d.toLocaleDateString("pt-BR")+" "+d.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"});};
const hojeIso=()=>{const d=new Date();return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");};
const norm=s=>String(s==null?"":s).normalize("NFD").replace(/[̀-ͯ]/g,"").toUpperCase();
const API=()=>window.PAINEL_API||{};

function erroPerm(e){
  const c=e&&(e.code||"");
  if(c==="42501"||c==="PGRST301"||/row-level security|permission denied/i.test((e&&e.message)||"")) return {code:"invalid_argument",message:"Sem permissão"};
  return {code:"unavailable",message:(e&&e.message)||"Falha ao gravar"};
}

/* linha da tabela ↔ documento do painel */
function docDe(r){
  return {envio:r.envio||"",carga:r.carga,galpao:r.galpao||"",loja:r.loja||"",rot:r.rot||"",agenda:r.agenda||"",
    volume:(typeof r.volume==="number"?r.volume:null),pbr:(typeof r.pbr==="number"?r.pbr:null),chep:(typeof r.chep==="number"?r.chep:null),rfInfo:r.rf_info&&r.rf_info.em?r.rf_info:null,
    obs:r.obs||"",status:(typeof r.status==="number"?r.status:1),
    hist:Array.isArray(r.hist)?r.hist:[],criadoEm:r.criado_em||"",atualizadoEm:r.atualizado_em||"",atualizadoPor:r.atualizado_por||null};
}
const CAMPOS={envio:v=>String(v==null?"":v),carga:v=>String(v==null?"":v),galpao:v=>String(v==null?"":v),loja:v=>String(v==null?"":v),
  rot:v=>v?String(v).slice(0,10):null,agenda:v=>v?String(v).slice(0,10):null,
  volume:v=>(v===null||v===undefined||v==="")?null:(Number.isFinite(Number(v))?Math.round(Number(v)):null),
  pbr:v=>(v===null||v===undefined||v==="")?null:(Number.isFinite(Number(v))&&Number(v)>=0?Math.round(Number(v)):null),
  chep:v=>(v===null||v===undefined||v==="")?null:(Number.isFinite(Number(v))&&Number(v)>=0?Math.round(Number(v)):null),
  rfInfo:v=>v&&v.em?{em:String(v.em),...(v.dia&&/^\d{4}-\d{2}-\d{2}$/.test(v.dia)?{dia:v.dia}:{}),por:v.por||null,porNome:v.porNome||""}:null,
  obs:v=>String(v==null?"":v),status:v=>Number(v),hist:v=>Array.isArray(v)?v:[]};
function linhaDe(d,completa){
  const o={};
  Object.keys(CAMPOS).forEach(k=>{ if(Object.prototype.hasOwnProperty.call(d,k)) o[k]=CAMPOS[k](d[k]); else if(completa) o[k]=CAMPOS[k](k==="status"?1:undefined); });
  if("rfInfo" in o){o.rf_info=o.rfInfo;delete o.rfInfo;}
  return o;
}

/* ================= dados das cargas (mesma interface do painel) ================= */
function criarStore(sb){
  const cargas=new Map(), cfg=new Map();       // id → doc ; path → data
  const subsC=[], subsD={};
  let tEmit=null, pendDocs=new Set(), pendCol=false, prontoCargas=false, vivo=false;
  const snapDoc=p=>({id:p.split("/").pop(),exists:cfg.has(p),data:()=>cfg.get(p),metadata:{fromCache:false,hasPendingWrites:false}});
  const snapCol=()=>({docs:[...cargas.keys()].sort().map(id=>({id,exists:true,data:()=>cargas.get(id)})),metadata:{fromCache:!prontoCargas,hasPendingWrites:false}});
  const emitir=()=>{clearTimeout(tEmit);tEmit=setTimeout(()=>{
    if(pendCol){pendCol=false;const s=snapCol();subsC.forEach(f=>f(s));}
    const ps=[...pendDocs];pendDocs=new Set();ps.forEach(p=>(subsD[p]||[]).forEach(f=>f(snapDoc(p))));},30);};
  const porLinha=r=>{ if(r.arquivado_em){ if(cargas.delete(r.id)){pendCol=true;emitir();} return; } cargas.set(r.id,docDe(r));pendCol=true;emitir();};
  const porCfg=r=>{const p=Object.keys(CHAVE_CFG).find(k=>CHAVE_CFG[k]===r.chave);if(!p)return;cfg.set(p,r.valor||{});pendDocs.add(p);emitir();};

  async function carregarTudo(){
    const novos=new Map(); let de=0; const passo=1000;
    for(;;){
      const {data,error}=await sb.from("cargas").select("*").is("arquivado_em",null).order("id").range(de,de+passo-1);
      if(error) throw error;
      data.forEach(r=>novos.set(r.id,docDe(r)));
      if(data.length<passo) break; de+=passo;
    }
    cargas.clear(); novos.forEach((v,k)=>cargas.set(k,v)); prontoCargas=true; pendCol=true;
    const {data:cf,error:e2}=await sb.from("cargas_config").select("*").in("chave",["geral","meta_base"]);
    if(e2) throw e2;
    const vistos=new Set();
    (cf||[]).forEach(r=>{const p=Object.keys(CHAVE_CFG).find(k=>CHAVE_CFG[k]===r.chave);if(p){cfg.set(p,r.valor||{});vistos.add(p);}});
    Object.keys(CHAVE_CFG).forEach(p=>{if(!vistos.has(p))cfg.delete(p);pendDocs.add(p);});
    emitir();
  }
  let carregando=null;
  const recarregar=()=>{ if(!carregando) carregando=carregarTudo().catch(e=>{console.warn("[painel] recarregar",e);}).finally(()=>{carregando=null;}); return carregando; };

  /* tempo real: qualquer mudança feita por outra pessoa aparece na hora */
  let canalOk=false;
  sb.channel("painel-cargas")
    .on("postgres_changes",{event:"*",schema:"public",table:"cargas"},pl=>{
      if(pl.eventType==="DELETE"){const id=pl.old&&pl.old.id;if(id&&cargas.delete(id)){pendCol=true;emitir();}}
      else if(pl.new&&pl.new.id) porLinha(pl.new);})
    .on("postgres_changes",{event:"*",schema:"public",table:"cargas_config"},pl=>{
      if(pl.eventType==="DELETE"){const p=Object.keys(CHAVE_CFG).find(k=>CHAVE_CFG[k]===(pl.old&&pl.old.chave));if(p){cfg.delete(p);pendDocs.add(p);emitir();}}
      else if(pl.new) porCfg(pl.new);})
    .subscribe(st=>{ vivo=st==="SUBSCRIBED"; if(st==="SUBSCRIBED"){ if(canalOk) recarregar(); canalOk=true; } });
  let saiuEm=0;
  document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="hidden") saiuEm=Date.now(); else if(saiuEm&&Date.now()-saiuEm>60000) recarregar(); });

  const docCarga=id=>({id,path:"cargas/"+id,
    get:async()=>({id,exists:cargas.has(id),data:()=>cargas.get(id)}),
    set:async d=>{const linha={id,...linhaDe(d,true),arquivado_em:null};
      let {data,error}=await sb.from("cargas").upsert(linha,{onConflict:"id"}).select().single();
      if(error&&error.code==="23505"){ /* a carga já existe com outro id (ex.: arquivada): atualiza a existente */
        const {id:_,...resto}=linha;
        ({data,error}=await sb.from("cargas").update(resto).eq("carga",linha.carga).select().single());
      }
      if(error) throw erroPerm(error); porLinha(data);},
    update:async d=>{const linha=linhaDe(d,false); if(!Object.keys(linha).length) return;
      const {data,error}=await sb.from("cargas").update(linha).eq("id",id).select();
      if(error) throw erroPerm(error); if(!data||!data.length) throw {code:"invalid_argument",message:"Sem permissão ou carga inexistente"};
      porLinha(data[0]);},
    delete:async()=>{const {data,error}=await sb.from("cargas").delete().eq("id",id).select("id");
      if(error) throw erroPerm(error); if(!data||!data.length){ if(cargas.has(id)) throw {code:"invalid_argument",message:"Sem permissão"}; }
      if(cargas.delete(id)){pendCol=true;emitir();}},
    onSnapshot:fn=>{const f=()=>fn({id,exists:cargas.has(id),data:()=>cargas.get(id)});subsC.push(f);setTimeout(f);return ()=>{};}});
  const docCfg=p=>({id:p.split("/").pop(),path:p,
    get:async()=>snapDoc(p),
    set:async d=>{const {data,error}=await sb.from("cargas_config").upsert({chave:CHAVE_CFG[p],valor:d},{onConflict:"chave"}).select().single();
      if(error) throw erroPerm(error); porCfg(data);},
    update:async d=>{const atual=cfg.get(p)||{};const {data,error}=await sb.from("cargas_config").update({valor:{...atual,...d}}).eq("chave",CHAVE_CFG[p]).select();
      if(error) throw erroPerm(error); if(!data||!data.length) throw {code:"invalid_argument",message:"Sem permissão"}; porCfg(data[0]);},
    delete:async()=>{const {error}=await sb.from("cargas_config").delete().eq("chave",CHAVE_CFG[p]); if(error) throw erroPerm(error); cfg.delete(p);pendDocs.add(p);emitir();},
    onSnapshot:(fn,err)=>{(subsD[p]=subsD[p]||[]).push(fn);if(prontoCargas)setTimeout(()=>fn(snapDoc(p)));return ()=>{};}});
  const doc=p=>{ if(CHAVE_CFG[p]) return docCfg(p); if(p.startsWith("cargas/")) return docCarga(p.slice(7)); throw new Error("Caminho desconhecido: "+p); };
  const db={doc,collection:c=>{ if(c!=="cargas") throw new Error("Coleção desconhecida: "+c);
    return {path:c,doc:id=>docCarga(id),onSnapshot:(fn,err)=>{subsC.push(fn);
      if(prontoCargas) setTimeout(()=>fn(snapCol())); else recarregar().then(()=>{ if(!prontoCargas&&err) err(new Error("falha")); });
      return ()=>{};}}; }};
  return {db,recarregar,aoVivo:()=>vivo};
}

/* ================= contas: entrar, criar conta, esqueci a senha ================= */
async function contas(corpo,token){
  const h={"Content-Type":"application/json",apikey:CFG.chave}; if(token) h.Authorization="Bearer "+token;
  const r=await fetch(CFG.url+"/functions/v1/contas",{method:"POST",headers:h,body:JSON.stringify(corpo)});
  let j={}; try{j=await r.json();}catch(_){}
  if(!r.ok||j.erro) throw new Error(j.erro||"Não foi possível falar com o servidor. Tente de novo.");
  return j;
}
/* página de entrada: apresentação animada da operação + formulário */
const LOGO_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.8 20 7.3v9.4L12 21.2 4 16.7V7.3z"/><path d="M4 7.3l8 4.6 8-4.6M12 11.9v9.3"/><circle cx="12" cy="11.9" r="1.6" fill="currentColor"/></svg>';
const REDE_SVG=`<svg class="rede" viewBox="0 0 560 250" role="img" aria-label="Cargas saindo dos galpões G10 e G20, passando pela expedição e chegando ao Mercado Livre">
  <defs><radialGradient id="rg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#22d3ee" stop-opacity=".55"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></radialGradient>
  <linearGradient id="lg1" x1="0" x2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient><linearGradient id="lg2" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#4ade80"/></linearGradient></defs>
  <g class="grade">${Array.from({length:12},(_,i)=>`<line x1="${i*50}" y1="0" x2="${i*50}" y2="250"/>`).join("")}${Array.from({length:6},(_,i)=>`<line x1="0" y1="${i*50}" x2="560" y2="${i*50}"/>`).join("")}</g>
  <path id="r1" class="rota" d="M70 62 C 160 62, 180 125, 280 125" stroke="url(#lg1)"/>
  <path id="r2" class="rota" d="M70 188 C 160 188, 180 125, 280 125" stroke="url(#lg1)"/>
  <path id="r3" class="rota" d="M280 125 C 350 92, 420 92, 490 125" stroke="url(#lg2)"/>
  ${[["r1",.1],["r1",1.6],["r2",.8],["r2",2.4],["r3",.4],["r3",1.5],["r3",2.6]].map(([r,b])=>`<circle class="pk" r="3.6"><animateMotion dur="3.2s" begin="-${b}s" repeatCount="indefinite" rotate="auto"><mpath href="#${r}"/></animateMotion></circle>`).join("")}
  ${[[70,62,"G10","#a78bfa"],[70,188,"G20","#a78bfa"],[280,125,"Expedição","#22d3ee"],[490,125,"Mercado Livre","#4ade80"]].map(([x,y,t,c],i)=>`<g class="no"><circle cx="${x}" cy="${y}" r="26" fill="url(#rg)" opacity=".5"><animate attributeName="r" values="18;30;18" dur="3s" begin="${i*.5}s" repeatCount="indefinite"/></circle><circle cx="${x}" cy="${y}" r="9" fill="#060b14" stroke="${c}" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="3.5" fill="${c}"/><text x="${x}" y="${y+(y<100?-22:y>150?32:-22)}" text-anchor="middle">${t}</text></g>`).join("")}
</svg>`;
function telaLogin(sb,msgInicial){
  return new Promise(res=>{
    let el=document.getElementById("login"); if(!el){el=document.createElement("div");el.id="login";document.body.appendChild(el);}
    let modo="entrar", aviso=msgInicial||"", ok="", erros=0;
    const desenhar=()=>{
      el.innerHTML=`<div class="land"><section class="lhero">
        <div class="lbrand"><span class="logo">${LOGO_SVG}</span><span>Painel de Cargas</span><span class="lchip"><i></i>Canais Digitais</span></div>
        <h1>Cada carga, do roteiro à agenda, em tempo real.</h1>
        <p class="lsub">A torre de controle dos envios para o Mercado Livre: R.F., cronograma, produção e expedição no mesmo lugar, atualizado para todo o time.</p>
        ${REDE_SVG}
      </section>
      <form class="lg" autocomplete="on" novalidate>
        <div class="label">Acesso do time</div>
        <h2>${modo==="cadastrar"?"Criar conta":modo==="recuperar"?"Nova senha":"Entrar"}</h2>
        <div class="seg lgtab" role="tablist"><button type="button" data-m="entrar" aria-pressed="${modo==="entrar"}">Entrar</button><button type="button" data-m="cadastrar" aria-pressed="${modo==="cadastrar"}">Criar conta</button></div>
        <p class="small">${modo==="recuperar"?"Informe seu usuário. Enviamos um link para o e-mail cadastrado para você criar uma nova senha.":modo==="cadastrar"?"Peça o código do time ao Administrador Master.":"Entre com seu usuário e senha."}</p>
        <label>Usuário<input name="usuario" autocomplete="username" required maxlength="40"></label>
        ${modo==="cadastrar"?`<label>E-mail<input type="email" name="email" autocomplete="email" required></label>`:""}
        ${modo!=="recuperar"?`<label>Senha${modo==="cadastrar"?" (mínimo de 8 caracteres)":""}<input type="password" name="senha" autocomplete="${modo==="cadastrar"?"new-password":"current-password"}" required ${modo==="cadastrar"?'minlength="8"':""}></label>`:""}
        ${modo==="cadastrar"?`<label>Código do time<input name="codigo" autocomplete="off" required></label>`:""}
        <div class="lgmsg" role="alert">${esc(aviso)}</div>${ok?`<div class="lgok" role="status">${esc(ok)}</div>`:""}
        <button class="btn" type="submit">${modo==="entrar"?"Entrar":modo==="cadastrar"?"Criar conta":"Enviar link"}</button>
        ${modo==="entrar"?`<button type="button" class="lglink" data-m="recuperar">Esqueci minha senha</button>`:modo==="recuperar"?`<button type="button" class="lglink" data-m="entrar">Voltar para entrar</button>`:""}
        ${modo==="cadastrar"?`<p class="small">Toda conta nova começa como Visualizador. O Administrador Master libera quem pode alterar.</p>`:""}
        ${erros>=2&&modo!=="recuperar"?`<p class="lalerta" role="alert"><b>Atenção:</b> ${erros>=5?"o acesso pode estar bloqueado por 15 minutos.":`depois de 5 tentativas erradas o acesso fica bloqueado por 15 minutos. Já foram ${erros}.`} Se esqueceu a senha, use <b>Esqueci minha senha</b>.</p>`:""}
      </form></div>`;
      const f=el.querySelector("form");
      el.querySelectorAll("[data-m]").forEach(b=>b.addEventListener("click",()=>{const u=f.usuario.value;modo=b.dataset.m;aviso="";ok="";desenhar();el.querySelector("form").usuario.value=u;}));
      setTimeout(()=>{const x=f.usuario.value?(f.senha||f.usuario):f.usuario;x.focus();},30);
      f.addEventListener("submit",async ev=>{ev.preventDefault();
        const bt=f.querySelector('button[type="submit"]'), msg=f.querySelector(".lgmsg");
        const usuario=f.usuario.value.trim(), senha=f.senha?f.senha.value:"";
        if(!usuario||(modo!=="recuperar"&&!senha)){msg.textContent="Preencha todos os campos.";return;}
        if(modo==="cadastrar"&&senha.length<8){msg.textContent="A senha precisa ter pelo menos 8 caracteres.";return;}
        bt.disabled=true; const txt=bt.textContent; bt.textContent="Aguarde…"; msg.textContent="";
        try{
          if(modo==="recuperar"){const r=await contas({acao:"recuperar",usuario}); ok=r.mensagem||"Enviamos o link para o seu e-mail."; aviso=""; desenhar(); el.querySelector("form").usuario.value=usuario; return;}
          const corpo={acao:modo,usuario,senha}; if(modo==="cadastrar"){corpo.email=f.email.value.trim();corpo.codigo=f.codigo.value.trim();}
          const r=await contas(corpo);
          const {data,error}=await sb.auth.setSession({access_token:r.access_token,refresh_token:r.refresh_token});
          if(error) throw error;
          el.hidden=true; document.documentElement.classList.remove("semlogin"); res(data.session);
        }catch(e){const m=(e&&e.message)||"Não foi possível concluir.";
          if(/incorret|tentativas/i.test(m)){erros++;aviso=m;const u=f.usuario.value;desenhar();const f2=el.querySelector("form");f2.usuario.value=u;if(f2.senha){f2.senha.focus();}return;}
          bt.disabled=false;bt.textContent=txt;msg.textContent=m;}
      });
    };
    el.hidden=false; document.documentElement.classList.add("semlogin"); desenhar();
  });
}
/* link do e-mail "criar nova senha" */
function telaNovaSenha(sb,hash){
  return new Promise(res=>{
    let el=document.getElementById("login"); if(!el){el=document.createElement("div");el.id="login";document.body.appendChild(el);}
    el.hidden=false; document.documentElement.classList.add("semlogin");
    el.innerHTML=`<form class="lg solo" novalidate><div class="lbrand"><span class="logo">${LOGO_SVG}</span><span>Painel de Cargas</span></div><h2>Criar nova senha</h2>
      <label>Nova senha (mínimo de 8 caracteres)<input type="password" name="s1" autocomplete="new-password" minlength="8" required></label>
      <label>Repita a nova senha<input type="password" name="s2" autocomplete="new-password" minlength="8" required></label>
      <div class="lgmsg" role="alert"></div><button class="btn" type="submit">Salvar e entrar</button></form>`;
    const f=el.querySelector("form"), msg=f.querySelector(".lgmsg"), bt=f.querySelector("button");
    f.s1.focus();
    f.addEventListener("submit",async ev=>{ev.preventDefault();
      if(f.s1.value.length<8){msg.textContent="A senha precisa ter pelo menos 8 caracteres.";return;}
      if(f.s1.value!==f.s2.value){msg.textContent="As duas senhas não são iguais.";return;}
      bt.disabled=true; msg.textContent="";
      const v=await sb.auth.verifyOtp({token_hash:hash,type:"recovery"});
      if(v.error){bt.disabled=false;msg.textContent="Este link expirou ou já foi usado. Peça um novo em \"Esqueci minha senha\".";return;}
      const u=await sb.auth.updateUser({password:f.s1.value});
      if(u.error){bt.disabled=false;msg.textContent="Não foi possível salvar: "+u.error.message;return;}
      el.hidden=true; document.documentElement.classList.remove("semlogin"); res(v.data.session);});
  });
}
/* trocar a senha já logado (botão "Senha") */
function janela(titulo,html){
  let el=document.getElementById("janela"); if(!el){el=document.createElement("div");el.id="janela";document.body.appendChild(el);}
  el.hidden=false; el.innerHTML=`<div class="acsh"></div><div class="acbox" role="dialog" aria-modal="true" aria-label="${esc(titulo)}"><div class="dhead"><h2>${esc(titulo)}</h2><button class="x" data-jx aria-label="Fechar">×</button></div>${html}</div>`;
  const fechar=()=>{el.hidden=true;el.innerHTML="";};
  el.querySelector(".acsh").onclick=fechar; el.querySelectorAll("[data-jx]").forEach(b=>b.onclick=fechar);
  return {el,fechar};
}
function trocarSenha(sb){
  const j=janela("Trocar senha",`<form class="jform" novalidate><label>Nova senha (mínimo de 8 caracteres)<input type="password" name="s1" autocomplete="new-password" minlength="8"></label>
    <label>Repita a nova senha<input type="password" name="s2" autocomplete="new-password" minlength="8"></label>
    <div class="lgmsg" role="alert"></div><div class="mfoot"><button type="button" class="btn ghost" data-jx>Cancelar</button><button class="btn" type="submit">Salvar senha</button></div></form>`);
  j.el.querySelectorAll("[data-jx]").forEach(b=>b.onclick=j.fechar);
  const f=j.el.querySelector("form"), msg=f.querySelector(".lgmsg"); f.s1.focus();
  f.addEventListener("submit",async ev=>{ev.preventDefault();
    if(f.s1.value.length<8){msg.textContent="A senha precisa ter pelo menos 8 caracteres.";return;}
    if(f.s1.value!==f.s2.value){msg.textContent="As duas senhas não são iguais.";return;}
    const {error}=await sb.auth.updateUser({password:f.s1.value});
    if(error){msg.textContent="Não foi possível salvar: "+error.message;return;}
    j.fechar(); API().toast&&API().toast("Senha trocada.");});
}

/* ================= abas Histórico, Ocorrências e Cadastro ================= */
const CAMPO_NOME={envio:"Envio",carga:"Carga",galpao:"Galpão",loja:"Loja destino",rot:"Roteirização",agenda:"Agenda",volume:"Paletes",obs:"Observação",status:"Status",
  tipo:"Tipo",descricao:"Descrição",solucao:"Solução",dia:"Dia",perfil:"Perfil",equipe:"Equipe",funcao:"Função",usuario:"Usuário",
  regraDias:"Dias úteis antes da agenda",rfDias:"R.F. antes do cronograma",atencaoDias:"Dias de atenção",feriadosExtras:"Feriados extras",
  equipes:"Equipes",funcoes:"Funções",lojas:"Lojas destino",galpoes:"Galpões",tiposOcorrencia:"Tipos de ocorrência",diario:"Resumo diário",semanal:"Relatório semanal",
  pbr:"Paletes PBR",chep:"Paletes CHEP",rf_info:"R.F. informado",regraTerca:"Regra da terça",limite:"Limite de PBR",aviso:"Aviso de PBR",corte:"Data de corte",destinatarios:"Quem recebe",
  alertaEmail:"Alerta por e-mail",alertaTeams:"Alerta no Teams",teams:"Teams",teamsConfigurado:"Teams configurado"};
const ALVO_NOME={carga:"Cargas",ocorrencia:"Ocorrências",paletes:"Paletes",perfil:"Usuários",regras:"Regras",cadastro:"Cadastro",emails:"E-mails e alertas"};
const DIAS_SEM=["","segunda","terça","quarta","quinta","sexta","sábado","domingo"];
function valorTxt(campo,v){
  if(v==null||v==="") return "—";
  if(campo==="status"){const st=API().ST; return st&&st[v]?st[v].nome:String(v);}
  if(campo==="perfil") return PERFIL_NOME[v]||String(v);
  if(campo==="rf_info") return v&&v.em?"informado em "+dtHora(v.em):"—";
  if(typeof v==="boolean") return v?"sim":"não";
  if(["rot","agenda","dia"].includes(campo)) return brA(v);
  if(Array.isArray(v)) return v.map(x=>typeof x==="object"?(x.codigo?x.codigo+(x.nome?" "+x.nome:""):JSON.stringify(x)):String(x)).join(", ")||"—";
  if(typeof v==="object"){
    if(campo==="diario"||campo==="semanal") return (v.ativo?"ativo":"desligado")+(v.hora?" · "+v.hora:"")+(v.diaSemana?" · "+DIAS_SEM[v.diaSemana]:"")+(Array.isArray(v.destinatarios)?" · "+v.destinatarios.join(", "):"")+(v.backup===false?" · sem backup":v.backup?" · com backup":"");
    if(campo==="teams") return "resumo "+(v.diario!==false?"sim":"não")+" · paletes "+(v.paletes!==false?"sim":"não");
    return JSON.stringify(v);
  }
  return String(v);
}

function criarExt(sb,info){
  const eu=info.uid, master=info.master, pode=info.pode;
  const E={ocs:[],ocsOk:false,perfis:[],perfisOk:false,hist:[],histOk:false,histDias:7,histPessoa:"",histAlvo:"",
    ocFiltro:"abertas",ocForm:null,resolvendo:null,cad:null,resumo:null,cfgOk:false,msg:{},
    pal:{mov:[],arq:[],cfg:null,ok:false,filtro:"todos",verTodos:false,cfgAberta:false},online:[]};
  const raiz={}; let pendente=new Set();
  const cadastros=()=>Object.assign({equipes:[],funcoes:[],lojas:[],galpoes:[],tiposOcorrencia:["Outros"]},E.cad||{});
  const redesenhar=v=>{ if(!raiz[v]||!raiz[v].isConnected) return;
    const a=document.activeElement; if(a&&raiz[v].contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)){pendente.add(v);return;}
    desenhar(v); };
  document.addEventListener("focusout",()=>setTimeout(()=>{ if(!pendente.size) return; const a=document.activeElement;
    [...pendente].forEach(v=>{ if(!(a&&raiz[v]&&raiz[v].contains(a))){pendente.delete(v);desenhar(v);} });},0));

  async function carregarOcs(){const {data,error}=await sb.from("ocorrencias").select("*").order("dia",{ascending:false}).order("criado_em",{ascending:false}).limit(3000);
    if(!error){E.ocs=data||[];E.ocsOk=true;} redesenhar("ocorrencias"); API().rerender&&API().rerender();}
  async function carregarPerfis(){const {data,error}=await sb.from("perfis").select("id,usuario,perfil,equipe,funcao,criado_em").order("usuario");
    if(!error){E.perfis=data||[];E.perfisOk=true;} redesenhar("cadastro"); redesenhar("historico");}
  async function carregarHist(){const desde=new Date(Date.now()-E.histDias*864e5).toISOString();
    const {data,error}=await sb.from("historico").select("*").gte("em",desde).order("em",{ascending:false}).limit(3000);
    if(!error){E.hist=data||[];E.histOk=true;} redesenhar("historico");}
  async function carregarCfg(){const {data,error}=await sb.from("cargas_config").select("chave,valor").in("chave",["cadastros","resumo","paletes"]);
    if(!error){(data||[]).forEach(r=>{if(r.chave==="cadastros")E.cad=r.valor||{};if(r.chave==="resumo")E.resumo=r.valor||{};if(r.chave==="paletes")E.pal.cfg=r.valor||{};});E.cfgOk=true;}
    redesenhar("cadastro"); redesenhar("ocorrencias"); carregarPaletes();}
  async function carregarPaletes(){
    if(!master) return;
    const corte=palCfg().corte;
    const [a,b]=await Promise.all([sb.from("paletes_mov").select("*").order("dia").order("criado_em"),
      sb.from("cargas").select("id,carga,envio,agenda,pbr,chep,status,arquivado_em").not("arquivado_em","is",null).gte("agenda",corte)]);
    if(!a.error){E.pal.mov=a.data||[];E.pal.arq=b.error?[]:(b.data||[]);E.pal.ok=true;}
    redesenhar("paletes"); API().rerender&&API().rerender();}
  carregarOcs(); carregarPerfis(); carregarCfg();

  sb.channel("painel-ext")
    .on("postgres_changes",{event:"*",schema:"public",table:"ocorrencias"},pl=>{
      if(pl.eventType==="DELETE"){E.ocs=E.ocs.filter(o=>o.id!==(pl.old&&pl.old.id));}
      else if(pl.new){const i=E.ocs.findIndex(o=>o.id===pl.new.id); if(i>=0)E.ocs[i]=pl.new; else E.ocs.unshift(pl.new);}
      redesenhar("ocorrencias"); API().rerender&&API().rerender();})
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"historico"},pl=>{ if(pl.new&&E.histOk){E.hist.unshift(pl.new); redesenhar("historico");} })
    .on("postgres_changes",{event:"*",schema:"public",table:"perfis"},()=>carregarPerfis())
    .on("postgres_changes",{event:"*",schema:"public",table:"paletes_mov"},()=>{if(master)carregarPaletes();})
    .on("postgres_changes",{event:"*",schema:"public",table:"cargas_config"},pl=>{ const r=pl.new; if(!r) return;
      if(r.chave==="cadastros"){E.cad=r.valor||{};redesenhar("cadastro");redesenhar("ocorrencias");}
      if(r.chave==="resumo"){E.resumo=r.valor||{};redesenhar("cadastro");}
      if(r.chave==="paletes"){E.pal.cfg=r.valor||{};redesenhar("paletes");API().rerender&&API().rerender();}
      if(r.chave==="geral") redesenhar("cadastro"); })
    .subscribe();

  /* quem está com o painel aberto agora (presença do Supabase Realtime) */
  const iniciais=n=>String(n||"?").trim().split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0].toUpperCase()).join("")||"?";
  const corDe=n=>{let h=0;for(const c of String(n))h=(h*31+c.charCodeAt(0))>>>0;return ["#2f6fdc","#0f8f8a","#7a4fd0","#c2255c","#d9480f","#2b8a3e","#5f3dc4","#1864ab"][h%8];};
  function presencaHtml(){const outros=E.online.filter(p=>p.uid!==eu);
    if(!outros.length) return "";
    return `<span class="on">${outros.length===1?"também online":outros.length+" online"}</span>`+outros.slice(0,6).map(p=>`<span class="av" style="--c:${corDe(p.nome)}" title="${esc(p.nome)} está com o painel aberto">${esc(iniciais(p.nome))}</span>`).join("")+(outros.length>6?`<span class="av" style="--c:#5b6a7d">+${outros.length-6}</span>`:"");}
  try{
    const pres=sb.channel("presenca-painel",{config:{presence:{key:eu}}});
    pres.on("presence",{event:"sync"},()=>{const st=pres.presenceState()||{};const vistos=new Map();
      Object.entries(st).forEach(([k,l])=>{const x=(l||[])[0];if(x&&x.nome)vistos.set(k,{uid:k,nome:x.nome});});
      E.online=[...vistos.values()].sort((a,b)=>a.nome.localeCompare(b.nome)); const el=document.getElementById("presenca"); if(el) el.innerHTML=presencaHtml();})
      .subscribe(async st=>{ if(st==="SUBSCRIBED"){ try{await pres.track({nome:info.nome,desde:new Date().toISOString()});}catch(_){} } });
  }catch(_){}

  const busca=()=>norm((API().busca&&API().busca())||"").trim();
  const cargaPorNumero=c=>(API().cargas?API().cargas():[]).find(r=>String(r.carga)===String(c));

  /* ---------- Histórico ---------- */
  function linhaHist(h){
    const muds=(h.mudancas||[]).map(m=>`${esc(CAMPO_NOME[m.campo]||m.campo)}: ${esc(valorTxt(m.campo,m.de))} → <b>${esc(valorTxt(m.campo,m.para))}</b>`).join("<br>");
    const alvo=h.alvo==="carga"||h.alvo==="ocorrencia"?(h.carga?`Carga <b class="mono">${esc(h.carga)}</b>`:"")+(h.envio?` · envio <span class="mono">${esc(h.envio)}</span>`:"")
      :h.alvo==="perfil"?`Usuário <b>${esc(h.chave||"")}</b>`:esc(ALVO_NOME[h.alvo]||h.alvo);
    return {muds,alvo};
  }
  function vHistorico(){
    if(!E.histOk) return `<p class="small">Carregando o histórico…</p>`;
    const q=busca();
    const l=E.hist.filter(h=>(!E.histPessoa||(E.histPessoa==="__sis"?!h.por:h.por===E.histPessoa))&&(!E.histAlvo||h.alvo===E.histAlvo)
      &&(!q||norm(h.carga).includes(q)||norm(h.envio).includes(q)||norm(h.chave).includes(q)||norm(h.por_nome).includes(q)));
    const pessoas=E.perfis.map(p=>`<option value="${esc(p.id)}" ${E.histPessoa===p.id?"selected":""}>${esc(p.usuario)}</option>`).join("");
    return `<div class="exbar">
      <label class="lbl">Período<select data-hdias>${[7,30,90,365].map(d=>`<option value="${d}" ${E.histDias===d?"selected":""}>últimos ${d} dias</option>`).join("")}</select></label>
      <label class="lbl">Quem<select data-hpessoa><option value="">Todos</option>${pessoas}<option value="__sis" ${E.histPessoa==="__sis"?"selected":""}>Sistema (automático)</option></select></label>
      <label class="lbl">O quê<select data-halvo><option value="">Tudo</option>${Object.entries(ALVO_NOME).map(([k,n])=>`<option value="${k}" ${E.histAlvo===k?"selected":""}>${n}</option>`).join("")}</select></label>
      <span class="sp"></span><button class="btn ghost sm" data-hcopiar>Copiar para o Excel</button></div>
      <p class="small">Toda alteração fica registrada pelo próprio banco, com data, hora e quem fez. Ninguém consegue editar nem apagar este histórico. Guardado por 12 meses.${q?` Filtrado pela busca.`:""}</p>
      ${l.length?`<div class="tablebox"><table class="t hist"><thead><tr><th>Data e hora</th><th>Quem</th><th>O quê</th><th>Onde</th><th>Detalhes</th></tr></thead><tbody>
      ${l.slice(0,600).map(h=>{const {muds,alvo}=linhaHist(h);return `<tr><td class="mono">${dtHora(h.em)}</td><td>${esc(h.por_nome||"Sistema")}</td><td>${esc(h.acao)}</td><td>${alvo}</td><td class="small">${muds||"—"}</td></tr>`;}).join("")}
      </tbody></table></div>${l.length>600?`<p class="small">Mostrando as 600 mais recentes de ${l.length}. Use os filtros ou a busca para achar o resto.</p>`:""}`
      :`<p class="vazio">Nenhuma alteração ${q?"para esta busca ":""}no período.</p>`}`;
  }
  function copiarHist(){
    const q=busca();
    const l=E.hist.filter(h=>(!E.histPessoa||(E.histPessoa==="__sis"?!h.por:h.por===E.histPessoa))&&(!E.histAlvo||h.alvo===E.histAlvo)&&(!q||norm(h.carga).includes(q)||norm(h.envio).includes(q)||norm(h.chave).includes(q)||norm(h.por_nome).includes(q)));
    const t=["Data e hora\tQuem\tO quê\tCarga\tEnvio\tDetalhes"].concat(l.map(h=>[dtHora(h.em),h.por_nome||"Sistema",h.acao,h.carga||h.chave||"",h.envio||"",
      (h.mudancas||[]).map(m=>`${CAMPO_NOME[m.campo]||m.campo}: ${valorTxt(m.campo,m.de)} → ${valorTxt(m.campo,m.para)}`).join("; ")].map(x=>String(x).replace(/\t|\n/g," ")).join("\t"))).join("\n");
    (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>API().toast&&API().toast(`${l.length} linhas copiadas. Cole no Excel.`)).catch(()=>API().toast&&API().toast("Não foi possível copiar nesta tela.",true));
  }

  /* ---------- Ocorrências ---------- */
  const ocsDe=carga=>E.ocs.filter(o=>String(o.carga)===String(carga));
  function formOc(){
    const f=E.ocForm, tipos=cadastros().tiposOcorrencia;
    const lista=(API().cargas?API().cargas():[]).map(r=>`<option value="${esc(r.carga)}">${esc(r.envio?"envio "+r.envio:"")}</option>`).join("");
    return `<form class="ocform" data-ocform novalidate><h3>Registrar ocorrência</h3>
      <div class="fgrid">
        <label>Carga<input type="text" name="carga" list="ocl-cargas" value="${esc(f.carga||"")}" inputmode="numeric" placeholder="nº da carga"><datalist id="ocl-cargas">${lista}</datalist></label>
        <label>Envio<input type="text" name="envio" value="${esc(f.envio||"")}" inputmode="numeric" placeholder="preenchido pela carga"></label>
        <label>Tipo<select name="tipo">${tipos.map(t=>`<option ${f.tipo===t?"selected":""}>${esc(t)}</option>`).join("")}</select></label>
        <label>Dia<input type="date" name="dia" value="${esc(f.dia||hojeIso())}" max="${hojeIso()}"></label>
      </div>
      <label>Descrição<textarea name="descricao" placeholder="O que aconteceu?">${esc(f.descricao||"")}</textarea></label>
      <div class="msg" role="alert">${esc(E.msg.oc||"")}</div>
      <div class="mfoot"><button type="button" class="btn ghost" data-occancel>Cancelar</button><button class="btn" type="submit">Registrar</button></div></form>`;
  }
  function cardOc(o){
    const r=o.carga?cargaPorNumero(o.carga):null;
    const resolv=E.resolvendo===o.id;
    return `<article class="occ ${o.status}"><div class="och"><span class="pill octp">${esc(o.tipo)}</span>${o.carga?`<b class="mono">Carga ${esc(o.carga)}</b>`:""}${o.envio?`<span class="mono small">envio ${esc(o.envio)}</span>`:""}<span class="small">· ${brA(o.dia)}</span><span class="sp"></span><span class="ocst">${o.status==="aberta"?"Aberta":"Resolvida"}</span></div>
      ${o.descricao?`<p>${esc(o.descricao)}</p>`:""}
      <div class="small">Aberta por ${esc(o.aberta_por_nome||"—")} em ${dtHora(o.criado_em)}</div>
      ${o.status==="resolvida"?`<div class="ocsol"><b>Solução:</b> ${esc(o.solucao||"—")}<div class="small">Resolvida por ${esc(o.resolvida_por_nome||"—")} em ${dtHora(o.resolvida_em)}</div></div>`:""}
      ${resolv?`<form class="ocres" data-ocresform="${esc(o.id)}"><label>Como foi resolvido?<textarea name="solucao" placeholder="Ex.: reagendado no portal para 14/11"></textarea></label><div class="msg" role="alert">${esc(E.msg.res||"")}</div><div class="mfoot"><button type="button" class="btn ghost sm" data-ocrescancel>Cancelar</button><button class="btn sm" type="submit">Marcar como resolvida</button></div></form>`:""}
      <div class="ocacts">${r?`<button class="btn ghost sm" data-open="${esc(r.id)}">Abrir carga</button>`:""}${pode&&o.status==="aberta"&&!resolv?`<button class="btn sm" data-ocres="${esc(o.id)}">Resolver</button>`:""}${pode&&o.status==="resolvida"?`<button class="btn ghost sm" data-ocreab="${esc(o.id)}">Reabrir</button>`:""}${master?`<button class="btn danger sm" data-ocdel="${esc(o.id)}">Excluir</button>`:""}</div></article>`;
  }
  function vOcorrencias(){
    if(!E.ocsOk) return `<p class="small">Carregando as ocorrências…</p>`;
    const q=busca(), ab=E.ocs.filter(o=>o.status==="aberta").length;
    const l=E.ocs.filter(o=>(E.ocFiltro==="todas"||o.status===(E.ocFiltro==="abertas"?"aberta":"resolvida"))&&(!q||norm(o.carga).includes(q)||norm(o.envio).includes(q)||norm(o.tipo).includes(q)||norm(o.descricao).includes(q)));
    return `<div class="exbar"><div class="chips">${[["abertas",`Abertas (${ab})`],["resolvidas","Resolvidas"],["todas","Todas"]].map(([k,n])=>`<button class="chip" data-ocf="${k}" aria-pressed="${E.ocFiltro===k}">${n}</button>`).join("")}</div>
      <span class="sp"></span>${pode&&!E.ocForm?`<button class="btn" data-ocnova>+ Registrar ocorrência</button>`:""}</div>
      ${E.ocForm?formOc():""}
      ${l.length?`<div class="oclist">${l.map(cardOc).join("")}</div>`:`<p class="vazio">Nenhuma ocorrência ${E.ocFiltro==="abertas"?"aberta":E.ocFiltro==="resolvidas"?"resolvida":""}${q?" para esta busca":""}.</p>`}`;
  }
  async function gravarOc(f){
    const carga=f.carga.value.trim(), r=carga?cargaPorNumero(carga):null;
    const o={carga,envio:f.envio.value.trim()||(r?r.envio:""),carga_id:r?r.id:null,tipo:f.tipo.value,dia:f.dia.value||hojeIso(),descricao:f.descricao.value.trim()};
    if(!o.descricao){E.msg.oc="Escreva o que aconteceu.";desenhar("ocorrencias");return;}
    E.ocForm={...E.ocForm,...o};
    const {error}=await sb.from("ocorrencias").insert(o);
    if(error){E.msg.oc="Não foi possível registrar: "+(erroPerm(error).code==="invalid_argument"?"seu perfil só visualiza.":error.message);desenhar("ocorrencias");return;}
    E.msg.oc=""; E.ocForm=null; E.ocFiltro="abertas"; await carregarOcs(); API().toast&&API().toast("Ocorrência registrada.");
  }

  /* ---------- Paletes PBR ---------- */
  const palCfg=()=>Object.assign({limite:200,aviso:180,corte:"2026-11-08",destinatarios:[],alertaEmail:true,alertaTeams:true},E.pal.cfg||{});
  const MESES=["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  const mesTxt=ym=>{const [y,m]=ym.split("-");return MESES[+m-1]+"/"+y.slice(2);};
  const diasEntre=(a,b)=>Math.round((Date.parse(b+"T12:00:00Z")-Date.parse(a+"T12:00:00Z"))/864e5);
  function calcPal(){
    if(!E.pal.ok) return null;
    const c=palCfg(), hoje=hojeIso(), corte=c.corte;
    const ativas=(API().cargas?API().cargas():[]).filter(r=>r.agenda&&r.agenda>=corte&&r.cod!==0)
      .map(r=>({tipo:"envio",dia:r.agenda,pbr:r.pbr||0,chep:r.chep||0,carga:r.carga,envio:r.envio,origem:"carga",id:r.id,semPal:r.pbr==null&&r.chep==null}));
    const ids=new Set(ativas.map(x=>x.id));
    const arq=E.pal.arq.filter(r=>r.status!==0&&!ids.has(r.id)).map(r=>({tipo:"envio",dia:r.agenda,pbr:r.pbr||0,chep:r.chep||0,carga:r.carga,envio:r.envio,origem:"carga",id:r.id,semPal:r.pbr==null&&r.chep==null}));
    const todos=E.pal.mov.map(m=>({...m})).concat(ativas,arq).sort((a,b)=>a.dia.localeCompare(b.dia)||(a.tipo===b.tipo?0:a.tipo==="envio"?-1:1));
    let saldo=0,proj=0,env=0,ret=0,chep=0,ult=null,ultQ=0; const mes=new Map(), futuros=[];
    todos.forEach(m=>{const ym=m.dia.slice(0,7); if(!mes.has(ym))mes.set(ym,{env:0,ret:0,chep:0,ac:0});const x=mes.get(ym);
      if(m.tipo==="envio"){ proj+=m.pbr; if(m.dia<=hoje){saldo+=m.pbr;env+=m.pbr;chep+=m.chep;x.env+=m.pbr;x.chep+=m.chep;} else futuros.push(m); }
      else { saldo-=m.pbr; proj-=m.pbr; ret+=m.pbr; x.ret+=m.pbr; if(m.pbr>0){ if(!ult||m.dia>ult){ult=m.dia;ultQ=0;} if(m.dia===ult) ultQ+=m.pbr; } }});
    let ac=0; [...mes.keys()].sort().forEach(k=>{const x=mes.get(k); if(k<=hoje.slice(0,7)){ac+=x.env-x.ret;x.ac=ac;} else x.ac=null;});
    /* quando o saldo passa do aviso e do limite, contando as cargas já agendadas */
    let corre=saldo, cruzaAviso=null, cruzaLimite=null;
    futuros.forEach(m=>{corre+=m.pbr; if(!cruzaAviso&&saldo<c.aviso&&corre>=c.aviso) cruzaAviso=m.dia; if(!cruzaLimite&&saldo<c.limite&&corre>=c.limite) cruzaLimite=m.dia;});
    const nivel=saldo>=c.limite?"limite":saldo>=c.aviso?"aviso":"";
    const semPal=ativas.filter(m=>m.semPal);
    return {c,saldo,proj,env,ret,chep,ult,ultQ,dias:ult?diasEntre(ult,hoje):null,nivel,mes,futuros,cruzaAviso,cruzaLimite,todos,semPal,pct:env?Math.round(100*ret/env):null};
  }
  function vPaletes(){
    if(!E.pal.ok) return `<p class="small">Carregando os paletes…</p>`;
    const p=calcPal(), c=p.c, pct=Math.min(100,Math.round(100*Math.max(0,p.saldo)/c.limite)), q=busca();
    const fmt=n=>Number(n).toLocaleString("pt-BR");
    const meses=[...p.mes.entries()].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,8);
    const maxM=Math.max(1,...meses.map(([,x])=>Math.max(x.env,x.ret)));
    const lista=p.todos.slice().reverse().filter(m=>(E.pal.filtro==="todos"||m.tipo===E.pal.filtro)&&(!q||norm(m.carga).includes(q)||norm(m.envio).includes(q)||norm(m.obs).includes(q)));
    const origem=m=>m.origem==="carga"?"carga do painel":m.origem==="planilha"?"planilha (histórico)":m.origem==="arquivo"?"carga já apagada":"registrado no painel";
    const prox=p.futuros.slice(0,8);
    return `<div class="palhead">
      <section class="palsaldo"><span class="label">Saldo de PBR a devolver</span>
        <div class="n">${fmt(p.saldo)} <small>de ${fmt(c.limite)}</small></div>
        <div class="palbar ${p.nivel}" role="img" aria-label="${pct}% do limite"><i style="width:${pct}%"></i><b style="left:${Math.min(100,Math.round(100*c.aviso/c.limite))}%" title="Aviso em ${c.aviso}"></b></div>
        <span class="small">${p.nivel==="limite"?"<b>Limite atingido: hora de pedir o retorno dos PBR ao Mercado Livre.</b>":p.nivel==="aviso"?`<b>Perto do limite</b>: faltam ${fmt(c.limite-p.saldo)} PBR.`:`Faltam ${fmt(c.limite-p.saldo)} PBR para o limite (aviso em ${c.aviso}).`}
        ${p.proj>p.saldo?` Com as cargas já agendadas, chega a <b>${fmt(p.proj)}</b>${p.cruzaLimite?` e passa do limite em <b>${brA(p.cruzaLimite)}</b>`:p.cruzaAviso?` e passa do aviso em <b>${brA(p.cruzaAviso)}</b>`:""}.`:""}</span></section>
      <div class="palk"><span class="label">PBR enviados</span><span class="v">${fmt(p.env)}</span><span class="d">desde o início do controle</span></div>
      <div class="palk"><span class="label">PBR devolvidos</span><span class="v">${fmt(p.ret)}</span><span class="d">${p.pct==null?"—":p.pct+"% dos enviados"}</span></div>
      <div class="palk"><span class="label">Último retorno</span><span class="v">${p.ult?brA(p.ult).slice(0,5):"—"}</span><span class="d">${p.ult?fmt(p.ultQ)+" PBR · há "+p.dias+" dia"+(p.dias===1?"":"s"):"nenhum registrado"}</span></div>
      <div class="palk"><span class="label">CHEP enviados</span><span class="v">${fmt(p.chep)}</span><span class="d">não retornam, ficam fora do saldo</span></div>
    </div>
    ${p.semPal.length?`<div class="notice">${p.semPal.length===1?"1 carga":p.semPal.length+" cargas"} com agenda a partir de ${brA(c.corte)} ainda sem PBR e CHEP: ${p.semPal.slice(0,12).map(m=>`<button class="lnk" data-open="${esc(m.id)}">${esc(m.carga)}</button>`).join(", ")}. Sem isso, o saldo fica menor do que o real.</div>`:""}
    <div class="secgrid">
      ${master?`<form class="sec ocform" data-palret novalidate><h2>Registrar retorno</h2><p class="small">Quando os paletes voltarem do Mercado Livre. Só o PBR entra no saldo.</p>
        <div class="fgrid"><label>Dia do retorno<input type="date" name="dia" value="${hojeIso()}" max="${hojeIso()}"></label><label>PBR devolvidos<input type="number" name="pbr" min="0" step="1" inputmode="numeric" placeholder="0"></label>
        <label>CHEP devolvidos (opcional)<input type="number" name="chep" min="0" step="1" inputmode="numeric" placeholder="0"></label><label>Observação<input type="text" name="obs" maxlength="200" placeholder="ex.: coleta no CD"></label></div>
        <div class="msg" role="alert">${esc(E.msg.pal||"")}</div><div class="mfoot"><button class="btn" type="submit">Registrar retorno</button></div></form>`:""}
      <section class="sec"><h2>Por mês</h2><div class="palleg"><span style="--c:var(--accent)">enviados</span><span style="--c:var(--ok)">devolvidos</span><span style="--c:transparent">número = saldo no fim do mês</span></div>
        <div class="palmes">${meses.map(([k,x])=>`<div class="m"><b>${mesTxt(k)}</b><div class="b e" title="${x.env} enviados"><i style="width:${Math.round(100*x.env/maxM)}%"></i></div><div class="b r" title="${x.ret} devolvidos"><i style="width:${Math.round(100*x.ret/maxM)}%"></i></div><span class="mono">${x.ac==null?"—":fmt(x.ac)}</span></div>`).join("")||`<p class="small">Sem movimentos.</p>`}</div></section>
      <section class="sec"><h2>Próximos envios</h2><p class="small">Cargas agendadas que ainda vão somar ao saldo.</p>
        ${prox.length?`<table class="s"><thead><tr><th>Agenda</th><th>Carga</th><th class="num">PBR</th></tr></thead><tbody>${prox.map(m=>`<tr><td class="mono">${brA(m.dia).slice(0,5)}</td><td class="mono"><button class="lnk" data-open="${esc(m.id)}">${esc(m.carga)}</button></td><td class="num mono">${m.semPal?'<span class="small">sem PBR</span>':m.pbr}</td></tr>`).join("")}</tbody></table>`:`<p class="small">Nenhuma carga agendada à frente.</p>`}</section>
    </div>
    ${master?`<section class="sec"><div class="och"><h2>Alerta de paletes</h2><span class="sp"></span><button class="btn ghost sm" data-palcfg>${E.pal.cfgAberta?"Fechar":"Configurar"}</button></div>
      <p class="small">Limite <b>${c.limite}</b> · aviso a partir de <b>${c.aviso}</b> · e-mail ${c.alertaEmail?"<b>ligado</b>":"desligado"} para ${c.destinatarios.length?esc(c.destinatarios.join(", ")):"ninguém"} · Teams ${c.alertaTeams?"<b>ligado</b>":"desligado"}${(E.resumo||{}).teamsConfigurado?"":" (falta configurar em Cadastro)"}. O servidor confere o saldo todo dia às 7h e avisa quando passa do aviso e quando chega no limite.</p>
      ${E.pal.cfgAberta?`<form class="mail" data-palcfgform novalidate><div class="fgrid"><label>Limite de PBR<input type="number" name="limite" min="1" value="${c.limite}"></label><label>Avisar a partir de<input type="number" name="aviso" min="1" value="${c.aviso}"></label></div>
        <label>Quem recebe o alerta (um e-mail por linha)<textarea name="destinatarios" rows="3">${esc(c.destinatarios.join("\n"))}</textarea></label>
        <label class="ck"><input type="checkbox" name="alertaEmail" ${c.alertaEmail?"checked":""}>Alerta por e-mail</label><label class="ck"><input type="checkbox" name="alertaTeams" ${c.alertaTeams?"checked":""}>Alerta no canal do Teams</label>
        <div class="msg" role="status">${esc(E.msg.palcfg||"")}</div><div class="mfoot"><button type="button" class="btn ghost sm" data-teste="paletes">Enviar e-mail de teste</button><button class="btn sm" type="submit">Salvar</button></div></form>`:`<div class="msg" role="status">${esc(E.msg.palcfg||"")}</div>`}</section>`:""}
    <section class="sec"><div class="och"><h2>Movimentos</h2><span class="sp"></span><div class="chips">${[["todos","Todos"],["envio","Envios"],["retorno","Retornos"]].map(([k,n])=>`<button class="chip" data-palf="${k}" aria-pressed="${E.pal.filtro===k}">${n}</button>`).join("")}</div></div>
      <div class="tablebox"><table class="t hist"><thead><tr><th>Data</th><th>Movimento</th><th class="num">PBR</th><th class="num">CHEP</th><th>Carga / envio</th><th>Origem</th><th></th></tr></thead><tbody>
      ${lista.slice(0,E.pal.verTodos?2000:30).map(m=>`<tr><td class="mono">${brA(m.dia)}</td><td>${m.tipo==="envio"?(m.dia>hojeIso()?'<span class="small">Agendado</span>':"Enviado"):"<b>Retorno</b>"}</td><td class="num mono">${m.tipo==="envio"&&m.semPal?'<span class="small">—</span>':m.pbr}</td><td class="num mono">${m.chep||0}</td>
        <td class="mono">${m.carga?(m.origem==="carga"?`<button class="lnk" data-open="${esc(m.id)}">${esc(m.carga)}</button>`:esc(m.carga)):""}${m.envio?` <span class="small">envio ${esc(m.envio)}</span>`:""}${m.obs&&m.origem!=="planilha"?`<div class="small">${esc(m.obs)}</div>`:""}</td>
        <td class="small">${origem(m)}${m.por_nome?" · "+esc(m.por_nome):""}</td><td>${master&&m.tipo==="retorno"&&m.origem==="painel"?`<button class="btn danger sm" data-paldel="${esc(m.id)}">Excluir</button>`:""}</td></tr>`).join("")||`<tr><td colspan="7" class="empty">Nenhum movimento${q?" para esta busca":""}.</td></tr>`}
      </tbody></table></div>${lista.length>30&&!E.pal.verTodos?`<button class="btn ghost sm" data-paltodos>Ver todos os ${lista.length}</button>`:""}
      <p class="small">Histórico até ${brA(new Date(Date.parse(c.corte+"T12:00:00Z")-864e5).toISOString().slice(0,10))} veio da planilha Paletes_Indicadores. A partir de ${brA(c.corte)}, os envios vêm das cargas do painel (coluna PBR), na data da agenda.</p></section>`;
  }

  /* ---------- Cadastro (Administrador Master) ---------- */
  const chipLista=(chave,itens,cont)=>`<div class="chips">${itens.length?itens.map((x,i)=>`<span class="ctag">${esc(typeof x==="object"?x.codigo+(x.nome?" · "+x.nome:""):x)}${cont?`<span class="n">${cont(x)}</span>`:""}<button class="tx" data-cdel="${chave}" data-i="${i}" aria-label="Remover">×</button></span>`).join(""):`<span class="small">Nenhum cadastrado.</span>`}</div>`;
  const addLinha=(chave,ph,extra)=>`<form class="acrow" data-cadd="${chave}"><input type="text" name="v" placeholder="${esc(ph)}" maxlength="60">${extra||""}<button class="btn sm" type="submit">Adicionar</button></form>`;
  function vCadastro(){
    if(!master) return `<p class="vazio">Só o Administrador Master acessa o Cadastro.</p>`;
    if(!E.perfisOk||!E.cfgOk) return `<p class="small">Carregando…</p>`;
    const c=cadastros(), rs=Object.assign({diario:{},semanal:{}},E.resumo||{}), d=Object.assign({ativo:false,hora:"07:00",fimDeSemana:false,destinatarios:[]},rs.diario), s=Object.assign({ativo:false,diaSemana:1,hora:"08:00",destinatarios:[]},rs.semanal);
    const g=(API().cfg&&API().cfg())||{};
    const nEq=e=>E.perfis.filter(p=>p.equipe===e).length, nFn=f=>E.perfis.filter(p=>p.funcao===f).length;
    const sel=(lista,val,attr)=>`<select ${attr}><option value="">—</option>${lista.map(x=>`<option ${x===val?"selected":""}>${esc(x)}</option>`).join("")}${val&&!lista.includes(val)?`<option selected>${esc(val)}</option>`:""}</select>`;
    return `<p class="small">Só você, Administrador Master, vê esta aba. Tudo o que muda aqui fica registrado no Histórico.</p>
    <section class="sec"><h2>Equipe e perfis</h2><p class="small">Toda conta nova entra como <b>Visualizador</b>. Você escolhe quem passa a <b>Administrador</b>.</p>
      <div class="tablebox"><table class="t cadt"><thead><tr><th>Pessoa</th><th>Perfil</th><th>Equipe</th><th>Função</th><th>O que pode fazer</th></tr></thead><tbody>
      ${E.perfis.map(p=>`<tr><td><b>${esc(p.usuario)}</b>${p.id===eu?' <span class="ctag mini">você</span>':""}</td>
        <td>${p.perfil==="master"?"<b>Administrador Master</b>":`<select data-pperfil="${esc(p.id)}" aria-label="Perfil de ${esc(p.usuario)}">${["admin","leitura"].map(n=>`<option value="${n}" ${p.perfil===n?"selected":""}>${PERFIL_NOME[n]}</option>`).join("")}</select>`}</td>
        <td>${sel(c.equipes,p.equipe||"",`data-pequipe="${esc(p.id)}" aria-label="Equipe de ${esc(p.usuario)}"`)}</td>
        <td>${sel(c.funcoes,p.funcao||"",`data-pfuncao="${esc(p.id)}" aria-label="Função de ${esc(p.usuario)}"`)}</td>
        <td class="small">${esc(PERFIL_PODE[p.perfil]||"")}</td></tr>`).join("")}</tbody></table></div>
      <div class="msg" role="status">${esc(E.msg.perfil||"")}</div></section>
    <section class="sec"><h2>Código do time <span class="ctag mini">criação de conta</span></h2><p class="small">É o código que a pessoa digita para criar a conta. Ao trocar, o antigo para de funcionar (quem já tem conta continua entrando).</p>
      <form class="acrow" data-codigo><input type="text" name="v" placeholder="NOVO CÓDIGO" maxlength="40" autocomplete="off" style="text-transform:uppercase"><button class="btn sm" type="submit">Trocar código</button></form><div class="msg" role="status">${esc(E.msg.codigo||"")}</div></section>
    <div class="secgrid">
    <section class="sec"><h2>Equipes</h2><p class="small">Times do setor. Cada pessoa pode ter uma equipe.</p>${chipLista("equipes",c.equipes,nEq)}${addLinha("equipes","Nova equipe")}</section>
    <section class="sec"><h2>Funções</h2><p class="small">Cargos do setor (Analista, Gestor…).</p>${chipLista("funcoes",c.funcoes,nFn)}${addLinha("funcoes","Nova função")}</section>
    <section class="sec"><h2>Lojas destino</h2><p class="small">Aparecem como sugestão no campo Loja destino da carga.</p>${chipLista("lojas",c.lojas)}${addLinha("lojas","Código (ex.: 558)",`<input type="text" name="nome" placeholder="Nome (opcional)" maxlength="60">`)}</section>
    <section class="sec"><h2>Galpões</h2><p class="small">Aparecem como sugestão no campo Galpão.</p>${chipLista("galpoes",c.galpoes)}${addLinha("galpoes","Novo galpão (ex.: G30)")}</section>
    <section class="sec"><h2>Tipos de ocorrência</h2><p class="small">Opções ao registrar uma ocorrência.</p>${chipLista("tiposOcorrencia",c.tiposOcorrencia)}${addLinha("tiposOcorrencia","Novo tipo")}</section>
    <section class="sec"><h2>Regras do painel</h2><p class="small">Entrar no cronograma <b>${esc(g.regraDias??3)} dias úteis</b> antes da agenda · R.F. sem prazo (informe em qualquer dia antes do cronograma) · <b>${(g.feriadosExtras||[]).length}</b> feriados locais cadastrados. Só você muda.</p><button class="btn ghost sm" data-regras>Editar regras e feriados</button></section>
    </div>
    <section class="sec"><h2>E-mails automáticos</h2><p class="small">Saem sozinhos pelo servidor, até 15 minutos depois do horário escolhido, mesmo com o site fechado. Até 20 e-mails por envio; o plano gratuito do Brevo permite 300 e-mails por dia.</p>
      <div class="secgrid">
      <form class="mail" data-mail="diario"><h3>Resumo do dia</h3><p class="small">O que vence no dia (entrar no cronograma, expedir), as cargas com R.F. pendente, o que está atrasado e as ocorrências abertas.</p>
        <label class="ck"><input type="checkbox" name="ativo" ${d.ativo?"checked":""}>Enviar o resumo diário</label>
        <div class="fgrid"><label>Horário<input type="time" name="hora" value="${esc(d.hora)}"></label><label class="ck" style="align-self:end"><input type="checkbox" name="fimDeSemana" ${d.fimDeSemana?"checked":""}>Também sábado e domingo</label></div>
        <label>Quem recebe (um e-mail por linha)<textarea name="destinatarios" rows="3">${esc((d.destinatarios||[]).join("\n"))}</textarea></label>
        <div class="msg" role="status">${esc(E.msg.diario||"")}</div>
        <div class="mfoot"><button type="button" class="btn ghost sm" data-teste="diario">Enviar teste agora</button><button class="btn sm" type="submit">Salvar</button></div></form>
      <form class="mail" data-mail="semanal"><h3>Relatório semanal de uso</h3><p class="small">Quanto do plano gratuito do Supabase e do Netlify já foi usado. Para os créditos do Netlify aparecerem, cadastre a chave NETLIFY_TOKEN no Supabase (veja a Ajuda).</p>
        <label class="ck"><input type="checkbox" name="ativo" ${s.ativo?"checked":""}>Enviar o relatório semanal</label>
        <label class="ck"><input type="checkbox" name="backup" ${s.backup!==false?"checked":""}>Anexar o backup da base em Excel (cargas, paletes e ocorrências)</label>
        <div class="fgrid"><label>Dia<select name="diaSemana">${[1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${Number(s.diaSemana)===n?"selected":""}>${DIAS_SEM[n]}</option>`).join("")}</select></label><label>Horário<input type="time" name="hora" value="${esc(s.hora)}"></label></div>
        <label>Quem recebe (um e-mail por linha)<textarea name="destinatarios" rows="3">${esc((s.destinatarios||[]).join("\n"))}</textarea></label>
        <div class="msg" role="status">${esc(E.msg.semanal||"")}</div>
        <div class="mfoot"><button type="button" class="btn ghost sm" data-teste="semanal">Enviar teste agora</button><button class="btn sm" type="submit">Salvar</button></div></form>
      </div></section>
    <section class="sec"><h2>Microsoft Teams</h2>
      <p class="small">Manda o resumo das 7h e os alertas de paletes para um canal do Teams. Como ligar: no canal, clique em <b>•••</b> → <b>Workflows</b> → <b>“Post to a channel when a webhook request is received”</b>, escolha a equipe e o canal, e copie o endereço que aparece no final. Cole aqui embaixo.</p>
      <p><b>${rs.teamsConfigurado?"Teams conectado ✓":"Teams ainda não conectado"}</b>${rs.teamsConfigurado?" · o endereço fica guardado no servidor e não aparece na tela.":""}</p>
      <form class="acrow" data-teams><input type="text" name="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="${rs.teamsConfigurado?"Cole um novo endereço para trocar":"Cole aqui o endereço do Workflow"}" style="max-width:none"><button class="btn sm" type="submit">Salvar</button></form>
      <div class="acrow"><label class="ck"><input type="checkbox" data-teamsflag="diario" ${(rs.teams||{}).diario!==false?"checked":""}>Resumo do dia no canal</label><label class="ck"><input type="checkbox" data-teamsflag="paletes" ${(rs.teams||{}).paletes!==false?"checked":""}>Alertas de paletes no canal</label></div>
      <div class="msg" role="status">${esc(E.msg.teams||"")}</div>
      ${rs.teamsConfigurado?`<div class="mfoot"><button class="btn ghost sm" data-teamsrem>Desconectar</button><button class="btn sm" data-teamsteste>Enviar teste no canal</button></div>`:""}</section>
    <section class="sec"><h2>Arquivamento automático</h2><p class="small">Toda madrugada o servidor tira do painel as cargas <b>Expedidas, Entregues ou Canceladas</b> com agenda há mais de <b>60 dias</b>. Elas continuam guardadas no banco e são apagadas de vez depois de <b>12 meses</b>, junto com o histórico e as ocorrências resolvidas desse período. Se uma carga arquivada voltar numa base, ela reaparece no painel.</p></section>`;
  }
  async function salvarCad(novo){
    const {error}=await sb.from("cargas_config").update({valor:novo}).eq("chave","cadastros");
    if(error){API().toast&&API().toast("Não foi possível salvar o cadastro: "+error.message,true);return false;}
    E.cad=novo; desenhar("cadastro"); return true;
  }
  async function fnResumo(corpo){const {data:{session}}=await sb.auth.getSession();
    const r=await fetch(CFG.url+"/functions/v1/resumo",{method:"POST",headers:{"Content-Type":"application/json",apikey:CFG.chave,Authorization:"Bearer "+(session&&session.access_token)},body:JSON.stringify(corpo)});
    const j=await r.json().catch(()=>({})); if(!r.ok||j.erro) throw new Error(j.erro||"Falha ("+r.status+")"); return j;}
  const emailsDe=t=>[...new Set(String(t||"").split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean))];
  const emailOk=x=>/^[^@\s]+@[^@\s.]+(\.[^@\s.]+)*\.[a-z]{2,}$/i.test(x);

  /* ---------- eventos das abas ---------- */
  function ligar(v,el){
    el.addEventListener("click",async e=>{
      const t=e.target;
      if(t.closest("[data-hcopiar]")){copiarHist();return;}
      const ocf=t.closest("[data-ocf]"); if(ocf){E.ocFiltro=ocf.dataset.ocf;desenhar("ocorrencias");return;}
      if(t.closest("[data-ocnova]")){E.ocForm={dia:hojeIso(),tipo:cadastros().tiposOcorrencia[0]};E.msg.oc="";desenhar("ocorrencias");return;}
      if(t.closest("[data-occancel]")){E.ocForm=null;E.msg.oc="";desenhar("ocorrencias");return;}
      const rs=t.closest("[data-ocres]"); if(rs){E.resolvendo=rs.dataset.ocres;E.msg.res="";desenhar("ocorrencias");const ta=el.querySelector('[data-ocresform] textarea');if(ta)ta.focus();return;}
      if(t.closest("[data-ocrescancel]")){E.resolvendo=null;desenhar("ocorrencias");return;}
      const rb=t.closest("[data-ocreab]"); if(rb){const {error}=await sb.from("ocorrencias").update({status:"aberta"}).eq("id",rb.dataset.ocreab);if(error)API().toast&&API().toast("Não foi possível reabrir: "+error.message,true);else carregarOcs();return;}
      const dl=t.closest("[data-ocdel]"); if(dl){ if(dl.dataset.conf!=="1"){dl.dataset.conf="1";dl.textContent="Confirmar exclusão";return;}
        const {error}=await sb.from("ocorrencias").delete().eq("id",dl.dataset.ocdel);if(error)API().toast&&API().toast("Não foi possível excluir: "+error.message,true);else carregarOcs();return;}
      const cd=t.closest("[data-cdel]"); if(cd){const c=cadastros(),k=cd.dataset.cdel,l=(c[k]||[]).slice();l.splice(Number(cd.dataset.i),1);salvarCad({...c,[k]:l});return;}
      if(t.closest("[data-regras]")){API().abrirRegras&&API().abrirRegras();return;}
      const pf=t.closest("[data-palf]"); if(pf){E.pal.filtro=pf.dataset.palf;desenhar("paletes");return;}
      if(t.closest("[data-paltodos]")){E.pal.verTodos=true;desenhar("paletes");return;}
      if(t.closest("[data-palcfg]")){E.pal.cfgAberta=!E.pal.cfgAberta;E.msg.palcfg="";desenhar("paletes");return;}
      const pd=t.closest("[data-paldel]"); if(pd){ if(pd.dataset.conf!=="1"){pd.dataset.conf="1";pd.textContent="Confirmar";return;}
        const {error}=await sb.from("paletes_mov").delete().eq("id",pd.dataset.paldel); if(error)API().toast&&API().toast("Não foi possível excluir: "+error.message,true); else {API().toast&&API().toast("Retorno excluído.");carregarPaletes();} return;}
      if(t.closest("[data-teamsteste]")){E.msg.teams="Enviando teste…";desenhar("cadastro");try{await fnResumo({acao:"teams_teste"});E.msg.teams="Teste enviado. Confira o canal do Teams.";}catch(err){E.msg.teams="Não foi possível: "+err.message;}desenhar("cadastro");return;}
      if(t.closest("[data-teamsrem]")){ const b=t.closest("[data-teamsrem]"); if(b.dataset.conf!=="1"){b.dataset.conf="1";b.textContent="Confirmar: desconectar";return;}
        try{await fnResumo({acao:"teams_salvar",url:""});E.msg.teams="Teams desconectado.";E.resumo={...(E.resumo||{}),teamsConfigurado:false};}catch(err){E.msg.teams=err.message;} desenhar("cadastro");return;}
      const ts=t.closest("[data-teste]"); if(ts){const tipo=ts.dataset.teste, chave=tipo==="paletes"?"palcfg":tipo, aba=tipo==="paletes"?"paletes":"cadastro";E.msg[chave]="Enviando teste…";desenhar(aba);
        try{const j=await fnResumo({acao:"teste",tipo});
          E.msg[chave]="Teste enviado para "+(j.para||[]).join(", ")+". Pode levar alguns minutos; veja também o spam.";}
        catch(err){E.msg[chave]="Não foi possível enviar: "+err.message;} desenhar(aba);return;}
    });
    el.addEventListener("change",async e=>{
      const t=e.target;
      if(t.matches("[data-hdias]")){E.histDias=Number(t.value);E.histOk=false;desenhar("historico");carregarHist();return;}
      if(t.matches("[data-hpessoa]")){E.histPessoa=t.value;desenhar("historico");return;}
      if(t.matches("[data-halvo]")){E.histAlvo=t.value;desenhar("historico");return;}
      if(t.matches("[data-pperfil]")){t.disabled=true;const {error}=await sb.rpc("definir_perfil",{alvo:t.dataset.pperfil,novo:t.value});
        E.msg.perfil=error?"Não foi possível salvar: "+error.message:"Perfil salvo. A mudança vale na hora para a pessoa."; carregarPerfis();return;}
      if(t.matches("[data-pequipe],[data-pfuncao]")){const id=t.dataset.pequipe||t.dataset.pfuncao;const p=E.perfis.find(x=>x.id===id)||{};
        const eq=t.dataset.pequipe?t.value:(p.equipe||""), fn=t.dataset.pfuncao?t.value:(p.funcao||"");
        const {error}=await sb.rpc("definir_equipe_funcao",{alvo:id,nova_equipe:eq,nova_funcao:fn});
        E.msg.perfil=error?"Não foi possível salvar: "+error.message:"Salvo."; carregarPerfis();return;}
      if(t.matches("[data-teamsflag]")){const atual=E.resumo||{};const novo={...atual,teams:{...(atual.teams||{diario:true,paletes:true}),[t.dataset.teamsflag]:t.checked}};
        const {error}=await sb.from("cargas_config").update({valor:novo}).eq("chave","resumo"); E.msg.teams=error?"Não foi possível salvar: "+error.message:"Salvo."; if(!error)E.resumo=novo; desenhar("cadastro");return;}
      if(t.name==="carga"&&t.closest("[data-ocform]")){const r=cargaPorNumero(t.value.trim());const f=t.closest("form");if(r&&!f.envio.value)f.envio.value=r.envio||"";return;}
    });
    el.addEventListener("submit",async e=>{
      const f=e.target; e.preventDefault();
      if(f.matches("[data-ocform]")){gravarOc(f);return;}
      if(f.matches("[data-palret]")){const n=x=>{const v=String(x||"").trim();return v===""?0:Number(v);}; const pbr=n(f.pbr.value), chep=n(f.chep.value);
        if(!(Number.isInteger(pbr)&&pbr>=0&&Number.isInteger(chep)&&chep>=0)||pbr+chep===0){E.msg.pal="Informe quantos paletes voltaram (número inteiro).";desenhar("paletes");return;}
        if(!f.dia.value||f.dia.value>hojeIso()){E.msg.pal="Informe o dia do retorno (hoje ou antes).";desenhar("paletes");return;}
        const bt=f.querySelector('button[type="submit"]'); bt.disabled=true;
        const {error}=await sb.from("paletes_mov").insert({tipo:"retorno",dia:f.dia.value,pbr,chep,obs:f.obs.value.trim()});
        if(error){bt.disabled=false;E.msg.pal="Não foi possível registrar: "+(erroPerm(error).code==="invalid_argument"?"seu perfil só visualiza.":error.message);desenhar("paletes");return;}
        E.msg.pal=""; f.reset(); await carregarPaletes(); API().toast&&API().toast(`Retorno de ${pbr} PBR registrado em ${brA(f.dia.value||hojeIso())}. O saldo já foi atualizado.`);return;}
      if(f.matches("[data-palcfgform]")){const lim=parseInt(f.limite.value,10), av=parseInt(f.aviso.value,10); const lista=emailsDe(f.destinatarios.value), ruins=lista.filter(x=>!emailOk(x));
        if(!(lim>0)||!(av>0)||av>lim){E.msg.palcfg="O aviso precisa ser um número menor ou igual ao limite.";desenhar("paletes");return;}
        if(ruins.length){E.msg.palcfg="E-mail inválido: "+ruins.join(", ");desenhar("paletes");return;}
        if(lista.length>20){E.msg.palcfg="No máximo 20 e-mails.";desenhar("paletes");return;}
        const novo={...palCfg(),limite:lim,aviso:av,destinatarios:lista,alertaEmail:f.alertaEmail.checked,alertaTeams:f.alertaTeams.checked};
        const {error}=await sb.from("cargas_config").update({valor:novo}).eq("chave","paletes");
        E.msg.palcfg=error?"Não foi possível salvar: "+error.message:"Salvo."; if(!error){E.pal.cfg=novo;E.pal.cfgAberta=false;API().rerender&&API().rerender();} desenhar("paletes");return;}
      if(f.matches("[data-teams]")){const url=f.url.value.trim(); if(!url){E.msg.teams="Cole o endereço do Workflow.";desenhar("cadastro");return;}
        E.msg.teams="Salvando…";desenhar("cadastro");
        try{await fnResumo({acao:"teams_salvar",url});E.resumo={...(E.resumo||{}),teamsConfigurado:true};E.msg.teams="Teams conectado. Clique em Enviar teste no canal para conferir.";}catch(err){E.msg.teams=err.message;} desenhar("cadastro");return;}
      if(f.matches("[data-ocresform]")){const sol=f.solucao.value.trim(); if(!sol){E.msg.res="Conte como foi resolvido.";desenhar("ocorrencias");return;}
        const {error}=await sb.from("ocorrencias").update({status:"resolvida",solucao:sol}).eq("id",f.dataset.ocresform);
        if(error){E.msg.res="Não foi possível salvar: "+error.message;desenhar("ocorrencias");return;}
        E.resolvendo=null; carregarOcs(); API().toast&&API().toast("Ocorrência resolvida.");return;}
      if(f.matches("[data-cadd]")){const k=f.dataset.cadd, v=f.v.value.trim(); if(!v) return; const c=cadastros(); const l=(c[k]||[]).slice();
        if(k==="lojas"){ if(l.some(x=>String(x.codigo)===v)) return; l.push({codigo:v,nome:(f.nome&&f.nome.value.trim())||""}); }
        else { if(l.some(x=>norm(x)===norm(v))) return; l.push(v); }
        salvarCad({...c,[k]:l});return;}
      if(f.matches("[data-codigo]")){const v=f.v.value.trim(); if(v.length<4){E.msg.codigo="Use pelo menos 4 caracteres.";desenhar("cadastro");return;}
        try{const {data:{session}}=await sb.auth.getSession(); await contas({acao:"alterar_codigo",novo:v},session&&session.access_token); E.msg.codigo="Código trocado. Novo código: "+v.toUpperCase();}
        catch(err){E.msg.codigo=err.message;} desenhar("cadastro");return;}
      if(f.matches("[data-mail]")){const tipo=f.dataset.mail; const lista=emailsDe(f.destinatarios.value); const ruins=lista.filter(x=>!emailOk(x));
        if(ruins.length){E.msg[tipo]="E-mail inválido: "+ruins.join(", ");desenhar("cadastro");return;}
        if(lista.length>20){E.msg[tipo]="No máximo 20 e-mails.";desenhar("cadastro");return;}
        const atual=Object.assign({diario:{},semanal:{}},E.resumo||{});
        const novo={...atual,[tipo]:tipo==="diario"?{ativo:f.ativo.checked,hora:f.hora.value||"07:00",fimDeSemana:f.fimDeSemana.checked,destinatarios:lista}
          :{ativo:f.ativo.checked,diaSemana:Number(f.diaSemana.value)||1,hora:f.hora.value||"08:00",backup:f.backup.checked,destinatarios:lista}};
        const {error}=await sb.from("cargas_config").update({valor:novo}).eq("chave","resumo");
        E.msg[tipo]=error?"Não foi possível salvar: "+error.message:"Salvo."+(novo[tipo].ativo?` Próximo envio a partir das ${novo[tipo].hora}.`:" Envio desligado.");
        if(!error)E.resumo=novo; desenhar("cadastro");return;}
    });
  }
  function desenhar(v){ const el=raiz[v]; if(!el) return; pendente.delete(v);
    el.innerHTML=v==="historico"?vHistorico():v==="ocorrencias"?vOcorrencias():v==="cadastro"?vCadastro():v==="paletes"?vPaletes():""; }
  /* formulário com algo digitado não é redesenhado quando o painel atualiza (para não perder o que a pessoa escreveu) */
  const digitando=el=>[...el.querySelectorAll("input,textarea")].some(i=>i.type!=="checkbox"&&i.type!=="date"&&i.value!==i.defaultValue);
  let ultimoFoco=null; document.addEventListener("focusin",e=>{ultimoFoco=e.target;});

  return {
    montar(v,slot){
      if(!raiz[v]){raiz[v]=document.createElement("div");raiz[v].className="ext ext-"+v;ligar(v,raiz[v]);
        if(v==="historico"&&!E.histOk) carregarHist();}
      const foco=ultimoFoco&&raiz[v].contains(ultimoFoco)?ultimoFoco:null;
      slot.appendChild(raiz[v]);
      if(digitando(raiz[v])){ if(foco&&foco.isConnected){try{foco.focus({preventScroll:true});}catch(_){}} } else desenhar(v);
    },
    paletesCfg:()=>palCfg(),
    paletesSaldo(){if(!master)return null;const p=calcPal(); return p?{saldo:p.saldo,limite:p.c.limite,aviso:p.c.aviso,nivel:p.nivel,proj:p.proj}:null;},
    presencaHtml,
    ocAbertas(){const s=new Set();E.ocs.forEach(o=>{if(o.status==="aberta"&&o.carga)s.add(String(o.carga));});return s;},
    ocAbertasN(){return E.ocs.filter(o=>o.status==="aberta").length;},
    ocDaCarga(carga){return ocsDe(carga);},
    cadastros,
    novaOcorrencia(r){E.ocForm={carga:r.carga,envio:r.envio,dia:hojeIso(),tipo:cadastros().tiposOcorrencia[0]};E.msg.oc="";E.ocFiltro="abertas";
      if(location.hash!=="#ocorrencias") location.hash="#ocorrencias"; else redesenhar("ocorrencias");}
  };
}

/* ================= entrada ================= */
async function conectar(){
  if(!window.supabase||!window.supabase.createClient) throw new Error("Biblioteca do Supabase não carregou");
  const sb=window.supabase.createClient(CFG.url,CFG.chave,{auth:{persistSession:true,autoRefreshToken:true,storageKey:"painel-cargas-auth"}});
  let {data:{session}}=await sb.auth.getSession();
  let aviso="";
  const mr=/^#recuperar=(.+)$/.exec(location.hash||"");
  if(mr){ history.replaceState(null,"",location.pathname+location.search); session=await telaNovaSenha(sb,decodeURIComponent(mr[1])); }
  for(;;){
    if(!session) session=await telaLogin(sb,aviso);
    const uid=session.user.id;
    const {data:pf,error}=await sb.from("perfis").select("id,usuario,perfil,equipe,funcao").eq("id",uid).maybeSingle();
    if(!error&&pf){
      sb.auth.onAuthStateChange((ev)=>{ if(ev==="SIGNED_OUT") location.reload(); });
      const store=criarStore(sb);
      const nivel=pf.perfil, master=nivel==="master", pode=master||nivel==="admin";
      /* se o Master mudar o meu perfil, o painel recarrega com as novas permissões */
      sb.channel("meu-perfil").on("postgres_changes",{event:"UPDATE",schema:"public",table:"perfis",filter:"id=eq."+uid},pl=>{ if(pl.new&&pl.new.perfil&&pl.new.perfil!==nivel) location.reload(); }).subscribe();
      const nomes={};
      const user={
        id:async()=>uid,
        can:async()=>pode,
        canEdit:async()=>master,
        profiles:async ids=>{const falta=ids.filter(i=>i&&!nomes[i]);
          if(falta.length){const {data}=await sb.from("perfis").select("id,usuario").in("id",falta);(data||[]).forEach(r=>{nomes[r.id]=r.usuario;});}
          const o={};ids.forEach(i=>{if(nomes[i])o[i]={name:nomes[i]};});return o;}
      };
      window.PAINEL_EXT=criarExt(sb,{uid,master,pode,nome:pf.usuario});
      return {db:store.db,user,uid,nome:pf.usuario,perfil:nivel,master,nivel,nivelNome:PERFIL_NOME[nivel]||nivel,podeAlterar:pode,admin:master,
        equipe:pf.equipe||"",funcao:pf.funcao||"",aoVivo:store.aoVivo,
        trocarSenha:()=>trocarSenha(sb),
        sair:async()=>{try{await sb.auth.signOut();}catch(_){} try{localStorage.removeItem("painel-cargas-auth");}catch(_){} location.reload();}};
    }
    aviso=error?"Não foi possível ler o seu perfil: "+error.message:"Seu usuário não tem perfil neste painel. Fale com o Administrador Master.";
    await sb.auth.signOut(); session=null;
  }
}
window.PAINEL_ONLINE={conectar};
})();
