// Map geography of Pax Renaissance 2E, transcribed from the mapboard and map card images.
// Religions: C = Catholic (gold), I = Islamic (green), R = Reformist (red).
// Map states: M = Medieval, C/R/I = Theocracy of that religion.
// City levy icons per state: 'K'|'R' (Knight/Rook) + religion letter, e.g. 'KC' = gold Knight.

export const EMPIRES = ['England', 'France', 'HRE', 'Hungary', 'Byzantium', 'Portugal', 'Aragon', 'Papal', 'Ottoman', 'Mamluk'];
export const EAST_EMPIRES = ['Hungary', 'Byzantium', 'Ottoman', 'Mamluk'];
export const WEST_EMPIRES = ['England', 'France', 'HRE', 'Portugal', 'Aragon', 'Papal'];
export const EMPIRE_NAMES = {
  England: 'England', France: 'France', HRE: 'Holy Roman Empire', Hungary: 'Hungary', Byzantium: 'Byzantium',
  Portugal: 'Portugal', Aragon: 'Aragon', Papal: 'Papal States', Ottoman: 'Ottoman', Mamluk: 'Mamluk',
  East: 'The East', West: 'The West',
};
// grid position [col,row]; row 0 = north
export const GRID = {
  England: [0, 0], France: [1, 0], HRE: [2, 0], Hungary: [3, 0], Byzantium: [4, 0],
  Portugal: [0, 1], Aragon: [1, 1], Papal: [2, 1], Ottoman: [3, 1], Mamluk: [4, 1],
};
export const START_STATE = {
  England: 'M', France: 'M', HRE: 'M', Hungary: 'M', Byzantium: 'M',
  Portugal: 'M', Aragon: 'M', Papal: 'C', Ottoman: 'M', Mamluk: 'I',
};

// pos = [x,y] on the 337x514 map card image
export const CITIES = [
  { id: 'London', empire: 'England', capital: true, pos: [215, 215], icons: { M: 'RC', C: 'KC', R: 'KR', I: 'RI' } },
  { id: 'Bordeaux', empire: 'England', pos: [283, 450], icons: { M: 'KC', C: 'KC', R: 'KR', I: 'RI' } },
  { id: 'Bruges', empire: 'France', pos: [155, 180], icons: { M: 'RC', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Paris', empire: 'France', capital: true, pos: [58, 325], icons: { M: 'KC', C: 'KC', R: 'KR', I: 'RI' } },
  { id: 'Lyon', empire: 'France', pos: [245, 405], icons: { M: 'KC', C: 'KC', R: 'KR', I: 'RI' } },
  { id: 'Lubeck', name: 'Lübeck', empire: 'HRE', pos: [100, 130], icons: { M: 'RC', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Novgorod', empire: 'HRE', emporium: 'black', pos: [240, 118], icons: { M: 'RR', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Nurnberg', name: 'Nürnberg', empire: 'HRE', pos: [70, 322], icons: { M: 'KR', C: 'RC', R: 'KR', I: 'RI' } },
  { id: 'Vienna', empire: 'HRE', capital: true, pos: [240, 375], icons: { M: 'RC', C: 'KC', R: 'KR', I: 'KI' } },
  { id: 'Buda', empire: 'Hungary', capital: true, pos: [72, 393], icons: { M: 'KC', C: 'KC', R: 'RR', I: 'KI' } },
  { id: 'Varna', empire: 'Hungary', pos: [210, 420], icons: { M: 'KR', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Tana', empire: 'Byzantium', capital: true, emporium: 'black', pos: [130, 130], icons: { M: 'KI', C: 'RC', R: 'RR', I: 'KI' } },
  { id: 'Caffa', empire: 'Byzantium', pos: [52, 333], icons: { M: 'KC', C: 'KC', R: 'RR', I: 'RI' } },
  { id: 'Trebizond', empire: 'Byzantium', emporium: 'white', pos: [290, 455], icons: { M: 'RR', C: 'RC', R: 'KR', I: 'KI' } },
  { id: 'Toledo', empire: 'Portugal', capital: true, pos: [255, 180], icons: { M: 'KC', C: 'KC', R: 'RR', I: 'RI' } },
  { id: 'Granada', empire: 'Portugal', pos: [268, 305], icons: { M: 'RI', C: 'RC', R: 'RR', I: 'KI' } },
  { id: 'SpiceIslands', name: 'Spice Islands', empire: 'Portugal', emporium: 'white', pos: [123, 452], icons: { M: 'RC', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Valencia', empire: 'Aragon', capital: true, pos: [65, 160], icons: { M: 'KC', C: 'KC', R: 'RR', I: 'RI' } },
  { id: 'Algiers', empire: 'Aragon', pos: [265, 355], icons: { M: 'RI', C: 'RC', R: 'RR', I: 'KI' } },
  { id: 'Timbuktu', empire: 'Aragon', emporium: 'black', pos: [115, 410], icons: { M: 'RI', C: 'RC', R: 'RR', I: 'KI' } },
  { id: 'Venice', empire: 'Papal', capital: true, pos: [130, 75], icons: { M: 'KC', C: 'KC', R: 'RR', I: 'RI' } },
  { id: 'Constantinople1', name: 'Constantinople', empire: 'Ottoman', capital: true, pos: [60, 95], icons: { M: 'RI', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Constantinople2', name: 'Constantinople', empire: 'Ottoman', capital: true, pos: [145, 95], icons: { M: 'KI', C: 'KC', R: 'KR', I: 'RI' } },
  { id: 'Constantinople3', name: 'Constantinople', empire: 'Ottoman', capital: true, pos: [225, 95], icons: { M: 'KI', C: 'KC', R: 'KR', I: 'KI' } },
  { id: 'Modon', empire: 'Ottoman', pos: [82, 255], icons: { M: 'RR', C: 'RC', R: 'RR', I: 'RI' } },
  { id: 'Rhodes', empire: 'Ottoman', pos: [282, 235], icons: { M: 'RC', C: 'KC', R: 'RR', I: 'RI' } },
  { id: 'Cyprus', empire: 'Mamluk', pos: [165, 210], icons: { M: 'RC', C: 'RC', R: 'KR', I: 'RC' } },
  { id: 'Cairo', empire: 'Mamluk', capital: true, pos: [143, 382], icons: { M: 'RI', C: 'RC', R: 'KR', I: 'RI' } },
  { id: 'RedSea', name: 'Red Sea', empire: 'Mamluk', emporium: 'white', pos: [277, 385], icons: { M: 'RI', C: 'RC', R: 'KR', I: 'RI' } },
];
export const CITY = Object.fromEntries(CITIES.map(c => [c.id, c]));
export const EMPORIA = { black: ['Tana', 'Novgorod', 'Timbuktu'], white: ['Trebizond', 'SpiceIslands', 'RedSea'] };

// 13 borders. sea = crossed by an (active or inactive) trade route.
export const BORDERS = [
  { id: 'England-France', a: 'England', b: 'France', sea: true },
  { id: 'France-HRE', a: 'France', b: 'HRE', sea: true, start: 'Fugger', name: 'Augsburg' },
  { id: 'HRE-Hungary', a: 'HRE', b: 'Hungary', sea: false },
  { id: 'Hungary-Byzantium', a: 'Hungary', b: 'Byzantium', sea: true },
  { id: 'Portugal-Aragon', a: 'Portugal', b: 'Aragon', sea: true },
  { id: 'Aragon-Papal', a: 'Aragon', b: 'Papal', sea: true, start: 'Medici', name: 'Florence' },
  { id: 'Papal-Ottoman', a: 'Papal', b: 'Ottoman', sea: true },
  { id: 'Ottoman-Mamluk', a: 'Ottoman', b: 'Mamluk', sea: true, start: 'Coeur', name: 'Alexandria' },
  { id: 'England-Portugal', a: 'England', b: 'Portugal', sea: true, start: 'Marchionni', name: 'Lisbon' },
  { id: 'France-Aragon', a: 'France', b: 'Aragon', sea: false },
  { id: 'HRE-Papal', a: 'HRE', b: 'Papal', sea: false },
  { id: 'Hungary-Ottoman', a: 'Hungary', b: 'Ottoman', sea: true },
  { id: 'Byzantium-Mamluk', a: 'Byzantium', b: 'Mamluk', sea: false },
];
export const BORDER = Object.fromEntries(BORDERS.map(b => [b.id, b]));
export function borderBetween(x, y) {
  return BORDERS.find(b => (b.a === x && b.b === y) || (b.a === y && b.b === x)) || null;
}
export function bordersOf(e) { return BORDERS.filter(b => b.a === e || b.b === e); }

// Trade routes: sequence of empires from the starting emporium to the arrowhead.
export const ROUTES = {
  Trebizond: ['Byzantium', 'Hungary', 'Ottoman', 'Papal', 'Aragon', 'Portugal', 'England', 'France', 'HRE'],
  RedSea: ['Mamluk', 'Ottoman', 'Papal', 'Aragon', 'Portugal', 'England', 'France', 'HRE'],
  SpiceIslands: ['Portugal', 'England', 'France', 'HRE'],
  Tana: ['Byzantium', 'Hungary', 'Ottoman', 'Mamluk'],
  Novgorod: ['HRE', 'France', 'England', 'Portugal', 'Aragon', 'Papal', 'Ottoman', 'Mamluk'],
  Timbuktu: ['Aragon', 'Papal', 'Ottoman', 'Mamluk'],
};

export const START_TOKENS = [
  ['London', 'R', 'C'], ['Paris', 'K', 'C'], ['Vienna', 'R', 'C'], ['Buda', 'K', 'C'], ['Tana', 'K', 'I'],
  ['Toledo', 'K', 'C'], ['Valencia', 'K', 'C'], ['Venice', 'K', 'C'],
  ['Constantinople1', 'R', 'I'], ['Constantinople2', 'K', 'I'], ['Constantinople3', 'K', 'I'], ['Cairo', 'R', 'I'],
];

export const BANKS = {
  Fugger: { color: 'blue', css: '#2f7fe0', name: 'Fugger Bank of Augsburg' },
  Medici: { color: 'yellow', css: '#e3c51b', name: 'Medici Bank of Florence' },
  Coeur: { color: 'purple', css: '#8e44c9', name: 'Coeur Bank' },
  Marchionni: { color: 'green', css: '#33b24a', name: 'Marchionni Bank of Lisbon' },
};

// Board image coordinates (6732 x 6732 mapboard image).
export const BOARD = {
  size: 6732,
  slot(e) { const [c, r] = GRID[e]; return { x: 1576 + 784 * c, y: r === 0 ? 1218 : 2366, w: 676, h: 1031 }; },
  cityPos(id) { const c = CITY[id]; const s = this.slot(c.empire); return [s.x + c.pos[0] * s.w / 337, s.y + c.pos[1] * s.h / 514]; },
  borderPos(id) {
    const b = BORDER[id]; const A = this.slot(b.a), B = this.slot(b.b);
    if (GRID[b.a][1] === GRID[b.b][1]) return [(A.x + A.w + B.x) / 2, A.y + A.h * (GRID[b.a][1] === 0 ? 0.62 : 0.4)];
    return [A.x + A.w * 0.5, (A.y + A.h + B.y) / 2];
  },
  throne(e) { const [c, r] = GRID[e]; return { x: 1576 + 784 * c + 25, y: r === 0 ? 570 : 3440, w: 630, h: 630 }; },
  victory: { renaissance: [600, 560], globalization: [600, 1350], imperial: [600, 2620], holy: [600, 3410], w: 700, h: 700 },
  china: [6050, 700],
  market(row, i) { return { x: 410 + 757 * i, y: row === 'W' ? 4290 : 5400, w: 673, h: 1010 }; },
  deck(row) { return { x: 4920, y: row === 'W' ? 4290 : 5400, w: 673, h: 1010 }; },
};
