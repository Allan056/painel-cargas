import { createClient } from "npm:@supabase/supabase-js@2";
import * as XLSX from "npm:xlsx@0.18.5";

// Painel de Cargas · e-mails automáticos (resumo diário, relatório semanal de uso, relatório mensal e alertas imediatos) · v7
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
// prazos de uma carga: cronograma até e informar R.F.
// agenda na terça (regra da terça ligada): R.F. na sexta anterior (dia útil anterior se for feriado) e cronograma até o sábado da produção
function prazos(ag: number, regra: number, rfd: number, terca: boolean, cal: ReturnType<typeof calendario>) {
  if (terca && new Date(ag * 864e5).getUTCDay() === 2) {
    let rf = ag - 4; while (!cal.util(rf)) rf--;
    return { lim: ag - 3, rf };
  }
  const lim = cal.menosUteis(ag, regra);
  return { lim, rf: cal.menosUteis(lim, rfd) };
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
  const pal = await saldoPBR(db, dia).catch(() => null);
  const [{ data: cargas, error: e1 }, { data: cfgRows }, { data: ocs }] = await Promise.all([
    db.from("cargas").select("carga,envio,galpao,loja,agenda,status,volume,rf_info").is("arquivado_em", null),
    db.from("cargas_config").select("chave,valor").eq("chave", "geral"),
    db.from("ocorrencias").select("dia,tipo,carga,envio,descricao,aberta_por_nome").eq("status", "aberta").order("dia"),
  ]);
  if (e1) throw e1;
  const g = (cfgRows?.[0]?.valor ?? {}) as { regraDias?: number; rfDias?: number; feriadosExtras?: string[]; regraTerca?: boolean };
  const regra = Number(g.regraDias ?? 3), rfd = Number(g.rfDias ?? 1), terca = g.regraTerca !== false;
  const cal = calendario(g.feriadosExtras ?? []);
  const hoje = dayOf(dia)!;
  type L = { carga: string; envio: string; galpao: string; loja: string; agenda: string | null; status: number; volume: number | null; rf_info?: unknown; lim?: number; rf?: number; exp?: number };
  const ab: L[] = (cargas ?? []).filter((c: L) => c.status >= 1 && c.status <= 4 && c.agenda).map((c: L) => {
    const ag = dayOf(c.agenda)!; const p = prazos(ag, regra, rfd, terca, cal); return { ...c, lim: p.lim, rf: p.rf, exp: ag - 1 };
  });
  // R.F. não tem prazo: fica pendente até ser informado, em qualquer dia antes do cronograma
  const rfOk = (c: L) => !!(c.rf_info && (c.rf_info as { em?: string }).em);
  const rfPend = ab.filter((c) => c.status === 1 && !rfOk(c) && c.lim! >= hoje);
  const rfDia = (c: L) => { const x = c.rf_info as { em?: string; dia?: string } | null; if (!x || !x.em) return "pendente"; if (x.dia) return "informado " + br(x.dia); const t = new Date(new Date(x.em).getTime() - 3 * 36e5); return "informado " + br(t.toISOString().slice(0, 10)); };
  const cronoHoje = ab.filter((c) => c.status === 1 && c.lim === hoje);
  const expHoje = ab.filter((c) => c.status >= 2 && c.exp === hoje);
  const cronoAtras = ab.filter((c) => c.status === 1 && c.lim! < hoje);
  const expAtras = ab.filter((c) => c.status >= 2 && c.exp! < hoje);
  const semAgenda = (cargas ?? []).filter((c: L) => c.status >= 1 && c.status <= 4 && !c.agenda);
  const atrasadas = cronoAtras.length + expAtras.length;
  const ord = (l: L[]) => l.sort((a, b) => String(a.agenda).localeCompare(String(b.agenda)) || a.envio.localeCompare(b.envio));
  const lin = (l: L[], extra?: (c: L) => string) => ord(l).map((c) => [c.carga, c.envio || "—", c.galpao || "—", `${br(c.agenda)} (${WD[new Date(dayOf(c.agenda)! * 864e5).getUTCDay()]})`, ST[c.status] ?? "", c.volume == null ? "—" : String(c.volume), ...(extra ? [extra(c)] : [])]);
  const cab = ["Carga", "Envio", "Galpão", "Agenda", "Status", "Paletes"];
  const d = new Date(hoje * 864e5);
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:720px">
  <h2 style="margin:0 0 2px">Resumo do dia · ${DOW[d.getUTCDay()]}, ${brA(dia)}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas – Envios Mercado Livre</p>
  <table cellspacing="6" style="width:100%"><tr>
    ${kpi("R.F. pendente", String(rfPend.length), "#17212b")}
    ${kpi("Entrar no cronograma", String(cronoHoje.length), cronoHoje.length ? "#e0681f" : "#17212b")}
    ${kpi("Expedir hoje", String(expHoje.length), expHoje.length ? "#1d5fa8" : "#17212b")}
    ${kpi("Atrasadas", String(atrasadas), atrasadas ? "#c62828" : "#17212b")}
  </tr></table>
  ${pal ? `<p style="margin:10px 0 0;font-size:14px;padding:10px 12px;border-radius:8px;background:${pal.nivel === "limite" ? "#fbe3e3" : pal.nivel === "aviso" ? "#fdf4dd" : "#f3f5f7"}"><b>Saldo de paletes PBR a devolver: ${pal.saldo} de ${pal.limite}</b>${pal.nivel === "limite" ? " · <b style=\"color:#c62828\">limite atingido: pedir o retorno dos paletes</b>" : pal.nivel === "aviso" ? " · perto do limite: programar o pedido de retorno" : ""}${pal.proj > pal.saldo ? ` · com as cargas já agendadas chega a ${pal.proj}` : ""}</p>` : ""}
  ${secao("Entrar no cronograma hoje", cronoHoje.length)}${tabela([...cab, "R.F."], lin(cronoHoje, rfDia))}
  ${secao("R.F. pendente", rfPend.length)}${tabela([...cab, "Cronograma até"], lin(rfPend, (c) => br(isoOf(c.lim!))))}
  ${secao("Expedir hoje", expHoje.length)}${tabela(cab, lin(expHoje))}
  <h2 style="margin:22px 0 4px;color:#c62828">Atrasadas (${atrasadas})</h2>
  ${secao("Fora do prazo do cronograma", cronoAtras.length, "#c62828")}${tabela([...cab, "Cronograma até"], lin(cronoAtras, (c) => br(isoOf(c.lim!))))}
  ${secao("Expedição atrasada", expAtras.length, "#c62828")}${tabela([...cab, "Expedir em"], lin(expAtras, (c) => br(isoOf(c.exp!))))}
  ${semAgenda.length ? secao("Aguardando envio e agenda", semAgenda.length) + tabela(["Carga", "Galpão", "Status"], semAgenda.map((c: L) => [c.carga, c.galpao || "—", ST[c.status] ?? ""])) : ""}
  ${secao("Ocorrências abertas", (ocs ?? []).length)}${tabela(["Dia", "Tipo", "Carga", "Descrição", "Aberta por"], (ocs ?? []).map((o: { dia: string; tipo: string; carga: string; envio: string; descricao: string; aberta_por_nome: string }) => [br(o.dia), o.tipo, o.carga || o.envio || "—", o.descricao, o.aberta_por_nome || ""]))}
  ${botao("Abrir o Painel de Cargas")}
  ${rodape("E-mails automáticos")}
</div>`;
  const assunto = `Cargas ${brA(dia)} · R.F. pendente ${rfPend.length} · cronograma ${cronoHoje.length} · expedir ${expHoje.length} · atrasadas ${atrasadas}`;
  const nomes = (l: L[]) => l.length ? ord(l).map((c) => c.carga + (c.galpao ? " (" + c.galpao + ")" : "")).join(", ") : "nenhuma";
  const teams = [
    `**Entrar no cronograma hoje (${cronoHoje.length}):** ${cronoHoje.length ? ord(cronoHoje).map((c) => c.carga + (c.galpao ? " (" + c.galpao + ")" : "") + " · R.F. " + rfDia(c)).join(", ") : "nenhuma"}`,
    `**R.F. pendente (${rfPend.length}):** ${nomes(rfPend)}`,
    `**Expedir hoje (${expHoje.length}):** ${nomes(expHoje)}`,
    `**Atrasadas (${atrasadas}):** ${nomes([...cronoAtras, ...expAtras])}`,
    `**Ocorrências abertas:** ${(ocs ?? []).length}`,
    ...(pal ? [`**Saldo de PBR a devolver:** ${pal.saldo} de ${pal.limite}${pal.nivel === "limite" ? " · limite atingido, pedir o retorno" : pal.nivel === "aviso" ? " · perto do limite" : ""}`] : []),
  ];
  return { html, assunto, teams };
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

// ---------- paletes PBR: saldo a devolver ----------
// envios da planilha (até a data de corte) + PBR das cargas do painel com agenda a partir do corte (até hoje, canceladas não contam) − retornos
// deno-lint-ignore no-explicit-any
async function saldoPBR(db: any, dia: string) {
  const { data: c } = await db.from("cargas_config").select("valor").eq("chave", "paletes").maybeSingle();
  const cfg = (c?.valor ?? {}) as { limite?: number; aviso?: number; corte?: string; destinatarios?: string[]; alertaEmail?: boolean; alertaTeams?: boolean };
  const corte = String(cfg.corte ?? "2026-11-08"), limite = Number(cfg.limite ?? 200), aviso = Number(cfg.aviso ?? 180);
  const [{ data: mov, error: e1 }, { data: cg, error: e2 }] = await Promise.all([
    db.from("paletes_mov").select("tipo,dia,pbr,chep").order("dia"),
    db.from("cargas").select("carga,agenda,pbr,status").gte("agenda", corte),
  ]);
  if (e1) throw e1; if (e2) throw e2;
  let saldo = 0, proj = 0, ultRet: string | null = null, ultQ = 0;
  for (const m of mov ?? []) {
    if (m.tipo === "envio") { if (m.dia <= dia) saldo += m.pbr; proj += m.pbr; }
    else { saldo -= m.pbr; proj -= m.pbr; if (m.pbr > 0 && (!ultRet || m.dia > ultRet)) { ultRet = m.dia; ultQ = 0; } if (m.dia === ultRet) ultQ += m.pbr; }
  }
  for (const x of cg ?? []) { if (x.status === 0 || !x.pbr) continue; if (x.agenda <= dia) saldo += x.pbr; proj += x.pbr; }
  const nivel = saldo >= limite ? "limite" : saldo >= aviso ? "aviso" : "";
  return { saldo, proj, limite, aviso, nivel, ultRet, ultQ, cfg };
}

// ---------- Microsoft Teams (Workflows: "Post to a channel when a webhook request is received") ----------
const teamsOk = (u: string) => { try { const x = new URL(u); return x.protocol === "https:" && /(\.logic\.azure\.com|\.powerplatform\.com|\.powerautomate\.com|\.office\.com|\.webhook\.office\.com)$/i.test(x.hostname); } catch { return false; } };
async function postTeams(url: string, titulo: string, linhas: string[], cor = "Default") {
  const card = {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.4",
        body: [{ type: "TextBlock", text: titulo, weight: "Bolder", size: "Medium", wrap: true, color: cor },
          ...linhas.map((t) => ({ type: "TextBlock", text: t, wrap: true, spacing: "Small" }))],
        actions: [{ type: "Action.OpenUrl", title: "Abrir o Painel de Cargas", url: SITE }],
      },
    }],
  };
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(card) });
  if (!r.ok && r.status !== 202) { const t = await r.text(); console.error("teams", r.status, t); throw new Error("Teams respondeu " + r.status); }
}

// ---------- backup semanal da base (Excel anexado) ----------
// deno-lint-ignore no-explicit-any
async function backupXlsx(db: any, dia: string) {
  const [{ data: cg }, { data: mov }, { data: ocs }] = await Promise.all([
    db.from("cargas").select("envio,carga,galpao,loja,rot,agenda,status,volume,pbr,chep,obs,rf_info,arquivado_em,atualizado_em").order("agenda"),
    db.from("paletes_mov").select("tipo,dia,pbr,chep,carga,envio,origem,obs,por_nome,criado_em").order("dia"),
    db.from("ocorrencias").select("dia,tipo,carga,envio,descricao,status,solucao,aberta_por_nome,resolvida_por_nome").order("dia"),
  ]);
  const d = (s: string | null) => s ? brA(s) : "";
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([["#ENVIO", "CARGA", "GALPÃO", "LOJA DESTINO", "DATA ROTEIRIZAÇÃO", "DATA AGENDA", "STATUS", "PALETES", "PALETES PBR", "PALETES CHEP", "OBSERVAÇÃO", "R.F. INFORMADO", "ARQUIVADA"]]
    // deno-lint-ignore no-explicit-any
    .concat((cg ?? []).map((c: any) => [c.envio, c.carga, c.galpao, c.loja, d(c.rot), d(c.agenda), (ST[c.status] ?? "").toUpperCase(), c.volume ?? "", c.pbr ?? "", c.chep ?? "", c.obs, c.rf_info?.em ? d(c.rf_info.dia || new Date(new Date(c.rf_info.em).getTime() - 3 * 36e5).toISOString().slice(0, 10)) : "", c.arquivado_em ? "sim" : ""])));
  ws1["!cols"] = [12, 12, 9, 12, 16, 12, 22, 9, 11, 11, 30, 14, 10].map((w) => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws1, "BASE");
  // deno-lint-ignore no-explicit-any
  const ws2 = XLSX.utils.aoa_to_sheet([["TIPO", "DATA", "PBR", "CHEP", "CARGA", "ENVIO", "ORIGEM", "OBSERVAÇÃO", "QUEM"]].concat((mov ?? []).map((m: any) => [m.tipo, d(m.dia), m.pbr, m.chep, m.carga, m.envio, m.origem, m.obs, m.por_nome ?? ""])));
  XLSX.utils.book_append_sheet(wb, ws2, "PALETES");
  // deno-lint-ignore no-explicit-any
  const ws3 = XLSX.utils.aoa_to_sheet([["DIA", "TIPO", "CARGA", "ENVIO", "DESCRIÇÃO", "STATUS", "SOLUÇÃO", "ABERTA POR", "RESOLVIDA POR"]].concat((ocs ?? []).map((o: any) => [d(o.dia), o.tipo, o.carga, o.envio, o.descricao, o.status, o.solucao, o.aberta_por_nome ?? "", o.resolvida_por_nome ?? ""])));
  XLSX.utils.book_append_sheet(wb, ws3, "OCORRENCIAS");
  return { name: `Backup_Painel_Cargas_${brA(dia).replaceAll("/", "-")}.xlsx`, content: XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string, n: (cg ?? []).length };
}

async function enviar(destinos: string[], assunto: string, html: string, anexo?: { name: string; content: string }) {
  const KEY = Deno.env.get("BREVO_API_KEY"), REM = Deno.env.get("BREVO_REMETENTE");
  if (!KEY || !REM) throw new Error("Envio de e-mail não configurado (Brevo)");
  // deno-lint-ignore no-explicit-any
  const corpo: any = { sender: { email: REM, name: "Painel de Cargas" }, to: destinos.map((email) => ({ email })), subject: assunto, htmlContent: html };
  if (anexo) corpo.attachment = [anexo];
  const r = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": KEY, "Content-Type": "application/json", accept: "application/json" },
    body: JSON.stringify(corpo),
  });
  if (!r.ok) { const t = await r.text(); console.error("brevo", r.status, t); throw new Error("Falha no envio (" + r.status + ")"); }
}
const validos = (l: unknown) => [...new Set((Array.isArray(l) ? l : []).map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s.]+(\.[^@\s.]+)*\.[a-z]{2,}$/i.test(x)))].slice(0, 20);

// deno-lint-ignore no-explicit-any
function emailPaletes(p: any, dia: string) {
  const cor = p.nivel === "limite" ? "#c62828" : "#c28a0c";
  const pct = Math.min(100, Math.round(p.saldo / p.limite * 100));
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:620px">
  <h2 style="margin:0 0 6px;color:${cor}">${p.nivel === "limite" ? "Limite de paletes PBR atingido" : "Saldo de paletes PBR perto do limite"}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas · ${brA(dia)}</p>
  <p style="font-size:28px;font-weight:bold;margin:0">${p.saldo} <span style="font-size:16px;color:#5d6b78">de ${p.limite} PBR a devolver</span></p>
  <div style="height:10px;background:#e1e6eb;border-radius:5px;margin:8px 0 14px"><div style="height:10px;width:${pct}%;background:${cor};border-radius:5px"></div></div>
  <p style="font-size:14px">${p.nivel === "limite" ? "Chegou a hora de <b>pedir o retorno dos paletes PBR</b> ao Mercado Livre." : `Faltam <b>${Math.max(0, p.limite - p.saldo)} PBR</b> para o limite. Vale programar o pedido de retorno.`}</p>
  ${p.proj > p.saldo ? `<p style="font-size:14px">Com as cargas já agendadas, o saldo chega a <b>${p.proj}</b>.</p>` : ""}
  <p style="font-size:14px;color:#5d6b78">Último retorno: ${p.ultRet ? brA(p.ultRet) + " (" + p.ultQ + " PBR)" : "nenhum registrado"}. Depois que os paletes voltarem, registre o retorno na aba Paletes.</p>
  ${botao("Abrir o Painel de Cargas")}
  <p style="color:#5d6b78;font-size:12px">Alerta automático. O Administrador Master ajusta o limite, o aviso e quem recebe na aba Paletes.</p></div>`;
  const assunto = `${p.nivel === "limite" ? "LIMITE ATINGIDO" : "Atenção"} · saldo de PBR ${p.saldo} de ${p.limite}`;
  const teams = [`**${p.saldo} de ${p.limite} PBR a devolver** (${pct}%)`, p.nivel === "limite" ? "Pedir o retorno dos paletes PBR ao Mercado Livre." : `Faltam ${Math.max(0, p.limite - p.saldo)} PBR para o limite.`,
    ...(p.proj > p.saldo ? [`Com as cargas já agendadas, o saldo chega a ${p.proj}.`] : []), `Último retorno: ${p.ultRet ? brA(p.ultRet) + " (" + p.ultQ + " PBR)" : "nenhum"}`];
  return { html, assunto, teams, titulo: p.nivel === "limite" ? "⚠ Limite de paletes PBR atingido" : "Saldo de paletes PBR perto do limite", cor: p.nivel === "limite" ? "Attention" : "Warning" };
}


// ---------- v7: quem recebe alertas (permissão "alertas" + e-mails extras) ----------
const PERM_PADRAO: Record<string, Record<string, boolean>> = {
  admin: { alertas: true }, operador: { alertas: true }, leitura: { alertas: false },
};
// deno-lint-ignore no-explicit-any
async function destinosAlertas(db: any, cfg: Record<string, any>) {
  const a = cfg.alertas ?? {};
  const [{ data: pf }, { data: mt }] = await Promise.all([
    db.from("perfis").select("id,perfil,bloqueado,permissoes"),
    db.from("cargas_config").select("valor").eq("chave", "permissoes").maybeSingle(),
  ]);
  const matriz = (mt?.valor ?? {}) as Record<string, Record<string, boolean>>;
  // deno-lint-ignore no-explicit-any
  const ids = (pf ?? []).filter((p: any) => !p.bloqueado && (p.perfil === "master" ||
    (p.perfil === "personalizado" ? !!p.permissoes?.alertas : !!({ ...(PERM_PADRAO[p.perfil] ?? {}), ...(matriz[p.perfil] ?? {}) }).alertas)))
    // deno-lint-ignore no-explicit-any
    .map((p: any) => p.id as string);
  const mails: string[] = [];
  for (const id of ids.slice(0, 30)) {
    const { data } = await db.auth.admin.getUserById(id);
    const e = data?.user?.email ?? ""; if (e && !e.endsWith("@painel.local")) mails.push(e);
  }
  return validos([...mails, ...(Array.isArray(a.extras) ? a.extras : [])]);
}

// ---------- v7: marcos do histórico (mesma regra do painel) ----------
type H = { tipo?: string; de?: number | null; para?: number; em?: string; reg?: string };
function marcos(hist: H[]) {
  const m: Record<number, string> = {}; let entrada: string | null = null;
  (Array.isArray(hist) ? hist : []).filter((h) => h && h.tipo === "status" && h.de != null && h.em)
    .sort((a, b) => (a.em! + (a.reg ?? "")).localeCompare(b.em! + (b.reg ?? "")))
    .forEach((h) => { if (m[h.para!] == null) m[h.para!] = h.em!; if (entrada == null && h.de === 1 && h.para! >= 2 && h.para! <= 6) entrada = h.em!; });
  return { m, entrada: entrada as string | null };
}
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const nomeMes = (k: string) => { const [y, m] = k.split("-").map(Number); return `${MESES[m - 1]} de ${y}`; };
const pctTxt = (a: number, n: number) => n ? Math.round(a / n * 100) + "%" : "sem dados";

// ---------- v7: relatório mensal ----------
// deno-lint-ignore no-explicit-any
async function montarMensal(db: any, mes: string) {
  const [y, mm] = mes.split("-").map(Number);
  const ini = `${mes}-01`, fim = isoOf(Date.UTC(y, mm, 1) / 864e5 - 1);
  const [{ data: cargas, error }, { data: cfgRows }, { data: ocs }] = await Promise.all([
    db.from("cargas").select("id,carga,envio,galpao,loja,agenda,status,volume,hist,motivo_atraso").gte("agenda", ini).lte("agenda", fim),
    db.from("cargas_config").select("chave,valor").eq("chave", "geral"),
    db.from("ocorrencias").select("carga,tipo,dia").gte("dia", ini).lte("dia", fim),
  ]);
  if (error) throw error;
  const g = (cfgRows?.[0]?.valor ?? {}) as { regraDias?: number; rfDias?: number; feriadosExtras?: string[]; regraTerca?: boolean };
  const regra = Number(g.regraDias ?? 3), rfd = Number(g.rfDias ?? 1), terca = g.regraTerca !== false, cal = calendario(g.feriadosExtras ?? []);
  const comOc = new Set((ocs ?? []).map((o: { carga: string }) => String(o.carga)));
  // deno-lint-ignore no-explicit-any
  const l = (cargas ?? []).filter((c: any) => c.status !== 0);
  let otOk = 0, otN = 0, enOk = 0, enN = 0, crOk = 0, crN = 0, vol = 0; const mot = new Map<string, number>(); const porG = new Map<string, { n: number; ok: number }>();
  // deno-lint-ignore no-explicit-any
  l.forEach((c: any) => {
    vol += Number(c.volume ?? 0); const ag = dayOf(c.agenda)!; const { m, entrada } = marcos(c.hist);
    if (entrada) { crN++; if (dayOf(entrada)! <= prazos(ag, regra, rfd, terca, cal).lim) crOk++; }
    if (m[6]) { enN++; if (dayOf(m[6])! <= ag) enOk++; }
    if (c.status === 6 && m[5]) { otN++; const ok = dayOf(m[5])! <= ag - 1 && !comOc.has(String(c.carga)); if (ok) otOk++;
      const k = c.galpao || "Sem galpão"; const x = porG.get(k) ?? { n: 0, ok: 0 }; x.n++; if (ok) x.ok++; porG.set(k, x); }
    const mv = c.motivo_atraso?.motivo; if (mv) mot.set(mv, (mot.get(mv) ?? 0) + 1);
  });
  const ent = l.filter((c: { status: number }) => c.status === 6).length, can = (cargas ?? []).length - l.length;
  const motL = [...mot.entries()].sort((a, b) => b[1] - a[1]);
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:720px">
  <h2 style="margin:0 0 2px">Relatório mensal · ${nomeMes(mes)}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas – Envios Mercado Livre · cargas com agenda no mês</p>
  <table cellspacing="6" style="width:100%"><tr>
    ${kpi("OTIF de expedição", pctTxt(otOk, otN), otN && otOk / otN < 0.9 ? "#c62828" : "#17212b")}
    ${kpi("Entrega na agenda", pctTxt(enOk, enN))}
    ${kpi("Cronograma no prazo", pctTxt(crOk, crN))}
    ${kpi("Cargas", String(l.length))}
  </tr></table>
  <p style="font-size:14px">${ent} entregues, ${l.length - ent} em aberto, ${can} canceladas · ${vol.toLocaleString("pt-BR")} paletes · ${(ocs ?? []).length} ocorrências registradas no mês.</p>
  <p style="font-size:13px;color:#5d6b78">OTIF de expedição: das ${otN} cargas entregues com data de expedição, ${otOk} saíram até a véspera da agenda e não tiveram ocorrência.</p>
  ${secao("OTIF por galpão", porG.size)}${tabela(["Galpão", "Entregues", "No prazo e sem ocorrência", "OTIF"], [...porG.entries()].map(([k, x]) => [k, String(x.n), String(x.ok), pctTxt(x.ok, x.n)]))}
  ${secao("Motivos de atraso", motL.reduce((a, x) => a + x[1], 0))}${tabela(["Motivo", "Cargas"], motL.map(([k, n]) => [k, String(n)]))}
  ${botao("Abrir os Indicadores")}
  <p style="color:#5d6b78;font-size:12px">E-mail automático do dia 1. O Administrador Master muda quem recebe em Indicadores → Ver relatório do mês.</p>
</div>`;
  return { html, assunto: `Relatório de cargas · ${nomeMes(mes)} · OTIF ${pctTxt(otOk, otN)} · entrega na agenda ${pctTxt(enOk, enN)}` };
}

// ---------- v7: cargas atrasadas ainda não avisadas ----------
// deno-lint-ignore no-explicit-any
async function atrasadasNovas(db: any, dia: string) {
  const { data, error } = await db.from("cargas").select("id,carga,envio,galpao,loja,agenda,status,volume,motivo_atraso").is("arquivado_em", null).gte("status", 1).lte("status", 4).not("agenda", "is", null);
  if (error) throw error;
  const hoje = dayOf(dia)!;
  // deno-lint-ignore no-explicit-any
  const atr = (data ?? []).filter((c: any) => { const ag = dayOf(c.agenda)!; return (c.status > 1 && hoje > ag - 1) || (c.status === 1 && hoje > ag); })
    // deno-lint-ignore no-explicit-any
    .map((c: any) => ({ ...c, chave: `${c.id}:${c.agenda}`, tipoAtraso: c.status > 1 ? "Expedição atrasada" : "Entrega atrasada" }));
  if (!atr.length) return [];
  // deno-lint-ignore no-explicit-any
  const { data: ja } = await db.from("alertas_enviados").select("chave").eq("tipo", "atrasada").in("chave", atr.map((c: any) => c.chave));
  const s = new Set((ja ?? []).map((x: { chave: string }) => x.chave));
  // deno-lint-ignore no-explicit-any
  return atr.filter((c: any) => !s.has(c.chave));
}
// deno-lint-ignore no-explicit-any
function emailAtrasadas(l: any[], dia: string) {
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:680px">
  <h2 style="margin:0 0 6px;color:#c62828">${l.length === 1 ? "1 carga ficou atrasada" : l.length + " cargas ficaram atrasadas"}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas · ${brA(dia)}</p>
  ${tabela(["Carga", "Envio", "Galpão", "Agenda", "Status", "Situação"], l.map((c) => [c.carga, c.envio || "—", c.galpao || "—", br(c.agenda), ST[c.status] ?? "", c.tipoAtraso]))}
  <p style="font-size:14px">Abra a carga no painel, reagende no portal se precisar e informe o <b>motivo do atraso</b>.</p>
  ${botao("Abrir as atrasadas")}
  <p style="color:#5d6b78;font-size:12px">Alerta automático, um aviso por carga. O Administrador Master configura em Ocorrências → Configurar alertas.</p></div>`;
  return { html, assunto: `Atenção · ${l.length === 1 ? "carga " + l[0].carga + " atrasada" : l.length + " cargas atrasadas"}` };
}
// deno-lint-ignore no-explicit-any
function emailOcorrencia(o: any) {
  const html = `<div style="font-family:Arial,sans-serif;color:#17212b;max-width:640px">
  <h2 style="margin:0 0 6px;color:#c28a0c">Nova ocorrência: ${esc(o.tipo)}</h2>
  <p style="margin:0 0 14px;color:#5d6b78">Painel de Cargas · registrada por ${esc(o.aberta_por_nome || "—")} em ${brA(String(o.dia || o.criado_em || ""))}</p>
  ${tabela(["Carga", "Envio", "Tipo", "Dia"], [[o.carga || "—", o.envio || "—", o.tipo, br(o.dia)]])}
  ${o.descricao ? `<p style="font-size:14px;white-space:pre-wrap">${esc(o.descricao)}</p>` : ""}
  ${botao("Abrir as ocorrências")}
  <p style="color:#5d6b78;font-size:12px">Alerta automático. O Administrador Master configura em Ocorrências → Configurar alertas.</p></div>`;
  return { html, assunto: `Ocorrência · ${o.tipo}${o.carga ? " · carga " + o.carga : ""}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ erro: "Método inválido" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const db = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const seg = async (k: string) => (await db.from("segredos").select("valor").eq("chave", k).maybeSingle()).data?.valor ?? null;
  const marcar = (k: string, v: string) => db.from("segredos").upsert({ chave: k, valor: v, atualizado_em: new Date().toISOString() });
  // deno-lint-ignore no-explicit-any
  const cfg = ((await db.from("cargas_config").select("valor").eq("chave", "resumo").maybeSingle()).data?.valor ?? {}) as Record<string, any>;
  const dia = hojeSP();
  const teamsUrl = async () => { const u = await seg("teams_webhook"); return u && teamsOk(u) ? u : null; };
  const souMaster = async () => {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: quem } = await db.auth.getUser(token);
    if (!quem?.user) return null;
    const { data: p } = await db.from("perfis").select("perfil,bloqueado").eq("id", quem.user.id).maybeSingle();
    return p?.perfil === "master" && !p?.bloqueado ? quem.user : null;
  };
  try {
    const acao = String(body.acao ?? "");
    if (acao === "diario" || acao === "semanal" || acao === "paletes") {
      const chave = await seg("cron_key");
      if (!chave || req.headers.get("x-cron-key") !== chave) return j({ erro: "Não autorizado" }, 401);
      if ((await seg(acao + "_ultimo")) === dia) return j({ ok: true, enviado: false, motivo: "já enviado hoje" });
      if (acao === "paletes") {
        const p = await saldoPBR(db, dia);
        const rank = (n: string | null) => n === "limite" ? 2 : n === "aviso" ? 1 : 0;
        const antes = await seg("paletes_nivel");
        let enviado = false;
        if (rank(p.nivel) > rank(antes)) {
          const m = emailPaletes(p, dia);
          const dest = validos(p.cfg.destinatarios);
          if (p.cfg.alertaEmail !== false && dest.length) { await enviar(dest, m.assunto, m.html); enviado = true; }
          const tu = await teamsUrl();
          if (tu && p.cfg.alertaTeams !== false && cfg.teams?.paletes !== false) { await postTeams(tu, m.titulo, m.teams, m.cor); enviado = true; }
        }
        await marcar("paletes_nivel", p.nivel);
        await marcar("paletes_ultimo", dia);
        return j({ ok: true, saldo: p.saldo, nivel: p.nivel, enviado });
      }
      const destinos = validos(cfg[acao]?.destinatarios);
      const tu = acao === "diario" && cfg.teams?.diario !== false ? await teamsUrl() : null;
      if (!destinos.length && !tu) { await marcar(acao + "_ultimo", dia); return j({ ok: true, enviado: false, motivo: "sem destinatários" }); }
      if (acao === "diario") {
        const r = await montarDiario(db, dia);
        if (destinos.length) await enviar(destinos, r.assunto, r.html);
        if (tu) await postTeams(tu, "Resumo do dia · " + brA(dia), r.teams).catch((e) => console.error(e));
      } else {
        const r = await montarSemanal(db, dia);
        const bk = cfg.semanal?.backup !== false ? await backupXlsx(db, dia).catch((e) => { console.error("backup", e); return null; }) : null;
        await enviar(destinos, r.assunto + (bk ? " · backup da base anexado" : ""), r.html.replace("</div>", (bk ? `<p style="font-size:14px">Em anexo: <b>${bk.name}</b>, backup da base com ${bk.n} cargas (inclui as arquivadas), movimentos de paletes e ocorrências. Guarde numa pasta segura.</p>` : "") + "</div>"), bk ?? undefined);
      }
      await marcar(acao + "_ultimo", dia);
      return j({ ok: true, enviado: true, para: destinos.length });
    }
    if (acao === "mensal" || acao === "alertas" || acao === "alerta_ocorrencia") {
      const chave = await seg("cron_key");
      if (!chave || req.headers.get("x-cron-key") !== chave) return j({ erro: "Não autorizado" }, 401);
      if (acao === "mensal") {
        const mes = /^\d{4}-\d{2}$/.test(String(body.mes ?? "")) ? String(body.mes) : (() => { const [y, m] = dia.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`; })();
        if ((await seg("mensal_ultimo")) === mes) return j({ ok: true, enviado: false, motivo: "já enviado" });
        const destinos = validos(cfg.mensal?.destinatarios);
        if (cfg.mensal?.ativo && destinos.length) { const r = await montarMensal(db, mes); await enviar(destinos, r.assunto, r.html); }
        await marcar("mensal_ultimo", mes);
        return j({ ok: true, enviado: !!(cfg.mensal?.ativo && destinos.length), para: destinos.length });
      }
      const al = cfg.alertas ?? {};
      if (!al.ativo) return j({ ok: true, enviado: false, motivo: "alertas desligados" });
      const destinos = await destinosAlertas(db, cfg);
      if (acao === "alertas") {
        if (al.atrasada === false) return j({ ok: true, enviado: false });
        const l = await atrasadasNovas(db, dia);
        if (!l.length) return j({ ok: true, enviado: false, motivo: "nenhuma nova" });
        if (destinos.length) { const m = emailAtrasadas(l, dia); await enviar(destinos, m.assunto, m.html); }
        // deno-lint-ignore no-explicit-any
        await db.from("alertas_enviados").upsert(l.map((c: any) => ({ tipo: "atrasada", chave: c.chave, carga: c.carga, envio: c.envio ?? "", para: destinos })), { onConflict: "tipo,chave", ignoreDuplicates: true });
        return j({ ok: true, enviado: destinos.length > 0, cargas: l.length });
      }
      if (al.ocorrencia === false) return j({ ok: true, enviado: false });
      const id = String(body.id ?? "");
      const { data: o } = await db.from("ocorrencias").select("*").eq("id", id).maybeSingle();
      if (!o) return j({ erro: "Ocorrência não encontrada" }, 404);
      const { error: dup } = await db.from("alertas_enviados").insert({ tipo: "ocorrencia", chave: id, carga: o.carga ?? "", envio: o.envio ?? "", para: destinos });
      if (dup) return j({ ok: true, enviado: false, motivo: "já avisado" });
      if (destinos.length) { const m = emailOcorrencia(o); await enviar(destinos, m.assunto, m.html); }
      return j({ ok: true, enviado: destinos.length > 0 });
    }
    if (acao === "teste" && (body.tipo === "mensal" || body.tipo === "alertas")) {
      const quem = await souMaster();
      if (!quem) return j({ erro: "Só o Administrador Master pode enviar o teste." }, 403);
      if (!quem.email) return j({ erro: "Sua conta não tem e-mail cadastrado." }, 400);
      const destinos = [quem.email];
      if (body.tipo === "mensal") {
        const mes = /^\d{4}-\d{2}$/.test(String(body.mes ?? "")) ? String(body.mes) : dia.slice(0, 7);
        const r = await montarMensal(db, mes); await enviar(destinos, "[TESTE] " + r.assunto, r.html);
      } else {
        const l = await atrasadasNovas(db, dia).catch(() => []);
        const m = l.length ? emailAtrasadas(l, dia) : emailOcorrencia({ tipo: "Exemplo de ocorrência", carga: "12345678", envio: "82000000", dia, aberta_por_nome: "Teste", descricao: "Este é um e-mail de teste dos alertas." });
        await enviar(destinos, "[TESTE] " + m.assunto, m.html);
        await db.from("alertas_enviados").insert({ tipo: "teste", chave: crypto.randomUUID(), para: destinos });
      }
      return j({ ok: true, para: destinos });
    }
    if (acao === "teste") {
      const quem = await souMaster();
      if (!quem) return j({ erro: "Só o Administrador Master pode enviar o teste." }, 403);
      const tipo = body.tipo === "semanal" ? "semanal" : body.tipo === "paletes" ? "paletes" : "diario";
      if (tipo === "paletes") {
        const p = await saldoPBR(db, dia);
        const m = emailPaletes({ ...p, nivel: p.nivel || "aviso" }, dia);
        let destinos = validos(p.cfg.destinatarios); if (!destinos.length && quem.email) destinos = [quem.email];
        await enviar(destinos, "[TESTE] " + m.assunto, m.html);
        return j({ ok: true, para: destinos });
      }
      let destinos = validos(cfg[tipo]?.destinatarios);
      if (!destinos.length && quem.email) destinos = [quem.email];
      if (tipo === "diario") { const r = await montarDiario(db, dia); await enviar(destinos, "[TESTE] " + r.assunto, r.html); }
      else {
        const r = await montarSemanal(db, dia);
        const bk = cfg.semanal?.backup !== false ? await backupXlsx(db, dia) : null;
        await enviar(destinos, "[TESTE] " + r.assunto, r.html, bk ?? undefined);
      }
      return j({ ok: true, para: destinos });
    }
    if (acao === "teams_salvar") {
      if (!(await souMaster())) return j({ erro: "Só o Administrador Master configura o Teams." }, 403);
      const url = String(body.url ?? "").trim();
      if (url && !teamsOk(url)) return j({ erro: "Esse endereço não parece um Workflow do Teams. Copie o endereço HTTP POST que o Teams mostra ao criar o fluxo." }, 400);
      if (url) await marcar("teams_webhook", url); else await db.from("segredos").delete().eq("chave", "teams_webhook");
      await db.from("cargas_config").update({ valor: { ...cfg, teamsConfigurado: !!url } }).eq("chave", "resumo");
      return j({ ok: true, configurado: !!url });
    }
    if (acao === "teams_teste") {
      if (!(await souMaster())) return j({ erro: "Só o Administrador Master configura o Teams." }, 403);
      const tu = await teamsUrl(); if (!tu) return j({ erro: "Cole o endereço do Workflow do Teams primeiro." }, 400);
      const r = await montarDiario(db, dia);
      await postTeams(tu, "[TESTE] Resumo do dia · " + brA(dia), r.teams);
      return j({ ok: true });
    }
    return j({ erro: "Ação inválida" }, 400);
  } catch (e) {
    console.error(e);
    return j({ erro: e instanceof Error ? e.message : "Erro ao montar o e-mail" }, 500);
  }
});
