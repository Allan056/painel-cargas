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
SB = '''<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js" onerror="var s=document.createElement('script');s.src='https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js';document.head.appendChild(s);this.remove()"></script>'''
CSS = '''<style id="online-st">
html.semlogin body>#app{visibility:hidden}
#login{position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:24px;background:var(--bg);overflow:auto}
#login .lg{width:min(380px,100%);display:grid;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:26px 24px;box-shadow:0 10px 30px var(--shade)}
#login h1{margin:0 0 2px}
#login label{display:grid;gap:5px;font-size:13px;font-weight:600;color:var(--muted)}
#login input{font:inherit;font-size:15px;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#login input:focus{outline:2px solid var(--accent);outline-offset:1px}
#login .btn{justify-content:center;padding:10px;font-size:15px}
#login .lgtab{justify-self:start}
#login .lgmsg{color:var(--crit);font-size:13px;min-height:0}
#login .lgmsg:empty{display:none}
#login .lgok{color:var(--ok);font-size:13px}
#login .lglink{all:unset;cursor:pointer;justify-self:center;font-size:13px;color:var(--accent);text-decoration:underline}
#login p{margin:0}
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
open(OUT / '_headers', 'w').write('''/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/index.html
  Cache-Control: no-cache
/*.png
  Cache-Control: public, max-age=604800
''')
print(len(out), hashlib.sha1(out.encode()).hexdigest()[:10])
