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
    volume:(typeof r.volume==="number"?r.volume:null),obs:r.obs||"",status:(typeof r.status==="number"?r.status:1),
    hist:Array.isArray(r.hist)?r.hist:[],criadoEm:r.criado_em||"",atualizadoEm:r.atualizado_em||"",atualizadoPor:r.atualizado_por||null};
}
const CAMPOS={envio:v=>String(v==null?"":v),carga:v=>String(v==null?"":v),galpao:v=>String(v==null?"":v),loja:v=>String(v==null?"":v),
  rot:v=>v?String(v).slice(0,10):null,agenda:v=>v?String(v).slice(0,10):null,
  volume:v=>(v===null||v===undefined||v==="")?null:(Number.isFinite(Number(v))?Math.round(Number(v)):null),
  obs:v=>String(v==null?"":v),status:v=>Number(v),hist:v=>Array.isArray(v)?v:[]};
function linhaDe(d,completa){
  const o={};
  Object.keys(CAMPOS).forEach(k=>{ if(Object.prototype.hasOwnProperty.call(d,k)) o[k]=CAMPOS[k](d[k]); else if(completa) o[k]=CAMPOS[k](k==="status"?1:undefined); });
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
function telaLogin(sb,msgInicial){
  return new Promise(res=>{
    let el=document.getElementById("login"); if(!el){el=document.createElement("div");el.id="login";document.body.appendChild(el);}
    let modo="entrar", aviso=msgInicial||"", ok="";
    const desenhar=()=>{
      el.innerHTML=`<form class="lg" autocomplete="on" novalidate>
        <div class="label">Canais Digitais · Envios Mercado Livre</div>
        <h1>Painel de Cargas</h1>
        <div class="seg lgtab" role="tablist"><button type="button" data-m="entrar" aria-pressed="${modo==="entrar"}">Entrar</button><button type="button" data-m="cadastrar" aria-pressed="${modo==="cadastrar"}">Criar conta</button></div>
        <p class="small">${modo==="recuperar"?"Informe seu usuário. Enviamos um link para o e-mail cadastrado para você criar uma nova senha.":modo==="cadastrar"?"Peça o código do time ao Administrador Master.":"Entre com seu usuário e senha."}</p>
        <label>Usuário<input name="usuario" autocomplete="username" required maxlength="40"></label>
        ${modo==="cadastrar"?`<label>E-mail<input type="email" name="email" autocomplete="email" required></label>`:""}
        ${modo!=="recuperar"?`<label>Senha<input type="password" name="senha" autocomplete="${modo==="cadastrar"?"new-password":"current-password"}" required minlength="6"></label>`:""}
        ${modo==="cadastrar"?`<label>Código do time<input name="codigo" autocomplete="off" required></label>`:""}
        <div class="lgmsg" role="alert">${esc(aviso)}</div>${ok?`<div class="lgok" role="status">${esc(ok)}</div>`:""}
        <button class="btn" type="submit">${modo==="entrar"?"Entrar":modo==="cadastrar"?"Criar conta":"Enviar link"}</button>
        ${modo==="entrar"?`<button type="button" class="lglink" data-m="recuperar">Esqueci minha senha</button>`:modo==="recuperar"?`<button type="button" class="lglink" data-m="entrar">Voltar para entrar</button>`:""}
        ${modo==="cadastrar"?`<p class="small">Toda conta nova começa como Visualizador. O Administrador Master libera quem pode alterar.</p>`:""}
      </form>`;
      const f=el.querySelector("form");
      el.querySelectorAll("[data-m]").forEach(b=>b.addEventListener("click",()=>{const u=f.usuario.value;modo=b.dataset.m;aviso="";ok="";desenhar();el.querySelector("form").usuario.value=u;}));
      setTimeout(()=>{const x=f.usuario.value?(f.senha||f.usuario):f.usuario;x.focus();},30);
      f.addEventListener("submit",async ev=>{ev.preventDefault();
        const bt=f.querySelector('button[type="submit"]'), msg=f.querySelector(".lgmsg");
        const usuario=f.usuario.value.trim(), senha=f.senha?f.senha.value:"";
        if(!usuario||(modo!=="recuperar"&&!senha)){msg.textContent="Preencha todos os campos.";return;}
        bt.disabled=true; const txt=bt.textContent; bt.textContent="Aguarde…"; msg.textContent="";
        try{
          if(modo==="recuperar"){const r=await contas({acao:"recuperar",usuario}); ok=r.mensagem||"Enviamos o link para o seu e-mail."; aviso=""; desenhar(); el.querySelector("form").usuario.value=usuario; return;}
          const corpo={acao:modo,usuario,senha}; if(modo==="cadastrar"){corpo.email=f.email.value.trim();corpo.codigo=f.codigo.value.trim();}
          const r=await contas(corpo);
          const {data,error}=await sb.auth.setSession({access_token:r.access_token,refresh_token:r.refresh_token});
          if(error) throw error;
          el.hidden=true; document.documentElement.classList.remove("semlogin"); res(data.session);
        }catch(e){bt.disabled=false;bt.textContent=txt;msg.textContent=(e&&e.message)||"Não foi possível concluir.";}
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
    el.innerHTML=`<form class="lg" novalidate><div class="label">Canais Digitais · Envios Mercado Livre</div><h1>Criar nova senha</h1>
      <label>Nova senha<input type="password" name="s1" autocomplete="new-password" minlength="6" required></label>
      <label>Repita a nova senha<input type="password" name="s2" autocomplete="new-password" minlength="6" required></label>
      <div class="lgmsg" role="alert"></div><button class="btn" type="submit">Salvar e entrar</button></form>`;
    const f=el.querySelector("form"), msg=f.querySelector(".lgmsg"), bt=f.querySelector("button");
    f.s1.focus();
    f.addEventListener("submit",async ev=>{ev.preventDefault();
      if(f.s1.value.length<6){msg.textContent="A senha precisa ter pelo menos 6 caracteres.";return;}
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
  const j=janela("Trocar senha",`<form class="jform" novalidate><label>Nova senha<input type="password" name="s1" autocomplete="new-password" minlength="6"></label>
    <label>Repita a nova senha<input type="password" name="s2" autocomplete="new-password" minlength="6"></label>
    <div class="lgmsg" role="alert"></div><div class="mfoot"><button type="button" class="btn ghost" data-jx>Cancelar</button><button class="btn" type="submit">Salvar senha</button></div></form>`);
  j.el.querySelectorAll("[data-jx]").forEach(b=>b.onclick=j.fechar);
  const f=j.el.querySelector("form"), msg=f.querySelector(".lgmsg"); f.s1.focus();
  f.addEventListener("submit",async ev=>{ev.preventDefault();
    if(f.s1.value.length<6){msg.textContent="A senha precisa ter pelo menos 6 caracteres.";return;}
    if(f.s1.value!==f.s2.value){msg.textContent="As duas senhas não são iguais.";return;}
    const {error}=await sb.auth.updateUser({password:f.s1.value});
    if(error){msg.textContent="Não foi possível salvar: "+error.message;return;}
    j.fechar(); API().toast&&API().toast("Senha trocada.");});
}

/* ================= abas Histórico, Ocorrências e Cadastro ================= */
const CAMPO_NOME={envio:"Envio",carga:"Carga",galpao:"Galpão",loja:"Loja destino",rot:"Roteirização",agenda:"Agenda",volume:"Paletes",obs:"Observação",status:"Status",
  tipo:"Tipo",descricao:"Descrição",solucao:"Solução",dia:"Dia",perfil:"Perfil",equipe:"Equipe",funcao:"Função",usuario:"Usuário",
  regraDias:"Dias úteis antes da agenda",rfDias:"R.F. antes do cronograma",atencaoDias:"Dias de atenção",feriadosExtras:"Feriados extras",
  equipes:"Equipes",funcoes:"Funções",lojas:"Lojas destino",galpoes:"Galpões",tiposOcorrencia:"Tipos de ocorrência",diario:"Resumo diário",semanal:"Relatório semanal"};
const ALVO_NOME={carga:"Cargas",ocorrencia:"Ocorrências",perfil:"Usuários",regras:"Regras",cadastro:"Cadastro",emails:"E-mails"};
const DIAS_SEM=["","segunda","terça","quarta","quinta","sexta","sábado","domingo"];
function valorTxt(campo,v){
  if(v==null||v==="") return "—";
  if(campo==="status"){const st=API().ST; return st&&st[v]?st[v].nome:String(v);}
  if(campo==="perfil") return PERFIL_NOME[v]||String(v);
  if(["rot","agenda","dia"].includes(campo)) return brA(v);
  if(Array.isArray(v)) return v.map(x=>typeof x==="object"?(x.codigo?x.codigo+(x.nome?" "+x.nome:""):JSON.stringify(x)):String(x)).join(", ")||"—";
  if(typeof v==="object"){
    if(campo==="diario"||campo==="semanal") return (v.ativo?"ativo":"desligado")+(v.hora?" · "+v.hora:"")+(v.diaSemana?" · "+DIAS_SEM[v.diaSemana]:"")+(Array.isArray(v.destinatarios)?" · "+v.destinatarios.join(", "):"");
    return JSON.stringify(v);
  }
  return String(v);
}

function criarExt(sb,info){
  const eu=info.uid, master=info.master, pode=info.pode;
  const E={ocs:[],ocsOk:false,perfis:[],perfisOk:false,hist:[],histOk:false,histDias:7,histPessoa:"",histAlvo:"",
    ocFiltro:"abertas",ocForm:null,resolvendo:null,cad:null,resumo:null,cfgOk:false,msg:{}};
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
  async function carregarCfg(){const {data,error}=await sb.from("cargas_config").select("chave,valor").in("chave",["cadastros","resumo"]);
    if(!error){(data||[]).forEach(r=>{if(r.chave==="cadastros")E.cad=r.valor||{};if(r.chave==="resumo")E.resumo=r.valor||{};});E.cfgOk=true;}
    redesenhar("cadastro"); redesenhar("ocorrencias"); API().rerender&&API().rerender();}
  carregarOcs(); carregarPerfis(); carregarCfg();

  sb.channel("painel-ext")
    .on("postgres_changes",{event:"*",schema:"public",table:"ocorrencias"},pl=>{
      if(pl.eventType==="DELETE"){E.ocs=E.ocs.filter(o=>o.id!==(pl.old&&pl.old.id));}
      else if(pl.new){const i=E.ocs.findIndex(o=>o.id===pl.new.id); if(i>=0)E.ocs[i]=pl.new; else E.ocs.unshift(pl.new);}
      redesenhar("ocorrencias"); API().rerender&&API().rerender();})
    .on("postgres_changes",{event:"INSERT",schema:"public",table:"historico"},pl=>{ if(pl.new&&E.histOk){E.hist.unshift(pl.new); redesenhar("historico");} })
    .on("postgres_changes",{event:"*",schema:"public",table:"perfis"},()=>carregarPerfis())
    .on("postgres_changes",{event:"*",schema:"public",table:"cargas_config"},pl=>{ const r=pl.new; if(!r) return;
      if(r.chave==="cadastros"){E.cad=r.valor||{};redesenhar("cadastro");redesenhar("ocorrencias");}
      if(r.chave==="resumo"){E.resumo=r.valor||{};redesenhar("cadastro");}
      if(r.chave==="geral") redesenhar("cadastro"); })
    .subscribe();

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
    <section class="sec"><h2>Regras do painel</h2><p class="small">Entrar no cronograma <b>${esc(g.regraDias??3)} dias úteis</b> antes da agenda · Informar R.F. <b>${esc(g.rfDias??1)} dia útil</b> antes do cronograma · <b>${(g.feriadosExtras||[]).length}</b> feriados locais cadastrados. Só você muda.</p><button class="btn ghost sm" data-regras>Editar regras e feriados</button></section>
    </div>
    <section class="sec"><h2>E-mails automáticos</h2><p class="small">Saem sozinhos pelo servidor, até 15 minutos depois do horário escolhido, mesmo com o site fechado. Até 20 e-mails por envio; o plano gratuito do Brevo permite 300 e-mails por dia.</p>
      <div class="secgrid">
      <form class="mail" data-mail="diario"><h3>Resumo do dia</h3><p class="small">O que vence no dia (informar R.F., entrar no cronograma, expedir), o que está atrasado e as ocorrências abertas.</p>
        <label class="ck"><input type="checkbox" name="ativo" ${d.ativo?"checked":""}>Enviar o resumo diário</label>
        <div class="fgrid"><label>Horário<input type="time" name="hora" value="${esc(d.hora)}"></label><label class="ck" style="align-self:end"><input type="checkbox" name="fimDeSemana" ${d.fimDeSemana?"checked":""}>Também sábado e domingo</label></div>
        <label>Quem recebe (um e-mail por linha)<textarea name="destinatarios" rows="3">${esc((d.destinatarios||[]).join("\n"))}</textarea></label>
        <div class="msg" role="status">${esc(E.msg.diario||"")}</div>
        <div class="mfoot"><button type="button" class="btn ghost sm" data-teste="diario">Enviar teste agora</button><button class="btn sm" type="submit">Salvar</button></div></form>
      <form class="mail" data-mail="semanal"><h3>Relatório semanal de uso</h3><p class="small">Quanto do plano gratuito do Supabase e do Netlify já foi usado. Para os créditos do Netlify aparecerem, cadastre a chave NETLIFY_TOKEN no Supabase (veja a Ajuda).</p>
        <label class="ck"><input type="checkbox" name="ativo" ${s.ativo?"checked":""}>Enviar o relatório semanal</label>
        <div class="fgrid"><label>Dia<select name="diaSemana">${[1,2,3,4,5,6,7].map(n=>`<option value="${n}" ${Number(s.diaSemana)===n?"selected":""}>${DIAS_SEM[n]}</option>`).join("")}</select></label><label>Horário<input type="time" name="hora" value="${esc(s.hora)}"></label></div>
        <label>Quem recebe (um e-mail por linha)<textarea name="destinatarios" rows="3">${esc((s.destinatarios||[]).join("\n"))}</textarea></label>
        <div class="msg" role="status">${esc(E.msg.semanal||"")}</div>
        <div class="mfoot"><button type="button" class="btn ghost sm" data-teste="semanal">Enviar teste agora</button><button class="btn sm" type="submit">Salvar</button></div></form>
      </div></section>
    <section class="sec"><h2>Arquivamento automático</h2><p class="small">Toda madrugada o servidor tira do painel as cargas <b>Expedidas, Entregues ou Canceladas</b> com agenda há mais de <b>60 dias</b>. Elas continuam guardadas no banco e são apagadas de vez depois de <b>12 meses</b>, junto com o histórico e as ocorrências resolvidas desse período. Se uma carga arquivada voltar numa base, ela reaparece no painel.</p></section>`;
  }
  async function salvarCad(novo){
    const {error}=await sb.from("cargas_config").update({valor:novo}).eq("chave","cadastros");
    if(error){API().toast&&API().toast("Não foi possível salvar o cadastro: "+error.message,true);return false;}
    E.cad=novo; desenhar("cadastro"); return true;
  }
  const emailsDe=t=>[...new Set(String(t||"").split(/[\s,;]+/).map(x=>x.trim().toLowerCase()).filter(Boolean))];
  const emailOk=x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x);

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
      const ts=t.closest("[data-teste]"); if(ts){const tipo=ts.dataset.teste;E.msg[tipo]="Enviando teste…";desenhar("cadastro");
        try{const {data:{session}}=await sb.auth.getSession();
          const r=await fetch(CFG.url+"/functions/v1/resumo",{method:"POST",headers:{"Content-Type":"application/json",apikey:CFG.chave,Authorization:"Bearer "+(session&&session.access_token)},body:JSON.stringify({acao:"teste",tipo})});
          const j=await r.json().catch(()=>({})); if(!r.ok||j.erro) throw new Error(j.erro||"Falha no envio");
          E.msg[tipo]="Teste enviado para "+(j.para||[]).join(", ")+". Pode levar alguns minutos; veja também o spam.";}
        catch(err){E.msg[tipo]="Não foi possível enviar: "+err.message;} desenhar("cadastro");return;}
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
      if(t.name==="carga"&&t.closest("[data-ocform]")){const r=cargaPorNumero(t.value.trim());const f=t.closest("form");if(r&&!f.envio.value)f.envio.value=r.envio||"";return;}
    });
    el.addEventListener("submit",async e=>{
      const f=e.target; e.preventDefault();
      if(f.matches("[data-ocform]")){gravarOc(f);return;}
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
          :{ativo:f.ativo.checked,diaSemana:Number(f.diaSemana.value)||1,hora:f.hora.value||"08:00",destinatarios:lista}};
        const {error}=await sb.from("cargas_config").update({valor:novo}).eq("chave","resumo");
        E.msg[tipo]=error?"Não foi possível salvar: "+error.message:"Salvo."+(novo[tipo].ativo?` Próximo envio a partir das ${novo[tipo].hora}.`:" Envio desligado.");
        if(!error)E.resumo=novo; desenhar("cadastro");return;}
    });
  }
  function desenhar(v){ const el=raiz[v]; if(!el) return; pendente.delete(v);
    el.innerHTML=v==="historico"?vHistorico():v==="ocorrencias"?vOcorrencias():v==="cadastro"?vCadastro():""; }

  return {
    montar(v,slot){
      if(!raiz[v]){raiz[v]=document.createElement("div");raiz[v].className="ext ext-"+v;ligar(v,raiz[v]);
        if(v==="historico"&&!E.histOk) carregarHist();}
      slot.appendChild(raiz[v]); desenhar(v);
    },
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
      window.PAINEL_EXT=criarExt(sb,{uid,master,pode});
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
