// card-nav.js — vanilla expander using Web Animations API
const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches; // [29]
const nav = document.getElementById('cardNav');
const content = document.getElementById('cardNavContent');
const burger = document.getElementById('hamburger');
const cards = Array.from(content.querySelectorAll('.nav-card'));
let isOpen = false;
let heightOpen = 260; // fallback default

function measureOpenHeight(){
  const prev = {
    visibility: content.style.visibility,
    pointer: content.style.pointerEvents,
    position: content.style.position,
    height: content.style.height
  };
  content.style.visibility = 'visible';
  content.style.pointerEvents = 'auto';
  content.style.position = 'static';
  content.style.height = 'auto';
  const topBar = 60;
  const padding = 8;
  const h = topBar + content.scrollHeight + padding;
  // restore
  content.style.visibility = prev.visibility;
  content.style.pointerEvents = prev.pointer;
  content.style.position = prev.position;
  content.style.height = prev.height;
  return h;
}

function animateHeight(from, to){
  const duration = prefersReduced ? 150 : 400; // honor reduced motion [29]
  const easing = 'cubic-bezier(.16,1,.3,1)';
  const anim = nav.animate([{height: from+'px'}, {height: to+'px'}], {duration, easing, fill:'forwards'}); // [23]
  return anim;
}

function revealCards(){
  const duration = prefersReduced ? 120 : 400;
  const easing = 'cubic-bezier(.16,1,.3,1)';
  cards.forEach((el, i) => {
    el.animate([{opacity:0, transform:'translateY(18px)'}, {opacity:1, transform:'translateY(0)'}],
      { duration, delay: prefersReduced ? 0 : i*80, easing, fill:'forwards' } // [23]
    );
  });
}

function hideCards(){
  const duration = prefersReduced ? 120 : 240;
  const easing = 'ease-out';
  cards.forEach((el) => {
    el.animate([{opacity:1, transform:'translateY(0)'}, {opacity:0, transform:'translateY(10px)'}],
      { duration, easing, fill:'forwards' } // [23]
    );
  });
}

function openNav(){
  heightOpen = measureOpenHeight(); // compute true open height before animation [28]
  content.classList.add('visible'); // allow interactions during/after
  nav.classList.add('open');
  burger.classList.add('open');
  burger.setAttribute('aria-expanded','true');
  animateHeight(60, heightOpen).finished.then(()=> revealCards());
}

function closeNav(){
  hideCards();
  animateHeight(nav.getBoundingClientRect().height, 60).finished.then(()=>{
    content.classList.remove('visible');
    nav.classList.remove('open');
    burger.classList.remove('open');
    burger.setAttribute('aria-expanded','false');
  });
}

burger.addEventListener('click', ()=>{
  isOpen ? closeNav() : openNav();
  isOpen = !isOpen;
});

// Keep layout correct on resize
window.addEventListener('resize', ()=>{
  if (!isOpen) return;
  heightOpen = measureOpenHeight();
  nav.style.height = heightOpen + 'px';
});
