// public/app.js
const $ = (sel) => document.querySelector(sel);

const views = {
  cuisines: $('#view-cuisines'),
  restaurants: $('#view-restaurants'),
  match: $('#view-match'),
  empty: $('#view-empty'),
};

let state = null;  // { phase, deck, mySwipes, matchedCuisine, matchedRestaurant, partnerOnline }
let deckIds = [];  // ids in order
let topIndex = 0;  // index of the top card

function showView(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = (k !== name);
}

function setStatus() {
  $('[data-phase]').textContent = `phase: ${state.phase}`;
  $('[data-partner]').textContent = `partner: ${state.partnerOnline ? 'online' : 'offline'}`;
}

function renderDeck(target, items, renderCard) {
  const stack = target.querySelector('.card-stack');
  stack.innerHTML = '';
  for (let i = items.length - 1; i >= 0; i--) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.itemId = items[i].id;
    card.dataset.index = String(i);
    renderCard(card, items[i]);
    stack.appendChild(card);
  }
}

function renderCuisineCard(card, c) {
  card.classList.add('cuisine');
  card.innerHTML = `<div class="emoji">${c.emoji}</div><div class="name">${c.name}</div>`;
}

function renderRestaurantCard(card, r) {
  const photo = r.photoUrl ? `<img class="photo" src="${r.photoUrl}" alt="">` : '';
  const rating = r.rating != null ? `<span class="rating">★ ${r.rating.toFixed(1)}</span>` : '';
  const price = r.priceLevel != null ? '$'.repeat(Math.max(1, r.priceLevel)) : '';
  card.innerHTML = `
    ${photo}
    <div class="name">${r.name}</div>
    <div class="meta">${rating} ${price}</div>
    <div class="meta">${r.address}</div>
  `;
}

function renderMatch() {
  const r = state.matchedRestaurant;
  const photo = r.photoUrl ? `<img src="${r.photoUrl}" alt="">` : '';
  const rating = r.rating != null ? `★ ${r.rating.toFixed(1)} ` : '';
  const price = r.priceLevel != null ? '$'.repeat(Math.max(1, r.priceLevel)) : '';
  const phone = r.phone ? `<a href="tel:${r.phone}">${r.phone}</a>` : '';
  const maps = r.mapsUrl ? `<a href="${r.mapsUrl}" target="_blank" rel="noopener">View on Google Maps</a>` : '';
  $('[data-match]').innerHTML = `
    ${photo}
    <h1>${r.name}</h1>
    <div class="meta">${rating}${price}</div>
    <div>${r.address}</div>
    <div>${phone}</div>
    <div>${maps}</div>
  `;
}

function applyState() {
  setStatus();
  if (state.phase === 'done' && state.matchedRestaurant) {
    renderMatch();
    showView('match');
    return;
  }
  const mySwipedIds = new Set(state.mySwipes.map(s => s.itemId));
  const remaining = state.deck.filter(item => !mySwipedIds.has(item.id));
  deckIds = remaining.map(i => i.id);
  topIndex = 0;

  if (remaining.length === 0) {
    const partnerStillSwiping = !state.partnerOnline ? 'waiting for partner…' :
      `you're done — no overlap yet`;
    $('[data-empty-message]').textContent = partnerStillSwiping;
    showView('empty');
    return;
  }

  if (state.phase === 'cuisines') {
    renderDeck(views.cuisines, remaining, renderCuisineCard);
    showView('cuisines');
  } else if (state.phase === 'restaurants') {
    renderDeck(views.restaurants, remaining, renderRestaurantCard);
    showView('restaurants');
  }
}

async function fetchState() {
  const res = await fetch('/api/state');
  state = await res.json();
  applyState();
}

function connectSse() {
  const es = new EventSource('/api/events');
  es.onmessage = (ev) => {
    const event = JSON.parse(ev.data);
    handleEvent(event);
  };
  es.onerror = () => { /* native EventSource auto-reconnects */ };
}

async function handleEvent(event) {
  if (event.type === 'partner-online') {
    state.partnerOnline = event.online;
    setStatus();
    return;
  }
  if (event.type === 'match' && event.phase === 'cuisines') {
    // server will follow with phase-change carrying the deck
    return;
  }
  if (event.type === 'phase-change') {
    await fetchState();
    return;
  }
  if (event.type === 'match' && event.phase === 'restaurants') {
    state.phase = 'done';
    state.matchedRestaurant = event.item;
    renderMatch();
    showView('match');
    return;
  }
  if (event.type === 'phase-reset' || event.type === 'session-reset') {
    await fetchState();
  }
}

async function postSwipe(itemId, direction) {
  await fetch('/api/swipe', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, direction }),
  });
}

async function postReset(scope) {
  await fetch('/api/reset', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
}

document.addEventListener('click', (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'reset-phase') postReset('phase');
  else if (action === 'reset-session') postReset('session');
});

fetchState();
connectSse();

// Exposed so the swipe-interaction task can call them
window.__fooder = { postSwipe };
