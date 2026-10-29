// Icons a session can wear (row menu → Icon & Color…): a curated set of SF Symbols, stored
// on the tab by id so the look can change without touching saved state.
import { Sym } from './icons.jsx';

export const TAB_ICONS = {
  terminal: 'terminal',
  code: 'chevron.left.forwardslash.chevron.right',
  server: 'server.rack',
  database: 'cylinder.split.1x2',
  globe: 'globe',
  cloud: 'cloud',
  network: 'network',
  webhook: 'link',
  container: 'shippingbox',
  package: 'cube.box',
  layers: 'square.3.stack.3d',
  'git-branch': 'arrow.triangle.branch',
  rocket: 'paperplane',
  zap: 'bolt',
  flame: 'flame',
  activity: 'waveform.path.ecg',
  chart: 'chart.line.uptrend.xyaxis',
  cpu: 'cpu',
  'hard-drive': 'internaldrive',
  monitor: 'display',
  smartphone: 'iphone',
  bug: 'ladybug',
  flask: 'flask|testtube.2',
  wrench: 'wrench.and.screwdriver',
  settings: 'gearshape',
  workflow: 'flowchart|square.stack.3d.down.right',
  shield: 'checkmark.shield',
  lock: 'lock',
  key: 'key',
  bot: 'brain|cpu',
  sparkles: 'sparkles',
  atom: 'atom',
  puzzle: 'puzzlepiece',
  book: 'book',
  notebook: 'note.text',
  calendar: 'calendar',
  mail: 'envelope',
  palette: 'paintpalette',
  music: 'music.note',
  coffee: 'cup.and.saucer',
  house: 'house',
  briefcase: 'briefcase',
  target: 'target',
  trophy: 'trophy|rosette',
  star: 'star',
  heart: 'heart',
  leaf: 'leaf',
  anchor: 'sailboat',
};

export function TabIcon({ name, size = 16 }) {
  const symbol = TAB_ICONS[name];
  if (symbol) return <Sym name={symbol} size={size} />;
  return name; // picked before the icon set: an emoji or typed character
}
