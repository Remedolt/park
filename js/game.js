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
  let lives = 3;
  let timeLeft = 100;
  let parkHold = 0;
  let invuln = 0;
  let shake = 0;
  let textures = null;
  let skids = [];

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
    return { pen: t.r - dist, nx, ny };
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
      speed: opts.speed || 0,
      lane: opts.lane || 0,
      spawnY: y,
      yMin: opts.yMin || -720,
      yMax: opts.yMax || 720,
    };
  }

  function stall(x, y, angle, color, empty) {
    return empty ? null : makeCar(x, y, angle, color);
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
      { x: -360, y: 420, w: 150, h: 220 },
      { x: -360, y: 40, w: 150, h: 180 },
      { x: -360, y: -380, w: 150, h: 200 },
      { x: 360, y: 300, w: 150, h: 240 },
      { x: 360, y: -80, w: 150, h: 200 },
      { x: 360, y: -460, w: 150, h: 180 },
      { x: -620, y: 180, w: 200, h: 280 },
      { x: -620, y: -320, w: 200, h: 240 },
      { x: 620, y: 80, w: 200, h: 300 },
      { x: 620, y: -380, w: 200, h: 220 },
    ];

    const trees = [
      { x: -265, y: 220, r: 16 },
      { x: -270, y: -120, r: 18 },
      { x: -258, y: -520, r: 14 },
      { x: 268, y: 140, r: 17 },
      { x: 262, y: -280, r: 15 },
      { x: 270, y: 480, r: 16 },
      { x: -80, y: 640, r: 14 },
      { x: 70, y: -640, r: 15 },
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
    ];
  }

  const LEVELS = buildLevels();

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
      g.fillStyle = "#8b6b4a";
      g.fillRect(0, 0, s, s);
      g.fillStyle = "rgba(0,0,0,0.08)";
      for (let y = 0; y < s; y += 8) g.fillRect(0, y, s, 3);
    });
    textures = { asphalt, concrete, roof };
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
    world.player = makeCar(L.spawn.x, L.spawn.y, L.spawn.angle, "#1e90c6");
    world.cam.x = L.spawn.x;
    world.cam.y = L.spawn.y;
    timeLeft = L.time;
    parkHold = 0;
    invuln = 0;
    shake = 0;
    skids = [];
    L.traffic.forEach((t) => {
      t.x = t.lane;
      t.y = t.spawnY;
      t.angle = t.speed >= 0 ? Math.PI / 2 : -Math.PI / 2;
      t.velLong = t.speed;
    });
    hud.level.textContent = `${levelIndex + 1} / ${LEVELS.length}`;
  }

  function startGame() {
    lives = 3;
    levelIndex = 0;
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
    car.velLong -= Math.sign(car.velLong) * roll * dt;
    car.velLong = clamp(car.velLong, -maxSpd * 0.7, maxSpd);
    if (Math.abs(car.velLong) < 2 && !controlled) car.velLong = 0;

    const grip = input.handbrake && controlled ? 3.2 : 11;
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
    const pos = 1 - clamp(Math.max(Math.abs(lx) / (s.h * 0.38), Math.abs(ly) / (s.w * 0.38)), 0, 1);
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

  function update(dt) {
    if (state !== "play") return;
    updateInput();
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

    const impact = collidePlayer(dt);
    if (impact > 38 && invuln <= 0) {
      lives -= 1;
      invuln = 1.15;
      shake = 0.45;
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
          showMenu("Park Ustası!", "Beş seviyeyi de temizledin. Motoru kapatsana.", "Baştan", () => {
            audio.start();
            startGame();
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
    ctx.fillStyle = ctx.createPattern(textures.concrete, "repeat");
    ctx.fillRect(-2200, -1600, 4400, 3200);

    ctx.fillStyle = ctx.createPattern(textures.asphalt, "repeat");
    ctx.fillRect(-96, -760, 192, 1520);

    ctx.strokeStyle = "#f4c430";
    ctx.setLineDash([22, 18]);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -740);
    ctx.lineTo(0, 740);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-94, -740);
    ctx.lineTo(-94, 740);
    ctx.moveTo(94, -740);
    ctx.lineTo(94, 740);
    ctx.stroke();

    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    for (const x of [-178, 178]) {
      for (let y = -540; y <= 540; y += 120) {
        ctx.strokeRect(x - 28, y - 52, 56, 104);
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
    ctx.restore();
  }

  function drawBuilding(b) {
    ctx.save();
    ctx.fillStyle = "#00000033";
    ctx.fillRect(b.x - b.w / 2 + 8, b.y - b.h / 2 - 8, b.w, b.h);
    ctx.fillStyle = ctx.createPattern(textures.roof, "repeat");
    ctx.fillRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    ctx.strokeStyle = "rgba(40,24,10,0.45)";
    ctx.lineWidth = 3;
    ctx.strokeRect(b.x - b.w / 2, b.y - b.h / 2, b.w, b.h);
    ctx.fillStyle = "rgba(255,255,255,0.08)";
    ctx.fillRect(b.x - b.w / 2 + 12, b.y - b.h / 2 + 12, b.w - 24, 10);
    ctx.restore();
  }

  function drawTree(t) {
    ctx.beginPath();
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.ellipse(t.x + 4, t.y - 4, t.r * 1.1, t.r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#2f6b32";
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = "#4c9a46";
    ctx.arc(t.x - t.r * 0.2, t.y + t.r * 0.15, t.r * 0.55, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawCar(car, player) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.ellipse(3, 0, car.l * 0.52, car.w * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();

    const hw = car.w / 2;
    const hl = car.l / 2;
    const wheel = (x, steer) => {
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(steer || 0);
      ctx.fillStyle = "#111";
      ctx.fillRect(-9, -hw - 4, 18, 7);
      ctx.fillRect(-9, hw - 3, 18, 7);
      ctx.restore();
    };
    wheel(hl - 16, player ? world.player.steer : 0);
    wheel(-hl + 16, 0);

    const grd = ctx.createLinearGradient(hl, 0, -hl, 0);
    grd.addColorStop(0, player ? "#5ec8f0" : car.color);
    grd.addColorStop(0.4, car.color);
    grd.addColorStop(1, "#0e1116");
    ctx.fillStyle = grd;
    roundRect(ctx, -hl, -hw, car.l, car.w, 8);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = "rgba(30, 50, 70, 0.85)";
    roundRect(ctx, hl - 28, -hw + 6, 16, car.w - 12, 3);
    ctx.fill();
    ctx.fillStyle = "rgba(20, 30, 45, 0.7)";
    roundRect(ctx, -hl + 10, -hw + 7, 14, car.w - 14, 3);
    ctx.fill();

    ctx.fillStyle = "#f4f0c8";
    ctx.fillRect(hl - 4, -hw + 6, 4, 8);
    ctx.fillRect(hl - 4, hw - 14, 4, 8);
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(-hl, -hw + 6, 3, 8);
    ctx.fillRect(-hl, hw - 14, 3, 8);

    if (player) {
      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(18, 0);
      ctx.stroke();
    }
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
    ctx.fillStyle = "rgba(8,10,14,0.7)";
    ctx.strokeStyle = "rgba(255,193,74,0.35)";
    ctx.lineWidth = 1.5;
    ctx.fillRect(x, y, mw, mh);
    ctx.strokeRect(x, y, mw, mh);
    const scale = Math.min(mw / 1400, mh / 1500);
    const mapX = (wx) => x + mw / 2 + wx * scale;
    const mapY = (wy) => y + mh / 2 - wy * scale;
    ctx.fillStyle = "#2c3036";
    ctx.fillRect(mapX(-96), mapY(760), 192 * scale, 1520 * scale);
    ctx.fillStyle = "#f0b429";
    ctx.fillRect(mapX(world.level.spot.x) - 3, mapY(world.level.spot.y) - 4, 6, 8);
    ctx.fillStyle = "#888";
    for (const c of world.level.parked) ctx.fillRect(mapX(c.x) - 2, mapY(c.y) - 2, 4, 4);
    ctx.fillStyle = "#5ec8f0";
    ctx.fillRect(mapX(world.player.x) - 3, mapY(world.player.y) - 3, 6, 6);
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    worldTransform();
    drawGround();
    drawSkids();
    drawSpot(world.level.spot);
    world.level.buildings.forEach(drawBuilding);
    world.level.trees.forEach(drawTree);
    world.level.parked.forEach((c) => drawCar(c, false));
    world.level.traffic.forEach((c) => drawCar(c, false));
    drawCar(world.player, true);
    ctx.restore();

    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.35)");
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
    startGame();
  });

  initTextures();
  resize();
  last = performance.now();
  requestAnimationFrame(loop);
})();
