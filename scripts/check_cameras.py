#!/usr/bin/env python3
"""Probe every playable camera and write cctv/data/status.json.

status.json: {"checked": ISO time, "cams": {id: {"ok": bool, "why": str}}}
The page hides cameras marked ok=false (they can be shown again with a toggle).

HLS: playlist must load and its newest segment must download.
MJPEG / JPEG: must return image bytes.
Also records whether the BMA Traffic website (outbound links) is reachable: status['sites']['bma'].
"""
import json, os, ssl, sys, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get('CCTV_DATA', os.path.join(ROOT, 'cctv', 'data'))
OUT = os.environ.get('CCTV_STATUS', os.path.join(DATA, 'status.json'))
UA = {'User-Agent': 'Mozilla/5.0 (cctvbkk camera check)'}
TIMEOUT = 12
MJPEG_TIMEOUT = 25  # DWR can take >12 s before the first frame
# Some agency servers ship an incomplete TLS chain. Browsers usually repair it; we only probe here.
CTX = ssl.create_default_context()
LAX = ssl._create_unverified_context()


def get(url, limit=None, lax=False, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout, context=LAX if lax else CTX) as r:
        return r.status, r.headers.get('Content-Type', ''), r.read(limit) if limit else r.read()


def fetch(url, limit=None, timeout=TIMEOUT):
    try:
        return get(url, limit, timeout=timeout) + (False,)
    except ssl.SSLError:
        return get(url, limit, lax=True, timeout=timeout) + (True,)
    except urllib.error.URLError as e:
        if isinstance(e.reason, ssl.SSLError):
            return get(url, limit, lax=True, timeout=timeout) + (True,)
        raise


def check_hls(url, depth=0):
    code, _, body, bad_tls = fetch(url)
    text = body.decode('utf-8', 'ignore')
    if '#EXTM3U' not in text:
        return False, 'playlist ไม่ถูกต้อง'
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith('#')]
    if not lines:
        return False, 'playlist ว่าง'
    nxt = urllib.parse.urljoin(url, lines[-1])
    if '.m3u8' in lines[-1] and depth < 2:
        return check_hls(nxt, depth + 1)
    code, _, seg, bad2 = fetch(nxt, 4096)
    if len(seg) < 188:
        return False, 'segment ว่าง'
    return True, 'TLS chain ไม่ครบ' if bad_tls or bad2 else ''


def check_image(url, timeout=TIMEOUT):
    code, ctype, body, bad_tls = fetch(url, 20000, timeout)
    if len(body) < 500 or not (b'\xff\xd8' in body[:4096] or ctype.startswith(('image/', 'multipart/'))):
        return False, 'ไม่มีภาพ'
    return True, ''


BMA_HOSTS = ['http://www.bmatraffic.com/', 'https://cpudapp.bangkok.go.th/bmatraffic/']


def check_bma_site():
    for base in BMA_HOSTS:
        try:
            code, _, body, _ = fetch(base, 4000, 25)
            if code == 200 and len(body) > 500:
                return {'up': True, 'base': base, 'checked': now()}
        except Exception:
            pass
    return {'up': False, 'checked': now()}


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def check(c):
    try:
        if c['kind'] == 'hls':
            ok, why = check_hls(c['url'])
            if not ok and c.get('snap'):
                sok, _ = check_image(c['snap'])
                if sok:
                    return c['id'], {'ok': True, 'why': 'วิดีโอเสีย ใช้ภาพนิ่งแทน', 'fallback': True}
            return c['id'], {'ok': ok, 'why': why}
        if c['kind'] in ('mjpeg', 'jpeg'):
            t = MJPEG_TIMEOUT if c['kind'] == 'mjpeg' else TIMEOUT
            return c['id'], dict(zip(('ok', 'why'), check_image(c['url'], t)))
        if c['kind'] == 'iframe':
            code, *_ = fetch(c['url'], 2000)
            return c['id'], {'ok': code == 200, 'why': ''}
    except Exception as e:
        return c['id'], {'ok': False, 'why': type(e).__name__ + ': ' + str(e)[:80]}
    return c['id'], None


def longdo():
    with urllib.request.urlopen(urllib.request.Request('https://traffic.longdo.com/camera.json', headers=UA), timeout=30) as r:
        items = json.load(r)['item']
    out = []
    for c in items:
        video = c.get('hls_url') and 'tempsus' not in c['hls_url']
        snap = c.get('imgurl') if c.get('imgurl') and 'X.X.X.X' not in c['imgurl'] else None
        if video or snap:
            out.append({'id': 'itic-' + c['camid'], 'kind': 'hls' if video else 'jpeg',
                        'url': c['hls_url'] if video else snap, 'snap': snap, 'title': c['title']})
    return out


if __name__ == '__main__':
    cams = json.load(open(os.path.join(DATA, 'cameras.json'), encoding='utf-8'))
    cams += longdo()
    cams = [c for c in cams if c['kind'] != 'link']
    t0 = time.time()
    with ThreadPoolExecutor(32) as ex:
        bma = ex.submit(check_bma_site)
        res = {k: v for k, v in ex.map(check, cams) if v}
        sites = {'bma': bma.result()}
    with open(OUT + '.tmp', 'w', encoding='utf-8') as f:
        json.dump({'checked': now(), 'sites': sites, 'cams': res}, f, ensure_ascii=False)
    os.replace(OUT + '.tmp', OUT)
    by = {}
    for c in cams:
        s = c['id'].split('-')[0]; r = res.get(c['id'], {})
        by.setdefault(s, [0, 0]); by[s][0 if r.get('ok') else 1] += 1
    print(f'{len(res)} checked in {time.time() - t0:.0f}s · BMA site', 'UP ' + sites['bma']['base'] if sites['bma']['up'] else 'DOWN')
    for s, (ok, bad) in sorted(by.items()):
        print(f'  {s:8} ok {ok:4}  dead {bad:4}')
    if '-v' in sys.argv:
        for c in cams:
            r = res.get(c['id'])
            if r and (not r['ok'] or r['why']):
                print(c['id'], r, c.get('title', '')[:50])
