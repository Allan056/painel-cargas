"""Gera o site online do Painel de Cargas (Netlify + Supabase) a partir do mesmo painel-cargas.html."""
import re, os, shutil, hashlib
import pathlib
RAIZ = pathlib.Path(__file__).resolve().parent.parent
SRC = RAIZ / 'src' / 'painel-cargas.html'
OUT = RAIZ / 'site'
src = open(SRC).read()
online = open(RAIZ / 'src' / 'online.js').read()

# Leitor de Excel (SheetJS) só carrega quando alguém importa/baixa planilha: página fica leve (economiza banda do Netlify)
tag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>'
assert src.count(tag) == 1
body = src.replace(tag, '')
title = re.search(r'<title>.*?</title>', body).group(0)
body = body.replace(title, '', 1).replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '', 1)

CFG = '''<script>window.PAINEL_SUPABASE={url:"https://yqwlxxfwarqnvjeggvvr.supabase.co",chave:"sb_publishable_i70GMn2jrVKxia7EoIe24g_6VEZw_E_"};</script>'''
SB = '''<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
<script>if(!window.supabase){document.write('<script src="https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js"><\\/script>');}</script>'''
CSS = '''<style id="online-st">
html.semlogin body>#app{visibility:hidden}
#login{position:fixed;inset:0;z-index:60;overflow:auto;background:var(--fundo,var(--bg));display:grid;place-items:center;padding:28px}
#login .land{width:min(1180px,100%);display:grid;grid-template-columns:minmax(0,1.35fr) minmax(320px,400px);gap:40px;align-items:center}
#login .lbrand{display:flex;align-items:center;gap:12px;font:700 17px var(--display);letter-spacing:-.01em}
#login .logo{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;color:var(--accent);background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 30%,transparent),transparent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);box-shadow:0 0 28px color-mix(in srgb,var(--accent) 25%,transparent)}
#login .logo svg{width:24px;height:24px}
#login .lchip{display:inline-flex;align-items:center;gap:7px;font:500 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ok);border:1px solid color-mix(in srgb,var(--ok) 35%,transparent);border-radius:999px;padding:4px 10px}
#login .lchip i{width:7px;height:7px;border-radius:50%;background:var(--ok);animation:pulso 2s ease-out infinite}
#login .lhero h1{font:700 clamp(32px,4.4vw,54px)/1.04 var(--display);letter-spacing:-.035em;margin:26px 0 14px;max-width:16ch;background:linear-gradient(120deg,var(--fg) 40%,color-mix(in srgb,var(--accent) 80%,var(--fg)));-webkit-background-clip:text;background-clip:text;color:transparent}
#login .lsub{font-size:16.5px;line-height:1.55;color:var(--muted);max-width:56ch;margin:0}
#login .rede{width:100%;max-width:640px;margin:18px 0 6px;overflow:visible}
#login .rede .grade line{stroke:color-mix(in srgb,var(--accent) 10%,transparent);stroke-width:1}
#login .rede .rota{fill:none;stroke-width:2;stroke-dasharray:5 7;animation:tracejado 1.6s linear infinite;opacity:.85}
@keyframes tracejado{to{stroke-dashoffset:-24}}
#login .rede .pk{fill:#e8fbff;filter:drop-shadow(0 0 5px #22d3ee)}
#login .rede text{font:500 11.5px var(--mono);letter-spacing:.06em;fill:var(--muted);text-transform:uppercase}
#login .lg{width:100%;display:grid;gap:13px;background:var(--surface);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid var(--line-forte);border-radius:20px;padding:28px 26px;box-shadow:0 30px 80px rgba(0,0,0,.45),0 0 0 1px rgba(255,255,255,.03) inset;position:relative}
#login .lg::before{content:"";position:absolute;inset:-1px;border-radius:20px;padding:1px;background:linear-gradient(140deg,color-mix(in srgb,var(--accent) 70%,transparent),transparent 40%,transparent 70%,color-mix(in srgb,#a78bfa 60%,transparent));-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask-composite:exclude;pointer-events:none}
#login .lg.solo{width:min(400px,100%)}
#login .lg h2{font:700 26px var(--display);margin:0;letter-spacing:-.02em}
#login label{display:grid;gap:6px;font-size:13px;font-weight:600;color:var(--muted)}
#login input{font:inherit;font-size:15px;padding:11px 12px;border:1px solid var(--line-forte);border-radius:10px;background:color-mix(in srgb,var(--surface-solid,var(--bg)) 80%,transparent);color:var(--fg)}
#login input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 28%,transparent)}
#login .btn{justify-content:center;padding:12px;font-size:15px;border-radius:10px}
#login .lgtab{justify-self:start}
#login .lgmsg{color:var(--crit);font-size:13px}
#login .lgmsg:empty{display:none}
#login .lgok{color:var(--ok);font-size:13px}
#login .lglink{all:unset;cursor:pointer;justify-self:center;font-size:13px;color:var(--accent);text-decoration:underline}
#login p{margin:0}
#login .lalerta{font-size:13px;line-height:1.45;color:var(--fg);background:var(--warn-bg);border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);border-left:3px solid var(--warn);border-radius:10px;padding:10px 12px;animation:sobe .35s ease both}
@media (prefers-reduced-motion:no-preference){#login .lhero>*{animation:sobe .7s cubic-bezier(.2,.7,.2,1) both}#login .lhero>*:nth-child(2){animation-delay:.08s}#login .lhero>*:nth-child(3){animation-delay:.16s}#login .lhero>*:nth-child(4){animation-delay:.24s}#login .lhero>*:nth-child(5){animation-delay:.32s}#login .lg{animation:sobe .7s .2s cubic-bezier(.2,.7,.2,1) both}}
@media (prefers-reduced-motion:reduce){#login .rede .pk{display:none}}
@media (max-width:980px){#login .land{grid-template-columns:1fr;gap:22px}#login .lg{order:-1;max-width:440px;justify-self:center}#login .lhero h1{margin-top:16px}}
@media (max-width:560px){#login{padding:16px;place-items:start}#login .rede{display:none}#login .lhero h1{font-size:30px}}
#janela{position:fixed;inset:0;z-index:55;display:grid;place-items:center;padding:20px}
#janela .acsh{position:absolute;inset:0;background:var(--shade)}
#janela .acbox{position:relative;width:min(760px,100%);max-height:90vh;overflow:auto;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:18px 20px;display:grid;gap:14px}
#janela table.t{width:100%;min-width:0}
#janela select{font:inherit;padding:5px 8px;border-radius:5px;border:1px solid var(--line);background:var(--bg);color:inherit}
#janela .jform{display:grid;gap:10px}
#janela .jform label{display:grid;gap:4px;font-size:13px;font-weight:600;color:var(--muted)}
#janela input[type=password]{font:15px var(--body);padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#janela .lgmsg{color:var(--crit);font-size:13px}#janela .lgmsg:empty{display:none}
#janela .acrow{display:flex;gap:8px;flex-wrap:wrap}
#janela .acrow input{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:200px}
</style>'''

out = ('<!doctype html>\n<html lang="pt-BR">\n<head>\n<meta charset="utf-8">\n'
       '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
       + title + '\n<meta name="robots" content="noindex,nofollow">\n<meta name="theme-color" content="#0f1720">\n'
       '<link rel="icon" href="favicon.png">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n'
       '<style>body{margin:0;font-size:14px}img{max-width:100%}[hidden]{display:none!important}</style>\n'
       + CFG + '\n' + SB + '\n<script id="online">\n' + online + '\n</script>\n' + CSS + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
os.makedirs(OUT, exist_ok=True)
open(OUT / 'index.html', 'w').write(out)
for f in ('favicon.png', 'apple-touch-icon.png'):
    shutil.copy(RAIZ / f, OUT / f)
# CSP: só roda o código desta página (pela impressão digital de cada script) e só conversa com o Supabase do painel
import base64
hashes = ["'sha256-" + base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() + "'"
          for m in re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', out, re.S)]
SUPA = 'yqwlxxfwarqnvjeggvvr.supabase.co'
CSP = ("default-src 'self'; script-src 'self' " + " ".join(hashes) + " https://cdn.jsdelivr.net https://unpkg.com; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "img-src 'self' data: blob:; connect-src 'self' https://" + SUPA + " wss://" + SUPA + "; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; worker-src 'self' blob:; manifest-src 'self'")
open(OUT / '_headers', 'w').write('''/*
  Content-Security-Policy: ''' + CSP + '''
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
/index.html
  Cache-Control: no-cache
/
  Cache-Control: no-cache
/*.png
  Cache-Control: public, max-age=604800
''')

print(len(out), hashlib.sha1(out.encode()).hexdigest()[:10])
