import { createClient } from "npm:@supabase/supabase-js@2";

// Painel de Cargas · contas (entrar, criar conta, esqueci a senha, trocar código do time)
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SITE = "https://painel-cargas-canais-digitais.netlify.app/";

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");
}
const normCodigo = (c: unknown) => String(c ?? "").trim().toUpperCase();
const normUsuario = (u: unknown) => String(u ?? "").trim().replace(/\s+/g, " ");
const validoUsuario = (u: string) => /^[\p{L}\p{N}][\p{L}\p{N} ._-]{1,39}$/u.test(u);
const mascarar = (e: string) => {
  const [n, d] = e.split("@");
  return (n.length <= 2 ? n[0] + "*" : n.slice(0, 2) + "*".repeat(Math.max(1, n.length - 2))) + "@" + d;
};
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ erro: "Método inválido" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return j({ erro: "Pedido inválido" }, 400); }

  const acao = String(body.acao ?? "");
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
  const perfilPorUsuario = async (u: string) =>
    (await admin.from("perfis").select("id, usuario, perfil").eq("usuario_lower", u.toLowerCase()).maybeSingle()).data;

  // ---------- trocar o código do time (só o Administrador Master) ----------
  if (acao === "alterar_codigo") {
    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: quem } = await admin.auth.getUser(token);
    if (!quem?.user) return j({ erro: "Entre com seu usuário primeiro." }, 401);
    const { data: p } = await admin.from("perfis").select("perfil").eq("id", quem.user.id).maybeSingle();
    if (!p || p.perfil !== "master") return j({ erro: "Só o Administrador Master pode trocar o código do time." }, 403);
    const novo = normCodigo(body.novo);
    if (novo.length < 4 || novo.length > 40) return j({ erro: "O código precisa ter de 4 a 40 caracteres." }, 400);
    await admin.from("segredos").upsert({ chave: "codigo_time_sha256", valor: await sha256(novo), atualizado_em: new Date().toISOString() });
    return j({ ok: true });
  }

  // ---------- esqueci minha senha ----------
  if (acao === "recuperar") {
    const usuario = normUsuario(body.usuario);
    const generico = { ok: true, mensagem: "Se esse usuário existir, enviamos um e-mail com o link para criar uma nova senha." };
    const KEY = Deno.env.get("BREVO_API_KEY");
    const REMETENTE = Deno.env.get("BREVO_REMETENTE");
    if (!KEY || !REMETENTE) return j({ erro: "O envio de e-mail ainda não foi configurado. Peça ao Administrador Master para trocar a sua senha." }, 503);
    if (!validoUsuario(usuario)) return j(generico);
    const p = await perfilPorUsuario(usuario);
    if (!p) return j(generico);
    const { data: u } = await admin.auth.admin.getUserById(p.id);
    const email = u?.user?.email;
    if (!email) return j(generico);
    const { data: link, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
    const hashed = link?.properties?.hashed_token;
    if (error || !hashed) return j({ erro: "Não foi possível gerar o link. Tente de novo em alguns minutos." }, 500);
    const url = SITE + "#recuperar=" + encodeURIComponent(hashed);
    const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#17212b;max-width:520px">
      <h2 style="margin:0 0 12px">Painel de Cargas – Canais Digitais</h2>
      <p>Olá, <b>${escHtml(p.usuario)}</b>.</p>
      <p>Recebemos um pedido para criar uma nova senha para a sua conta.</p>
      <p style="margin:22px 0"><a href="${url}" style="background:#1d5fa8;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:bold">Criar nova senha</a></p>
      <p style="color:#5d6b78;font-size:13px">O link vale por 1 hora e só pode ser usado uma vez. Se você não pediu, ignore este e-mail: sua senha continua a mesma.</p>
    </div>`;
    const r = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": KEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: REMETENTE, name: "Painel de Cargas" },
        to: [{ email, name: p.usuario }],
        subject: "Painel de Cargas – criar nova senha",
        htmlContent: html,
      }),
    });
    if (!r.ok) {
      console.error("brevo", r.status, await r.text());
      return j({ erro: "Não foi possível enviar o e-mail agora. Tente de novo em alguns minutos." }, 502);
    }
    return j({ ok: true, mensagem: "Enviamos um e-mail para " + mascarar(email) + " com o link para criar uma nova senha. Veja também a caixa de spam." });
  }

  // ---------- criar conta / entrar ----------
  const usuario = normUsuario(body.usuario);
  const senha = String(body.senha ?? "");
  if (!validoUsuario(usuario)) return j({ erro: "Nome de usuário inválido: use de 2 a 40 letras ou números." }, 400);
  if (senha.length < 6) return j({ erro: "A senha precisa ter pelo menos 6 caracteres." }, 400);

  if (acao === "cadastrar") {
    const { data: seg } = await admin.from("segredos").select("valor").eq("chave", "codigo_time_sha256").maybeSingle();
    if (!seg || (await sha256(normCodigo(body.codigo))) !== seg.valor) {
      return j({ erro: "Código do time incorreto. Peça o código ao administrador." }, 403);
    }
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return j({ erro: "E-mail inválido." }, 400);
    if (await perfilPorUsuario(usuario)) return j({ erro: "Esse nome de usuário já está em uso. Escolha outro." }, 409);
    const { data: criado, error } = await admin.auth.admin.createUser({
      email, password: senha, email_confirm: true, user_metadata: { usuario },
    });
    if (error || !criado?.user) {
      const msg = String(error?.message ?? "").toLowerCase();
      if (msg.includes("already") || msg.includes("exists") || msg.includes("registered")) {
        return j({ erro: "Esse e-mail já tem cadastro." }, 409);
      }
      if (msg.includes("password")) return j({ erro: "Senha fraca demais. Use uma senha mais longa." }, 400);
      return j({ erro: "Não foi possível criar a conta." }, 400);
    }
    // a primeira conta vira Administrador Master; as demais começam só visualizando
    const { count } = await admin.from("perfis").select("id", { count: "exact", head: true });
    const primeiro = (count ?? 0) === 0;
    const { error: e2 } = await admin.from("perfis").insert({ id: criado.user.id, usuario, perfil: primeiro ? "master" : "leitura" });
    if (e2) {
      await admin.auth.admin.deleteUser(criado.user.id);
      return j({ erro: "Esse nome de usuário já está em uso. Escolha outro." }, 409);
    }
  } else if (acao !== "entrar") {
    return j({ erro: "Ação inválida" }, 400);
  }

  const perfil = await perfilPorUsuario(usuario);
  if (!perfil) return j({ erro: "Usuário ou senha incorretos." }, 401);
  const { data: u } = await admin.auth.admin.getUserById(perfil.id);
  if (!u?.user?.email) return j({ erro: "Usuário ou senha incorretos." }, 401);
  const pub = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: s, error: e3 } = await pub.auth.signInWithPassword({ email: u.user.email, password: senha });
  if (e3 || !s?.session) return j({ erro: "Usuário ou senha incorretos." }, 401);
  return j({ access_token: s.session.access_token, refresh_token: s.session.refresh_token, usuario: perfil.usuario, perfil: perfil.perfil });
});
