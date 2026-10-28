// Ненавязчивый живой фон Side Panel: 12 контурных фигур, отражения от стен,
// плавное изменение размера и независимые случайные изменения траектории.
// Слой декоративный: никакого влияния на поиск, фильтры или историю.
(() => {
  'use strict';

  const canvas = document.getElementById('kinoAmbientCanvas');
  if (!canvas) return;
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) return;

  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const SPEED = 1.4; // «Быстрее» из согласованного предпросмотра.
  const FRAME_MS = 1000 / 30;
  const TYPES = [
    'circle', 'square', 'triangle', 'diamond', 'hexagon', 'pentagon',
    'ring', 'rounded', 'triangle', 'square', 'circle', 'diamond'
  ];

  let width = 0;
  let height = 0;
  let deviceScale = 1;
  let particles = [];
  let stroke = '';
  let dotColor = '';
  let frameId = null;
  let lastTick = 0;
  let lastPaint = 0;

  const rand = (min, max) => min + Math.random() * (max - min);

  function refreshPalette() {
    const styles = getComputedStyle(document.body);
    stroke = styles.getPropertyValue('--kino-shape').trim() || 'rgba(100, 115, 190, .3)';
    dotColor = styles.getPropertyValue('--kino-dot').trim() || 'rgba(100, 115, 190, .3)';
  }

  function polygon(sides, radius) {
    context.moveTo(radius, 0);
    for (let i = 1; i < sides; i++) {
      const angle = (i * Math.PI * 2) / sides;
      context.lineTo(Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    context.closePath();
  }

  function drawShape(particle) {
    const radius = particle.size *
      (1 + particle.breathe * Math.sin(particle.phase));
    context.save();
    context.translate(particle.x, particle.y);
    context.rotate(particle.angle);
    context.globalAlpha = particle.alpha;
    context.strokeStyle = stroke;
    context.lineWidth = particle.type === 'ring' ? 1.25 : 1.15;
    context.beginPath();

    switch (particle.type) {
      case 'circle':
        context.arc(0, 0, radius, 0, Math.PI * 2);
        break;
      case 'ring':
        context.arc(0, 0, radius, 0, Math.PI * 2);
        context.moveTo(radius * .72, 0);
        context.arc(0, 0, radius * .72, 0, Math.PI * 2);
        break;
      case 'square':
        context.rect(-radius * .8, -radius * .8, radius * 1.6, radius * 1.6);
        break;
      case 'rounded':
        context.roundRect(-radius, -radius * .63,
          radius * 2, radius * 1.26, radius * .34);
        break;
      case 'diamond':
        polygon(4, radius * 1.15);
        break;
      case 'triangle':
        polygon(3, radius * 1.1);
        break;
      case 'pentagon':
        polygon(5, radius);
        break;
      case 'hexagon':
        polygon(6, radius);
        break;
    }

    context.stroke();
    context.restore();
  }

  function draw() {
    if (width <= 0 || height <= 0) return;
    context.clearRect(0, 0, width, height);
    for (const particle of particles) drawShape(particle);

    // Несколько едва заметных точек для глубины фона.
    context.fillStyle = dotColor;
    context.globalAlpha = .75;
    const positions = [
      [.13, .22], [.78, .14], [.35, .69],
      [.87, .55], [.62, .86], [.22, .47]
    ];
    for (let i = 0; i < positions.length; i++) {
      context.beginPath();
      context.arc(width * positions[i][0], height * positions[i][1],
        i % 3 === 0 ? 1.8 : 1.3, 0, Math.PI * 2);
      context.fill();
    }
    context.globalAlpha = 1;
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, bounds.width);
    const nextHeight = Math.max(1, bounds.height);
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (width === nextWidth && height === nextHeight && deviceScale === nextDpr) {
      return;
    }

    width = nextWidth;
    height = nextHeight;
    deviceScale = nextDpr;
    canvas.width = Math.round(width * deviceScale);
    canvas.height = Math.round(height * deviceScale);
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);

    if (!particles.length) {
      particles = TYPES.map(type => {
        const size = rand(11, 33);
        const angle = rand(-Math.PI, Math.PI);
        const speed = rand(7, 15);
        const padding = size * 1.35 + 2;
        return {
          type, size,
          x: rand(padding, Math.max(padding, width - padding)),
          y: rand(padding, Math.max(padding, height - padding)),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          angle: rand(0, Math.PI * 2),
          spin: rand(-.18, .18),
          phase: rand(0, Math.PI * 2),
          breathe: rand(.12, .25),
          breathSpeed: rand(.35, .75),
          alpha: rand(.50, .88),
          turnIn: rand(5, 12)
        };
      });
    }

    for (const particle of particles) {
      const radius = particle.size * (1 + particle.breathe) * 1.15 + 2;
      particle.x = Math.max(radius,
        Math.min(Math.max(radius, width - radius), particle.x));
      particle.y = Math.max(radius,
        Math.min(Math.max(radius, height - radius), particle.y));
    }

    draw();
  }

  function step(seconds) {
    for (const particle of particles) {
      particle.turnIn -= seconds;
      if (particle.turnIn <= 0) {
        // Небольшой непредсказуемый поворот, не телепортация.
        const angle = rand(-.38, .38);
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const vx = particle.vx * cos - particle.vy * sin;
        particle.vy = particle.vx * sin + particle.vy * cos;
        particle.vx = vx;
        particle.turnIn = rand(5, 11);
      }

      particle.x += particle.vx * seconds;
      particle.y += particle.vy * seconds;
      const radius = particle.size * (1 + particle.breathe) * 1.15 + 2;
      const right = Math.max(radius, width - radius);
      const bottom = Math.max(radius, height - radius);

      if (particle.x <= radius) {
        particle.x = radius;
        particle.vx = Math.abs(particle.vx);
      } else if (particle.x >= right) {
        particle.x = right;
        particle.vx = -Math.abs(particle.vx);
      }
      if (particle.y <= radius) {
        particle.y = radius;
        particle.vy = Math.abs(particle.vy);
      } else if (particle.y >= bottom) {
        particle.y = bottom;
        particle.vy = -Math.abs(particle.vy);
      }

      particle.phase += particle.breathSpeed * seconds;
      particle.angle += particle.spin * seconds;
    }
  }

  function tick(time) {
    frameId = null;
    if (document.hidden || motionPreference.matches) return;
    if (time - lastPaint >= FRAME_MS) {
      // Учитываем время между нарисованными кадрами, не между RAF-вызовами.
      const elapsed = Math.min((time - (lastTick || time)) / 1000, .06);
      lastTick = time;
      lastPaint = time;
      step(elapsed * SPEED);
      draw();
    }
    frameId = requestAnimationFrame(tick);
  }

  function syncAnimation() {
    if (document.hidden || motionPreference.matches) {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      lastTick = 0;
      lastPaint = 0;
      draw(); // статичный фон в режиме уменьшения анимации
    } else if (frameId === null) {
      lastTick = 0;
      lastPaint = 0;
      frameId = requestAnimationFrame(tick);
    }
  }

  // Цвета обновляются при переключении любой из четырёх штатных тем.
  const themeObserver = new MutationObserver(() => {
    refreshPalette();
    draw();
  });
  themeObserver.observe(document.body, {
    attributes: true, attributeFilter: ['class']
  });

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  document.addEventListener('visibilitychange', syncAnimation);
  motionPreference.addEventListener('change', syncAnimation);
  window.addEventListener('pagehide', () => {
    if (frameId !== null) cancelAnimationFrame(frameId);
    frameId = null;
    resizeObserver.disconnect();
    themeObserver.disconnect();
  }, { once: true });

  refreshPalette();
  resize();
  syncAnimation();
})();
