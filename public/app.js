// public/app.js
const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Deferring re-renders while a card is mid-drag stops SSE events from
// yanking the deck out from under the user's finger.
let dragActive = false;
let pendingApply = false;

const views = {
  cuisines: $('#view-cuisines'),
  cuisinesWaiting: $('#view-cuisines-waiting'),
  bracket: $('#view-bracket'),
  noOverlap: $('#view-no-overlap'),
  restaurants: $('#view-restaurants'),
  match: $('#view-match'),
  empty: $('#view-empty'),
};

const SIDE = window.MY_SIDE === 'b' ? 'b' : 'a';
const Q = `?side=${SIDE}`;

let state = null;  // { phase, stage, deck, mySwipes, matchedCuisine, matchedRestaurant, partnerOnline, partnerDone, bracket, mySide, myName, partnerName }

function showView(name) {
  for (const [k, el] of Object.entries(views)) el.hidden = (k !== name);
}

const PHASE_LABELS = {
  cuisines: 'Choosing a cuisine',
  restaurants: 'Choosing a restaurant',
  done: 'Matched!',
};

function phaseLabel() {
  if (state.phase === 'cuisines' && state.stage === 'bracket') return 'Cuisine bracket';
  if (state.phase === 'cuisines' && state.stage === 'no-overlap') return 'No overlap';
  if (state.phase === 'cuisines' && state.partnerDone === false && state.mySwipes.length >= state.deck.length) {
    return `Waiting for ${state.partnerName ?? 'partner'}`;
  }
  return PHASE_LABELS[state.phase] ?? state.phase;
}

function setStatus() {
  const me = state.myName ?? window.SIDE_NAMES?.[SIDE] ?? SIDE.toUpperCase();
  const partner = state.partnerName ?? window.SIDE_NAMES?.[SIDE === 'a' ? 'b' : 'a'] ?? (SIDE === 'a' ? 'B' : 'A');
  $('[data-phase]').textContent = phaseLabel();
  $('[data-partner]').textContent = `${me} · ${partner} ${state.partnerOnline ? '🟢' : '⚫'}`;
}

function attachSwipe(stack) {
  const cards = Array.from(stack.querySelectorAll('.card'));
  if (cards.length === 0) return;
  const top = cards[cards.length - 1];  // last in DOM = top of stack (we render reversed)
  if (top.dataset.swipeAttached) return;
  top.dataset.swipeAttached = '1';
  let startX = 0, dx = 0, dragging = false, threshold = Infinity;

  top.addEventListener('pointerdown', (e) => {
    dragging = true; dragActive = true; startX = e.clientX; dx = 0;
    // Measured here, not at attach time: the view may still be hidden
    // (width 0) when the deck is rendered, which made any tap a swipe.
    threshold = Math.max(40, Math.min(top.getBoundingClientRect().width * 0.3, 120));
    top.setPointerCapture(e.pointerId);
    top.style.transition = 'none';
  });
  top.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const rot = dx / 20;
    top.style.transform = `translateX(${dx}px) rotate(${rot}deg)`;
  });
  top.addEventListener('pointerup', () => finish());
  top.addEventListener('pointercancel', () => finish());

  function finish() {
    if (!dragging) return;
    dragging = false;
    dragActive = false;
    top.style.transition = '';
    if (dx !== 0 && Math.abs(dx) >= threshold) {
      const direction = dx > 0 ? 'right' : 'left';
      const fly = direction === 'right' ? window.innerWidth + 200 : -(window.innerWidth + 200);
      top.style.transform = `translateX(${fly}px) rotate(${fly / 20}deg)`;
      top.style.opacity = '0';
      const itemId = top.dataset.itemId;
      setTimeout(() => {
        top.remove();
        attachSwipe(stack);
      }, 300);
      window.__fooder.postSwipe(itemId, direction);
    } else {
      top.style.transform = '';
    }
    if (pendingApply) {
      pendingApply = false;
      applyState();
    }
  }
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
  card.innerHTML = `<div class="emoji">${esc(c.emoji)}</div><div class="name">${esc(c.name)}</div>`;
}

function renderRestaurantCard(card, r) {
  const photo = r.photoUrl ? `<img class="photo" src="${esc(r.photoUrl)}" alt="">` : '';
  const rating = r.rating != null ? `<span class="rating">★ ${r.rating.toFixed(1)}</span>` : '';
  const price = r.priceLevel != null ? '$'.repeat(Math.max(1, r.priceLevel)) : '';
  card.innerHTML = `
    ${photo}
    <div class="name">${esc(r.name)}</div>
    <div class="meta">${rating} ${price}</div>
    <div class="meta">${esc(r.address)}</div>
  `;
}

function renderMatch() {
  const r = state.matchedRestaurant;
  const photo = r.photoUrl ? `<img src="${esc(r.photoUrl)}" alt="">` : '';
  const rating = r.rating != null ? `★ ${r.rating.toFixed(1)} ` : '';
  const price = r.priceLevel != null ? '$'.repeat(Math.max(1, r.priceLevel)) : '';
  const phone = r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : '';
  const maps = r.mapsUrl ? `<a href="${esc(r.mapsUrl)}" target="_blank" rel="noopener">View on Google Maps</a>` : '';
  $('[data-match]').innerHTML = `
    ${photo}
    <h1>${esc(r.name)}</h1>
    <div class="meta">${rating}${price}</div>
    <div>${esc(r.address)}</div>
    <div>${phone}</div>
    <div>${maps}</div>
  `;
}

function renderBracket() {
  if (!state.bracket || !state.bracket.currentPair) return;
  $('[data-bracket-round]').textContent = String((state.bracket.roundIndex ?? 0) + 1);
  const { a, b, pairIndex } = state.bracket.currentPair;
  const cardA = document.querySelector('[data-bracket-pick="a"]');
  const cardB = document.querySelector('[data-bracket-pick="b"]');
  cardA.innerHTML = `<div class="emoji">${a.emoji}</div><div class="name">${a.name}</div>`;
  cardB.innerHTML = b ? `<div class="emoji">${b.emoji}</div><div class="name">${b.name}</div>` : '<div class="name">(bye)</div>';
  cardA.dataset.itemId = a.id;
  cardB.dataset.itemId = b ? b.id : '';
  cardA.dataset.pairIndex = String(pairIndex);
  cardB.dataset.pairIndex = String(pairIndex);
  const myVote = state.bracket.myVote;
  cardA.dataset.state = myVote === a.id ? 'picked' : (myVote ? 'dimmed' : '');
  cardB.dataset.state = (myVote && b && myVote === b.id) ? 'picked' : ((myVote && b) ? 'dimmed' : '');
  $('[data-bracket-waiting]').hidden = !myVote;
  if (state.partnerName) {
    for (const el of document.querySelectorAll('[data-partner-name]')) el.textContent = state.partnerName;
  }
}

function renderWaiting() {
  const swipedCount = state.mySwipes.length;
  const total = state.deck.length;
  $('[data-waiting-meta]').textContent = `You finished ${swipedCount}/${total}. They're still swiping.`;
  if (state.partnerName) {
    for (const el of document.querySelectorAll('[data-partner-name]')) el.textContent = state.partnerName;
  }
}

function applyState() {
  if (dragActive) {
    pendingApply = true;
    return;
  }
  setStatus();
  if (state.phase === 'done' && state.matchedRestaurant) {
    renderMatch();
    showView('match');
    return;
  }

  if (state.phase === 'cuisines') {
    if (state.stage === 'bracket') {
      renderBracket();
      showView('bracket');
      return;
    }
    if (state.stage === 'no-overlap') {
      showView('noOverlap');
      return;
    }
    const mySwipedIds = new Set(state.mySwipes.map(s => s.itemId));
    const remaining = state.deck.filter(item => !mySwipedIds.has(item.id));
    if (remaining.length === 0) {
      renderWaiting();
      showView('cuisinesWaiting');
      return;
    }
    showView('cuisines');
    renderDeck(views.cuisines, remaining, renderCuisineCard);
    attachSwipe(views.cuisines.querySelector('.card-stack'));
    return;
  }

  if (state.phase === 'restaurants') {
    const mySwipedIds = new Set(state.mySwipes.map(s => s.itemId));
    const remaining = state.deck.filter(item => !mySwipedIds.has(item.id));
    if (remaining.length === 0) {
      let msg;
      if (state.deckError && state.deck.length === 0) {
        msg = `couldn't load restaurants — ${state.deckError}`;
      } else if (state.partnerDone) {
        msg = 'you both finished — no mutual pick';
      } else {
        msg = `waiting for ${state.partnerName ?? 'partner'}…`;
      }
      $('[data-empty-message]').textContent = msg;
      showView('empty');
      return;
    }
    showView('restaurants');
    renderDeck(views.restaurants, remaining, renderRestaurantCard);
    attachSwipe(views.restaurants.querySelector('.card-stack'));
  }
}

async function fetchState() {
  try {
    const res = await fetch(`/api/state${Q}`);
    if (!res.ok) throw new Error(`state fetch failed: ${res.status}`);
    state = await res.json();
  } catch {
    return; // transient network failure; SSE reconnect or next event retries
  }
  applyState();
}

function connectSse() {
  const es = new EventSource(`/api/events${Q}`);
  // Resync on every (re)connect: events missed while disconnected are gone.
  es.onopen = () => { fetchState(); };
  es.onmessage = (ev) => {
    const event = JSON.parse(ev.data);
    handleEvent(event);
  };
  es.onerror = () => { /* native EventSource auto-reconnects */ };
}

async function handleEvent(event) {
  if (!state) { await fetchState(); return; }

  // Side-tagged events are broadcast to everyone, including their originator;
  // only the partner's matter here.
  if (event.type === 'partner-online') {
    if (event.side !== SIDE) { state.partnerOnline = event.online; setStatus(); }
    return;
  }
  if (event.type === 'partner-done') {
    if (event.side !== SIDE) { state.partnerDone = true; setStatus(); applyState(); }
    return;
  }

  if (event.type === 'stage-change') {
    if (event.stage === 'no-overlap') {
      state.phase = 'cuisines'; state.stage = 'no-overlap';
      setStatus();
      showView('noOverlap');
      return;
    }
    if (event.stage === 'bracket') {
      await fetchState();
      return;
    }
  }

  if (event.type === 'bracket-round-start' ||
      event.type === 'bracket-pair-resolved' ||
      event.type === 'bracket-vote-cast') {
    await fetchState();
    return;
  }

  if (event.type === 'phase-change') { await fetchState(); return; }

  if (event.type === 'match' && event.phase === 'cuisines') {
    // server follows with phase-change carrying the deck; nothing to do here
    return;
  }
  if (event.type === 'match' && event.phase === 'restaurants') {
    state.phase = 'done'; state.matchedRestaurant = event.item;
    renderMatch(); showView('match');
    return;
  }

  if (event.type === 'phase-reset' || event.type === 'session-reset') {
    await fetchState();
  }
}

async function postSwipe(itemId, direction) {
  // Optimistic: keeps re-renders from resurrecting the card while the POST is in flight.
  state.mySwipes.push({ side: SIDE, itemId, direction });
  try {
    const res = await fetch(`/api/swipe${Q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId, direction }),
    });
    if (!res.ok) throw new Error(`swipe failed: ${res.status}`);
  } catch {
    await fetchState(); // roll back to server truth; the card legitimately comes back
  }
}

async function postReset(scope) {
  await fetch(`/api/reset${Q}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope }),
  });
}

document.addEventListener('click', async (e) => {
  const bracketCard = e.target.closest('.bracket-card');
  if (bracketCard && bracketCard.dataset.itemId) {
    const pairIndex = Number(bracketCard.dataset.pairIndex);
    const pick = bracketCard.dataset.itemId;
    bracketCard.dataset.state = 'picked';
    if (state?.bracket) state.bracket.myVote = pick;
    $('[data-bracket-waiting]').hidden = false;
    const res = await fetch(`/api/bracket-vote${Q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairIndex, pick }),
    }).catch(() => null);
    if (!res?.ok) await fetchState(); // stale pair or network failure — resync instead of hanging on "waiting"
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'reset-phase') postReset('phase');
  else if (action === 'reset-session') postReset('session');
});

fetchState();
connectSse();

// Exposed so the swipe-interaction task can call them
window.__fooder = { postSwipe };
