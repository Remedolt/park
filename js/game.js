(() => {
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  const audio = new AudioEngine();

  const hud = {
    root: document.getElementById("hud"),
    time: document.getElementById("hud-time"),
    lives: document.getElementById("hud-lives"),
    level: document.getElementById("hud-level"),
    speed: document.getElementById("speed-num"),
    gear: document.getElementById("gear"),
    hint: document.getElementById("park-hint"),
    name: document.getElementById("hud-name"),
    align: document.getElementById("align-meter"),
    fill: document.getElementById("align-fill"),
  };
  const overlay = document.getElementById("overlay");
  const touch = document.getElementById("touch");

  const input = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
  };

  const keys = new Set();
  let dpr = 1;
  let W = 800;
  let H = 600;
  let last = 0;
  let state = "menu";
  let levelIndex = 0;
  let runStart = 0;
  let lives = 3;
  let timeLeft = 100;
  let parkHold = 0;
  let invuln = 0;
  let shake = 0;
  let textures = null;
  let patterns = null;
  let skids = [];
  let particles = [];
  let rain = [];
  let clock = 0;

  const CAR_W = 36;
  const CAR_L = 78;

  const COLORS = ["#2b6cb0", "#e3b341", "#c0392b", "#2d3436", "#1b7a4a", "#6c5ce7", "#d35400"];

  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  function carRect(c) {
    return { x: c.x, y: c.y, w: c.w, h: c.l, a: c.angle };
  }

  function corners(obb) {
    const hx = obb.h / 2;
    const hy = obb.w / 2;
    const ca = Math.cos(obb.a);
    const sa = Math.sin(obb.a);
    const pts = [
      { x: hx, y: hy },
      { x: hx, y: -hy },
      { x: -hx, y: -hy },
      { x: -hx, y: hy },
    ];
    return pts.map((p) => ({
      x: obb.x + p.x * ca - p.y * sa,
      y: obb.y + p.x * sa + p.y * ca,
    }));
  }

  function axesOf(pts) {
    const ax = [];
    for (let i = 0; i < 4; i++) {
      const n = pts[(i + 1) % 4];
      const p = pts[i];
      const dx = n.x - p.x;
      const dy = n.y - p.y;
      const len = Math.hypot(dx, dy) || 1;
      ax.push({ x: -dy / len, y: dx / len });
    }
    return ax;
  }

  function project(pts, axis) {
    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      const d = p.x * axis.x + p.y * axis.y;
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    return { min, max };
  }

  function sat(a, b) {
    const pa = corners(a);
    const pb = corners(b);
    const axes = axesOf(pa).concat(axesOf(pb));
    let minPen = Infinity;
    let nrm = { x: 0, y: 0 };
    for (const axis of axes) {
      const A = project(pa, axis);
      const B = project(pb, axis);
      const overlap = Math.min(A.max, B.max) - Math.max(A.min, B.min);
      if (overlap <= 0) return null;
      if (overlap < minPen) {
        minPen = overlap;
        const mx = (a.x - b.x);
        const my = (a.y - b.y);
        const sign = mx * axis.x + my * axis.y < 0 ? -1 : 1;
        nrm = { x: axis.x * sign, y: axis.y * sign };
      }
    }
    return { pen: minPen, nx: nrm.x, ny: nrm.y };
  }

  function hitAABB(obb, box) {
    return sat(obb, { x: box.x, y: box.y, w: box.h, h: box.w, a: 0 });
  }

  function hitCircle(obb, t) {
    const pts = corners(obb);
    let closest = pts[0];
    let best = Infinity;
    const cx = t.x;
    const cy = t.y;
    for (const p of pts) {
      const d = (p.x - cx) ** 2 + (p.y - cy) ** 2;
      if (d < best) {
        best = d;
        closest = p;
      }
    }
    const ca = Math.cos(-obb.a);
    const sa = Math.sin(-obb.a);
    let lx = (cx - obb.x) * ca - (cy - obb.y) * sa;
    let ly = (cx - obb.x) * sa + (cy - obb.y) * ca;
    lx = clamp(lx, -obb.h / 2, obb.h / 2);
    ly = clamp(ly, -obb.w / 2, obb.w / 2);
    const wx = obb.x + lx * Math.cos(obb.a) - ly * Math.sin(obb.a);
    const wy = obb.y + lx * Math.sin(obb.a) + ly * Math.cos(obb.a);
    const dx = cx - wx;
    const dy = cy - wy;
    const dist = Math.hypot(dx, dy);
    if (dist >= t.r) return null;
    const nx = dist < 1e-4 ? 1 : dx / dist;
    const ny = dist < 1e-4 ? 0 : dy / dist;
    return { pen: t.r - dist, nx: -nx, ny: -ny };
  }

  function makeCar(x, y, angle, color, opts = {}) {
    return {
      x, y, angle,
      w: opts.w || CAR_W,
      l: opts.l || CAR_L,
      color,
      velLong: 0,
      velLat: 0,
      steer: 0,
      gear: "N",
      moving: !!opts.moving,
      type: opts.type || "car",
      speed: opts.speed || 0,
      lane: opts.lane || 0,
      spawnY: y,
      yMin: opts.yMin || -720,
      yMax: opts.yMax || 720,
    };
  }

  const THEMES = {
    day: { tint: null, lights: false, sky: "#1a1c1f", lamp: 0 },
    dusk: { tint: "#b5794a", lights: true, sky: "#2a1e18", lamp: 0.55 },
    night: { tint: "#3b4a86", lights: true, sky: "#0a0d18", lamp: 1 },
  };

  const LAMP_R = 5;
  const LAMPS = [];
  for (let y = -540; y <= 540; y += 240) {
    LAMPS.push({ x: -220, y, side: 1, r: LAMP_R });
    LAMPS.push({ x: 220, y: y + 120, side: -1, r: LAMP_R });
  }

  function buildLevels() {
    const leftX = -178;
    const rightX = 178;
    const stallYs = [-480, -360, -240, -120, 0, 120, 240, 360, 480];

    function lotCars(filled) {
      const cars = [];
      stallYs.forEach((y, i) => {
        if (filled.left && filled.left[i]) {
          cars.push(makeCar(leftX, y, Math.PI, COLORS[filled.left[i] % COLORS.length]));
        }
        if (filled.right && filled.right[i]) {
          cars.push(makeCar(rightX, y, 0, COLORS[filled.right[i] % COLORS.length]));
        }
      });
      return cars;
    }

    const buildings = [
      { x: -360, y: 420, w: 150, h: 220, hgt: 120, wall: "#8a6a4e" },
      { x: -360, y: 40, w: 150, h: 180, hgt: 78, wall: "#9c7d5c" },
      { x: -360, y: -380, w: 150, h: 200, hgt: 152, wall: "#7d6350" },
      { x: 360, y: 300, w: 150, h: 240, hgt: 96, wall: "#94765a" },
      { x: 360, y: -80, w: 150, h: 200, hgt: 134, wall: "#836850" },
      { x: 360, y: -460, w: 150, h: 180, hgt: 70, wall: "#a08360" },
      { x: -620, y: 180, w: 200, h: 280, hgt: 190, wall: "#6f5947" },
      { x: -620, y: -320, w: 200, h: 240, hgt: 148, wall: "#87664b" },
      { x: 620, y: 80, w: 200, h: 300, hgt: 205, wall: "#75604d" },
      { x: 620, y: -380, w: 200, h: 220, hgt: 116, wall: "#8e7154" },
    ];

    const trees = [
      { x: -265, y: 220, r: 16 },
      { x: -270, y: -120, r: 18 },
      { x: -258, y: -520, r: 14 },
      { x: 268, y: 140, r: 17 },
      { x: 262, y: -280, r: 15 },
      { x: 270, y: 480, r: 16 },
      { x: -266, y: 620, r: 14 },
      { x: 266, y: -620, r: 15 },
    ];

    return [
      {
        name: "Merkez Otopark",
        time: 100,
        spawn: { x: 10, y: -210, angle: Math.PI / 2 },
        spot: { x: leftX, y: 0, w: 50, h: 108, angle: Math.PI },
        buildings,
        trees,
        parked: lotCars({
          left: [1, 2, 0, 4, 0, 3, 1, 0, 5],
          right: [2, 0, 3, 1, 6, 0, 2, 4, 1],
        }).filter((c) => !(Math.abs(c.x - leftX) < 1 && Math.abs(c.y - 0) < 1)),
        traffic: [
          makeCar(42, 280, Math.PI / 2, "#e3b341", { moving: true, speed: 55, lane: 42 }),
          makeCar(-42, 420, -Math.PI / 2, "#2b6cb0", { moving: true, speed: -48, lane: -42 }),
        ],
      },
      {
        name: "Dar Alan",
        time: 90,
        spawn: { x: 30, y: -200, angle: Math.PI / 2 },
        spot: { x: rightX, y: 120, w: 48, h: 102, angle: 0 },
        buildings,
        trees,
        parked: lotCars({
          left: [1, 3, 2, 5, 4, 1, 6, 2, 3],
          right: [2, 1, 4, 0, 3, 0, 5, 1, 6],
        }).filter((c) => !(Math.abs(c.x - rightX) < 1 && Math.abs(c.y - 120) < 1)),
        traffic: [
          makeCar(42, 80, Math.PI / 2, "#c0392b", { moving: true, speed: 70, lane: 42 }),
        ],
      },
      {
        name: "Paralel Park",
        time: 95,
        spawn: { x: 0, y: -500, angle: Math.PI / 2 },
        spot: { x: 58, y: 40, w: 40, h: 118, angle: Math.PI / 2 },
        buildings,
        trees,
        parked: [
          makeCar(58, 160, Math.PI / 2, "#2b6cb0"),
          makeCar(58, -80, Math.PI / 2, "#e3b341"),
          ...lotCars({
            left: [2, 1, 4, 3, 5, 1, 2, 6, 3],
            right: [1, 5, 2, 4, 6, 3, 1, 2, 5],
          }),
        ],
        traffic: [],
      },
      {
        name: "Yoğun Trafik",
        time: 85,
        spawn: { x: -20, y: -580, angle: Math.PI / 2 },
        spot: { x: leftX, y: 240, w: 48, h: 102, angle: Math.PI },
        buildings,
        trees,
        parked: lotCars({
          left: [1, 2, 4, 3, 5, 6, 0, 2, 1],
          right: [3, 1, 2, 5, 4, 1, 6, 2, 3],
        }).filter((c) => !(Math.abs(c.x - leftX) < 1 && Math.abs(c.y - 240) < 1)),
        traffic: [
          makeCar(42, -300, Math.PI / 2, "#d35400", { moving: true, speed: 80, lane: 42 }),
          makeCar(42, 100, Math.PI / 2, "#2d3436", { moving: true, speed: 62, lane: 42 }),
          makeCar(-42, 400, -Math.PI / 2, "#6c5ce7", { moving: true, speed: -72, lane: -42 }),
        ],
      },
      {
        name: "Usta Parkı",
        time: 80,
        spawn: { x: 0, y: 560, angle: -Math.PI / 2 },
        spot: { x: rightX, y: -240, w: 46, h: 98, angle: 0 },
        buildings: buildings.concat([
          { x: 0, y: 80, w: 70, h: 50 },
        ]),
        trees,
        parked: lotCars({
          left: [1, 3, 2, 4, 5, 1, 6, 2, 3],
          right: [2, 4, 1, 5, 0, 3, 6, 0, 1],
        }).filter((c) => !(Math.abs(c.x - rightX) < 1 && Math.abs(c.y + 240) < 1)),
        traffic: [
          makeCar(-42, 0, -Math.PI / 2, "#e3b341", { moving: true, speed: -90, lane: -42 }),
          makeCar(42, -200, Math.PI / 2, "#2b6cb0", { moving: true, speed: 85, lane: 42 }),
        ],
      },
      {
        name: "Akşam Vardiyası",
        time: 90,
        theme: "dusk",
        spawn: { x: 20, y: -560, angle: Math.PI / 2 },
        spot: { x: leftX, y: -120, w: 48, h: 104, angle: Math.PI },
        buildings,
        trees,
        parked: lotCars({
          left: [2, 4, 0, 1, 3, 5, 2, 6, 1],
          right: [1, 2, 5, 3, 4, 6, 1, 2, 4],
        }).filter((c) => !(Math.abs(c.x - leftX) < 1 && Math.abs(c.y + 120) < 1)),
        traffic: [
          makeCar(42, -400, Math.PI / 2, "#1b7a4a", { moving: true, speed: 68, lane: 42 }),
          makeCar(-42, 260, -Math.PI / 2, "#c0392b", { moving: true, speed: -74, lane: -42 }),
        ],
      },
      {
        name: "Gece Nöbeti",
        time: 85,
        theme: "night",
        spawn: { x: -20, y: 600, angle: -Math.PI / 2 },
        spot: { x: rightX, y: -120, w: 46, h: 100, angle: 0 },
        buildings,
        trees,
        parked: lotCars({
          left: [3, 1, 5, 2, 6, 4, 1, 3, 2],
          right: [2, 5, 1, 4, 0, 6, 3, 1, 5],
        }).filter((c) => !(Math.abs(c.x - rightX) < 1 && Math.abs(c.y + 120) < 1)),
        traffic: [
          makeCar(42, -400, Math.PI / 2, "#e3b341", { moving: true, speed: 78, lane: 42 }),
          makeCar(-42, 120, -Math.PI / 2, "#2d3436", { moving: true, speed: -66, lane: -42 }),
        ],
      },
      {
        name: "Yağmurlu Gece",
        time: 95,
        theme: "night",
        weather: "rain",
        grip: 0.45,
        spawn: { x: 24, y: -600, angle: Math.PI / 2 },
        spot: { x: leftX, y: 360, w: 50, h: 106, angle: Math.PI },
        buildings,
        trees,
        parked: lotCars({
          left: [1, 4, 2, 6, 3, 5, 0, 1, 2],
          right: [4, 2, 6, 1, 5, 3, 2, 4, 1],
        }).filter((c) => !(Math.abs(c.x - leftX) < 1 && Math.abs(c.y - 360) < 1)),
        traffic: [
          makeCar(42, 0, Math.PI / 2, "#6c5ce7", { moving: true, speed: 72, lane: 42 }),
          makeCar(-42, -260, -Math.PI / 2, "#d35400", { moving: true, speed: -60, lane: -42 }),
        ],
      },
      {
        name: "Kamyon Manevrası",
        time: 115,
        theme: "dusk",
        car: { w: 44, l: 116, type: "truck" },
        spawn: { x: 30, y: 240, angle: -Math.PI / 2 },
        spot: { x: rightX, y: -360, w: 58, h: 140, angle: 0 },
        buildings,
        trees,
        parked: lotCars({
          left: [2, 3, 1, 5, 4, 6, 2, 1, 3],
          right: [0, 0, 0, 2, 5, 1, 4, 3, 6],
        }),
        traffic: [
          makeCar(-42, 480, -Math.PI / 2, "#2b6cb0", { moving: true, speed: -58, lane: -42 }),
          makeCar(42, -560, Math.PI / 2, "#1b7a4a", {
            moving: true, speed: 52, lane: 42, w: 42, l: 110, type: "truck",
          }),
        ],
      },
    ];
  }

  const LEVELS = buildLevels();
  LEVELS.forEach((l) => {
    l.theme = l.theme || "day";
    l.weather = l.weather || null;
    l.grip = l.grip || 1;
    l.car = l.car || null;
  });

  const world = {
    player: makeCar(10, -210, Math.PI / 2, "#1e90c6"),
    level: LEVELS[0],
    cam: { x: 10, y: -210 },
  };

  function makeTexture(size, paint) {
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    paint(c.getContext("2d"), size);
    return c;
  }

  function initTextures() {
    const asphalt = makeTexture(256, (g, s) => {
      g.fillStyle = "#2c3036";
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 1800; i++) {
        const n = Math.random();
        g.fillStyle = n > 0.5 ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.08)";
        g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
    });
    const concrete = makeTexture(256, (g, s) => {
      g.fillStyle = "#cbb99a";
      g.fillRect(0, 0, s, s);
      g.strokeStyle = "rgba(90,70,40,0.12)";
      g.lineWidth = 2;
      for (let i = 0; i <= s; i += 32) {
        g.beginPath();
        g.moveTo(i, 0);
        g.lineTo(i, s);
        g.stroke();
        g.beginPath();
        g.moveTo(0, i);
        g.lineTo(s, i);
        g.stroke();
      }
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `rgba(80,60,30,${Math.random() * 0.07})`;
        g.fillRect(Math.random() * s, Math.random() * s, 3, 3);
      }
    });
    const roof = makeTexture(128, (g, s) => {
      g.fillStyle = "#5b5f63";
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 2600; i++) {
        const n = Math.random();
        g.fillStyle = n > 0.55 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.10)";
        g.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
      g.fillStyle = "rgba(0,0,0,0.07)";
      for (let y = 0; y < s; y += 21) g.fillRect(0, y, s, 2);
    });
    const grass = makeTexture(128, (g, s) => {
      g.fillStyle = "#3f6b39";
      g.fillRect(0, 0, s, s);
      for (let i = 0; i < 900; i++) {
        const t = Math.random();
        g.fillStyle = t > 0.6 ? "rgba(120,170,90,0.25)" : "rgba(20,50,20,0.22)";
        g.fillRect(Math.random() * s, Math.random() * s, 2, 3);
      }
    });
    textures = { asphalt, concrete, roof, grass };
    patterns = {
      asphalt: ctx.createPattern(asphalt, "repeat"),
      concrete: ctx.createPattern(concrete, "repeat"),
      roof: ctx.createPattern(roof, "repeat"),
      grass: ctx.createPattern(grass, "repeat"),
    };
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    if (amt >= 0) {
      r += (255 - r) * amt;
      g += (255 - g) * amt;
      b += (255 - b) * amt;
    } else {
      r *= 1 + amt;
      g *= 1 + amt;
      b *= 1 + amt;
    }
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function theme() {
    return THEMES[world.level.theme] || THEMES.day;
  }

  const SUN = { x: 0.72, y: -0.7 };

  function parallax(x, y, hgt) {
    const k = hgt * 0.00085;
    return { x: (x - world.cam.x) * k, y: (y - world.cam.y) * k };
  }

  function faceShade(nx, ny) {
    const d = nx * SUN.x + ny * SUN.y;
    return clamp(0.5 + d * 0.5, 0, 1);
  }

  function addParticle(p) {
    particles.push(p);
    if (particles.length > 260) particles.shift();
  }

  function burst(x, y, n, kind) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = kind === "spark" ? rand(40, 190) : rand(8, 34);
      addParticle({
        kind,
        x, y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: kind === "spark" ? rand(0.2, 0.5) : rand(0.5, 1.3),
        max: 1,
        r: kind === "spark" ? rand(1.2, 2.6) : rand(4, 11),
      });
    }
  }

  function initRain() {
    rain = [];
    if (world.level.weather !== "rain") return;
    for (let i = 0; i < 260; i++) {
      rain.push({
        x: Math.random(),
        y: Math.random(),
        len: rand(0.02, 0.06),
        spd: rand(1.1, 2.2),
      });
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resetLevel() {
    const L = LEVELS[levelIndex];
    world.level = L;
    world.player = makeCar(L.spawn.x, L.spawn.y, L.spawn.angle, "#1e90c6", L.car || {});
    world.cam.x = L.spawn.x;
    world.cam.y = L.spawn.y;
    timeLeft = L.time;
    parkHold = 0;
    invuln = 0;
    shake = 0;
    skids = [];
    particles = [];
    initRain();
    L.traffic.forEach((t) => {
      t.x = t.lane;
      t.y = t.spawnY;
      t.angle = t.speed >= 0 ? Math.PI / 2 : -Math.PI / 2;
      t.velLong = t.speed;
    });
    hud.level.textContent = `${levelIndex + 1} / ${LEVELS.length}`;
    if (hud.name) hud.name.textContent = L.name;
    canvas.style.background = theme().sky;
  }

  function startLevelFromHash() {
    const m = /level=(\d+)/.exec(location.hash);
    return m ? clamp(parseInt(m[1], 10) - 1, 0, LEVELS.length - 1) : 0;
  }

  function startGame(levelStart) {
    lives = 3;
    levelIndex = clamp(levelStart == null ? levelIndex : levelStart, 0, LEVELS.length - 1);
    runStart = levelIndex;
    resetLevel();
    state = "play";
    overlay.classList.add("hidden");
    hud.root.classList.remove("hidden");
    if (window.innerWidth < 900) touch.classList.remove("hidden");
    canvas.tabIndex = 0;
    canvas.focus({ preventScroll: true });
  }

  function showMenu(title, text, btn, fn) {
    state = "menu";
    hud.root.classList.add("hidden");
    overlay.classList.remove("hidden");
    overlay.innerHTML = `
      <div class="menu">
        <p class="kicker">PARK USTASI</p>
        <h1>${title}</h1>
        <p class="blurb">${text}</p>
        <button type="button" id="btn-again">${btn}</button>
      </div>`;
    document.getElementById("btn-again").onclick = fn;
  }

  function bindKeys(e, down) {
    const names = [];
    names.push(e.key.toLowerCase());
    if (e.code) names.push(e.code.toLowerCase());
    if (e.code === "KeyW" || e.code === "ArrowUp" || e.code === "Numpad8") names.push("throttle");
    if (e.code === "KeyS" || e.code === "ArrowDown" || e.code === "Numpad2" || e.code === "KeyR") names.push("reverse");
    if (e.code === "KeyA" || e.code === "ArrowLeft" || e.code === "Numpad4") names.push("steerl");
    if (e.code === "KeyD" || e.code === "ArrowRight" || e.code === "Numpad6") names.push("steerr");
    if (e.code === "Space") names.push(" ");
    for (const n of names) {
      if (down) keys.add(n);
      else keys.delete(n);
    }
  }

  function updateInput() {
    const up = keys.has("w") || keys.has("arrowup") || keys.has("throttle");
    const down = keys.has("s") || keys.has("arrowdown") || keys.has("r") || keys.has("reverse") || keys.has("brake");
    const left = keys.has("a") || keys.has("arrowleft") || keys.has("steerl");
    const right = keys.has("d") || keys.has("arrowright") || keys.has("steerr");
    input.throttle = up ? 1 : 0;
    input.brake = down ? 1 : 0;
    input.steer = (left ? 1 : 0) - (right ? 1 : 0);
    input.handbrake = keys.has(" ") || keys.has("handbrake");
  }

  function physicsCar(car, dt, controlled) {
    const maxSteer = 0.68;
    const wheelBase = 46;
    const engine = 560;
    const brakeF = 720;
    const reverseF = 420;
    const drag = 0.85;
    const roll = 10;
    const maxSpd = 125;

    if (controlled) {
      const spd = Math.abs(car.velLong);
      const steerLimit = maxSteer * (1 - clamp(spd / 220, 0, 0.72));
      car.steer = lerp(car.steer, input.steer * steerLimit, 1 - Math.exp(-10 * dt));

      const gas = input.throttle && !input.brake;
      const reverse = input.brake && !input.throttle;

      if (gas) {
        if (car.velLong < 0) car.velLong += brakeF * dt;
        else car.velLong += engine * dt;
        car.gear = "D";
      } else if (reverse) {
        if (car.velLong > 0) car.velLong -= brakeF * dt;
        else car.velLong -= reverseF * dt;
        car.gear = car.velLong > 8 ? "D" : "R";
      } else {
        car.velLong *= Math.max(0, 1 - 6 * dt);
        car.gear = Math.abs(car.velLong) < 6 ? "N" : car.velLong < 0 ? "R" : "D";
      }
    }

    car.velLong -= car.velLong * drag * dt;
    car.velLong -= Math.sign(car.velLong) * roll * (controlled ? world.level.grip : 1) * dt;
    car.velLong = clamp(car.velLong, -maxSpd * 0.7, maxSpd);
    if (Math.abs(car.velLong) < 2 && !controlled) car.velLong = 0;

    const road = controlled ? world.level.grip : 1;
    const grip = (input.handbrake && controlled ? 3.2 : 11) * road;
    car.velLat -= car.velLat * grip * dt;
    if (controlled && input.handbrake) {
      car.velLat += -car.steer * Math.abs(car.velLong) * 0.35 * dt * 60;
    }

    const yaw = (car.velLong / wheelBase) * Math.tan(car.steer || 0);
    car.angle = wrapAngle(car.angle + yaw * dt);
    const c = Math.cos(car.angle);
    const s = Math.sin(car.angle);
    car.x += (car.velLong * c - car.velLat * s) * dt;
    car.y += (car.velLong * s + car.velLat * c) * dt;
    car.x = clamp(car.x, -700, 700);
    car.y = clamp(car.y, -740, 740);
  }

  function moveTraffic(dt) {
    for (const t of world.level.traffic) {
      t.x = t.lane;
      t.y += t.speed * dt;
      t.angle = t.speed >= 0 ? Math.PI / 2 : -Math.PI / 2;
      t.velLong = t.speed;
      if (t.y > 760) t.y = -760;
      if (t.y < -760) t.y = 760;
    }
  }

  function collidePlayer(dt) {
    const p = world.player;
    const body = carRect(p);
    const L = world.level;
    const hits = [];

    for (const b of L.buildings) {
      const h = hitAABB(body, b);
      if (h) hits.push(h);
    }
    for (const t of L.trees) {
      const h = hitCircle(body, t);
      if (h) hits.push(h);
    }
    for (const l of LAMPS) {
      const h = hitCircle(body, l);
      if (h) hits.push(h);
    }
    for (const c of L.parked.concat(L.traffic)) {
      const h = sat(body, carRect(c));
      if (h) hits.push(h);
    }

    if (!hits.length) return 0;
    let impact = 0;
    for (const h of hits) {
      p.x += h.nx * h.pen;
      p.y += h.ny * h.pen;
      const vn = p.velLong * Math.cos(p.angle) * h.nx + p.velLong * Math.sin(p.angle) * h.ny;
      impact = Math.max(impact, Math.abs(vn) + Math.abs(p.velLat));
      p.velLong *= 0.35;
      p.velLat *= 0.2;
    }
    return impact;
  }

  function parkingScore() {
    const p = world.player;
    const s = world.level.spot;
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const ca = Math.cos(-s.angle);
    const sa = Math.sin(-s.angle);
    const lx = dx * ca - dy * sa;
    const ly = dx * sa + dy * ca;
    const tolX = Math.max(6, (s.h - p.l) / 2);
    const tolY = Math.max(5, (s.w - p.w) / 2);
    const off = Math.max(Math.abs(lx) / tolX, Math.abs(ly) / tolY);
    const pos = 1 - clamp(off / 3, 0, 1);
    let ad = Math.abs(wrapAngle(p.angle - s.angle));
    ad = Math.min(ad, Math.abs(wrapAngle(ad - Math.PI)));
    const ang = 1 - clamp(ad / 0.45, 0, 1);
    const spd = 1 - clamp(Math.abs(p.velLong) / 40, 0, 1);
    return { pos, ang, spd, ready: pos > 0.72 && ang > 0.78 && spd > 0.7 };
  }

  function nearestRearDist() {
    const p = world.player;
    if (p.gear !== "R") return 999;
    const back = 48;
    const bx = p.x - Math.cos(p.angle) * back;
    const by = p.y - Math.sin(p.angle) * back;
    let best = 999;
    const check = (x, y) => {
      best = Math.min(best, Math.hypot(x - bx, y - by));
    };
    for (const c of world.level.parked.concat(world.level.traffic)) check(c.x, c.y);
    for (const b of world.level.buildings) check(b.x, b.y);
    return best;
  }

  function updateParticles(dt) {
    for (const p of particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 1.8 * dt;
      p.vy *= 1 - 1.8 * dt;
      if (p.kind === "smoke") p.r += 14 * dt;
    }
    particles = particles.filter((p) => p.life > 0);

    for (const d of rain) {
      d.y += d.spd * dt;
      d.x += d.spd * 0.16 * dt;
      if (d.y > 1.1) {
        d.y = -0.1;
        d.x = Math.random();
      }
      if (d.x > 1.1) d.x -= 1.2;
    }
  }

  function update(dt) {
    if (state !== "play") return;
    updateInput();
    clock += dt;
    timeLeft -= dt;
    invuln = Math.max(0, invuln - dt);
    shake = Math.max(0, shake - dt * 3);

    physicsCar(world.player, dt, true);
    moveTraffic(dt);

    const slip = Math.abs(world.player.velLat) / 40 + (input.handbrake && Math.abs(world.player.velLong) > 30 ? 0.6 : 0);
    if (slip > 0.22 && Math.abs(world.player.velLong) > 20) {
      skids.push({ x: world.player.x, y: world.player.y, a: world.player.angle, life: 8 });
      if (skids.length > 420) skids.shift();
    }
    for (const s of skids) s.life -= dt;
    updateParticles(dt);

    const pl = world.player;
    if (Math.abs(pl.velLong) > 4 && Math.random() < (input.throttle ? 0.5 : 0.12)) {
      const bx = pl.x - Math.cos(pl.angle) * (pl.l / 2 + 3);
      const by = pl.y - Math.sin(pl.angle) * (pl.l / 2 + 3);
      addParticle({
        kind: world.level.weather === "rain" ? "splash" : "smoke",
        x: bx + rand(-3, 3),
        y: by + rand(-3, 3),
        vx: rand(-8, 8) - Math.cos(pl.angle) * 14,
        vy: rand(-8, 8) - Math.sin(pl.angle) * 14,
        life: rand(0.4, 0.9),
        max: 1,
        r: rand(3, 7),
      });
    }

    const impact = collidePlayer(dt);
    if (impact > 38 && invuln <= 0) {
      lives -= 1;
      invuln = 1.15;
      shake = 0.45;
      burst(world.player.x, world.player.y, 14, "spark");
      audio.crash();
      if (lives <= 0) {
        audio.fail();
        showMenu("Çarpışma", "Canın bitti. Otopark kuralları acımasız.", "Tekrar Dene", () => {
          audio.start();
          startGame();
        });
        return;
      }
    } else if (impact > 12 && invuln <= 0) {
      audio.crash();
      invuln = 0.35;
      shake = 0.18;
      burst(world.player.x, world.player.y, 6, "spark");
    }

    const p = world.player;
    audio.setEngine(p.velLong / 8, input.throttle, input.brake, p.gear === "R");
    audio.setSkid(slip);
    audio.sensor(nearestRearDist());

    const score = parkingScore();
    if (score.ready) {
      parkHold += dt;
      if (parkHold > 0.85) {
        audio.success();
        if (levelIndex >= LEVELS.length - 1) {
          const cleared = LEVELS.length - runStart;
          showMenu("Park Ustası!", `${cleared} seviyeyi temizledin. Motoru kapatsana.`, "Baştan", () => {
            audio.start();
            startGame(0);
          });
        } else {
          showMenu("Park Tamam", `${world.level.name} bitti. Sıradaki daha zor.`, "Sonraki Seviye", () => {
            levelIndex += 1;
            lives = Math.min(3, lives + 1);
            resetLevel();
            state = "play";
            overlay.classList.add("hidden");
            hud.root.classList.remove("hidden");
          });
        }
      }
    } else parkHold = Math.max(0, parkHold - dt * 0.6);

    if (timeLeft <= 0) {
      audio.fail();
      showMenu("Süre Doldu", "Park yeri başkasına kaldı.", "Tekrar Dene", () => {
        audio.start();
        startGame();
      });
    }

    world.cam.x = lerp(world.cam.x, p.x, 1 - Math.exp(-4 * dt));
    world.cam.y = lerp(world.cam.y, p.y, 1 - Math.exp(-4 * dt));
    hud.time.textContent = Math.max(0, Math.ceil(timeLeft));
    hud.lives.textContent = "❤ ".repeat(Math.max(0, lives)).trim() || "—";
    hud.speed.textContent = String(Math.round(Math.abs(p.velLong) * 0.55));
    hud.gear.textContent = p.gear;
    const near = score.pos > 0.15;
    hud.hint.classList.toggle("hidden", !near);
    hud.align.classList.toggle("hidden", !near);
    hud.fill.style.width = `${Math.round((score.pos * 0.5 + score.ang * 0.35 + score.spd * 0.15) * 100)}%`;
  }

  function worldTransform() {
    const zoom = Math.min(W / 1680, H / 900);
    const sx = shake ? rand(-7, 7) * shake : 0;
    const sy = shake ? rand(-7, 7) * shake : 0;
    ctx.translate(W / 2 + sx, H / 2 + sy);
    ctx.scale(zoom, -zoom);
    ctx.translate(-world.cam.x, -world.cam.y);
    return zoom;
  }

  function drawGround() {
    const wet = world.level.weather === "rain";

    ctx.fillStyle = patterns.concrete;
    ctx.fillRect(-2200, -1600, 4400, 3200);

    ctx.fillStyle = "rgba(0,0,0,0.05)";
    for (let x = -2200; x < 2200; x += 120) ctx.fillRect(x, -1600, 2, 3200);
    for (let y = -1600; y < 1600; y += 120) ctx.fillRect(-2200, y, 4400, 2);

    ctx.fillStyle = "rgba(30,34,30,0.16)";
    ctx.fillRect(-2200, -1600, 1900, 3200);
    ctx.fillRect(300, -1600, 1900, 3200);
    for (let i = 0; i < 18; i++) {
      const sx = (i % 2 ? 1 : -1) * (340 + ((i * 173) % 560));
      const sy = -700 + ((i * 311) % 1450);
      const rw = 40 + (i % 5) * 12;
      const rh = 26 + (i % 4) * 9;
      ctx.fillStyle = "rgba(0,0,0,0.16)";
      ctx.fillRect(sx - rw - 3, sy - rh - 3, rw * 2 + 6, rh * 2 + 6);
      ctx.fillStyle = patterns.grass;
      ctx.fillRect(sx - rw, sy - rh, rw * 2, rh * 2);
      ctx.fillStyle = "rgba(0,0,0,0.12)";
      ctx.fillRect(sx - rw, sy - rh, rw * 2, 4);
    }

    ctx.fillStyle = patterns.grass;
    ctx.fillRect(-296, -760, 60, 1520);
    ctx.fillRect(236, -760, 60, 1520);
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(-296, -760, 5, 1520);
    ctx.fillRect(291, -760, 5, 1520);
    ctx.fillRect(236, -760, 5, 1520);
    ctx.fillRect(231, -760, 5, 1520);
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    for (let y = -760; y < 760; y += 46) {
      ctx.fillRect(-292, y, 52, 3);
      ctx.fillRect(240, y, 52, 3);
    }

    for (const dir of [-1, 1]) {
      const x0 = dir < 0 ? -230 : 118;
      ctx.fillStyle = patterns.asphalt;
      ctx.fillRect(x0, -660, 112, 1320);
      const wash = ctx.createLinearGradient(x0, 0, x0 + 112, 0);
      wash.addColorStop(0, "rgba(255,255,255,0.05)");
      wash.addColorStop(0.55, "rgba(0,0,0,0.10)");
      wash.addColorStop(1, "rgba(0,0,0,0.20)");
      ctx.fillStyle = wash;
      ctx.fillRect(x0, -660, 112, 1320);
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fillRect(x0, -660, 112, 5);
      ctx.fillRect(x0, 655, 112, 5);
      ctx.fillStyle = "#b9b2a5";
      ctx.fillRect(dir < 0 ? -230 : 224, -660, 6, 1320);
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(dir < 0 ? -224 : 220, -660, 4, 1320);
    }

    ctx.fillStyle = patterns.asphalt;
    ctx.fillRect(-96, -760, 192, 1520);

    const roadShade = ctx.createLinearGradient(-96, 0, 96, 0);
    roadShade.addColorStop(0, "rgba(0,0,0,0.26)");
    roadShade.addColorStop(0.18, "rgba(0,0,0,0.05)");
    roadShade.addColorStop(0.5, "rgba(255,255,255,0.04)");
    roadShade.addColorStop(0.82, "rgba(0,0,0,0.05)");
    roadShade.addColorStop(1, "rgba(0,0,0,0.26)");
    ctx.fillStyle = roadShade;
    ctx.fillRect(-96, -760, 192, 1520);

    ctx.fillStyle = "rgba(0,0,0,0.10)";
    for (const cx of [-66, -22, 22, 66]) ctx.fillRect(cx - 11, -760, 22, 1520);

    ctx.fillStyle = "#b9b2a5";
    ctx.fillRect(-106, -760, 10, 1520);
    ctx.fillRect(96, -760, 10, 1520);
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.fillRect(-98, -760, 2, 1520);
    ctx.fillRect(96, -760, 2, 1520);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    for (let y = -760; y < 760; y += 60) {
      ctx.fillRect(-106, y, 10, 2);
      ctx.fillRect(96, y, 10, 2);
    }

    ctx.fillStyle = "rgba(0,0,0,0.12)";
    for (let i = 0; i < 14; i++) {
      const s = 12 + ((i * 37) % 26);
      ctx.beginPath();
      ctx.ellipse(-70 + ((i * 113) % 140), -700 + i * 108, s, s * 0.6, i, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.strokeStyle = "rgba(20,20,22,0.55)";
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 9; i++) {
      const y = -680 + i * 170;
      ctx.beginPath();
      ctx.moveTo(-96, y);
      ctx.lineTo(-40, y + 14);
      ctx.lineTo(20, y - 6);
      ctx.lineTo(96, y + 10);
      ctx.stroke();
    }

    for (const y of [-330, 130, 480]) {
      ctx.fillStyle = "#3c4046";
      ctx.beginPath();
      ctx.arc(-62, y, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      for (let i = -8; i <= 8; i += 4) {
        ctx.beginPath();
        ctx.moveTo(-62 + i, y - 10);
        ctx.lineTo(-62 + i, y + 10);
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "#f4c430";
    ctx.setLineDash([22, 18]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-3, -740);
    ctx.lineTo(-3, 740);
    ctx.moveTo(3, -740);
    ctx.lineTo(3, 740);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(255,255,255,0.72)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-88, -740);
    ctx.lineTo(-88, 740);
    ctx.moveTo(88, -740);
    ctx.lineTo(88, 740);
    ctx.stroke();

    for (const cy of [-620, 560]) {
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      for (let x = -88; x < 88; x += 24) ctx.fillRect(x, cy - 22, 14, 44);
      ctx.fillStyle = "rgba(0,0,0,0.18)";
      for (let x = -88; x < 88; x += 24) ctx.fillRect(x + 1, cy - 24, 14, 3);
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.fillRect(-88, cy + (cy < 0 ? 34 : -38), 176, 4);
    }

    ctx.fillStyle = "rgba(255,255,255,0.6)";
    for (const dir of [1, -1]) {
      for (let y = -420; y <= 420; y += 420) {
        ctx.save();
        ctx.translate(dir * 46, y);
        ctx.rotate(dir > 0 ? 0 : Math.PI);
        ctx.fillRect(-3, -26, 6, 40);
        ctx.beginPath();
        ctx.moveTo(-11, 12);
        ctx.lineTo(11, 12);
        ctx.lineTo(0, 30);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    for (const x of [-178, 178]) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      for (let y = -540; y <= 540; y += 120) {
        ctx.beginPath();
        ctx.moveTo(x - 28, y - 52);
        ctx.lineTo(x + 28, y - 52);
        ctx.moveTo(x - 28, y + 52);
        ctx.lineTo(x + 28, y + 52);
        ctx.stroke();
        ctx.fillStyle = "rgba(20,20,22,0.55)";
        ctx.fillRect(x + (x < 0 ? 20 : -26), y - 16, 6, 32);
        ctx.fillStyle = "rgba(220,215,205,0.5)";
        ctx.fillRect(x + (x < 0 ? 20 : -26), y - 16, 6, 4);
      }
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x - 28, -600);
      ctx.lineTo(x - 28, 600);
      ctx.moveTo(x + 28, -600);
      ctx.lineTo(x + 28, 600);
      ctx.stroke();
    }

    if (wet) {
      ctx.fillStyle = "rgba(120,160,200,0.10)";
      for (let i = 0; i < 12; i++) {
        const px = -180 + ((i * 271) % 380);
        const py = -620 + ((i * 197) % 1240);
        ctx.beginPath();
        ctx.ellipse(px, py, 26 + (i % 4) * 9, 15 + (i % 3) * 7, i, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawLamps() {
    const t = theme();
    const hgt = 96;
    for (const l of LAMPS) {
      const off = parallax(l.x, l.y, hgt);
      const hx = l.x + off.x + l.side * 30;
      const hy = l.y + off.y;
      ctx.save();

      ctx.fillStyle = "rgba(0,0,0,0.26)";
      ctx.beginPath();
      ctx.ellipse(l.x + SUN.x * 22, l.y + SUN.y * 22, 8, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.22)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(l.x + SUN.x * 20, l.y + SUN.y * 20);
      ctx.lineTo(l.x + SUN.x * 20 + l.side * 30, l.y + SUN.y * 20);
      ctx.stroke();

      ctx.fillStyle = "#3a3f47";
      ctx.beginPath();
      ctx.ellipse(l.x, l.y, 7, 6, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#565c66";
      ctx.lineWidth = 7;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(l.x, l.y);
      ctx.lineTo(l.x + off.x, l.y + off.y);
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.16)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(l.x, l.y - 1.5);
      ctx.lineTo(l.x + off.x, l.y + off.y - 1.5);
      ctx.stroke();

      ctx.strokeStyle = "#4d525b";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(l.x + off.x, l.y + off.y);
      ctx.lineTo(hx, hy);
      ctx.stroke();

      ctx.fillStyle = "#2f343b";
      roundRect(ctx, hx - 10, hy - 6, 20, 12, 4);
      ctx.fill();
      ctx.fillStyle = t.lamp > 0 ? "#ffe6a8" : "#b6bcc4";
      ctx.beginPath();
      ctx.ellipse(hx, hy, 6.5, 4.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (t.lamp > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const pool = ctx.createRadialGradient(l.x + l.side * 30, l.y, 6, l.x + l.side * 30, l.y, 74);
        pool.addColorStop(0, `rgba(255, 226, 165, ${0.16 * t.lamp})`);
        pool.addColorStop(1, "rgba(255, 210, 130, 0)");
        ctx.fillStyle = pool;
        ctx.beginPath();
        ctx.ellipse(l.x + l.side * 30, l.y, 78, 60, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  function drawSpot(s) {
    const pulse = 0.55 + Math.sin(performance.now() / 280) * 0.45;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.shadowColor = `rgba(255, 180, 40, ${0.35 + pulse * 0.4})`;
    ctx.shadowBlur = 22;
    ctx.beginPath();
    ctx.rect(-s.h / 2, -s.w / 2, s.h, s.w);
    ctx.clip();
    ctx.fillStyle = "#f0b429";
    ctx.fillRect(-s.h / 2, -s.w / 2, s.h, s.w);
    ctx.fillStyle = "#e67e22";
    ctx.rotate(Math.PI / 4);
    for (let i = -160; i < 160; i += 16) ctx.fillRect(i, -80, 8, 160);
    ctx.restore();
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(s.angle);
    ctx.strokeStyle = "#ffd34a";
    ctx.lineWidth = 3;
    ctx.strokeRect(-s.h / 2, -s.w / 2, s.h, s.w);
    ctx.fillStyle = `rgba(255, 245, 200, ${0.35 + pulse * 0.5})`;
    const bob = Math.sin(performance.now() / 380) * 6;
    ctx.beginPath();
    ctx.moveTo(-s.h / 2 + 14 + bob, -12);
    ctx.lineTo(-s.h / 2 + 14 + bob, 12);
    ctx.lineTo(-s.h / 2 - 6 + bob, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawBuilding(b) {
    const x = b.x - b.w / 2;
    const y = b.y - b.h / 2;
    const hgt = b.hgt || 110;
    const lit = theme().lamp > 0;
    const wallCol = b.wall || "#8a6a4e";
    const off = parallax(b.x, b.y, hgt);
    const sunLen = hgt * 0.18;

    ctx.save();

    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + b.w, y);
    ctx.lineTo(x + b.w + SUN.x * sunLen, y + SUN.y * sunLen);
    ctx.lineTo(x + SUN.x * sunLen, y + SUN.y * sunLen);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(x + SUN.x * sunLen, y + SUN.y * sunLen, b.w, b.h);

    const base = [
      { x, y },
      { x: x + b.w, y },
      { x: x + b.w, y: y + b.h },
      { x, y: y + b.h },
    ];
    const top = base.map((p) => ({ x: p.x + off.x, y: p.y + off.y }));
    const normals = [
      { x: 0, y: -1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
    ];

    for (let i = 0; i < 4; i++) {
      const p1 = base[i];
      const p2 = base[(i + 1) % 4];
      const n = normals[i];
      if (n.x * off.x + n.y * off.y >= 0) continue;
      const t1 = top[i];
      const t2 = top[(i + 1) % 4];
      const s = faceShade(n.x, n.y);
      ctx.fillStyle = shade(wallCol, -0.55 + s * 0.5);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.lineTo(t2.x, t2.y);
      ctx.lineTo(t1.x, t1.y);
      ctx.closePath();
      ctx.fill();

      const wcols = Math.max(2, Math.floor(Math.hypot(p2.x - p1.x, p2.y - p1.y) / 30));
      const rows = Math.max(1, Math.round(hgt / 46));
      ctx.fillStyle = lit ? "rgba(255,214,140,0.55)" : "rgba(150,185,210,0.30)";
      for (let c = 0; c < wcols; c++) {
        for (let r = 0; r < rows; r++) {
          const seed = (b.x * 31 + b.y * 17 + c * 7 + r * 13 + i * 3) % 10;
          if (lit && seed < 4) continue;
          const u0 = (c + 0.28) / wcols;
          const u1 = (c + 0.72) / wcols;
          const v0 = (r + 0.25) / rows;
          const v1 = (r + 0.7) / rows;
          const q = (u, v) => ({
            x: lerp(p1.x + (p2.x - p1.x) * u, t1.x + (t2.x - t1.x) * u, v),
            y: lerp(p1.y + (p2.y - p1.y) * u, t1.y + (t2.y - t1.y) * u, v),
          });
          const a = q(u0, v0);
          const bb = q(u1, v0);
          const cc = q(u1, v1);
          const dd = q(u0, v1);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(bb.x, bb.y);
          ctx.lineTo(cc.x, cc.y);
          ctx.lineTo(dd.x, dd.y);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    ctx.save();
    ctx.translate(off.x, off.y);
    ctx.fillStyle = patterns.roof;
    ctx.fillRect(x, y, b.w, b.h);
    const roofShade = ctx.createLinearGradient(x, y + b.h, x + b.w, y);
    roofShade.addColorStop(0, "rgba(0,0,0,0.22)");
    roofShade.addColorStop(0.5, "rgba(255,255,255,0.05)");
    roofShade.addColorStop(1, "rgba(255,255,255,0.12)");
    ctx.fillStyle = roofShade;
    ctx.fillRect(x, y, b.w, b.h);

    ctx.fillStyle = shade(wallCol, 0.05);
    ctx.fillRect(x, y, b.w, b.h);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x + 7, y + 7, b.w - 14, b.h - 14);
    ctx.fillStyle = patterns.roof;
    ctx.fillRect(x + 10, y + 10, b.w - 20, b.h - 20);
    ctx.fillStyle = roofShade;
    ctx.fillRect(x + 10, y + 10, b.w - 20, b.h - 20);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, b.w - 2, b.h - 2);

    const unit = (ux, uy, uw, uh) => {
      ctx.fillStyle = "rgba(0,0,0,0.30)";
      ctx.fillRect(ux + 5, uy - 5, uw, uh);
      ctx.fillStyle = "#9aa1a8";
      ctx.fillRect(ux, uy, uw, uh);
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.fillRect(ux, uy + uh - 4, uw, 4);
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ux, uy, uw, uh);
    };
    unit(x + b.w * 0.18, y + b.h * 0.68, 26, 18);
    unit(x + b.w * 0.58, y + b.h * 0.2, 22, 16);
    ctx.fillStyle = "rgba(60,60,66,0.85)";
    ctx.fillRect(x + b.w * 0.4, y + b.h * 0.45, 14, 26);
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    for (let i = 0; i < 5; i++) ctx.fillRect(x + b.w * 0.4, y + b.h * 0.45 + i * 5, 14, 1.5);

    ctx.strokeStyle = "rgba(30,18,8,0.5)";
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, b.w, b.h);
    ctx.restore();
    ctx.restore();
  }

  function drawTree(t) {
    const seed = Math.abs(Math.sin(t.x * 12.9898 + t.y * 78.233));
    const hgt = t.r * 4.2;
    const off = parallax(t.x, t.y, hgt);
    const sway = Math.sin(clock * 1.1 + seed * 6) * t.r * 0.05;
    const cx = t.x + off.x + sway;
    const cy = t.y + off.y;
    const sunLen = hgt * 0.2;

    ctx.save();
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(t.x + SUN.x * sunLen, t.y + SUN.y * sunLen, t.r * 1.1, t.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = "#4a3524";
    ctx.lineCap = "round";
    ctx.lineWidth = t.r * 0.42;
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.fillStyle = "#4a3524";
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r * 0.3, 0, Math.PI * 2);
    ctx.fill();

    const leaf = seed > 0.55 ? "#2f6b33" : "#356b2c";
    const blobs = [
      { dx: 0, dy: 0, r: 1 },
      { dx: -0.5, dy: 0.35, r: 0.64 },
      { dx: 0.45, dy: 0.4, r: 0.6 },
      { dx: 0.2, dy: -0.5, r: 0.62 },
      { dx: -0.35, dy: -0.4, r: 0.57 },
    ];
    ctx.fillStyle = shade(leaf, -0.35);
    blobs.forEach((b) => {
      ctx.beginPath();
      ctx.arc(cx + b.dx * t.r + 3, cy + b.dy * t.r - 3, t.r * b.r, 0, Math.PI * 2);
      ctx.fill();
    });
    blobs.forEach((b, i) => {
      const g = ctx.createRadialGradient(
        cx + b.dx * t.r - t.r * 0.3, cy + b.dy * t.r + t.r * 0.3, t.r * 0.1,
        cx + b.dx * t.r, cy + b.dy * t.r, t.r * b.r,
      );
      g.addColorStop(0, shade(leaf, 0.3 + seed * 0.12));
      g.addColorStop(1, shade(leaf, -0.18 + i * 0.02));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx + b.dx * t.r, cy + b.dy * t.r, t.r * b.r, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = "rgba(180, 225, 150, 0.22)";
    ctx.beginPath();
    ctx.arc(cx - t.r * 0.34, cy + t.r * 0.32, t.r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of particles) {
      const a = clamp(p.life / p.max, 0, 1);
      ctx.beginPath();
      if (p.kind === "spark") {
        ctx.fillStyle = `rgba(255, ${180 + Math.floor(a * 60)}, 90, ${a})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      } else if (p.kind === "splash") {
        ctx.fillStyle = `rgba(180, 205, 225, ${a * 0.5})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      } else {
        ctx.fillStyle = `rgba(190, 190, 190, ${a * 0.28})`;
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  function drawRain() {
    if (!rain.length) return;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = "rgba(190, 215, 245, 0.35)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (const d of rain) {
      const x = d.x * W;
      const y = d.y * H;
      ctx.moveTo(x, y);
      ctx.lineTo(x - d.len * W * 0.12, y + d.len * H);
    }
    ctx.stroke();
    ctx.restore();
  }

  function lightCone(car, dist) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    const hl = car.l / 2;
    const g = ctx.createRadialGradient(hl, 0, 6, hl, 0, dist);
    g.addColorStop(0, "rgba(255,240,200,0.5)");
    g.addColorStop(0.5, "rgba(255,235,180,0.16)");
    g.addColorStop(1, "rgba(255,235,180,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(hl - 8, 0);
    ctx.arc(hl, 0, dist, -0.42, 0.42);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawLighting() {
    const t = theme();
    if (t.tint) {
      ctx.save();
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = t.tint;
      ctx.fillRect(-2200, -1600, 4400, 3200);
      ctx.restore();
    }
    if (!t.lamp) return;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const l of LAMPS) {
      const gx = l.x + l.side * 30;
      const g = ctx.createRadialGradient(gx, l.y, 4, gx, l.y, 150);
      g.addColorStop(0, `rgba(255, 216, 150, ${0.42 * t.lamp})`);
      g.addColorStop(1, "rgba(255, 200, 120, 0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(gx, l.y, 150, 0, Math.PI * 2);
      ctx.fill();
    }

    lightCone(world.player, 300);
    for (const c of world.level.traffic) lightCone(c, 230);

    const p = world.player;
    if (input.brake || p.gear === "R" || Math.abs(p.velLong) < 4) {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.angle);
      const g = ctx.createRadialGradient(-p.l / 2, 0, 2, -p.l / 2, 0, 60);
      g.addColorStop(0, p.gear === "R" ? "rgba(255,255,255,0.4)" : "rgba(255,60,40,0.45)");
      g.addColorStop(1, "rgba(255,60,40,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(-p.l / 2, 0, 60, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const spot = world.level.spot;
    const pulse = 0.35 + Math.sin(clock * 3) * 0.15;
    const sg = ctx.createRadialGradient(spot.x, spot.y, 4, spot.x, spot.y, 120);
    sg.addColorStop(0, `rgba(255, 190, 70, ${pulse})`);
    sg.addColorStop(1, "rgba(255, 190, 70, 0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(spot.x, spot.y, 120, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawCar(car, player) {
    const hw = car.w / 2;
    const hl = car.l / 2;
    const truck = car.type === "truck";
    const braking = player && (input.brake || Math.abs(car.velLong) < 3);

    const carH = truck ? 46 : 30;
    const off = parallax(car.x, car.y, carH);

    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);

    ctx.save();
    ctx.rotate(-car.angle);
    ctx.fillStyle = "rgba(0,0,0,0.14)";
    ctx.beginPath();
    ctx.ellipse(SUN.x * 12, SUN.y * 12, car.l * 0.58, car.w * 0.7, car.angle, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(SUN.x * 9, SUN.y * 9);
    ctx.rotate(car.angle);
    ctx.fillStyle = "rgba(0,0,0,0.34)";
    roundRect(ctx, -hl, -hw, car.l, car.w, 10);
    ctx.fill();
    ctx.restore();

    const wheel = (x, steer) => {
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(steer || 0);
      ctx.fillStyle = "#0b0c0e";
      roundRect(ctx, -10, -hw - 5, 20, 9, 3);
      ctx.fill();
      roundRect(ctx, -10, hw - 4, 20, 9, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      ctx.fillRect(-6, -hw - 3, 12, 2);
      ctx.fillRect(-6, hw - 1, 12, 2);
      ctx.restore();
    };
    wheel(hl - 18, player ? world.player.steer : 0);
    if (truck) wheel(-hl + 40, 0);
    wheel(-hl + 16, 0);

    ctx.rotate(-car.angle);
    ctx.translate(off.x, off.y);
    ctx.rotate(car.angle);

    const base = player ? "#1e90c6" : car.color;
    const grd = ctx.createLinearGradient(0, -hw, 0, hw);
    grd.addColorStop(0, shade(base, -0.5));
    grd.addColorStop(0.24, shade(base, 0.22));
    grd.addColorStop(0.5, base);
    grd.addColorStop(0.78, shade(base, -0.18));
    grd.addColorStop(1, shade(base, -0.55));
    ctx.fillStyle = grd;
    roundRect(ctx, -hl, -hw, car.l, car.w, truck ? 5 : 9);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const sheen = ctx.createLinearGradient(-hl, 0, hl, 0);
    sheen.addColorStop(0, "rgba(255,255,255,0)");
    sheen.addColorStop(0.35, "rgba(255,255,255,0.16)");
    sheen.addColorStop(0.55, "rgba(255,255,255,0.05)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    roundRect(ctx, -hl + 3, -hw + 3, car.l - 6, 5, 2.5);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    roundRect(ctx, -hl + 3, hw - 7, car.l - 6, 4, 2);
    ctx.fill();

    if (truck) {
      ctx.fillStyle = shade(base, -0.3);
      roundRect(ctx, -hl + 6, -hw + 3, car.l * 0.58, car.w - 6, 4);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        const bx = -hl + 6 + (car.l * 0.58 * i) / 5;
        ctx.beginPath();
        ctx.moveTo(bx, -hw + 4);
        ctx.lineTo(bx, hw - 4);
        ctx.stroke();
      }
      ctx.fillStyle = "rgba(25, 40, 60, 0.9)";
      roundRect(ctx, hl - 20, -hw + 5, 12, car.w - 10, 3);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(hl - 20, -hw + 5, 12, 3);
      ctx.fillStyle = "#c9ccd1";
      ctx.fillRect(hl - 26, -hw + 2, 4, car.w - 4);
    } else {
      ctx.fillStyle = shade(base, -0.12);
      roundRect(ctx, -hl + 16, -hw + 4, car.l - 40, car.w - 8, 7);
      ctx.fill();

      const glass = ctx.createLinearGradient(hl - 30, -hw, hl - 12, hw);
      glass.addColorStop(0, "rgba(150, 200, 235, 0.75)");
      glass.addColorStop(1, "rgba(25, 45, 70, 0.9)");
      ctx.fillStyle = glass;
      roundRect(ctx, hl - 30, -hw + 7, 15, car.w - 14, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(20, 35, 55, 0.85)";
      roundRect(ctx, -hl + 12, -hw + 8, 13, car.w - 16, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(30, 50, 75, 0.5)";
      ctx.fillRect(-hl + 28, -hw + 5, car.l - 60, 4);
      ctx.fillRect(-hl + 28, hw - 9, car.l - 60, 4);

      const roof = ctx.createLinearGradient(0, -hw + 4, 0, hw - 4);
      roof.addColorStop(0, "rgba(255,255,255,0.16)");
      roof.addColorStop(0.45, "rgba(255,255,255,0.03)");
      roof.addColorStop(1, "rgba(0,0,0,0.20)");
      ctx.fillStyle = roof;
      roundRect(ctx, -hl + 16, -hw + 4, car.l - 40, car.w - 8, 7);
      ctx.fill();

      ctx.strokeStyle = "rgba(0,0,0,0.30)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(-hl + 16, -hw + 4);
      ctx.lineTo(-hl + 16, hw - 4);
      ctx.moveTo(hl - 24, -hw + 4);
      ctx.lineTo(hl - 24, hw - 4);
      ctx.stroke();

      ctx.fillStyle = shade(base, -0.35);
      roundRect(ctx, hl - 34, -hw - 5, 8, 5, 2);
      ctx.fill();
      roundRect(ctx, hl - 34, hw, 8, 5, 2);
      ctx.fill();
    }

    const headOn = theme().lamp > 0;
    ctx.fillStyle = headOn ? "#fff6d0" : "#e6e2c2";
    roundRect(ctx, hl - 6, -hw + 5, 6, 9, 2);
    ctx.fill();
    roundRect(ctx, hl - 6, hw - 14, 6, 9, 2);
    ctx.fill();
    if (headOn) {
      ctx.fillStyle = "rgba(255, 245, 205, 0.35)";
      roundRect(ctx, hl - 9, -hw + 2, 12, 15, 4);
      ctx.fill();
      roundRect(ctx, hl - 9, hw - 17, 12, 15, 4);
      ctx.fill();
    }

    ctx.fillStyle = braking ? "#ff4530" : "#8e2b20";
    roundRect(ctx, -hl, -hw + 5, 4, 9, 2);
    ctx.fill();
    roundRect(ctx, -hl, hw - 14, 4, 9, 2);
    ctx.fill();
    if (player && car.gear === "R") {
      ctx.fillStyle = "#f2f6ff";
      ctx.fillRect(-hl, -4, 4, 8);
    }

    ctx.fillStyle = "#c9ccd1";
    ctx.fillRect(-hl - 1, -6, 4, 12);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(-hl + 3, -hw + 1, 3, car.w - 2);
    ctx.restore();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawSkids() {
    ctx.strokeStyle = "rgba(20,20,20,0.28)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (const s of skids) {
      if (s.life <= 0) continue;
      ctx.globalAlpha = clamp(s.life / 8, 0, 0.4);
      ctx.beginPath();
      ctx.moveTo(s.x - Math.sin(s.a) * 12, s.y + Math.cos(s.a) * 12);
      ctx.lineTo(s.x + Math.sin(s.a) * 12, s.y - Math.cos(s.a) * 12);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  function drawMinimap() {
    const mw = 170;
    const mh = 110;
    const x = 18;
    const y = 18;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 12;
    ctx.fillStyle = "rgba(8,10,14,0.78)";
    roundRect(ctx, x, y, mw, mh, 8);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.save();
    roundRect(ctx, x, y, mw, mh, 8);
    ctx.clip();
    const scale = Math.min(mw / 1400, mh / 1500);
    const mapX = (wx) => x + mw / 2 + wx * scale;
    const mapY = (wy) => y + mh / 2 - wy * scale;
    ctx.fillStyle = "#2c3036";
    ctx.fillRect(mapX(-96), mapY(760), 192 * scale, 1520 * scale);
    ctx.fillStyle = "rgba(44,48,54,0.9)";
    ctx.fillRect(mapX(-230), mapY(660), 112 * scale, 1320 * scale);
    ctx.fillRect(mapX(118), mapY(660), 112 * scale, 1320 * scale);
    ctx.fillStyle = "rgba(90,110,80,0.5)";
    ctx.fillRect(mapX(-296), mapY(760), 60 * scale, 1520 * scale);
    ctx.fillRect(mapX(236), mapY(760), 60 * scale, 1520 * scale);
    ctx.fillStyle = "rgba(120,90,60,0.65)";
    for (const b of world.level.buildings) {
      ctx.fillRect(mapX(b.x - b.w / 2), mapY(b.y + b.h / 2), b.w * scale, b.h * scale);
    }
    ctx.fillStyle = "#888";
    for (const c of world.level.parked) ctx.fillRect(mapX(c.x) - 2, mapY(c.y) - 2, 4, 4);
    ctx.fillStyle = "#e05a3a";
    for (const c of world.level.traffic) ctx.fillRect(mapX(c.x) - 2, mapY(c.y) - 3, 4, 6);
    const blink = 0.5 + Math.sin(clock * 5) * 0.5;
    ctx.fillStyle = `rgba(240, 180, 41, ${0.45 + blink * 0.55})`;
    ctx.fillRect(mapX(world.level.spot.x) - 4, mapY(world.level.spot.y) - 5, 8, 10);
    ctx.fillStyle = "#5ec8f0";
    ctx.fillRect(mapX(world.player.x) - 3, mapY(world.player.y) - 3, 6, 6);
    ctx.restore();
    ctx.strokeStyle = "rgba(255,193,74,0.4)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, mw, mh, 8);
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme().sky;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    worldTransform();
    drawGround();
    drawSkids();
    drawSpot(world.level.spot);
    drawLamps();
    world.level.buildings.forEach(drawBuilding);
    world.level.trees.forEach(drawTree);
    world.level.parked.forEach((c) => drawCar(c, false));
    world.level.traffic.forEach((c) => drawCar(c, false));
    drawCar(world.player, true);
    drawParticles();
    drawLighting();
    ctx.restore();

    drawRain();

    const t = theme();
    const sun = ctx.createLinearGradient(0, 0, W, H);
    sun.addColorStop(0, t.lamp > 0 ? "rgba(90,120,190,0.12)" : "rgba(255,226,170,0.14)");
    sun.addColorStop(0.55, "rgba(255,255,255,0)");
    sun.addColorStop(1, t.lamp > 0 ? "rgba(10,14,30,0.28)" : "rgba(40,30,60,0.12)");
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, W, H);

    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.32, W / 2, H / 2, H * 0.82);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.7, t.lamp > 0 ? "rgba(0,0,0,0.22)" : "rgba(0,0,0,0.10)");
    g.addColorStop(1, t.lamp > 0 ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0.32)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (state === "play") drawMinimap();
  }

  function loop(t) {
    const dt = clamp((t - last) / 1000, 0, 0.033);
    last = t;
    if (state === "play") update(dt);
    render();
    requestAnimationFrame(loop);
  }

  window.addEventListener("keydown", (e) => {
    bindKeys(e, true);
    if (e.key === " " || e.key.startsWith("Arrow") || e.code === "KeyR" || e.code === "KeyS") e.preventDefault();
    if (e.key.toLowerCase() === "h") audio.horn();
    if (e.key.toLowerCase() === "t" && state === "play") resetLevel();
  });
  window.addEventListener("keyup", (e) => bindKeys(e, false));
  window.addEventListener("resize", resize);

  for (const btn of document.querySelectorAll("#touch [data-key]")) {
    const k = btn.getAttribute("data-key").toLowerCase();
    const on = (e) => {
      e.preventDefault();
      keys.add(k);
    };
    const off = (e) => {
      e.preventDefault();
      keys.delete(k);
    };
    btn.addEventListener("pointerdown", on);
    btn.addEventListener("pointerup", off);
    btn.addEventListener("pointerleave", off);
  }

  document.getElementById("btn-start").addEventListener("click", async () => {
    await audio.start();
    startGame(startLevelFromHash());
  });

  window.__park = {
    get world() { return world; },
    get levelIndex() { return levelIndex; },
    score: () => parkingScore(),
    levels: LEVELS,
  };

  initTextures();
  resize();
  last = performance.now();
  requestAnimationFrame(loop);
})();
