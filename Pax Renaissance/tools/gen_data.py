# Generates src/data/cards.js and src/data/assets.js from the transcribed card data
# (tools/cards_all.json, tools/data_empires.json) and the image URL map (tools/urlmap.json).
# Only image URLs are taken from the TTS save file.
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
P = os.path.dirname(HERE)
urlmap = json.load(open(os.path.join(HERE, 'urlmap.json')))
U = {l.replace(' ', '_'): u for u, l in urlmap}


def u(prefix):
    for l, url in U.items():
        if l.startswith(prefix):
            return url
    raise Exception(prefix)


LOC = {'England': 'England', 'France': 'France', 'Holy Roman Empire': 'HRE', 'Hungary': 'Hungary',
       'Byzantium': 'Byzantium', 'Portugal': 'Portugal', 'Aragon': 'Aragon', 'Papal States': 'Papal',
       'Ottoman': 'Ottoman', 'Mamluk': 'Mamluk', 'The East': 'East', 'The West': 'West', None: None}
REL = {'catholic': 'C', 'islamic': 'I', 'reformist': 'R'}
SHEETS = {527: (6, 4), 528: (6, 4), 529: (6, 4), 531: (6, 4), 532: (6, 4), 533: (6, 4), 534: (6, 4),
          530: (2, 2), 535: (2, 2)}
cards = json.load(open(os.path.join(HERE, 'cards_all.json'), encoding='utf-8'))
out = []
for c in cards:
    ab = c['ability']
    if c['id'] == 'PREN164X' and not any('SLAVE' in (a.get('name') or '') for a in ab):
        ab.append({'name': 'SLAVE SOLDIERS',
                   'text': 'Each Repressed Token in Mamluk counts as a Knight in your East campaign.',
                   'allPlayers': False})
    ops = []
    for o in c['ops']:
        d = {'type': o['type']}
        if 'religion' in o:
            d['religion'] = REL[o['religion']]
        if 'market' in o:
            d['market'] = o['market']
        if o['type'] == 'repress':
            d['targets'] = o.get('targets') or ['pawn', 'rook', 'knight']
        ops.append(d)
    os_ = c['oneShot']
    if os_:
        t = os_['type']
        d = {'type': t}
        if t == 'apostasy':
            d['religions'] = [REL[r] for r in os_['religions']]
        if t == 'trade_shift':
            d['emporium'] = os_['emporium'].replace(' ', '')
            d['requires'] = os_.get('requires')
        os_ = d
    agents = []
    for a in c['agents']:
        d = {'type': a['type']}
        if a.get('color'):
            d['color'] = REL[a['color']]
        agents.append(d)
    out.append({'id': c['id'], 'name': c['name'], 'side': c['side'], 'loc': LOC[c['location']],
                'prestige': c['prestige'], 'ops': ops, 'oneShot': os_, 'agents': agents,
                'suitors': [LOC[s] for s in c['suitors']] if c.get('suitors') else None,
                'abilities': [{'name': a.get('name') or '', 'text': a['text'], 'all': bool(a.get('allPlayers'))} for a in ab],
                'img': [c['sheet'], c['index']]})
for s, side in ((530, 'E'), (535, 'W')):
    for i in range(2):
        out.append({'id': 'COMET_%s%d' % (side, i), 'name': 'Comet', 'side': side, 'loc': None, 'prestige': [],
                    'ops': [], 'oneShot': None, 'agents': [], 'suitors': None, 'abilities': [], 'img': [s, i],
                    'comet': True})
emp = json.load(open(os.path.join(HERE, 'data_empires.json'), encoding='utf-8'))
E = {}
EIMG = {}


def side(x):
    return {'name': x['name'], 'prestige': x['prestige'],
            'ops': [dict({'type': o['type']}, **({'market': o['market']} if 'market' in o else {})) for o in x['ops']]}


for e in emp:
    k = LOC[e['empire']]
    E[k] = {'side': e['side'], 'king': side(e['king']), 'republic': side(e['republic'])}
    EIMG[k] = {'king': u('Empire_Card_%s_a' % e['guid']), 'republic': u('Empire_Card_%s_b' % e['guid'])}
sheets = {k: {'url': u('sheet_%d' % k), 'cols': v[0], 'rows': v[1]} for k, v in SHEETS.items()}


def tile(g):
    for pre in ('Custom_Tile_', 'Ottoman_Map_', 'Hungary_Map_'):
        try:
            return u(pre + g)
        except Exception:
            pass
    raise Exception(g)


# order per empire: [Medieval, Catholic, Reformist, Islamic] (base tile first)
MAPS = {'England': ['53c078', '256a29', 'f04ba3', 'a44015'], 'France': ['a612db', 'dd89dd', '3f1285', 'd37f68'],
        'HRE': ['018ce4', 'e57fb9', '0c60f4', '9f29a3'], 'Hungary': ['47c43e', '67ecd2', '0898a1', '546702'],
        'Byzantium': ['5e53c0', '5ce9ba', 'f8fb33', '87f749'], 'Portugal': ['f1ef5b', '90f577', '4cc69c', '07cab0'],
        'Aragon': ['2e4c42', '10716c', 'e2a8ee', 'd218f8'], 'Ottoman': ['a114bd', 'fd62cc', 'c4353c', '72be71']}
mapimg = {k: dict(zip('MCRI', [tile(g) for g in l])) for k, l in MAPS.items()}
mapimg['Papal'] = {'C': tile('2dbbe6'), 'M': tile('f80c42'), 'R': tile('e44e97'), 'I': tile('d43286')}
mapimg['Mamluk'] = {'I': tile('338e5d'), 'M': tile('36b1c0'), 'C': tile('c35f4b'), 'R': tile('979abe')}


def vic(n):
    a = [l for l in U if l.startswith('%s_Victory_Card' % n)]
    return {'active': U[[l for l in a if l.endswith('_a')][0]], 'inactive': U[[l for l in a if l.endswith('_b')][0]]}


assets = {'board': u('MapBoard_Large'), 'background': u('Background_Artwork'),
          'cardBack': {'E': u('back_527'), 'W': u('back_531')},
          'sheets': sheets, 'empires': EIMG, 'maps': mapimg,
          'victory': {k: vic(n) for k, n in [('holy', 'Holy'), ('imperial', 'Imperial'), ('globalization', 'Globalization'), ('renaissance', 'Renaissance')]},
          'placards': {b: u('%s_Placard' % b) for b in ['Fugger', 'Medici', 'Coeur', 'Marchionni']},
          'playerAid': u('Player_Aid')}
open(os.path.join(P, 'src', 'data', 'cards.js'), 'w', encoding='utf-8').write(
    '// Card data transcribed from the card images (generated by tools/gen_data.py).\nexport const CARDS = '
    + json.dumps(out, ensure_ascii=False, indent=0) + ';\nexport const EMPIRE_SQUARES = '
    + json.dumps(E, ensure_ascii=False, indent=1) + ';\n')
open(os.path.join(P, 'src', 'data', 'assets.js'), 'w', encoding='utf-8').write(
    '// Image asset URLs (only the URLs are taken from the Tabletop Simulator save).\nexport const ASSETS = '
    + json.dumps(assets, indent=1) + ';\n')
print(len(out))
