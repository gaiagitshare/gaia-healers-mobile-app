"""Pull the contact details a company already publishes on its own site.

Only what is on the page: mailto:, tel:, a postal address, and the meta
description. Nothing inferred, nothing guessed -- a blank stays blank, because a
directory entry with a wrong phone number is worse than one with none.
"""
import json, re, subprocess, sys, html
from urllib.parse import urljoin

SITES = json.load(open("sites.json"))
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36"

def get(url, timeout=20):
    try:
        r = subprocess.run(["curl","-sL","--max-time",str(timeout),"-A",UA,url],
                           capture_output=True, text=True, errors="ignore")
        return r.stdout or ""
    except Exception:
        return ""

def clean(t):
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", t, flags=re.S|re.I)
    return html.unescape(re.sub(r"<[^>]+>", " ", t))

BAD_MAIL = re.compile(r"(sentry|example|\.png|\.jpg|wixpress|@2x|u003)", re.I)
def emails(t):
    got = re.findall(r'mailto:([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})', t)
    got += re.findall(r'\b([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b', clean(t))
    out=[]
    for e in got:
        e=e.strip().lower()
        if BAD_MAIL.search(e) or e in out: continue
        out.append(e)
    return out

def phones(t):
    got = re.findall(r'tel:\+?([0-9\-\.\(\)\s]{7,})', t)
    txt = clean(t)
    got += re.findall(r'(\+?1?[\s\-\.]?\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})', txt)
    out=[]
    for p in got:
        d = re.sub(r"\D","",p)
        if not (10 <= len(d) <= 13): continue
        f = "+1 (%s) %s-%s" % (d[-10:-7], d[-7:-4], d[-4:]) if len(d) in (10,11) else "+"+d
        if f not in out: out.append(f)
    return out

def address(t):
    txt = re.sub(r"\s+"," ", clean(t))
    m = re.findall(r'(\d{1,6}[^,]{3,40},\s*[A-Za-z .\'-]{2,30},\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\s*\d{5})', txt)
    return m[0].strip() if m else ""

def meta_desc(t):
    for pat in (r'<meta[^>]+name="description"[^>]+content="([^"]{20,300})"',
                r'<meta[^>]+property="og:description"[^>]+content="([^"]{20,300})"'):
        m = re.search(pat, t, re.I)
        if m: return html.unescape(m.group(1)).strip()
    return ""

out={}
for name, url in SITES.items():
    if not url.startswith("http"): url = "https://" + url
    body = get(url)
    if not body:
        out[name]={"ok":False}; print("%-30s  no response" % name[:30]); continue
    e, p, a, d = emails(body), phones(body), address(body), meta_desc(body)
    # a contact page usually carries what the homepage does not
    if not (e and p and a):
        m = re.search(r'href="([^"]*contact[^"]*)"', body, re.I)
        if m:
            body2 = get(urljoin(url, html.unescape(m.group(1))))
            e = e or emails(body2); p = p or phones(body2); a = a or address(body2)
    out[name] = {"ok":True,"email":e[0] if e else "","phone":p[0] if p else "",
                 "address":a,"desc":d,"url":url}
    print("%-30s  %-30s %-18s %s" % (name[:30], (e[0] if e else "-")[:30], (p[0] if p else "-"), a[:34] or "-"))
json.dump(out, open("scraped.json","w"), indent=1)
