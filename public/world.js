// Office layout: an open-plan floor with a grid of cubicles (one per session, 8 per row,
// grouped by project), aisles between rows, side corridors, and a common area
// (kitchen, gym, game room, lounge) at the bottom.
export const CUBES_PER_ROW = 8;
const CUBE_W = 4;       // shared partition + 3 tiles inside
const ROW_PITCH = 4;    // 2 aisle rows + seat row + desk row
const X_CUBES = 3;      // first partition column (0 outer wall, 1-2 left corridor)
export const W = X_CUBES + CUBES_PER_ROW * CUBE_W + 4; // + last partition, right corridor, outer wall

function hueOf(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360; }
function hsl2hex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return `#${[f(0), f(8), f(4)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}
export const projectColor = project => hsl2hex(hueOf(project || '?'), 45, 55);

export const EXEC_LEVEL = 5; // agents at this level or above get a private office
const OFFICES_PER_ROW = 4;
const OFFICE_PITCH = 7;       // top wall, 4 inner rows, bottom wall with door, aisle

export function buildWorld(sessions, { pm = null } = {}) {
  const exec = sessions.filter(s => (s.level || 1) >= EXEC_LEVEL);
  const cube = sessions.filter(s => (s.level || 1) < EXEC_LEVEL);
  const officeRows = Math.ceil(exec.length / OFFICES_PER_ROW);
  const base = officeRows ? officeRows * OFFICE_PITCH : 0; // cubicle area starts on the last office aisle (offices start at y=1)
  const rows = cube.length ? Math.ceil(cube.length / CUBES_PER_ROW) : (exec.length ? 0 : 1);
  const yCommon = base + 3 + rows * ROW_PITCH;
  const H = yCommon + 20; // common area (kitchen/gym/games/lounge) + meeting room below it
  const tiles = Array.from({ length: H }, () => Array.from({ length: W }, () => ({ kind: 'wall' })));
  const set = (x, y, kind, extra) => { if (tiles[y]?.[x]) tiles[y][x] = { kind, ...extra }; };
  const objects = [];
  const spots = [];
  const rooms = [];   // one cubicle or private office per session
  const zones = [];

  // open floor: everything between the outer walls is carpet/aisle
  for (let y = 1; y < yCommon; y++) for (let x = 1; x < W - 1; x++) set(x, y, 'hall');
  // agents arrive and leave through the elevator (top of the right corridor)
  const elevator = { type: 'elevator', x: W - 3, y: 0, w: 2, h: 1, wall: true, open: 0 };
  objects.push(elevator);
  const spawn = { x: W - 3, y: 1 };
  if (!officeRows) for (let x = 2; x < W - 6; x += 5) objects.push({ type: 'window', x, y: 0, w: 2, h: 1, wall: true });

  // executive wing: private offices for high-level agents
  for (let i = 0; i < officeRows * OFFICES_PER_ROW; i++) {
    const r = Math.floor(i / OFFICES_PER_ROW), c = i % OFFICES_PER_ROW;
    const wl = X_CUBES + c * 8, top = 1 + r * OFFICE_PITCH; // y=0 stays outer wall: headroom for speech bubbles
    for (let x = wl; x <= wl + 8; x++) { set(x, top, 'wall'); set(x, top + 5, 'wall'); }
    for (let y = top; y <= top + 5; y++) { set(wl, y, 'wall'); set(wl + 8, y, 'wall'); }
    const s = exec[i];
    const tint = s ? projectColor(s.project) : '#8d8a84';
    // an empty office has no door: seal it so nobody can end up inside
    for (let y = top + 1; y <= top + 4; y++) for (let x = wl + 1; x <= wl + 7; x++) set(x, y, 'room', { tint, sealed: !s });
    if (!s) { objects.push({ type: 'plant', x: wl + 4, y: top + 2, w: 1, h: 1, block: true }); continue; }
    set(wl + 4, top + 5, 'room', { tint, door: true });
    const index = rooms.length;
    const desk = { type: 'desk', x: wl + 3, y: top + 2, w: 3, h: 1, block: true, room: index, exec: true };
    objects.push(desk,
      { type: 'rug', x: wl + 3, y: top + 3, w: 3, h: 2, under: true, color: tint },
      { type: 'plant', x: wl + 1, y: top + 1, w: 1, h: 1, block: true },
      { type: 'shelf', x: wl + 7, y: top + 1, w: 1, h: 1, block: true },
      { type: 'lamp', x: wl + 1, y: top + 4, w: 1, h: 1, block: true },
      { type: 'beanbag', x: wl + 7, y: top + 4, w: 1, h: 1, under: true, color: '#8e44ad' });
    const seat = { id: `desk-${s.id}`, x: wl + 4, y: top + 1, dir: 'down', pose: 'sit', zone: 'desk', owner: s.id };
    const visit = { id: `visit-${s.id}`, x: wl + 4, y: top + 3, dir: 'up', pose: 'stand', zone: 'visit', owner: s.id, bubble: '👀', dur: [5, 10] };
    const lounge = { id: `lounge-${s.id}`, x: wl + 7, y: top + 4, dir: 'down', pose: 'sit', zone: 'lounge', bubble: '📱', dur: [10, 20], nap: true, owner: s.id }; // only the office owner uses it
    spots.push(seat, visit, lounge);
    rooms.push({
      kind: 'office', index, session: s, x0: wl + 1, top: top + 1, seat, visit, desk, tint, door: { x: wl + 4, y: top + 5 },
      plaque: { x: wl + 0.1, y: top + 5.1, w: 3.75 },
      helperSlots: [[wl + 2, top + 4], [wl + 6, top + 4], [wl + 2, top + 3], [wl + 6, top + 3], [wl + 5, top + 4]],
    });
  }

  const cubeAt = i => {
    const r = Math.floor(i / CUBES_PER_ROW), c = i % CUBES_PER_ROW;
    const x0 = X_CUBES + c * CUBE_W, seatY = base + 3 + r * ROW_PITCH;
    return { x0, seatY, deskY: seatY + 1 };
  };
  const totalSlots = rows * CUBES_PER_ROW;
  for (let i = 0; i < totalSlots; i++) {
    const { x0, seatY, deskY } = cubeAt(i);
    const s = cube[i];
    const index = rooms.length;
    const tint = s ? projectColor(s.project) : '#8d8a84';
    for (const y of [seatY, deskY]) for (let x = x0 + 1; x <= x0 + 3; x++) set(x, y, 'cube', { tint });
    // partitions: left of every cubicle, plus the far right of each row
    objects.push({ type: 'partition', x: x0, y: seatY, w: 1, h: 2, block: true });
    if (i % CUBES_PER_ROW === CUBES_PER_ROW - 1) objects.push({ type: 'partition', x: x0 + CUBE_W, y: seatY, w: 1, h: 2, block: true });
    const desk = { type: 'desk', x: x0 + 1, y: deskY, w: 3, h: 1, block: true, room: s ? index : undefined, empty: !s };
    objects.push(desk);
    // a little clutter that differs per cubicle
    const deco = ['plant', 'cabinet', 'bin', 'plant', 'cabinet'][(i * 7 + 3) % 5];
    if (s) objects.push({ type: deco, x: x0 + 3, y: seatY, w: 1, h: 1, block: true });
    if (!s) continue;
    const seat = { id: `desk-${s.id}`, x: x0 + 2, y: seatY, dir: 'down', pose: 'sit', zone: 'desk', owner: s.id };
    const visit = { id: `visit-${s.id}`, x: x0 + 1, y: seatY, dir: 'right', pose: 'stand', zone: 'visit', owner: s.id, bubble: '👀', dur: [5, 10] };
    spots.push(seat, visit);
    rooms.push({
      kind: 'cubicle', index, session: s, x0, top: seatY, seat, visit, desk, tint, door: { x: x0 + 1, y: seatY - 1 },
      plaque: { x: x0 + 0.1, y: seatY + 1.45, w: 3.8 },
      helperSlots: [[x0 + 1, seatY - 1], [x0 + 2, seatY - 1], [x0 + 3, seatY - 1], [x0 + 1, seatY - 2], [x0 + 2, seatY - 2], [x0 + 3, seatY - 2]],
    });
  }

  // corridor extras
  objects.push({ type: 'cooler', x: 1, y: 1, w: 1, h: 1, block: true }, { type: 'plant', x: W - 2, y: yCommon - 5 > 1 ? yCommon - 5 : yCommon - 1, w: 1, h: 1, block: true });
  spots.push({ id: 'floor-cooler', zone: 'kitchen', x: 1, y: 2, dir: 'up', pose: 'stand', bubble: '💧', dur: [5, 9] });
  objects.push({ type: 'printer', x: W - 2, y: yCommon - 3, w: 1, h: 1, block: true });
  spots.push({ id: 'floor-printer', zone: 'office', x: W - 3, y: yCommon - 3, dir: 'right', pose: 'use', bubble: '🖨️', dur: [4, 8] });

  // common area
  const c1 = yCommon + 1;
  const zoneDefs = [
    { id: 'kitchen', label: 'KITCHEN', x0: 1, x1: 9, door: [4, 5] },
    { id: 'gym', label: 'GYM', x0: 11, x1: 18, door: [14, 15] },
    { id: 'games', label: 'GAME ROOM', x0: 20, x1: 28, door: [24, 25] },
    { id: 'lounge', label: 'LOUNGE', x0: 30, x1: W - 2, door: [33, 34] },
  ];
  for (const z of zoneDefs) {
    for (let y = c1; y < c1 + 10; y++) for (let x = z.x0; x <= z.x1; x++) set(x, y, z.id);
    for (const dx of z.door) set(dx, yCommon, z.id);
    zones.push({ ...z, y0: c1, y1: c1 + 9 });
  }
  const O = (type, x, y, w = 1, h = 1, extra = {}) => objects.push({ type, x, y, w, h, block: true, ...extra });
  const S = (zone, x, y, dir, pose, bubble, extra = {}) => spots.push({ id: `${zone}-${x}-${y}`, zone, x, y, dir, pose, bubble, ...extra });

  // kitchen
  O('counter', 1, c1, 3); O('coffee', 2, c1, 1, 1, { block: false, over: true });
  O('cooler', 6, c1); O('fridge', 8, c1);
  S('kitchen', 2, c1 + 1, 'up', 'use', '☕', { dur: [6, 12] });
  S('kitchen', 6, c1 + 1, 'up', 'stand', '💧');
  S('kitchen', 8, c1 + 1, 'up', 'use', '🥪');
  O('table', 3, c1 + 5, 4, 2);
  for (const x of [4, 5]) { S('kitchen', x, c1 + 4, 'down', 'sit', '☕', { dur: [10, 20] }); S('kitchen', x, c1 + 7, 'up', 'sit', '🍩', { dur: [10, 20] }); }
  O('plant', 1, c1 + 9); O('plant', 9, c1 + 9);

  // gym
  O('treadmill', 12, c1 + 1, 1, 1, { block: false, under: true }); O('treadmill', 16, c1 + 1, 1, 1, { block: false, under: true });
  S('gym', 12, c1 + 1, 'down', 'run', '🏃', { dur: [8, 16] }); S('gym', 16, c1 + 1, 'down', 'run', '🏃', { dur: [8, 16] });
  O('rack', 18, c1, 1, 3);
  O('bench', 12, c1 + 5, 2, 1, { block: false, under: true });
  S('gym', 12, c1 + 5, 'down', 'lift', '💪', { dur: [6, 12] });
  O('mat', 15, c1 + 5, 2, 1, { block: false, under: true });
  S('gym', 15, c1 + 5, 'down', 'stretch', '🧘', { dur: [8, 14] });
  O('bag', 18, c1 + 8);
  S('gym', 17, c1 + 8, 'right', 'punch', '🥊', { dur: [5, 10] });

  // game room
  O('pingpong', 22, c1 + 3, 3, 2);
  S('games', 21, c1 + 3, 'right', 'paddle', '🏓', { dur: [10, 18], pair: 'pp' });
  S('games', 25, c1 + 4, 'left', 'paddle', '🏓', { dur: [10, 18], pair: 'pp' });
  O('arcade', 27, c1, 1, 1, { hue: '#8e44ad' }); O('arcade', 28, c1, 1, 1, { hue: '#d35400' });
  S('games', 27, c1 + 1, 'up', 'use', '🕹️', { dur: [10, 20] }); S('games', 28, c1 + 1, 'up', 'use', '👾', { dur: [10, 20] });
  O('foosball', 22, c1 + 7, 3, 1);
  S('games', 23, c1 + 6, 'down', 'use', '⚽', { dur: [8, 14] }); S('games', 23, c1 + 8, 'up', 'use', '⚽', { dur: [8, 14] });
  O('beanbag', 20, c1, 1, 1, { block: false, under: true, color: '#e67e22' });
  S('games', 20, c1, 'down', 'sit', '📱');

  // lounge
  O('sofa', 30, c1 + 1, 3, 1, { block: false, under: true }); O('sofaFront', 30, c1 + 1, 3, 1, { block: false, over: true });
  for (const x of [30, 31, 32]) S('lounge', x, c1 + 1, 'down', 'sit', x === 31 ? '📺' : '💬', { dur: [12, 25], nap: true });
  O('ctable', 30, c1 + 3, 3, 1);
  O('tv', 30, c1 + 6, 3, 1);
  O('shelf', 36, c1, 1, 1); O('shelf', 37, c1, 1, 1);
  S('lounge', 36, c1 + 1, 'up', 'stand', '📖', { dur: [6, 12] });
  O('beanbag', 36, c1 + 5, 1, 1, { block: false, under: true, color: '#16a085' });
  S('lounge', 36, c1 + 5, 'down', 'sit', '🎧', { dur: [12, 25], nap: true });
  O('lamp', 30, c1 + 9); O('plant', 37, c1 + 9);

  // meeting room under the common area, reachable through the kitchen and the lounge
  const m0 = c1 + 11;
  const meeting = { id: 'meeting', label: 'MEETING ROOM', x0: 1, x1: W - 2, door: [5, 34], y0: m0, y1: m0 + 6 };
  for (let y = m0; y <= m0 + 6; y++) for (let x = 1; x <= W - 2; x++) set(x, y, 'meeting');
  for (const dx of meeting.door) set(dx, c1 + 10, 'meeting');
  zones.push(meeting);
  O('table', 10, m0 + 2, 18, 2);
  for (let x = 10; x <= 27; x++) {
    O('chair', x, m0 + 1, 1, 1, { block: false, under: true, dir: 'down' });
    O('chair', x, m0 + 4, 1, 1, { block: false, under: true, dir: 'up' });
    S('meeting', x, m0 + 1, 'down', 'sit', null, { meeting: true });
    S('meeting', x, m0 + 4, 'up', 'sit', null, { meeting: true });
  }
  O('tv', 3, m0 + 2, 3, 1);
  objects.push({ type: 'whiteboard', x: 14, y: c1 + 10, w: 2, h: 1, wall: true }, { type: 'whiteboard', x: 23, y: c1 + 10, w: 2, h: 1, wall: true });
  // the Product Manager's desk, at the head of the meeting room
  if (pm) {
    const index = rooms.length, px = 31, py = m0 + 2;
    const desk = { type: 'desk', x: px, y: py + 1, w: 3, h: 1, block: true, room: index, exec: true };
    objects.push(desk, { type: 'rug', x: px - 1, y: py, w: 5, h: 4, under: true, color: '#8e6fb8' }, { type: 'lamp', x: px + 4, y: py + 1, w: 1, h: 1, block: true }, { type: 'shelf', x: px - 2, y: py, w: 1, h: 1, block: true });
    const seat = { id: 'desk-pm', x: px + 1, y: py, dir: 'down', pose: 'sit', zone: 'desk', owner: pm.id };
    const visit = { id: 'visit-pm', x: px + 1, y: py + 3, dir: 'up', pose: 'stand', zone: 'visit', owner: pm.id, bubble: '👀', dur: [5, 10] };
    spots.push(seat, visit);
    rooms.push({ kind: 'pm', index, session: pm, x0: px, top: py, seat, visit, desk, tint: '#8e6fb8', door: { x: px + 1, y: py + 3 },
      plaque: { x: px - 0.4, y: py + 1.45, w: 3.8 }, helperSlots: [[px, py + 3], [px + 2, py + 3], [px - 1, py + 2]] });
  }

  // the office TODO board: click it to open the board
  const kanban = { type: 'kanban', x: 17, y: c1 + 10, w: 4, h: 1, wall: true, counts: [0, 0, 0] };
  objects.push(kanban);
  O('plant', 1, m0 + 6); O('plant', W - 2, m0 + 6); O('plant', 1, m0 + 1); O('plant', W - 2, m0 + 1);

  // keep doorways clear: nothing may stand on the first two tiles inside a door
  for (const z of zones) for (const dx of z.door) for (const y of (z.id === 'meeting' ? [m0, m0 + 1, c1 + 9, c1 + 8] : [c1, c1 + 1])) {
    const hit = objects.find(o => dx >= o.x && dx < o.x + o.w && y >= o.y && y < o.y + o.h) || spots.find(sp => sp.x === dx && sp.y === y);
    if (hit) console.warn(`${z.id} doorway at ${dx},${y} is blocked by`, hit.type || hit.id);
  }

  // blocking grid
  const walkable = tiles.map(row => row.map(t => t.kind !== 'wall' && !t.sealed));
  for (const o of objects) if (o.block) for (let y = o.y; y < o.y + o.h; y++) for (let x = o.x; x < o.x + o.w; x++) if (walkable[y]) walkable[y][x] = false;

  // hallway wander points
  const wanderPts = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (tiles[y][x].kind === 'hall' && walkable[y][x] && (x * 7 + y * 3) % 11 === 0) wanderPts.push({ x, y });

  const world = { W, H, tiles, walkable, objects, spots, rooms, zones, wanderPts, yCommon, elevator, spawn, meeting, kanban };
  for (const s of spots) if (!findPath(world, { x: 2, y: 1 }, s)) console.warn('unreachable spot', s.id);
  return world;
}

// BFS on the tile grid (4-neighbour). Returns list of {x,y} excluding start.
export function findPath(world, from, to) {
  const { W, H, walkable } = world;
  const key = (x, y) => y * W + x;
  const start = key(from.x, from.y), goal = key(to.x, to.y);
  if (start === goal) return [];
  const prev = new Int32Array(W * H).fill(-1);
  prev[start] = start;
  const q = [start];
  let head = 0;
  const passable = (x, y) => x >= 0 && y >= 0 && x < W && y < H && (walkable[y][x] || key(x, y) === goal);
  while (head < q.length) {
    const k = q[head++];
    if (k === goal) break;
    const x = k % W, y = (k / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, nk = key(nx, ny);
      if (passable(nx, ny) && prev[nk] === -1) { prev[nk] = k; q.push(nk); }
    }
  }
  if (prev[goal] === -1) return null;
  const path = [];
  for (let k = goal; k !== start; k = prev[k]) path.push({ x: k % W, y: (k / W) | 0 });
  return path.reverse();
}
