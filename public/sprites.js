// Procedural pixel-art sprites. Everything is drawn at native resolution (1 unit = 1 pixel)
// into a small offscreen buffer and scaled up with smoothing disabled.
export const T = 16;

// Floor themes: colours for the open floor, walls, partitions and windows.
export const THEMES = {
  classic: { label: 'Classic', hall: ['#8f9aa8', '#8a95a3', '#838e9c'], wall: ['#3d3a4b', '#4a4659'], face: ['#e8dcc4', '#d6c7aa', '#b9a988'], part: ['#4b576b', '#5d6b82', '#71809a'], sky: ['#9ed3f0', '#c7e8fa'], frame: '#6d6a7c' },
  loft: { label: 'Startup loft', hall: ['#9a9590', '#948f8a', '#8a857f'], wall: ['#5a2f24', '#6b3a2c'], face: ['#a4553f', '#8f4a36', '#6e3829'], part: ['#2b2b2b', '#3a3a3a', '#d9a441'], sky: ['#bfe3f2', '#e2f3fa'], frame: '#222', bricks: true },
  beige: { label: 'Dunder Mifflin beige', hall: ['#b9ab8c', '#b3a586', '#a89a7c'], wall: ['#6e6758', '#7c7464'], face: ['#e6dcc2', '#d9ceb1', '#bfb394'], part: ['#7d8591', '#8f97a2', '#a6adb7'], sky: ['#c9d6dc', '#e0e8ec'], frame: '#8a8375' },
  space: { label: 'Space station', hall: ['#2c3342', '#283040', '#3a4458'], wall: ['#141824', '#1f2535'], face: ['#39465e', '#2f3a50', '#6ce0ff'], part: ['#1f2535', '#2b3348', '#6ce0ff'], sky: ['#070b1a', '#0d1430'], frame: '#4b5670', stars: true },
};
let theme = THEMES.classic;
export function setTheme(key) { theme = THEMES[key] || THEMES.classic; cache.clear(); }

const cache = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  return [c, g];
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const f = v => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const r = f(n >> 16), g = f((n >> 8) & 255), b = f(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// ---------- characters ----------
// look: { skin, hair, shirt, pants, hairStyle: short|long|spiky|bun|bald, glasses }
// dir: down|up|left|right ; pose: stand|walk|sit|type|raise|run|lift|paddle|use|stretch|punch|sleep
export function characterFrame(look, dir, pose, frame) {
  const key = `${look.skin}${look.hair}${look.shirt}${look.pants}${look.hairStyle}${look.glasses}|${dir}|${pose}|${frame}`;
  let c = cache.get(key);
  if (c) return c;
  const [cv, g] = canvas(16, 26);
  const flip = dir === 'left';
  if (flip) { g.translate(16, 0); g.scale(-1, 1); }
  drawCharacter(g, look, flip ? 'right' : dir, pose, frame);
  cache.set(key, cv);
  return cv;
}

function drawCharacter(g, L, dir, pose, f) {
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const shirtD = shade(L.shirt, -0.12), pantsD = shade(L.pants, -0.12), hairD = shade(L.hair, -0.15);
  const skinD = shade(L.skin, -0.1);
  const shoes = '#2b2b33';
  const eye = '#1d1d24';
  const sitting = pose === 'sit' || pose === 'type' || pose === 'raise' || pose === 'sleep';
  const oy = sitting ? 3 : 0; // sitting sinks the body
  const walking = pose === 'walk' || pose === 'run';
  const step = walking ? [0, 1, 0, -1][f % 4] : 0;
  const bob = walking && f % 2 === 1 ? -1 : 0;
  const y0 = 2 + oy + bob;

  // shadow
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(3, 23, 10, 2);

  // legs
  if (sitting) {
    px(5, y0 + 16, 6, 3, L.pants);
    px(5, y0 + 19, 2, 1, shoes); px(9, y0 + 19, 2, 1, shoes);
  } else if (dir === 'right') {
    const a = step, b = -step;
    px(6 + a, y0 + 15, 2, 5, pantsD); px(6 + a, y0 + 20, 3, 1, shoes);
    px(8 + b, y0 + 15, 2, 5, L.pants); px(8 + b, y0 + 20, 3, 1, shoes);
  } else {
    const lUp = step > 0 ? 1 : 0, rUp = step < 0 ? 1 : 0;
    px(5, y0 + 15, 2, 5 - lUp, L.pants); px(5, y0 + 20 - lUp, 2, 1, shoes);
    px(9, y0 + 15, 2, 5 - rUp, L.pants); px(9, y0 + 20 - rUp, 2, 1, shoes);
  }

  // torso
  px(4, y0 + 8, 8, 8, L.shirt);
  px(4, y0 + 14, 8, 1, shirtD);
  if (dir === 'down') px(7, y0 + 8, 2, 2, shade(L.shirt, 0.12)); // collar

  // arms
  const armSwing = walking ? step : 0;
  const hand = L.skin;
  const armsUp = pose === 'raise' || pose === 'lift' || pose === 'stretch';
  if (armsUp) {
    const up = pose === 'raise' ? 0 : (f % 2) ; // lift/stretch pump
    if (pose === 'raise') {
      px(12, y0 + 1, 2, 8, L.shirt); px(12, y0 - 1, 2, 2, hand);
      px(3, y0 + 8, 1, 6, shirtD);
    } else {
      px(2, y0 + 1 + up, 2, 8, L.shirt); px(12, y0 + 1 + up, 2, 8, L.shirt);
      px(2, y0 - 1 + up, 2, 2, hand); px(12, y0 - 1 + up, 2, 2, hand);
      if (pose === 'lift') {
        px(0, y0 - 1 + up, 16, 1, '#8a8f99');
        px(0, y0 - 3 + up, 2, 5, '#3a3d45'); px(14, y0 - 3 + up, 2, 5, '#3a3d45');
      }
    }
  } else if (dir === 'right') {
    const reach = pose === 'paddle' || pose === 'punch' || pose === 'use';
    if (reach) {
      const out = f % 2;
      px(8, y0 + 9, 4 + out * 2, 2, L.shirt); px(12 + out * 2, y0 + 9, 2, 2, hand);
      if (pose === 'paddle') { px(13 + out * 2, y0 + 6, 3, 4, '#d94c4c'); }
      if (pose === 'punch') { px(12 + out * 2, y0 + 8, 3, 3, '#c0392b'); }
    } else {
      px(7 + armSwing, y0 + 9, 2, 6, shirtD); px(7 + armSwing, y0 + 15, 2, 1, hand);
    }
  } else {
    const typing = pose === 'type';
    const tA = typing ? (f % 2) : 0;
    const la = dir === 'down' ? -armSwing : armSwing;
    px(3, y0 + 9 + la, 1, 6, shirtD); px(12, y0 + 9 - la, 1, 6, shirtD);
    if (typing) {
      px(4, y0 + 13 - tA, 2, 2, hand); px(10, y0 + 12 + tA, 2, 2, hand);
    } else if (pose === 'use' || pose === 'paddle') {
      px(3, y0 + 14 - (f % 2), 2, 2, hand); px(11, y0 + 14 - ((f + 1) % 2), 2, 2, hand);
    } else {
      px(3, y0 + 15 + la, 1, 1, hand); px(12, y0 + 15 - la, 1, 1, hand);
    }
  }

  // head
  const hy = y0;
  px(4, hy, 8, 8, L.skin);
  px(4, hy + 7, 8, 1, skinD);
  const hs = L.hairStyle;
  if (dir === 'down') {
    if (hs !== 'bald') {
      px(3, hy - 1, 10, 3, L.hair);
      px(3, hy + 2, 1, hs === 'long' ? 8 : 3, L.hair); px(12, hy + 2, 1, hs === 'long' ? 8 : 3, L.hair);
      if (hs === 'spiky') { px(4, hy - 2, 1, 1, L.hair); px(7, hy - 2, 1, 1, L.hair); px(10, hy - 2, 1, 1, L.hair); }
      if (hs === 'bun') px(6, hy - 3, 4, 2, hairD);
      if (hs === 'short') px(4, hy + 2, 2, 1, hairD);
    } else px(4, hy, 8, 1, skinD);
    if (pose === 'sleep') { px(5, hy + 4, 2, 1, eye); px(9, hy + 4, 2, 1, eye); }
    else { px(5, hy + 4, 2, 2, eye); px(9, hy + 4, 2, 2, eye); px(5, hy + 4, 1, 1, '#fff'); px(9, hy + 4, 1, 1, '#fff'); }
    px(7, hy + 6, 2, 1, skinD);
    if (L.glasses) { px(4, hy + 4, 3, 1, '#222'); px(9, hy + 4, 3, 1, '#222'); px(7, hy + 4, 2, 1, '#222'); }
    px(4, hy + 5, 1, 1, '#f3a0a0'); px(11, hy + 5, 1, 1, '#f3a0a0');
  } else if (dir === 'up') {
    if (hs !== 'bald') {
      px(3, hy - 1, 10, hs === 'long' ? 11 : 8, L.hair);
      if (hs === 'bun') px(6, hy - 3, 4, 3, hairD);
      if (hs === 'spiky') { px(4, hy - 2, 1, 1, L.hair); px(7, hy - 2, 1, 1, L.hair); px(10, hy - 2, 1, 1, L.hair); }
      px(3, hy + 5, 10, 1, hairD);
    }
  } else { // right
    if (hs !== 'bald') {
      px(3, hy - 1, 9, 3, L.hair);
      px(3, hy + 2, 4, hs === 'long' ? 8 : 4, L.hair);
      if (hs === 'spiky') { px(5, hy - 2, 1, 1, L.hair); px(8, hy - 2, 1, 1, L.hair); }
      if (hs === 'bun') px(2, hy, 2, 3, hairD);
    }
    px(12, hy + 4, 1, 2, L.skin);
    if (pose === 'sleep') px(9, hy + 4, 2, 1, eye); else { px(9, hy + 4, 2, 2, eye); px(10, hy + 4, 1, 1, '#fff'); }
    if (L.glasses) { px(8, hy + 4, 4, 1, '#222'); }
  }
}

// ---------- tiles & furniture ----------
function hash(x, y) { let h = x * 374761393 + y * 668265263; h = (h ^ (h >> 13)) * 1274126177; return (h ^ (h >> 16)) >>> 0; }

export const FLOORS = {
  meeting: ['#5b6b7a', '#566575'],
  hall: ['#cbbfa8', '#c3b79f'],
  kitchen: ['#e9e4d8', '#d9d2c2'],
  gym: ['#6f7d8c', '#667381'],
  games: ['#7a5a8c', '#6f5181'],
  lounge: ['#b98a5e', '#ae8055'],
};

export function drawFloor(g, x, y, kind, tint) {
  const X = x * T, Y = y * T;
  const h = hash(x, y);
  if (kind === 'room') {
    // wood planks tinted per project
    const base = tint || '#a97c50';
    g.fillStyle = base; g.fillRect(X, Y, T, T);
    g.fillStyle = shade(base, -0.06);
    const off = (y % 2) * 8;
    g.fillRect(X + ((off + 0) % 16), Y, 1, T);
    g.fillRect(X, Y + 7, T, 1); g.fillRect(X, Y + 15, T, 1);
    if (h % 7 === 0) { g.fillStyle = shade(base, 0.05); g.fillRect(X + 3, Y + 3, 3, 1); }
    return;
  }
  if (kind === 'cube') {
    const base = tint || '#8d8a84';
    g.fillStyle = base; g.fillRect(X, Y, T, T);
    g.fillStyle = shade(base, -0.05);
    for (let i = 0; i < 6; i++) g.fillRect(X + ((h >> (i * 3)) % 16), Y + ((h >> (i * 2 + 5)) % 16), 1, 1);
    return;
  }
  if (kind === 'hall') {
    g.fillStyle = (x + y) % 2 ? theme.hall[0] : theme.hall[1]; g.fillRect(X, Y, T, T);
    g.fillStyle = theme.hall[2];
    for (let i = 0; i < 4; i++) g.fillRect(X + ((h >> (i * 4)) % 16), Y + ((h >> (i * 3 + 7)) % 16), 1, 1);
    return;
  }
  const [a, b] = FLOORS[kind] || FLOORS.hall;
  if (kind === 'kitchen') {
    g.fillStyle = (x + y) % 2 ? a : b; g.fillRect(X, Y, T, T);
  } else if (kind === 'gym') {
    g.fillStyle = a; g.fillRect(X, Y, T, T);
    g.fillStyle = b; g.fillRect(X, Y, T, 1); g.fillRect(X, Y, 1, T);
    if (h % 5 === 0) { g.fillStyle = shade(a, 0.05); g.fillRect(X + 5, Y + 9, 2, 1); }
  } else if (kind === 'games') {
    g.fillStyle = a; g.fillRect(X, Y, T, T);
    if (h % 3 === 0) { g.fillStyle = b; g.fillRect(X + (h % 12), Y + ((h >> 4) % 12), 3, 3); }
  } else {
    g.fillStyle = a; g.fillRect(X, Y, T, T);
    g.fillStyle = b; g.fillRect(X, Y + 15, T, 1);
    if (h % 4 === 0) { g.fillStyle = shade(a, 0.04); g.fillRect(X + 2, Y + 5, 6, 1); }
  }
}

export function drawWall(g, x, y, faceBelow) {
  const X = x * T, Y = y * T;
  g.fillStyle = theme.wall[0]; g.fillRect(X, Y, T, T);
  g.fillStyle = theme.wall[1]; g.fillRect(X, Y, T, 3);
  if (faceBelow) {
    // visible wall face
    g.fillStyle = theme.face[0]; g.fillRect(X, Y + 5, T, 11);
    g.fillStyle = theme.face[1]; g.fillRect(X, Y + 13, T, 3);
    g.fillStyle = theme.face[2]; g.fillRect(X, Y + 15, T, 1);
    if (theme.bricks) { g.fillStyle = theme.face[1]; for (let r = 0; r < 2; r++) for (let i = 0; i < 4; i++) g.fillRect(X + ((i * 5 + r * 2) % 16), Y + 7 + r * 3, 1, 2); g.fillRect(X, Y + 9, T, 1); }
    if (theme.stars) { g.fillStyle = theme.face[2]; g.fillRect(X, Y + 10, T, 1); }
  }
}

// Furniture drawers. Each receives (g, pixelX, pixelY, obj, t)
export const FURNITURE = {
  desk(g, X, Y, o, t) {
    const w = o.w * T;
    // desk surface
    g.fillStyle = o.exec ? '#7b4f2c' : '#b08457'; g.fillRect(X, Y - 4, w, 9);
    g.fillStyle = o.exec ? '#946139' : '#c69a6b'; g.fillRect(X, Y - 4, w, 2);
    if (!o.empty) {
      // monitor off to the side so the face stays visible, screen glows when busy
      const mx = X + 2;
      g.fillStyle = '#2a2d36'; g.fillRect(mx, Y - 12, 12, 9);
      g.fillStyle = o.on ? (Math.floor(t * 4) % 2 ? '#7fd1ff' : '#6ec3f2') : '#40444f';
      g.fillRect(mx + 1, Y - 11, 10, 7);
      g.fillStyle = '#2a2d36'; g.fillRect(mx + 5, Y - 3, 2, 2);
      g.fillStyle = '#e9e6df'; g.fillRect(X + w - 18, Y - 2, 8, 2); // keyboard
      g.fillStyle = o.mug || '#d05a5a'; g.fillRect(X + w - 6, Y - 5, 4, 4);
    }
    if (o.exec) {
      // executive desk: dark wood front with legs and a brass nameplate
      g.fillStyle = '#5c3a1f'; g.fillRect(X, Y + 5, w, 7);
      g.fillStyle = '#4a2e18'; g.fillRect(X + 1, Y + 12, 3, 4); g.fillRect(X + w - 4, Y + 12, 3, 4);
      g.fillStyle = '#d9a441'; g.fillRect(X + w / 2 - 5, Y + 7, 10, 3);
      return;
    }
    // front cubicle panel (spans the partition column on the left)
    g.fillStyle = theme.part[1]; g.fillRect(X - 3, Y + 5, w + 6, 11);
    g.fillStyle = theme.part[2]; g.fillRect(X - 3, Y + 5, w + 6, 2);
    g.fillStyle = theme.part[0]; g.fillRect(X - 3, Y + 15, w + 6, 1);
  },
  partition(g, X, Y, o) {
    const h = o.h * T;
    g.fillStyle = theme.part[0]; g.fillRect(X + 5, Y - 8, 6, h + 8);
    g.fillStyle = theme.part[2]; g.fillRect(X + 5, Y - 8, 6, 2);
    g.fillStyle = theme.part[1]; g.fillRect(X + 6, Y - 6, 4, h + 6);
  },
  cabinet(g, X, Y) {
    g.fillStyle = '#9aa3ae'; g.fillRect(X + 2, Y - 2, 12, 16);
    g.fillStyle = '#7d8691'; g.fillRect(X + 2, Y + 5, 12, 1);
    g.fillStyle = '#5c646e'; g.fillRect(X + 6, Y + 1, 4, 1); g.fillRect(X + 6, Y + 8, 4, 1);
  },
  bin(g, X, Y) {
    g.fillStyle = '#5c646e'; g.fillRect(X + 5, Y + 4, 6, 9);
    g.fillStyle = '#f4f1ea'; g.fillRect(X + 6, Y + 3, 3, 2);
  },
  printer(g, X, Y, o, t) {
    g.fillStyle = '#d9dde2'; g.fillRect(X + 1, Y - 4, 14, 14);
    g.fillStyle = '#a9b0b8'; g.fillRect(X + 1, Y + 4, 14, 2);
    g.fillStyle = '#fff'; g.fillRect(X + 4, Y - 7 + (Math.floor(t * 2) % 2), 8, 4);
    g.fillStyle = '#4cd964'; g.fillRect(X + 12, Y - 2, 2, 1);
  },
  plant(g, X, Y) {
    g.fillStyle = '#8c5a3c'; g.fillRect(X + 4, Y + 8, 8, 7);
    g.fillStyle = '#3f8f4f'; g.fillRect(X + 2, Y, 12, 9); g.fillRect(X + 5, Y - 4, 6, 5);
    g.fillStyle = '#56a866'; g.fillRect(X + 4, Y + 1, 3, 3); g.fillRect(X + 9, Y - 2, 2, 3);
  },
  shelf(g, X, Y, o) {
    const w = o.w * T;
    g.fillStyle = '#6b4526'; g.fillRect(X, Y - 10, w, 25);
    const cols = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad', '#16a085'];
    for (let r = 0; r < 3; r++) {
      g.fillStyle = '#4e3119'; g.fillRect(X + 1, Y - 9 + r * 8, w - 2, 7);
      for (let i = 0; i < w / 3 - 1; i++) { g.fillStyle = cols[(i + r * 2 + X) % cols.length]; g.fillRect(X + 2 + i * 3, Y - 8 + r * 8 + (i % 2), 2, 6 - (i % 2)); }
    }
  },
  whiteboard(g, X, Y, o) {
    g.fillStyle = '#9aa0a8'; g.fillRect(X, Y + 4, o.w * T, 10);
    g.fillStyle = '#fafafa'; g.fillRect(X + 1, Y + 5, o.w * T - 2, 8);
    g.fillStyle = '#3b7dd8'; g.fillRect(X + 4, Y + 7, 8, 1); g.fillRect(X + 4, Y + 9, 12, 1);
    g.fillStyle = '#d84b3b'; g.fillRect(X + 18, Y + 7, 5, 4);
  },
  rug(g, X, Y, o) {
    g.fillStyle = o.color || '#c85a5a'; g.fillRect(X + 2, Y + 2, o.w * T - 4, o.h * T - 4);
    g.fillStyle = shade(o.color || '#c85a5a', 0.12); g.fillRect(X + 4, Y + 4, o.w * T - 8, o.h * T - 8);
    g.fillStyle = o.color || '#c85a5a'; g.fillRect(X + 6, Y + 6, o.w * T - 12, o.h * T - 12);
  },
  counter(g, X, Y, o) {
    g.fillStyle = '#8d949e'; g.fillRect(X, Y - 4, o.w * T, 19);
    g.fillStyle = '#b8bec6'; g.fillRect(X, Y - 4, o.w * T, 4);
    g.fillStyle = '#737a84'; for (let i = 0; i < o.w; i++) g.fillRect(X + i * T + 7, Y + 3, 2, 8);
  },
  coffee(g, X, Y, o, t) {
    g.fillStyle = '#2d2d33'; g.fillRect(X + 3, Y - 12, 10, 14);
    g.fillStyle = '#c0392b'; g.fillRect(X + 4, Y - 10, 3, 2);
    g.fillStyle = '#555'; g.fillRect(X + 6, Y - 3, 4, 3);
    if (Math.floor(t * 2) % 2) { g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(X + 7, Y - 16, 1, 3); g.fillRect(X + 9, Y - 18, 1, 3); }
  },
  fridge(g, X, Y) {
    g.fillStyle = '#e8eef3'; g.fillRect(X + 1, Y - 14, 14, 29);
    g.fillStyle = '#c3ccd4'; g.fillRect(X + 1, Y - 3, 14, 1); g.fillRect(X + 12, Y - 11, 1, 5); g.fillRect(X + 12, Y + 1, 1, 6);
    g.fillStyle = '#f1c40f'; g.fillRect(X + 4, Y - 10, 3, 3);
  },
  cooler(g, X, Y) {
    g.fillStyle = '#dfe6ec'; g.fillRect(X + 4, Y - 2, 8, 16);
    g.fillStyle = '#7ec8f0'; g.fillRect(X + 5, Y - 12, 6, 10);
    g.fillStyle = '#a9dcf7'; g.fillRect(X + 6, Y - 11, 2, 6);
  },
  table(g, X, Y, o) {
    g.fillStyle = '#c99a6b'; g.fillRect(X + 1, Y - 3, o.w * T - 2, o.h * T);
    g.fillStyle = '#ddb184'; g.fillRect(X + 1, Y - 3, o.w * T - 2, 3);
    g.fillStyle = '#8c6440'; g.fillRect(X + 2, Y + o.h * T - 3, 2, 4); g.fillRect(X + o.w * T - 4, Y + o.h * T - 3, 2, 4);
    g.fillStyle = '#fff'; g.fillRect(X + 10, Y + 4, 5, 4); g.fillRect(X + o.w * T - 16, Y + 14, 5, 4);
  },
  treadmill(g, X, Y, o, t) {
    g.fillStyle = '#26282e'; g.fillRect(X + 1, Y - 2, 14, 18);
    g.fillStyle = '#3a3d45';
    const s = Math.floor(t * 10) % 4;
    for (let i = 0; i < 5; i++) g.fillRect(X + 3, Y + (i * 4 + s) % 16 - 1, 10, 1);
    g.fillStyle = '#9aa0a8'; g.fillRect(X + 1, Y - 12, 2, 10); g.fillRect(X + 13, Y - 12, 2, 10);
    g.fillStyle = '#2f3440'; g.fillRect(X + 1, Y - 14, 14, 4);
    g.fillStyle = '#4cd964'; g.fillRect(X + 6, Y - 13, 4, 2);
  },
  bench(g, X, Y, o) {
    g.fillStyle = '#2b2d33'; g.fillRect(X + 2, Y + 4, o.w * T - 4, 5);
    g.fillStyle = '#c0392b'; g.fillRect(X + 2, Y + 2, o.w * T - 4, 4);
    g.fillStyle = '#9aa0a8'; g.fillRect(X + 3, Y + 9, 2, 6); g.fillRect(X + o.w * T - 5, Y + 9, 2, 6);
  },
  rack(g, X, Y, o) {
    g.fillStyle = '#4b4f58'; g.fillRect(X + 2, Y - 8, 12, o.h * T + 6);
    for (let i = 0; i < o.h * 2 + 1; i++) { g.fillStyle = i % 2 ? '#2d3037' : '#5f6570'; g.fillRect(X + 1, Y - 6 + i * 7, 14, 3); }
  },
  mat(g, X, Y, o) {
    g.fillStyle = '#5bb5a2'; g.fillRect(X + 2, Y - 6, o.w * T - 4, o.h * T + 4);
    g.fillStyle = '#4a9c8b'; g.fillRect(X + 2, Y - 6, o.w * T - 4, 2);
  },
  bag(g, X, Y, o, t) {
    g.fillStyle = '#777'; g.fillRect(X + 7, Y - 18, 2, 6);
    const sw = Math.round(Math.sin(t * 3) * 1);
    g.fillStyle = '#8e2b2b'; g.fillRect(X + 4 + sw, Y - 12, 8, 20);
    g.fillStyle = '#a93a3a'; g.fillRect(X + 5 + sw, Y - 11, 2, 18);
  },
  pingpong(g, X, Y, o) {
    const w = o.w * T, h = o.h * T;
    g.fillStyle = '#1e5c3a'; g.fillRect(X, Y - 2, w, h);
    g.fillStyle = '#ffffff'; g.fillRect(X, Y - 2, w, 1); g.fillRect(X, Y + h - 3, w, 1); g.fillRect(X, Y - 2 + h / 2 - 1, w, 1);
    g.fillStyle = '#ddd'; g.fillRect(X + w / 2 - 1, Y - 6, 2, h + 3);
    g.fillStyle = '#123a25'; g.fillRect(X + 2, Y + h - 2, 2, 4); g.fillRect(X + w - 4, Y + h - 2, 2, 4);
  },
  arcade(g, X, Y, o, t) {
    const hue = o.hue || '#8e44ad';
    g.fillStyle = hue; g.fillRect(X + 1, Y - 16, 14, 31);
    g.fillStyle = '#111'; g.fillRect(X + 3, Y - 13, 10, 9);
    g.fillStyle = ['#e74c3c', '#f1c40f', '#2ecc71', '#3498db'][Math.floor(t * 3 + X) % 4];
    g.fillRect(X + 5 + (Math.floor(t * 5) % 5), Y - 10, 2, 2);
    g.fillStyle = shade(hue, -0.2); g.fillRect(X + 1, Y - 2, 14, 5);
    g.fillStyle = '#e74c3c'; g.fillRect(X + 4, Y - 1, 2, 2); g.fillStyle = '#f1c40f'; g.fillRect(X + 9, Y - 1, 2, 2);
  },
  foosball(g, X, Y, o) {
    const w = o.w * T;
    g.fillStyle = '#5a3d25'; g.fillRect(X, Y - 3, w, 16);
    g.fillStyle = '#2f8f46'; g.fillRect(X + 2, Y - 1, w - 4, 12);
    g.fillStyle = '#bbb'; for (let i = 0; i < 4; i++) g.fillRect(X + 6 + i * 10, Y - 5, 1, 20);
    g.fillStyle = '#e74c3c'; g.fillRect(X + 5, Y + 3, 3, 2); g.fillRect(X + 25, Y + 6, 3, 2);
    g.fillStyle = '#3498db'; g.fillRect(X + 15, Y + 1, 3, 2); g.fillRect(X + 35, Y + 5, 3, 2);
  },
  sofa(g, X, Y, o) {
    const w = o.w * T;
    g.fillStyle = '#34607f'; g.fillRect(X, Y - 10, w, 12);
    g.fillStyle = '#3f7396'; g.fillRect(X, Y + 2, w, 9);
    g.fillStyle = '#2a4f69'; g.fillRect(X - 2, Y - 4, 4, 15); g.fillRect(X + w - 2, Y - 4, 4, 15);
    g.fillStyle = '#4a86ad'; for (let i = 0; i < o.w; i++) g.fillRect(X + i * T + 2, Y + 3, T - 4, 2);
  },
  sofaFront(g, X, Y, o) { // front lip drawn over sitting agents
    const w = o.w * T;
    g.fillStyle = '#3f7396'; g.fillRect(X, Y + 10, w, 5);
    g.fillStyle = '#2a4f69'; g.fillRect(X - 2, Y + 4, 4, 11); g.fillRect(X + w - 2, Y + 4, 4, 11);
  },
  ctable(g, X, Y, o) {
    g.fillStyle = '#5c3a1f'; g.fillRect(X + 2, Y, o.w * T - 4, 9);
    g.fillStyle = '#7b4f2c'; g.fillRect(X + 2, Y, o.w * T - 4, 3);
    g.fillStyle = '#ecf0f1'; g.fillRect(X + 8, Y + 2, 6, 3);
  },
  tv(g, X, Y, o, t) {
    const w = o.w * T;
    g.fillStyle = '#1b1b1f'; g.fillRect(X + 2, Y - 2, w - 4, 14);
    g.fillStyle = `hsl(${(t * 40) % 360},55%,45%)`; g.fillRect(X + 3, Y - 1, w - 6, 12);
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(X + 4, Y, 6, 2);
  },
  beanbag(g, X, Y, o) {
    g.fillStyle = o.color || '#e67e22'; g.fillRect(X + 1, Y + 2, 14, 12); g.fillRect(X + 3, Y, 10, 2);
    g.fillStyle = shade(o.color || '#e67e22', 0.12); g.fillRect(X + 3, Y + 3, 5, 3);
  },
  window(g, X, Y, o) {
    const w = o.w * T;
    const night = o.night || theme.stars;
    g.fillStyle = theme.frame; g.fillRect(X + 1, Y + 4, w - 2, 11);
    g.fillStyle = night ? '#0d1430' : theme.sky[0]; g.fillRect(X + 2, Y + 5, w - 4, 9);
    if (night) { g.fillStyle = '#fff'; g.fillRect(X + 5, Y + 7, 1, 1); g.fillRect(X + 12, Y + 10, 1, 1); g.fillRect(X + 20, Y + 6, 1, 1); g.fillStyle = '#f5e7a1'; g.fillRect(X + w - 8, Y + 6, 3, 3); }
    else { g.fillStyle = theme.sky[1]; g.fillRect(X + 3, Y + 6, 3, 3); }
    g.fillStyle = theme.frame; g.fillRect(X + w / 2, Y + 5, 1, 9);
  },
  lamp(g, X, Y, o, t) {
    g.fillStyle = '#555'; g.fillRect(X + 7, Y - 8, 2, 20);
    g.fillStyle = '#f5d76e'; g.fillRect(X + 3, Y - 14, 10, 6);
  },
};

// ---------- helper bot (subagents) ----------
// A little orange robot that comes to help when a session spawns a subagent.
export function helperFrame(frame, hue = '#d97757') {
  const key = `helper|${hue}|${frame}`;
  let c = cache.get(key);
  if (c) return c;
  const [cv, g] = canvas(16, 26);
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const dark = shade(hue, -0.25), light = shade(hue, 0.15);
  const bob = frame % 2;
  g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(4, 23, 8, 2);
  // legs
  px(5, 19 - (frame === 1 ? 1 : 0), 2, 4, '#3a3d45'); px(9, 19 - (frame === 3 ? 1 : 0), 2, 4, '#3a3d45');
  // body
  px(4, 12 + bob, 8, 8, hue); px(4, 12 + bob, 8, 1, light); px(4, 19 + bob, 8, 1, dark);
  px(6, 14 + bob, 4, 3, '#f4efe6'); px(7, 15 + bob, 2, 1, hue);
  // arms
  px(2, 13 + bob, 2, 5, dark); px(12, 13 + bob, 2, 5, dark);
  // head + visor
  px(3, 5 + bob, 10, 7, hue); px(3, 5 + bob, 10, 1, light);
  px(4, 7 + bob, 8, 3, '#1d1b26');
  px(5, 8 + bob, 2, 1, '#7fe3ff'); px(9, 8 + bob, 2, 1, '#7fe3ff');
  // antenna with blinking tip
  px(7, 2 + bob, 2, 3, dark);
  px(7, 1 + bob, 2, 1, frame % 4 < 2 ? '#ffe066' : '#ff6b6b');
  cache.set(key, cv);
  return cv;
}

FURNITURE.elevator = (g, X, Y, o, t) => {
  const w = o.w * T;
  g.fillStyle = '#6d6a7c'; g.fillRect(X, Y + 1, w, 15);
  g.fillStyle = '#a8adb8'; g.fillRect(X + 2, Y + 3, w - 4, 13);
  const open = Math.max(0, Math.min(1, o.open || 0)) * (w / 2 - 3);
  g.fillStyle = '#2b2a35'; g.fillRect(X + w / 2 - open, Y + 3, open * 2, 13);
  g.fillStyle = '#8e939e'; g.fillRect(X + w / 2, Y + 3, 1, 13);
  g.fillStyle = o.open ? '#4cd964' : '#f5b83d'; g.fillRect(X + w / 2 - 2, Y, 4, 2);
};

FURNITURE.oooSign = (g, X, Y) => {
  g.fillStyle = '#6b4526'; g.fillRect(X + 7, Y - 8, 2, 6);
  g.fillStyle = '#f4efe6'; g.fillRect(X + 2, Y - 14, 12, 7);
  g.fillStyle = '#3f8f4f'; g.fillRect(X + 4, Y - 12, 3, 3);
  g.fillStyle = '#d9a441'; g.fillRect(X + 8, Y - 12, 4, 1); g.fillRect(X + 8, Y - 10, 3, 1);
};

// ---------- easter egg critters ----------
export function critterFrame(kind, frame) {
  const key = `critter|${kind}|${frame}`;
  let c = cache.get(key);
  if (c) return c;
  const [cv, g] = canvas(16, 16);
  const px = (x, y, w, h, col) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  const hop = kind === 'rabbit' ? [0, -2, -3, -1][frame % 4] : 0;
  const body = kind === 'rabbit' ? '#f7f7f2' : '#1b1b20', shadowC = kind === 'rabbit' ? '#d8d8d0' : '#2c2c33';
  g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(3, 14, 10, 2);
  px(3, 8 + hop, 9, 5, body); px(3, 12 + hop, 9, 1, shadowC);
  px(10, 5 + hop, 5, 5, body);                                        // head
  if (kind === 'rabbit') { px(11, 0 + hop, 1, 5, body); px(13, 1 + hop, 1, 4, body); px(11, 1 + hop, 1, 3, '#f3b5b5'); px(1, 8 + hop, 2, 2, '#fff'); }
  else { px(10, 3, 1, 2, body); px(14, 3, 1, 2, body); px(0, 5 + (frame % 2), 1, 4, body); px(1, 8, 2, 1, body); }
  px(13, 7 + hop, 1, 1, kind === 'rabbit' ? '#c0392b' : '#9be15d');   // eye
  const leg = frame % 2;
  px(4 + leg, 13 + hop, 2, 2, shadowC); px(9 - leg, 13 + hop, 2, 2, shadowC);
  cache.set(key, cv);
  return cv;
}

FURNITURE.chair = (g, X, Y, o) => {
  g.fillStyle = '#3a3d45'; g.fillRect(X + 3, Y + 4, 10, 9);
  g.fillStyle = '#4b4f58'; g.fillRect(X + 4, Y + 5, 8, 6);
  g.fillStyle = '#2b2d33'; if (o.dir === 'down') g.fillRect(X + 3, Y + 1, 10, 4); else g.fillRect(X + 3, Y + 11, 10, 4);
};

// Kanban board on the wall: three columns of sticky notes that follow the real board
FURNITURE.kanban = (g, X, Y, o) => {
  const w = o.w * T;
  g.fillStyle = '#6b4526'; g.fillRect(X, Y + 1, w, 15);
  g.fillStyle = '#e9e2cf'; g.fillRect(X + 1, Y + 2, w - 2, 13);
  const colW = (w - 2) / 3, colors = ['#f5d76e', '#7fd1ff', '#6fdc8c'];
  for (let c = 0; c < 3; c++) {
    const cx = X + 1 + c * colW;
    g.fillStyle = '#c9c0a8'; g.fillRect(cx + colW - 1, Y + 2, 1, 13);
    const n = Math.min(6, o.counts?.[c] || 0);
    for (let i = 0; i < n; i++) { g.fillStyle = colors[c]; g.fillRect(cx + 2 + (i % 2) * 9, Y + 4 + Math.floor(i / 2) * 4, 7, 3); }
  }
};
