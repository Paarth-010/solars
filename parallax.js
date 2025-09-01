// parallax.js
import { Renderer, Camera, Geometry, Program, Mesh } from 'https://cdn.skypack.dev/ogl';

const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ===== Page transition (radial clip-path wipe) =====
const cta = document.getElementById('ctaStart');
const overlay = document.getElementById('pageTransition');

if (cta && overlay) {
  cta.addEventListener('click', (e) => {
    if (prefersReduced) return;
    e.preventDefault();
    const href = cta.getAttribute('href');
    const rect = cta.getBoundingClientRect();
    overlay.style.setProperty('--cx', (rect.left + rect.width / 2) / window.innerWidth * 100 + '%');
    overlay.style.setProperty('--cy', (rect.top + rect.height / 2) / window.innerHeight * 100 + '%');
    document.body.classList.add('leaving');
    overlay.classList.add('active');
    overlay.addEventListener('transitionend', () => { window.location.href = href; }, { once: true });
  });
}

// ===== OGL starfield =====
const container = document.getElementById('particles');
const renderer = new Renderer({ depth: false, alpha: true });
const gl = renderer.gl;
container.appendChild(gl.canvas);
gl.clearColor(0, 0, 0, 0);

const camera = new Camera(gl, { fov: 15 });
camera.position.set(0, 0, 20);
function resize() {
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.perspective({ aspect: gl.canvas.width / gl.canvas.height });
}
window.addEventListener('resize', resize, false);
resize();

// Tunables
const particleCount = 320;
const particleSpread = 10;
const speed = prefersReduced ? 0.04 : 0.09;
const particleBaseSize = 110;
const sizeRandomness = 1.0;
const alphaParticles = false;
const hoverFactor = prefersReduced ? 0.6 : 1.6;

// Buffers
const positions = new Float32Array(particleCount * 3);
const randoms   = new Float32Array(particleCount * 4);
const colors    = new Float32Array(particleCount * 3);
const palette   = ['#ffffff', '#cfe3ff', '#a3bfff'];
const hexToRgb = (hex) => {
  hex = hex.replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const int = parseInt(hex, 16);
  return [((int>>16)&255)/255, ((int>>8)&255)/255, (int&255)/255];
};
for (let i = 0; i < particleCount; i++) {
  let x, y, z, len;
  do { x=Math.random()*2-1; y=Math.random()*2-1; z=Math.random()*2-1; len=x*x+y*y+z*z; } while (len > 1 || len === 0);
  const r = Math.cbrt(Math.random());
  positions.set([x*r, y*r, z*r], i*3);
  randoms.set([Math.random(), Math.random(), Math.random(), Math.random()], i*4);
  colors.set(hexToRgb(palette[Math.floor(Math.random()*palette.length)]), i*3);
}

const vertex = `
  attribute vec3 position; attribute vec4 random; attribute vec3 color;
  uniform mat4 modelMatrix, viewMatrix, projectionMatrix;
  uniform float uTime, uSpread, uBaseSize, uSizeRandomness;
  varying vec4 vRandom; varying vec3 vColor;
  void main(){
    vRandom = random; vColor = color;
    vec3 pos = position * uSpread; pos.z *= 10.0;
    vec4 mPos = modelMatrix * vec4(pos, 1.0);
    float t = uTime;
    mPos.x += sin(t * random.z + 6.2831 * random.w) * mix(0.1, 1.5, random.x);
    mPos.y += sin(t * random.y + 6.2831 * random.x) * mix(0.1, 1.5, random.w);
    mPos.z += sin(t * random.w + 6.2831 * random.y) * mix(0.1, 1.5, random.z);
    vec4 mvPos = viewMatrix * mPos;
    gl_PointSize = (uBaseSize * (1.0 + uSizeRandomness * (random.x - 0.5))) / length(mvPos.xyz);
    gl_Position = projectionMatrix * mvPos;
  }`;

const fragment = `
  precision highp float;
  uniform float uTime, uAlphaParticles;
  varying vec4 vRandom; varying vec3 vColor;
  void main(){
    vec2 uv = gl_PointCoord.xy;
    float d = length(uv - vec2(0.5));
    vec3 tint = vColor + 0.22 * sin(uv.yxx + uTime + vRandom.y * 6.2831);
    if(uAlphaParticles < 0.5){ if(d > 0.5) discard; gl_FragColor = vec4(tint, 1.0); }
    else{ float circle = smoothstep(0.5, 0.4, d) * 0.8; gl_FragColor = vec4(tint, circle); }
  }`;

const geometry = new Geometry(gl, {
  position: { size: 3, data: positions },
  random:   { size: 4, data: randoms   },
  color:    { size: 3, data: colors    },
});
const program = new Program(gl, {
  vertex, fragment,
  uniforms: {
    uTime:           { value: 0 },
    uSpread:         { value: particleSpread },
    uBaseSize:       { value: particleBaseSize },
    uSizeRandomness: { value: sizeRandomness },
    uAlphaParticles: { value: alphaParticles ? 1 : 0 },
  },
  transparent: true, depthTest: false,
});
const particles = new Mesh(gl, { mode: gl.POINTS, geometry, program });

// ===== Pixel‑snapped cursor parallax on a single wrapper =====
const parallaxEl = document.querySelector('.parallax');
const navContainer = document.querySelector('.card-nav-container');
const mouse = { x: 0, y: 0 }, smoothed = { x: 0, y: 0 };
const lerp = (a,b,t) => a + (b - a) * t;
let liveTimer;
let parallaxPaused = false;

function setLive(){
  if (!document.body.classList.contains('parallax-live')) document.body.classList.add('parallax-live');
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => document.body.classList.remove('parallax-live'), 120);
}
function snapPx(px){
  const dpr = window.devicePixelRatio || 1;
  return Math.round(px * dpr) / dpr;
}
function onMove(e){
  if (parallaxPaused) return;
  mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
  mouse.y = -((e.clientY / window.innerHeight) * 2 - 1);
  setLive();
}
function reset(){
  mouse.x = 0; mouse.y = 0;
  document.body.classList.remove('parallax-live');
}
window.addEventListener('pointermove', onMove, { passive:true });
window.addEventListener('pointerleave', reset, { passive:true });
window.addEventListener('blur', reset, { passive:true });

// Pause parallax when hovering the top nav to avoid hover/transform contention
if (navContainer){
  navContainer.addEventListener('pointerenter', () => { parallaxPaused = true; }, { passive:true }); // isolate hover work
  navContainer.addEventListener('pointerleave', () => { parallaxPaused = false; setLive(); }, { passive:true }); // resume smoothly
}

let rafId, last = performance.now(), elapsed = 0;
function update(t){
  rafId = requestAnimationFrame(update);
  const dt = t - last; last = t;
  elapsed += dt * speed;
  program.uniforms.uTime.value = elapsed * 0.001;

  const targetX = parallaxPaused ? 0 : mouse.x;
  const targetY = parallaxPaused ? 0 : mouse.y;
  smoothed.x = lerp(smoothed.x, targetX, 0.10);
  smoothed.y = lerp(smoothed.y, targetY, 0.10);

  if (!prefersReduced){
    const dx = snapPx(smoothed.x * 10);
    const dy = snapPx(smoothed.y * 10);
    parallaxEl.style.setProperty('--dx', dx + 'px');
    parallaxEl.style.setProperty('--dy', dy + 'px');

    particles.position.x = -smoothed.x * hoverFactor;
    particles.position.y = -smoothed.y * hoverFactor;

    particles.rotation.x = Math.sin(elapsed * 0.0002) * 0.1;
    particles.rotation.y = Math.cos(elapsed * 0.0005) * 0.15;
    particles.rotation.z += 0.01 * speed;
  } else {
    parallaxEl.style.setProperty('--dx', '0px');
    parallaxEl.style.setProperty('--dy', '0px');
    particles.position.x = 0.0; particles.position.y = 0.0;
  }

  document.documentElement.style.setProperty('--mx', String(smoothed.x));
  document.documentElement.style.setProperty('--my', String(smoothed.y));

  renderer.render({ scene: particles, camera });
}
rafId = requestAnimationFrame(update);
window.addEventListener('pagehide', () => cancelAnimationFrame(rafId), { once:true });
