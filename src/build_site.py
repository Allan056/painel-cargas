"""Gera o site online do Painel de Cargas (Netlify + Supabase) a partir do mesmo painel-cargas.html."""
import re, os, shutil, hashlib
SRC = '/home/claude/painel/painel-cargas.html'
OUT = '/home/claude/site/dist'
src = open(SRC).read()
online = open('/home/claude/site/online.js').read()

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
#login{position:fixed;inset:0;z-index:60;overflow:auto;background:#081230;display:grid;place-items:center;padding:28px}
#login>.cena{position:fixed}
#login .land{position:relative;z-index:1;width:min(410px,100%)}
#login .lbrand{display:flex;align-items:center;gap:10px;font:700 17px var(--display);color:var(--fg);margin-bottom:6px}
#login .logo{width:36px;height:36px;border-radius:8px;display:grid;place-items:center;color:var(--destaque-fg,#2d3277);background:var(--destaque,#ffe600)}
#login .logo svg{width:22px;height:22px}
#login .lequipe{font:500 14px var(--body);color:var(--muted);padding-left:10px;border-left:1px solid var(--line-forte)}
#login .lg{width:100%;box-sizing:border-box;display:grid;gap:14px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:26px 26px 22px;box-shadow:0 24px 60px rgba(2,6,24,.55);position:relative}
#login .lg.solo{width:min(400px,100%)}
#login .lg h2{font:700 24px var(--display);margin:4px 0 0}
#login label{display:grid;gap:6px;font-size:14px;font-weight:600;color:var(--fg)}
#login input{font:inherit;font-size:16px;min-height:44px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--line-forte);border-radius:8px;background:var(--surface);color:var(--fg)}
#login input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
#login .btn{justify-content:center;min-height:46px;font-size:15px;border-radius:8px}
#login .lgtab{justify-self:start}
#login .lgmsg{color:var(--crit);font-size:13.5px}
#login .lgmsg:empty{display:none}
#login .lgok{color:var(--ok);font-size:13.5px}
#login .lglink{all:unset;cursor:pointer;justify-self:center;font-size:14px;color:var(--accent);text-decoration:underline;text-underline-offset:3px;padding:6px}
:root[data-tema="escuro"] #login .lglink{color:var(--fg)}
#login p{margin:0}
#login .small{color:var(--muted);font-size:13.5px}
#login .lalerta{font-size:13.5px;line-height:1.45;color:var(--fg);background:var(--warn-bg);border:1px solid color-mix(in srgb,var(--warn) 45%,transparent);border-radius:8px;padding:10px 12px}
@media (max-width:560px){#login{padding:16px}#login .lg{padding:22px 18px 18px}}
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
       + title + '\n<meta name="robots" content="noindex,nofollow">\n<meta name="theme-color" content="#0f1c42">\n'
       '<link rel="icon" href="favicon.png">\n<link rel="apple-touch-icon" href="apple-touch-icon.png">\n'
       '<style>body{margin:0;font-size:14px}img{max-width:100%}[hidden]{display:none!important}</style>\n'
       + CFG + '\n' + SB + '\n<script id="online">\n' + online + '\n</script>\n' + CSS + '\n</head>\n<body>\n' + body + '\n</body>\n</html>\n')
os.makedirs(OUT, exist_ok=True)
open(OUT + '/index.html', 'w').write(out)
for f in ('favicon.png', 'apple-touch-icon.png'):
    shutil.copy('/home/claude/app/' + f, OUT + '/' + f)
# CSP: só roda o código desta página (pela impressão digital de cada script) e só conversa com o Supabase do painel
import base64
hashes = ["'sha256-" + base64.b64encode(hashlib.sha256(m.encode()).digest()).decode() + "'"
          for m in re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', out, re.S)]
SUPA = 'yqwlxxfwarqnvjeggvvr.supabase.co'
CSP = ("default-src 'self'; script-src 'self' " + " ".join(hashes) + " https://cdn.jsdelivr.net https://unpkg.com; "
       "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; "
       "img-src 'self' data: blob:; connect-src 'self' https://" + SUPA + " wss://" + SUPA + "; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'; worker-src 'self' blob:; manifest-src 'self'")
open(OUT + '/_headers', 'w').write('''/*
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
open(OUT + '/csp.txt', 'w').write(CSP)
print(len(out), hashlib.sha1(out.encode()).hexdigest()[:10])
