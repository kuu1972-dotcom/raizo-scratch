const DB_NAME = "scratch-photos";
const STORE_NAME = "photos";
const DB_VERSION = 1;

const stage = document.querySelector("#stage");
const photo = document.querySelector("#photo");
const cover = document.querySelector("#cover");
const effects = document.querySelector("#effects");
const emptyState = document.querySelector("#emptyState");
const addButton = document.querySelector("#addButton");
const shuffleButton = document.querySelector("#shuffleButton");
const categoryButton = document.querySelector("#categoryButton");
const tagButton = document.querySelector("#tagButton");
const photoInput = document.querySelector("#photoInput");
const ctx = cover.getContext("2d", { willReadFrequently: false });
const fx = effects.getContext("2d", { willReadFrequently: false });

const COLORS = ["#fff3a3", "#ff7aa8", "#75e6da", "#8fd14f", "#ffb347", "#b89cff", "#ffffff"];
const EFFECT_COUNT = 10;
const CATEGORIES = [
  { id: "all", label: "ぜんぶ" },
  { id: "person", label: "ひと" },
  { id: "car", label: "くるま" },
  { id: "other", label: "そのた" }
];
const ASSIGNABLE_CATEGORIES = CATEGORIES.filter((category) => category.id !== "all");

let db;
let photoItems = [];
let currentObjectUrl = "";
let currentIndex = -1;
let currentEffect = 0;
let activeCategory = "all";
let isDrawing = false;
let lastPoint = null;
let resizeTimer = 0;
let particles = [];
let animationFrame = 0;
let audioContext = null;
let masterGain = null;
let lastSoundAt = 0;
let audioUnlocked = false;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = action(store);

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readAllPhotos() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function savePhoto(file) {
  const category = await detectCategory(file);
  const item = {
    id: `${Date.now()}-${crypto.randomUUID()}`,
    blob: file,
    category,
    name: file.name,
    createdAt: Date.now()
  };

  return transact("readwrite", (store) => {
    store.put(item);
    return item;
  });
}

function updatePhoto(item) {
  return transact("readwrite", (store) => {
    store.put(item);
    return item;
  });
}

function visiblePhotoIndexes() {
  if (activeCategory === "all") {
    return photoItems.map((item, index) => index);
  }

  const indexes = [];
  photoItems.forEach((item, index) => {
    if ((item.category || "other") === activeCategory) {
      indexes.push(index);
    }
  });

  return indexes.length ? indexes : photoItems.map((item, index) => index);
}

function randomIndex(exceptIndex = -1) {
  const indexes = visiblePhotoIndexes();
  if (indexes.length <= 1) {
    return indexes[0] ?? 0;
  }

  let next = indexes[Math.floor(Math.random() * indexes.length)];
  while (next === exceptIndex) {
    next = indexes[Math.floor(Math.random() * indexes.length)];
  }
  return next;
}

function setEmptyState(isEmpty) {
  emptyState.hidden = !isEmpty;
  shuffleButton.disabled = isEmpty;
  categoryButton.disabled = isEmpty;
  tagButton.disabled = isEmpty;
}

function updateCategoryButtons() {
  const selected = CATEGORIES.find((category) => category.id === activeCategory) || CATEGORIES[0];
  const current = photoItems[currentIndex];
  const assigned = ASSIGNABLE_CATEGORIES.find((category) => category.id === (current?.category || "other"));
  categoryButton.textContent = selected.label;
  tagButton.textContent = assigned ? assigned.label : "分類";
}

function fitCanvasToStage() {
  const rect = stage.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  for (const canvas of [cover, effects]) {
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  fx.setTransform(ratio, 0, 0, ratio, 0, 0);
  resetCover();
  clearEffects();
}

function resetCover() {
  const width = cover.width / (window.devicePixelRatio || 1);
  const height = cover.height / (window.devicePixelRatio || 1);

  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, width, height);

  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#f7c948");
  gradient.addColorStop(0.5, "#6ec6ff");
  gradient.addColorStop(1, "#58c77d");

  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "rgba(255, 255, 255, 0.34)";
  const dotSize = Math.max(34, Math.min(width, height) * 0.08);
  for (let y = -dotSize; y < height + dotSize; y += dotSize * 1.8) {
    for (let x = -dotSize; x < width + dotSize; x += dotSize * 1.8) {
      ctx.beginPath();
      ctx.arc(x, y, dotSize * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function showPhoto(index) {
  if (!photoItems.length) {
    setEmptyState(true);
    return;
  }

  setEmptyState(false);
  currentIndex = index;
  currentEffect = Math.floor(Math.random() * EFFECT_COUNT);

  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }

  currentObjectUrl = URL.createObjectURL(photoItems[index].blob);
  photo.src = currentObjectUrl;
  resetCover();
  clearEffects();
  updateCategoryButtons();
}

function showRandomPhoto() {
  showPhoto(randomIndex(currentIndex));
}

function nextCategoryId(categoryId, categories) {
  const index = categories.findIndex((category) => category.id === categoryId);
  return categories[(index + 1 + categories.length) % categories.length].id;
}

function changeActiveCategory() {
  activeCategory = nextCategoryId(activeCategory, CATEGORIES);
  updateCategoryButtons();
  if (photoItems.length) {
    showRandomPhoto();
  }
}

async function changeCurrentPhotoCategory() {
  const item = photoItems[currentIndex];
  if (!item) {
    return;
  }

  item.category = nextCategoryId(item.category || "other", ASSIGNABLE_CATEGORIES);
  await updatePhoto(item);
  updateCategoryButtons();
}

async function detectCategory(file) {
  const filename = file.name.toLowerCase();
  if (/car|auto|vehicle|truck|bus|taxi|van|車|くるま|自動車/.test(filename)) {
    return "car";
  }

  if (await hasFace(file)) {
    return "person";
  }

  return "other";
}

async function hasFace(file) {
  if (!("FaceDetector" in window) || !("createImageBitmap" in window)) {
    return false;
  }

  try {
    const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 4 });
    const bitmap = await createImageBitmap(file);
    const faces = await detector.detect(bitmap);
    bitmap.close();
    return faces.length > 0;
  } catch {
    return false;
  }
}

function pointFromEvent(event) {
  const rect = cover.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function scratch(from, to) {
  const width = cover.width / (window.devicePixelRatio || 1);
  const height = cover.height / (window.devicePixelRatio || 1);
  const brush = Math.max(34, Math.min(width, height) * 0.075);

  ctx.globalCompositeOperation = "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = brush;

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(to.x, to.y, brush * 0.5, 0, Math.PI * 2);
  ctx.fill();

  emitEffect(to, from, brush);
  playEffectSound(currentEffect);
  startEffects();
}

async function unlockAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContext();
    masterGain = audioContext.createGain();
    masterGain.gain.value = 0.42;
    masterGain.connect(audioContext.destination);
  }

  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      return audioContext;
    }
  }

  if (!audioUnlocked) {
    const buffer = audioContext.createBuffer(1, 1, audioContext.sampleRate);
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    gain.gain.value = 0.0001;
    source.buffer = buffer;
    source.connect(gain);
    gain.connect(masterGain);
    source.start(0);
    audioUnlocked = true;
  }

  return audioContext;
}

function playEffectSound(effect) {
  const now = performance.now();
  if (now - lastSoundAt < 95) {
    return;
  }

  if (!audioContext || !masterGain || audioContext.state !== "running") {
    return;
  }

  lastSoundAt = now;
  const players = [
    playSparkleSound,
    playRainbowSound,
    playBubbleSound,
    playConfettiSound,
    playRingSound,
    playPetalSound,
    playCometSound,
    playSnowSound,
    playFireworkSound,
    playCandySound
  ];

  players[effect](audioContext.currentTime);
}

function playTone(start, frequency, duration, options = {}) {
  if (!audioContext || !masterGain) {
    return;
  }

  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = options.type || "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  if (options.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, start + duration);
  }

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.volume || 0.25, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  oscillator.connect(gain);
  gain.connect(masterGain);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playNoise(start, duration, options = {}) {
  if (!audioContext || !masterGain) {
    return;
  }

  const length = Math.max(1, Math.floor(audioContext.sampleRate * duration));
  const buffer = audioContext.createBuffer(1, length, audioContext.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = random(-1, 1);
  }

  const noise = audioContext.createBufferSource();
  const gain = audioContext.createGain();
  const filter = audioContext.createBiquadFilter();
  filter.type = options.filterType || "highpass";
  filter.frequency.value = options.frequency || 1200;
  gain.gain.setValueAtTime(options.volume || 0.08, start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  noise.buffer = buffer;
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);
  noise.start(start);
}

function playSparkleSound(start) {
  playTone(start, 1180, 0.08, { endFrequency: 1760, volume: 0.2 });
  playTone(start + 0.035, 1680, 0.07, { endFrequency: 2320, volume: 0.12 });
}

function playRainbowSound(start) {
  playTone(start, 520, 0.16, { endFrequency: 980, type: "triangle", volume: 0.16 });
  playTone(start + 0.05, 780, 0.13, { endFrequency: 1320, type: "triangle", volume: 0.1 });
}

function playBubbleSound(start) {
  playTone(start, 360, 0.11, { endFrequency: 720, type: "sine", volume: 0.18 });
}

function playConfettiSound(start) {
  playNoise(start, 0.08, { frequency: 2600, volume: 0.06 });
  playTone(start + 0.01, 760, 0.06, { type: "square", volume: 0.07 });
}

function playRingSound(start) {
  playTone(start, 640, 0.22, { endFrequency: 620, volume: 0.14 });
  playTone(start, 1280, 0.18, { endFrequency: 1240, volume: 0.06 });
}

function playPetalSound(start) {
  playTone(start, 440, 0.18, { endFrequency: 330, type: "triangle", volume: 0.13 });
}

function playCometSound(start) {
  playTone(start, 980, 0.18, { endFrequency: 260, type: "sawtooth", volume: 0.11 });
}

function playSnowSound(start) {
  playTone(start, 1320, 0.1, { endFrequency: 920, volume: 0.12 });
  playTone(start + 0.04, 1720, 0.08, { endFrequency: 1200, volume: 0.08 });
}

function playFireworkSound(start) {
  playNoise(start, 0.12, { filterType: "bandpass", frequency: 900, volume: 0.09 });
  playTone(start, 180, 0.12, { endFrequency: 90, type: "triangle", volume: 0.11 });
}

function playCandySound(start) {
  playTone(start, 660, 0.07, { endFrequency: 880, type: "square", volume: 0.11 });
  playTone(start + 0.055, 990, 0.07, { endFrequency: 1320, type: "square", volume: 0.08 });
}

function random(min, max) {
  return min + Math.random() * (max - min);
}

function pickColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function angleBetween(from, to) {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function addParticle(point, options = {}) {
  const life = options.life ?? random(22, 42);
  particles.push({
    x: point.x,
    y: point.y,
    vx: options.vx ?? random(-1.6, 1.6),
    vy: options.vy ?? random(-1.9, 1.2),
    size: options.size ?? random(4, 12),
    life,
    maxLife: life,
    color: options.color ?? pickColor(),
    shape: options.shape ?? "dot",
    spin: options.spin ?? random(-0.16, 0.16),
    rotation: options.rotation ?? random(0, Math.PI * 2),
    gravity: options.gravity ?? 0.03,
    fade: options.fade ?? 1,
    lineWidth: options.lineWidth ?? 3
  });
}

function emitEffect(point, from, brush) {
  const angle = angleBetween(from, point);
  const amount = Math.max(2, Math.round(brush / 18));
  const emitters = [
    emitSparkles,
    emitRainbowDust,
    emitBubbles,
    emitConfetti,
    emitRings,
    emitPetals,
    emitComets,
    emitSnow,
    emitFireworks,
    emitCandyDots
  ];

  emitters[currentEffect](point, angle, amount);
}

function emitSparkles(point, angle, amount) {
  for (let i = 0; i < amount + 2; i += 1) {
    addParticle(point, {
      shape: "star",
      size: random(7, 16),
      vx: random(-2.4, 2.4),
      vy: random(-2.4, 1.4),
      life: random(24, 38),
      gravity: 0.02,
      color: pickColor()
    });
  }
}

function emitRainbowDust(point, angle, amount) {
  for (let i = 0; i < amount + 4; i += 1) {
    const direction = angle + random(-1.8, 1.8);
    const speed = random(0.6, 2.2);
    addParticle(point, {
      shape: "soft",
      size: random(12, 28),
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      life: random(18, 32),
      gravity: -0.01,
      color: pickColor(),
      fade: 0.75
    });
  }
}

function emitBubbles(point, angle, amount) {
  for (let i = 0; i < amount + 2; i += 1) {
    addParticle(point, {
      shape: "bubble",
      size: random(10, 28),
      vx: random(-1.2, 1.2),
      vy: random(-2.6, -0.7),
      life: random(30, 54),
      gravity: -0.015,
      color: "#ffffff",
      lineWidth: random(2, 4)
    });
  }
}

function emitConfetti(point, angle, amount) {
  for (let i = 0; i < amount + 3; i += 1) {
    addParticle(point, {
      shape: "rect",
      size: random(7, 15),
      vx: random(-2.6, 2.6),
      vy: random(-2.2, 1.4),
      life: random(26, 46),
      gravity: 0.05,
      color: pickColor()
    });
  }
}

function emitRings(point, angle, amount) {
  for (let i = 0; i < Math.max(2, amount); i += 1) {
    addParticle(point, {
      shape: "ring",
      size: random(10, 24),
      vx: random(-0.45, 0.45),
      vy: random(-0.45, 0.45),
      life: random(22, 36),
      gravity: 0,
      color: pickColor(),
      lineWidth: random(3, 5)
    });
  }
}

function emitPetals(point, angle, amount) {
  for (let i = 0; i < amount + 2; i += 1) {
    addParticle(point, {
      shape: "petal",
      size: random(10, 20),
      vx: random(-1.7, 1.7),
      vy: random(-2.1, 0.7),
      life: random(30, 52),
      gravity: 0.025,
      color: ["#ff9ec4", "#ffc2d6", "#fff1a8"][Math.floor(Math.random() * 3)]
    });
  }
}

function emitComets(point, angle, amount) {
  for (let i = 0; i < amount + 1; i += 1) {
    const direction = angle + Math.PI + random(-0.9, 0.9);
    const speed = random(2, 4);
    addParticle(point, {
      shape: "comet",
      size: random(12, 22),
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      life: random(18, 30),
      gravity: 0,
      color: pickColor(),
      lineWidth: random(4, 7)
    });
  }
}

function emitSnow(point, angle, amount) {
  for (let i = 0; i < amount + 2; i += 1) {
    addParticle(point, {
      shape: "cross",
      size: random(9, 18),
      vx: random(-1.4, 1.4),
      vy: random(-1.8, 1),
      life: random(26, 46),
      gravity: 0.015,
      color: "#ffffff",
      lineWidth: 2
    });
  }
}

function emitFireworks(point, angle, amount) {
  const count = amount + 5;
  for (let i = 0; i < count; i += 1) {
    const direction = (Math.PI * 2 * i) / count + random(-0.18, 0.18);
    const speed = random(1.2, 3.2);
    addParticle(point, {
      shape: "dot",
      size: random(5, 11),
      vx: Math.cos(direction) * speed,
      vy: Math.sin(direction) * speed,
      life: random(20, 34),
      gravity: 0.025,
      color: pickColor()
    });
  }
}

function emitCandyDots(point, angle, amount) {
  for (let i = 0; i < amount + 4; i += 1) {
    addParticle(point, {
      shape: "dot",
      size: random(8, 18),
      vx: random(-1.8, 1.8),
      vy: random(-2, 1.2),
      life: random(24, 42),
      gravity: 0.04,
      color: pickColor()
    });
  }
}

function clearEffects() {
  particles = [];
  const width = effects.width / (window.devicePixelRatio || 1);
  const height = effects.height / (window.devicePixelRatio || 1);
  fx.clearRect(0, 0, width, height);
  if (animationFrame) {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
  }
}

function startEffects() {
  if (!animationFrame) {
    animationFrame = requestAnimationFrame(drawEffects);
  }
}

function drawEffects() {
  const width = effects.width / (window.devicePixelRatio || 1);
  const height = effects.height / (window.devicePixelRatio || 1);
  fx.clearRect(0, 0, width, height);

  particles = particles.filter((particle) => {
    particle.life -= 1;
    if (particle.life <= 0) {
      return false;
    }

    particle.x += particle.vx;
    particle.y += particle.vy;
    particle.vy += particle.gravity;
    particle.rotation += particle.spin;
    drawParticle(particle);
    return true;
  });

  animationFrame = particles.length ? requestAnimationFrame(drawEffects) : 0;
}

function drawParticle(particle) {
  const progress = 1 - particle.life / particle.maxLife;
  const alpha = Math.max(0, (particle.life / particle.maxLife) * particle.fade);
  const size = particle.shape === "ring" ? particle.size * (1 + progress * 1.9) : particle.size;

  fx.save();
  fx.globalAlpha = alpha;
  fx.translate(particle.x, particle.y);
  fx.rotate(particle.rotation);
  fx.fillStyle = particle.color;
  fx.strokeStyle = particle.color;
  fx.lineWidth = particle.lineWidth;

  if (particle.shape === "star") {
    drawStar(size);
  } else if (particle.shape === "soft") {
    const gradient = fx.createRadialGradient(0, 0, 0, 0, 0, size);
    gradient.addColorStop(0, particle.color);
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    fx.fillStyle = gradient;
    fx.beginPath();
    fx.arc(0, 0, size, 0, Math.PI * 2);
    fx.fill();
  } else if (particle.shape === "bubble") {
    fx.beginPath();
    fx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
    fx.stroke();
    fx.beginPath();
    fx.arc(-size * 0.15, -size * 0.16, size * 0.1, 0, Math.PI * 2);
    fx.fill();
  } else if (particle.shape === "rect") {
    fx.fillRect(-size * 0.45, -size * 0.25, size * 0.9, size * 0.5);
  } else if (particle.shape === "ring") {
    fx.beginPath();
    fx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
    fx.stroke();
  } else if (particle.shape === "petal") {
    fx.beginPath();
    fx.ellipse(0, 0, size * 0.35, size * 0.75, 0, 0, Math.PI * 2);
    fx.fill();
  } else if (particle.shape === "comet") {
    fx.lineCap = "round";
    fx.beginPath();
    fx.moveTo(0, 0);
    fx.lineTo(-particle.vx * size * 1.4, -particle.vy * size * 1.4);
    fx.stroke();
    fx.beginPath();
    fx.arc(0, 0, size * 0.22, 0, Math.PI * 2);
    fx.fill();
  } else if (particle.shape === "cross") {
    fx.lineCap = "round";
    for (let i = 0; i < 3; i += 1) {
      fx.rotate(Math.PI / 3);
      fx.beginPath();
      fx.moveTo(-size * 0.45, 0);
      fx.lineTo(size * 0.45, 0);
      fx.stroke();
    }
  } else {
    fx.beginPath();
    fx.arc(0, 0, size * 0.5, 0, Math.PI * 2);
    fx.fill();
  }

  fx.restore();
}

function drawStar(size) {
  const points = 5;
  const outer = size * 0.5;
  const inner = outer * 0.45;
  fx.beginPath();
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / points;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) {
      fx.moveTo(x, y);
    } else {
      fx.lineTo(x, y);
    }
  }
  fx.closePath();
  fx.fill();
}

function startScratch(event) {
  if (!photoItems.length) {
    photoInput.click();
    return;
  }

  event.preventDefault();
  unlockAudio().then(() => playEffectSound(currentEffect));
  isDrawing = true;
  currentEffect = (currentEffect + 1) % EFFECT_COUNT;
  lastPoint = pointFromEvent(event);
  scratch(lastPoint, lastPoint);
}

function moveScratch(event) {
  if (!isDrawing || !lastPoint) {
    return;
  }

  event.preventDefault();
  const nextPoint = pointFromEvent(event);
  scratch(lastPoint, nextPoint);
  lastPoint = nextPoint;
}

function stopScratch() {
  isDrawing = false;
  lastPoint = null;
}

async function addPhotos(files) {
  const images = [...files].filter((file) => file.type.startsWith("image/"));
  if (!images.length) {
    return;
  }

  const firstNewIndex = photoItems.length;
  const saved = await Promise.all(images.map(savePhoto));
  photoItems = [...photoItems, ...saved];
  showPhoto(firstNewIndex + Math.floor(Math.random() * saved.length));
}

async function init() {
  db = await openDatabase();
  photoItems = await readAllPhotos();
  fitCanvasToStage();

  if (photoItems.length) {
    showRandomPhoto();
  } else {
    setEmptyState(true);
  }
}

addButton.addEventListener("click", () => photoInput.click());
emptyState.addEventListener("click", () => photoInput.click());
shuffleButton.addEventListener("click", showRandomPhoto);
categoryButton.addEventListener("click", changeActiveCategory);
tagButton.addEventListener("click", changeCurrentPhotoCategory);
photoInput.addEventListener("change", async () => {
  await addPhotos(photoInput.files);
  photoInput.value = "";
});

cover.addEventListener("pointerdown", startScratch);
cover.addEventListener("pointermove", moveScratch);
window.addEventListener("pointerup", stopScratch);
window.addEventListener("pointercancel", stopScratch);
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(fitCanvasToStage, 120);
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

init().catch(() => {
  setEmptyState(true);
});
