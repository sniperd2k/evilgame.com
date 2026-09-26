/**
 * Unit-level recreation of the input-lock bug + fix contract.
 * Run: node tests/farm-input-lock.test.mjs
 */
function assert(c, m) { if (!c) throw new Error(m); }

// Simulate pre-fix cinema start
function buggyBeginRonnie(state, input) {
  state.mode = 'ronnie_intro';
  state.dragging = false; // BUG: left input.activePointerId set
}

function fixedBeginRonnie(state, input) {
  state.mode = 'ronnie_intro';
  state.dragging = false;
  input.activePointerId = null;
  input.movePending = false;
  input.moveEvt = null;
}

function onDown(state, input, pointerId) {
  if (input.activePointerId != null && pointerId !== input.activePointerId) return false;
  if (state.mode !== 'play') return false;
  state.dragging = true;
  input.activePointerId = pointerId;
  return true;
}

function buggyOnUp(state, input, pointerId) {
  if (!state.dragging) return; // BUG: never clears activePointerId
  if (input.activePointerId != null && pointerId !== input.activePointerId) return;
  state.dragging = false;
  input.activePointerId = null;
}

function fixedOnUp(state, input, pointerId) {
  const same = input.activePointerId == null || pointerId === input.activePointerId;
  if (!same) return;
  if (!state.dragging && input.activePointerId == null) return;
  state.dragging = false;
  input.activePointerId = null;
}

// Reproduce bug
{
  const state = { mode: 'play', dragging: true };
  const input = { activePointerId: 5, movePending: false, moveEvt: null };
  buggyBeginRonnie(state, input);
  buggyOnUp(state, input, 5); // user lifts during cinema
  state.mode = 'play'; // soft reset
  const accepted = onDown(state, input, 9); // new finger
  assert(accepted === false, 'bug repro: new touch should be rejected');
  assert(input.activePointerId === 5, 'bug repro: stale pointer id remains');
}

// Fixed path
{
  const state = { mode: 'play', dragging: true };
  const input = { activePointerId: 5, movePending: false, moveEvt: null };
  fixedBeginRonnie(state, input);
  assert(input.activePointerId == null, 'fix: cinema clears pointer id');
  fixedOnUp(state, input, 5);
  state.mode = 'play';
  const accepted = onDown(state, input, 9);
  assert(accepted === true, 'fix: new touch accepted after cinema');
}

console.log('PASS farm-input-lock');
