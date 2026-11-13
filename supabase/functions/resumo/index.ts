import { createClient } from "npm:@supabase/supabase-js@2";

// Painel de Cargas · e-mails automáticos (resumo diário e relatório semanal de uso)
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE = "https://painel-cargas-canais-digitais.netlify.app/";

// ---------- datas e dias úteis (mesma regra do painel) ----------
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const dayOf = (s: string | null) => { if (!s) return null; const [y, m, d] = String(s).slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const isoOf = (n: number) => { const d = new Date(n * 864e5); return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
const br = (s: string | null) => { if (!s) return "—"; const [, m, d] = String(s).slice(0, 10).split("-"); return `${d}/${m}`; };
const brA = (s: string) => String(s).slice(0, 10).split("-").reverse().join("/");
const DOW = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const WD = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
function hojeSP() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date());
}
function feriados(y: number, extras: string[]) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
    mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  const pascoa = Date.UTC(y, mo - 1, da) / 864e5;
  const s = new Set(["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"].map((x) => `${y}-${x}`));
  s.add(isoOf(pascoa - 2)); extras.forEach((x) => s.add(x));
  return s;
}
function calendario(extras: string[]) {
  const cache: Record<number, Set<string>> = {};
  const util = (n: number) => { const dt = new Date(n * 864e5), w = dt.getUTCDay(), y = dt.getUTCFullYear(); cache[y] ??= feriados(y, extras); return w !== 0 && w !== 6 && !cache[y].has(isoOf(n)); };
  const menosUteis = (n: number, k: number) => { let x = n; while (k > 0) { x--; if (util(x)) k--; } return x; };
  return { util, menosUteis };
}
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const ST: Record<number, string> = { 1: "Aguardando cronograma", 2: "Próxima a produzir", 3: "Em produção", 4: "Produzida", 5: "Expedida", 6: "Entregue", 0: "Cancelada" };

// ---------- pedaços do e-mail ----------
const kpi = (l: string, v: string, cor = "#17212b") =>
  `<td style="padding:10px 12px;background:#f3f5f7;border-radius:8px;vertical-align:top"><div style="font-size:11px;color:#5d6b78;text-transform:uppercase;letter-spacing:.05em;font-weight:bold">${l}</div><div style="font-size:24px;font-weight:bold;color:${cor}">${v}</div></td>`;
const th = (t: string) => `<th style="text-align:left;font-size:11px;color:#5d6b78;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid #d9dfe5">${t}</th>`;
const td = (t: string) => `<td style="padding:6px 8px;border-bottom:1px solid #eef2f6;font-size:14px">${t}</td>`;
const tabela = (cab: string[], linhas: string[][]) => linhas.length
  ? `<table cellspacing="0" style="width:100%;border-collapse:collapse;margin:6px 0 18px"><tr>${cab.map(th).join("")}</tr>${linhas.map((l) => `<tr>${l.map((x) => td(esc(x))).join("")}</tr>`).join("")}</table>`
  : `<p style="color:#5d6b78;font-size:14px;margin:6px 0 18px">Nenhuma.</p>`;
const secao = (t: string, n: number, cor = "#17212b") => `<h3 style="margin:16px 0 4px;color:${cor}">${t} (${n})</h3>`;
const botao = (t: string) => `<p style="margin:20px 0"><a href="${SITE}" style="background:#1d5fa8;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:bold">${t}</a></p>`;
const rodape = (o: string) => `<p style="color:#5d6b78;font-size:12px">E-mail automático. Para mudar o horário ou quem recebe, o Administrador Master ajusta em Cadastro → ${o}.</p>`;

// deno-lint-ignore no-explicit-any
async function montarDiario(db: any, dia: string) {
  const [{ data: cargas, error: e1 }, { data: cfgRows }, { data: ocs }] = await Promise.all([
    db.from("cargas").select("carga,envio,galpao,loja,agenda,status,volume").is("arquivado_em", null),
    db.from("cargas_config").select("chave,valor").eq("chave", "geral"),
    db.from("ocorrencias").select("dia,tipo,carga,envio,descricao,aberta_por_nome").eq("status", "aberta").order("dia"),
  ]);
  if (e1) throw e1;
  const g = (cfgRows?.[0]?.valor ?? {}) as { regraDias?: number; rfDias?: number; feriadosExtras?: string[] };
  const regra = Number(g.regraDias ?? 3), rfd = Number(g.rfDias ?? 1);
  const cal = calendario(g.feriadosExtras ?? []);
  const hoje = dayOf(dia)!;
  type L = { carga: string; envio: string; galpao: string; loja: string; agenda: string | null; status: number; volume: number | null; lim?: number; rf?: number; exp?: number };
  const ab: L[] = (cargas ?? []).filter((c: L) => c.status >= 1 && c.status <= 4 && c.agenda).map((c: L) => {
    const ag = dayOf(c.agenda)!; const lim = cal.menosUteis(ag, regra); return { ...c, lim, rf: cal.menosUteis(lim, rfd), exp: ag - 1 };
  });
  const rfHoje = ab.filter((c) => c.status === 1 && c.rf === hoje && c.lim! > hoje);
  const cronoHoje = ab.filter((c) => c.status === 1 && c.lim === hoje);
  const expHoje = ab.filter((c) => c.status >= 2 && c.exp === hoje);
  const rfAtras = ab.filter((c) => c.status === 1 && c.rf! < hoje && c.lim! > hoje);
  const cronoAtras = ab.filter((c) => c.status === 1 && c.lim! < hoje);
  const expAtras = ab.filter((c) => c.status >= 2 && c.exp! < hoje);
  const semAgenda = (cargas ?? []).filter((c: L) => c.status >= 1 && c.status <= 4 && !c.agenda);
  const atrasadas = rfAtras.length + cronoAtras.length + expAtras.length;
  const ord = (l: L[]) => l.sort((a, b) => String(a.agenda).localeCompare(String(b.agenda)) || a.envio.localeCompare(b.envio));
  const lin = (l: L[], extra?: (c: L) => string) => ord(l).map((c) => [c.carga, c.envio || "—", c.galpao || "—", `${br(c.agenda)} (${WD[new Date(dayOf(c.agenda)! * 864e5).getUTCDay()]})`, ST[c.status] ?? "", c.volume == null ? "—" : String(c.volume), ...(extra ? [extra(c)] : [])]);
  const cab = ["Carga", "Envio", "Galpão", "Agenda", "Status", "Paletes"];
  const d = new Date(hoje * 864e5);
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:720px">
  <h2 style="margin:0 0 2px">Resumo do dia · ${DOW[d.getUTCDay()]}, ${brA(dia)}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas – Envios Mercado Livre</p>
  <table cellspacing="6" style="width:100%"><tr>
    ${kpi("Informar R.F. hoje", String(rfHoje.length), rfHoje.length ? "#e0681f" : "#17212b")}
    ${kpi("Entrar no cronograma", String(cronoHoje.length), cronoHoje.length ? "#e0681f" : "#17212b")}
    ${kpi("Expedir hoje", String(expHoje.length), expHoje.length ? "#1d5fa8" : "#17212b")}
    ${kpi("Atrasadas", String(atrasadas), atrasadas ? "#c62828" : "#17212b")}
  </tr></table>
  ${secao("Informar R.F. hoje", rfHoje.length)}${tabela(cab, lin(rfHoje))}
  ${secao("Entrar no cronograma hoje", cronoHoje.length)}${tabela(cab, lin(cronoHoje))}
  ${secao("Expedir hoje", expHoje.length)}${tabela(cab, lin(expHoje))}
  <h2 style="margin:22px 0 4px;color:#c62828">Atrasadas (${atrasadas})</h2>
  ${secao("Fora do prazo do cronograma", cronoAtras.length, "#c62828")}${tabela([...cab, "Cronograma até"], lin(cronoAtras, (c) => br(isoOf(c.lim!))))}
  ${secao("R.F. não informado", rfAtras.length, "#c62828")}${tabela([...cab, "Informar R.F."], lin(rfAtras, (c) => br(isoOf(c.rf!))))}
  ${secao("Expedição atrasada", expAtras.length, "#c62828")}${tabela([...cab, "Expedir em"], lin(expAtras, (c) => br(isoOf(c.exp!))))}
  ${semAgenda.length ? secao("Aguardando envio e agenda", semAgenda.length) + tabela(["Carga", "Galpão", "Status"], semAgenda.map((c: L) => [c.carga, c.galpao || "—", ST[c.status] ?? ""])) : ""}
  ${secao("Ocorrências abertas", (ocs ?? []).length)}${tabela(["Dia", "Tipo", "Carga", "Descrição", "Aberta por"], (ocs ?? []).map((o: { dia: string; tipo: string; carga: string; envio: string; descricao: string; aberta_por_nome: string }) => [br(o.dia), o.tipo, o.carga || o.envio || "—", o.descricao, o.aberta_por_nome || ""]))}
  ${botao("Abrir o Painel de Cargas")}
  ${rodape("E-mails automáticos")}
</div>`;
  const assunto = `Cargas ${brA(dia)} · R.F. ${rfHoje.length} · cronograma ${cronoHoje.length} · expedir ${expHoje.length} · atrasadas ${atrasadas}`;
  return { html, assunto };
}

// ---------- relatório semanal de uso ----------
const GB = 1024 ** 3;
const fmtMB = (b: number) => (b / 1024 ** 2).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " MB";
// deno-lint-ignore no-explicit-any
async function netlifyUso(): Promise<any> {
  const TOKEN = Deno.env.get("NETLIFY_TOKEN");
  if (!TOKEN) return { configurado: false };
  const h = { Authorization: `Bearer ${TOKEN}` };
  const get = async (p: string) => { const r = await fetch("https://api.netlify.com/api/v1" + p, { headers: h }); if (!r.ok) throw new Error(p + " → " + r.status); return r.json(); };
  const agora = new Date(); const inicioMes = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), 1)).toISOString();
  try {
    const sites = await get("/sites?filter=all&per_page=100");
    const porSite: { nome: string; deploys: number; url: string }[] = [];
    let conta = "";
    for (const s of sites) {
      conta ||= s.account_slug || "";
      const deps = await get(`/sites/${s.id}/deploys?per_page=100`);
      const n = deps.filter((d: { context: string; state: string; created_at: string }) => d.context === "production" && d.state === "ready" && d.created_at >= inicioMes).length;
      porSite.push({ nome: s.name, deploys: n, url: s.ssl_url || s.url });
    }
    let bandaGB: number | null = null;
    try { if (conta) { const b = await get(`/accounts/${conta}/bandwidth`); if (typeof b.used === "number") bandaGB = b.used / GB; } } catch { /* nem toda conta expõe */ }
    const deploys = porSite.reduce((a, x) => a + x.deploys, 0);
    const usados = deploys * 15 + (bandaGB == null ? 0 : Math.ceil(bandaGB * 20));
    return { configurado: true, porSite, deploys, bandaGB, usados, restantes: Math.max(0, 300 - usados) };
  } catch (e) {
    return { configurado: true, erro: e instanceof Error ? e.message : String(e) };
  }
}
// deno-lint-ignore no-explicit-any
async function montarSemanal(db: any, dia: string) {
  const { data: est, error } = await db.rpc("estatisticas_uso");
  if (error) throw error;
  const nf = await netlifyUso();
  const lim = 500 * 1024 ** 2, usado = Number(est.banco_bytes), pct = Math.round(usado / lim * 100);
  const sup = `<h3 style="margin:16px 0 4px">Supabase · projeto painel-cargas (plano gratuito)</h3>
  ${tabela(["Item", "Uso", "Limite grátis"], [
    ["Banco de dados", fmtMB(usado) + ` (${pct}%)`, "500 MB"],
    ["Cargas ativas / arquivadas", `${est.cargas_ativas} / ${est.cargas_arquivadas}`, "—"],
    ["Ocorrências (abertas / total)", `${est.ocorrencias_abertas} / ${est.ocorrencias_total}`, "—"],
    ["Registros no histórico", String(est.historico_registros), "—"],
    ["Alterações nos últimos 7 dias", String(est.alteracoes_semana), "—"],
    ["Usuários", String(est.usuarios), "50.000 por mês"],
  ])}
  <p style="font-size:13px;color:#5d6b78;margin:0 0 14px">O Supabase gratuito não cobra créditos: ele tem limites. Pausa o projeto só depois de 7 dias sem nenhum acesso.</p>`;
  let net = "";
  if (!nf.configurado) {
    net = `<h3 style="margin:16px 0 4px">Netlify</h3><p style="font-size:14px">Para mostrar os créditos do Netlify aqui, cadastre a chave <b>NETLIFY_TOKEN</b> no Supabase (Edge Functions → Secrets). Enquanto isso, veja em <a href="https://app.netlify.com/teams/allan-camilo/usage">app.netlify.com → Usage</a>.</p>`;
  } else if (nf.erro) {
    net = `<h3 style="margin:16px 0 4px">Netlify</h3><p style="font-size:14px">Não consegui ler o Netlify agora (${esc(nf.erro)}). Confira a chave NETLIFY_TOKEN ou veja em <a href="https://app.netlify.com/teams/allan-camilo/usage">app.netlify.com → Usage</a>.</p>`;
  } else {
    net = `<h3 style="margin:16px 0 4px">Netlify · conta inteira (300 créditos por mês no plano gratuito)</h3>
    <table cellspacing="6" style="width:100%"><tr>${kpi("Créditos usados no mês (estimativa)", String(nf.usados), nf.usados > 240 ? "#c62828" : "#17212b")}${kpi("Créditos restantes (estimativa)", String(nf.restantes), nf.restantes < 60 ? "#c62828" : "#2e8b57")}</tr></table>
    ${tabela(["Site", "Publicações no mês", "Créditos (15 cada)"], nf.porSite.map((s: { nome: string; deploys: number }) => [s.nome, String(s.deploys), String(s.deploys * 15)]))}
    <p style="font-size:13px;color:#5d6b78;margin:0 0 14px">${nf.bandaGB == null ? "O tráfego (banda) não entrou na conta porque o Netlify não informa esse número pela API para esta conta; para sites leves como os seus ele costuma ser poucos créditos." : `Tráfego no período: ${nf.bandaGB.toLocaleString("pt-BR", { maximumFractionDigits: 2 })} GB (20 créditos por GB).`} O número exato está em <a href="https://app.netlify.com/teams/allan-camilo/usage">app.netlify.com → Usage</a>.</p>`;
  }
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:720px">
  <h2 style="margin:0 0 2px">Relatório semanal de uso · ${brA(dia)}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas – Supabase e Netlify</p>
  ${sup}${net}
  ${botao("Abrir o Painel de Cargas")}
  ${rodape("E-mails automáticos")}
</div>`;
  const assunto = `Uso semanal · Supabase ${pct}% do banco` + (nf.configurado && !nf.erro ? ` · Netlify ~${nf.restantes} créditos restantes` : "");
  return { html, assunto };
}

async function enviar(destinos: string[], assunto: string, html: string) {
  const KEY = Deno.env.get("BREVO_API_KEY"), REM = Deno.env.get("BREVO_REMETENTE");
  if (!KEY || !REM) throw new Error("Envio de e-mail não configurado (Brevo)");
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { email: REM, name: "Painel de Cargas" }, to: destinos.map((email) => ({ email })), subject: assunto, htmlContent: html }),
  });
  if (!r.ok) { const t = await r.text(); console.error("brevo", r.status, t); throw new Error("Falha no envio (" + r.status + ")"); }
}
const validos = (l: unknown) => [...new Set((Array.isArray(l) ? l : []).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x)))].slice(0, 20);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ erro: "Método inválido" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const db = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const seg = async (k: string) => (await db.from("segredos").select("valor").eq("chave", k).maybeSingle()).data?.valor ?? null;
  const marcar = (k: string, v: string) => db.from("segredos").upsert({ chave: k, valor: v, atualizado_em: new Date().toISOString() });
  const cfg = ((await db.from("cargas_config").select("valor").eq("chave", "resumo").maybeSingle()).data?.valor ?? {}) as Record<string, { destinatarios?: string[] }>;
  const dia = hojeSP();
  try {
    const acao = String(body.acao ?? "");
    if (acao === "diario" || acao === "semanal") {
      const chave = await seg("cron_key");
      if (!chave || req.headers.get("x-cron-key") !== chave) return j({ erro: "Não autorizado" }, 401);
      if ((await seg(acao + "_ultimo")) === dia) return j({ ok: true, enviado: false, motivo: "já enviado hoje" });
      const destinos = validos(cfg[acao]?.destinatarios);
      if (!destinos.length) { await marcar(acao + "_ultimo", dia); return j({ ok: true, enviado: false, motivo: "sem destinatários" }); }
      const r = acao === "diario" ? await montarDiario(db, dia) : await montarSemanal(db, dia);
      await enviar(destinos, r.assunto, r.html);
      await marcar(acao + "_ultimo", dia);
      return j({ ok: true, enviado: true, para: destinos.length });
    }
    if (acao === "teste") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: quem } = await db.auth.getUser(token);
      if (!quem?.user) return j({ erro: "Entre com seu usuário primeiro." }, 401);
      const { data: p } = await db.from("perfis").select("perfil").eq("id", quem.user.id).maybeSingle();
      if (!p || p.perfil !== "master") return j({ erro: "Só o Administrador Master pode enviar o teste." }, 403);
      const tipo = body.tipo === "semanal" ? "semanal" : "diario";
      let destinos = validos(cfg[tipo]?.destinatarios);
      if (!destinos.length && quem.user.email) destinos = [quem.user.email];
      const r = tipo === "diario" ? await montarDiario(db, dia) : await montarSemanal(db, dia);
      await enviar(destinos, "[TESTE] " + r.assunto, r.html);
      return j({ ok: true, para: destinos });
    }
    return j({ erro: "Ação inválida" }, 400);
  } catch (e) {
    console.error(e);
    return j({ erro: e instanceof Error ? e.message : "Erro ao montar o e-mail" }, 500);
  }
});
