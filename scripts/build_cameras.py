#!/usr/bin/env python3
"""Merge the camera lists in sources/ into cctv/data/cameras.json.

Longdo/iTIC cameras are not included here: the page loads them live from
traffic.longdo.com/camera.json. Duplicates of those DOH codes are skipped.

Each camera: {id, src, title, org, lat, lng, kind, url}
  kind: hls | mjpeg | jpeg | iframe | link
"""
import json, os, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'sources')
OUT = os.path.join(ROOT, 'cctv', 'data', 'cameras.json')


def load(name):
    with open(os.path.join(SRC, name), encoding='utf-8-sig') as f:
        d = json.load(f)
    return d['cameras'] if isinstance(d, dict) and 'cameras' in d else d


def longdo_doh_codes():
    try:
        with urllib.request.urlopen('https://traffic.longdo.com/camera.json', timeout=30) as r:
            items = json.load(r)['item']
        return {c['camid'].removeprefix('DOH-').split('_')[0] for c in items if c['camid'].startswith('DOH-')}
    except Exception as e:
        print('warning: could not fetch Longdo list, DOH duplicates kept:', e)
        return set()


def doh(skip):
    names = {s['siteId']: s for s in load('doh-highwaytraffic.json')}
    ok = {}
    for s in load('doh-highwaytraffic.json'):
        ok.update({u: str(c) for u, c in s.get('hls_probe', {}).items()})
    for s in load('doh_highway_cameras.json'):
        ok.update(dict(zip(s['streams'], s['streamHttp'])))
    seen, out = set(), []
    for s in load('doh_highway_cameras.json') + load('doh-highwaytraffic.json'):
        if s['code'] in skip:
            continue
        info = names.get(s['siteId'], s)
        streams = s.get('streams') or s.get('hls') or []
        dirs = s.get('directions') or []
        for i, url in enumerate(streams):
            if url in seen or ok.get(url) != '200':
                continue
            seen.add(url)
            d = dirs[i] if i < len(dirs) else ''
            out.append(dict(id=f"doh-{s['code']}-{i}", src='doh',
                            title=' · '.join(x for x in [info.get('name') or s['code'], d] if x),
                            org='กรมทางหลวง', lat=s['lat'], lng=s['lng'], kind='hls', url=url))
    return out


def dwr():
    return [dict(id='dwr-' + c['stationCode'], src='dwr',
                 title=f"{c['nameTh']} · อ.{c['districtTh']} จ.{c['provinceTh']}",
                 org='กรมทรัพยากรน้ำ', lat=c['lat'], lng=c['lon'], kind='mjpeg', url=c['mjpeg'])
            for c in load('dwr_cameras.json') if c.get('lat') and c.get('lon') and c.get('cctvOnline')]


def hatyai():
    return [dict(id='hatyai-' + (c['code'] or str(c['cameraId'])), src='hatyai', title=(c['title'] or c['name']) + ' (หาดใหญ่)',
                 org=c.get('sponsorName') or 'Hat Yai City Climate',
                 lat=c['location']['latitude'], lng=c['location']['longitude'], kind='jpeg', url=c['photo'])
            for c in load('hatyai_flood_cams.json')['items']
            if c.get('enable') and c.get('location', {}).get('latitude')]


def gistda():
    return [dict(id='gistda-' + c['code'], src='gistda', title=c['site'], org='GISTDA (เรดาร์ชายฝั่ง)',
                 lat=c['lat'], lng=c['lng'], kind='iframe', url=c['page'])
            for c in load('gistda_coastal_cctv.json') if c.get('hlsHttp') == '200' and c.get('lat')]


def bma():
    return [dict(id='bma-' + c['id'], src='bma', title=c['name'], org='กรุงเทพมหานคร (สจส.)',
                 lat=c['lat'], lng=c['lng'], kind='link', url=c['viewer_url'])
            for c in load('bmatraffic-wayback-2025-07.json') if c.get('lat') and c.get('lng')]


def pattaya():
    return [dict(id='pattaya-' + c['id'], src='pattaya', title=f"{c['location']} ({c['name']})",
                 org='เมืองพัทยา', lat=c['lat'], lng=c['lng'], kind='link', url='https://livestream.pattaya.go.th/')
            for c in load('pattaya_livestream_map.json')['details']['items']
            if c.get('lat') and c.get('lng') and c.get('monitorState') == 'online']


if __name__ == '__main__':
    cams = doh(longdo_doh_codes()) + dwr() + hatyai() + gistda() + bma() + pattaya()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(cams, f, ensure_ascii=False, separators=(',', ':'))
    counts = {}
    for c in cams:
        counts[c['src']] = counts.get(c['src'], 0) + 1
    print(len(cams), counts, '->', OUT)
