// Hardle main script

// Global constants
const NUM_ROWS = 10;
const WORD_LEN = 5;
const CYCLE_ORDER = ['mark-absent', 'mark-correct', 'mark-present', 'unmarked']; // grey -> green -> yellow -> unmarked

// State
let allowedSet = new Set();
let answers = [];
let answer = '';
let seed = null;

let currentRow = 0;
let currentCol = 0;
let ended = false;

// Mapping from letter => one of 'unmarked' | 'mark-absent' | 'mark-correct' | 'mark-present'
const letterMarks = Object.create(null);

// Cached DOM
const $board = document.getElementById('board');
const $results = document.getElementById('results');
const $keyboard = document.getElementById('keyboard');
const $message = document.getElementById('message');
const $seedInput = document.getElementById('seed-input');
const $applySeed = document.getElementById('apply-seed');
const $currentSeed = document.getElementById('current-seed');

// Utils
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function setMessage(text, timeout = 1600) {
  $message.textContent = text;
  if (timeout > 0) {
    setTimeout(() => {
      // Only clear if the same message hasn't changed
      if ($message.textContent === text) $message.textContent = '';
    }, timeout);
  }
}
function todaySeedNumber() {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return Number(`${yyyy}${mm}${dd}`);
}
function hashStringToInt(str) {
  // Simple 32-bit FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0);
}
function seededIndexFromSeed(seedValue, modulo) {
  // Allow numeric or string seed
  let s = 0;
  if (typeof seedValue === 'number' && Number.isFinite(seedValue)) {
    s = seedValue >>> 0;
  } else if (typeof seedValue === 'string') {
    s = hashStringToInt(seedValue);
  } else {
    s = todaySeedNumber() >>> 0;
  }
  // Xorshift32
  let x = s || 1;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17; x >>>= 0;
  x ^= x << 5; x >>>= 0;
  return x % modulo;
}
function getQueryParam(name) {
  const url = new URL(window.location.href);
  return url.searchParams.get(name);
}
function setQueryParam(name, val) {
  const url = new URL(window.location.href);
  if (val === null || val === undefined || val === '') {
    url.searchParams.delete(name);
  } else {
    url.searchParams.set(name, String(val));
  }
  window.history.replaceState({}, '', url.toString());
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Board creation
function createBoard() {
  $board.innerHTML = '';
  $results.innerHTML = '';
  for (let r = 0; r < NUM_ROWS; r++) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.row = String(r);
    for (let c = 0; c < WORD_LEN; c++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.row = String(r);
      tile.dataset.col = String(c);
      tile.setAttribute('role', 'gridcell');
      row.appendChild(tile);
    }
    $board.appendChild(row);

    const res = document.createElement('div');
    res.className = 'result-row';
    const span = document.createElement('span');
    span.className = 'result-text';
    span.textContent = '';
    res.appendChild(span);
    $results.appendChild(res);
  }
}

function createKeyboard() {
  $keyboard.innerHTML = '';
  const rows = [
    'QWERTYUIOP',
    'ASDFGHJKL',
    'ENTER|ZXCVBNM|BACK'
  ];
  rows.forEach((r, idx) => {
    const rowDiv = document.createElement('div');
    rowDiv.className = 'key-row';
    const parts = r.split('|');
    parts.forEach((part, partIdx) => {
      if (part === 'ENTER') {
        const key = document.createElement('button');
        key.className = 'key wide';
        key.textContent = 'ENTER';
        key.dataset.key = 'Enter';
        rowDiv.appendChild(key);
      } else if (part === 'BACK') {
        const key = document.createElement('button');
        key.className = 'key wide';
        key.textContent = '⌫';
        key.title = 'Backspace';
        key.dataset.key = 'Backspace';
        rowDiv.appendChild(key);
      } else {
        for (const ch of part) {
          const key = document.createElement('button');
          key.className = 'key';
          key.textContent = ch;
          key.dataset.key = ch;
          key.dataset.letter = ch.toLowerCase();
          rowDiv.appendChild(key);
        }
      }
      if (partIdx < parts.length - 1) {
        // small gap via CSS already; no spacer needed
      }
    });
    $keyboard.appendChild(rowDiv);
  });
}

// Input handling
function handleKeyInput(k) {
  if (ended) return;
  if (/^[a-z]$/i.test(k)) {
    addLetter(k.toLowerCase());
  } else if (k === 'Backspace') {
    removeLetter();
  } else if (k === 'Enter') {
    submitGuess();
  }
}
function addLetter(ch) {
  if (currentCol >= WORD_LEN || currentRow >= NUM_ROWS) return;
  const rowEl = $board.children[currentRow];
  const tile = rowEl.children[currentCol];
  tile.textContent = ch;
  tile.classList.add('filled');
  tile.dataset.letter = ch;
  currentCol++;
}
function removeLetter() {
  if (currentCol <= 0 || currentRow >= NUM_ROWS) return;
  currentCol--;
  const rowEl = $board.children[currentRow];
  const tile = rowEl.children[currentCol];
  tile.textContent = '';
  tile.classList.remove('filled', 'clickable');
  tile.removeAttribute('data-letter');
}

function rowWord(r) {
  const rowEl = $board.children[r];
  let w = '';
  for (let c = 0; c < WORD_LEN; c++) {
    w += (rowEl.children[c].dataset.letter || '');
  }
  return w;
}

function evaluateGuess(guess, answer) {
  // Wordle-style evaluation: count greens then yellows with multiplicity
  const gArr = guess.split('');
  const aArr = answer.split('');
  const greens = Array(WORD_LEN).fill(false);
  const remaining = {}; // letter => count remaining (answer letters not green)

  let greenCount = 0;
  for (let i = 0; i < WORD_LEN; i++) {
    if (gArr[i] === aArr[i]) {
      greens[i] = true;
      greenCount++;
    } else {
      remaining[aArr[i]] = (remaining[aArr[i]] || 0) + 1;
    }
  }

  let yellowCount = 0;
  for (let i = 0; i < WORD_LEN; i++) {
    if (greens[i]) continue;
    const ch = gArr[i];
    if (remaining[ch] > 0) {
      yellowCount++;
      remaining[ch]--;
    }
  }

  return { green: greenCount, yellow: yellowCount };
}

function showResultForRow(r, result) {
  const rowEl = $board.children[r];
  for (let c = 0; c < WORD_LEN; c++) {
    const tile = rowEl.children[c];
    tile.classList.add('clickable'); // now clickable for marking
    tile.dataset.submitted = 'true';
  }
  const resEl = $results.children[r].querySelector('.result-text');
  // 修改为方格显示
  resEl.innerHTML = `
    <span class="result-square mark-correct">${result.green}</span>
    <span class="result-square mark-present">${result.yellow}</span>
  `;
}

async function submitGuess() {
  if (currentCol !== WORD_LEN) {
    setMessage('Not enough letters');
    shakeRow(currentRow);
    return;
  }
  const guess = rowWord(currentRow);
  if (!allowedSet.has(guess) && !answersSet().has(guess)) {
    setMessage('Not in word list');
    shakeRow(currentRow);
    return;
  }

  const res = evaluateGuess(guess, answer);
  showResultForRow(currentRow, res);

  if (res.green === WORD_LEN) {
    ended = true;
    setMessage('Correct! You win!', 3000);
    disableInput();
    return;
  }

  currentRow++;
  currentCol = 0;

  if (currentRow >= NUM_ROWS) {
    ended = true;
    setMessage(`Out of guesses. Answer: ${answer.toUpperCase()}`, 5000);
    disableInput();
  }
}

function shakeRow(r) {
  const rowEl = $board.children[r];
  rowEl.classList.add('shake');
  setTimeout(() => rowEl.classList.remove('shake'), 400);
}

function disableInput() {
  // no-op; handlers check `ended`
}

// Marking logic
function nextCycleMark(current) {
  const idx = CYCLE_ORDER.indexOf(current || 'unmarked');
  const next = CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
  return next;
}

// Update all tiles and keys for a specific letter according to global letterMarks[letter]
function applyLetterMark(letter) {
  const mark = letterMarks[letter] || 'unmarked';

  // Update tiles
  const tiles = $board.querySelectorAll(`.tile[data-letter="${letter}"]`);
  tiles.forEach(tile => {
    tile.classList.remove('mark-absent', 'mark-present', 'mark-correct');
    if (mark !== 'unmarked') {
      tile.classList.add(mark);
    }
  });

  // Update keyboard key
  const key = $keyboard.querySelector(`.key[data-letter="${letter}"]`);
  if (key) {
    key.classList.remove('mark-absent', 'mark-present', 'mark-correct');
    if (mark !== 'unmarked') {
      key.classList.add(mark);
    }
  }
}

function handleTileClick(e) {
  const t = e.target;
  if (!t.classList.contains('tile')) return;
  if (t.dataset.submitted !== 'true') return; // only submitted rows
  const letter = t.dataset.letter;
  if (!letter) return;
  const current = letterMarks[letter] || 'unmarked';
  const next = nextCycleMark(current);
  letterMarks[letter] = next;
  applyLetterMark(letter);
}

// Keyboard click handler
function handleKeyboardClick(e) {
  const btn = e.target.closest('.key');
  if (!btn) return;
  const key = btn.dataset.key;
  if (key) {
    handleKeyInput(key);
  } else if (btn.dataset.letter) {
    handleKeyInput(btn.dataset.letter);
  }
}

// Data loading
function parseWordList(text) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim().toLowerCase())
    .filter(l => l.length === WORD_LEN && /^[a-z]+$/.test(l));
}

let _answersSetCache = null;
function answersSet() {
  if (!_answersSetCache) {
    _answersSetCache = new Set(answers);
  }
  return _answersSetCache;
}

async function loadLists() {
  const [allowedRes, answersRes] = await Promise.all([
    fetch('resources/allowed.txt'),
    fetch('resources/answers.txt'),
  ]);

  if (!allowedRes.ok) throw new Error('Failed to load allowed.txt');
  if (!answersRes.ok) throw new Error('Failed to load answers.txt');

  const [allowedText, answersText] = await Promise.all([
    allowedRes.text(),
    answersRes.text(),
  ]);

  const allowed = parseWordList(allowedText);
  const ans = parseWordList(answersText);

  allowedSet = new Set(allowed);
  answers = ans;
  _answersSetCache = null;

  if (answers.length === 0) {
    throw new Error('answers.txt has no valid entries');
  }
}

function pickAnswerFromSeed() {
  const idx = seededIndexFromSeed(seed, answers.length);
  answer = answers[idx];
  return answer;
}

function updateSeedUI() {
  $seedInput.value = String(seed ?? '');
  $currentSeed.textContent = `(current: ${seed})`;
}

function resetGameState() {
  currentRow = 0;
  currentCol = 0;
  ended = false;
  // clear letter marks
  for (const k of Object.keys(letterMarks)) delete letterMarks[k];
}

function clearBoard() {
  for (let r = 0; r < NUM_ROWS; r++) {
    const rowEl = $board.children[r];
    for (let c = 0; c < WORD_LEN; c++) {
      const tile = rowEl.children[c];
      tile.textContent = '';
      tile.classList.remove('filled', 'clickable', 'mark-absent', 'mark-present', 'mark-correct');
      tile.removeAttribute('data-letter');
      delete tile.dataset.submitted;
    }
    const resEl = $results.children[r].querySelector('.result-text');
    resEl.textContent = '';
  }
  // clear keyboard states
  $keyboard.querySelectorAll('.key').forEach(key => {
    key.classList.remove('mark-absent', 'mark-present', 'mark-correct');
  });
}

function applySeed(newSeed) {
  seed = newSeed;
  setQueryParam('seed', seed);
  updateSeedUI();
  resetGameState();
  clearBoard();
  pickAnswerFromSeed();
  setMessage(`New seed applied. Good luck!`, 1500);
}

// Init
async function init() {
  createBoard();
  createKeyboard();

  window.addEventListener('keydown', (e) => {
    if (document.activeElement === $seedInput) return;
    let key = e.key;
    if (key.length === 1 && /^[a-z]$/i.test(key)) key = key.toLowerCase();
    if (key === 'Backspace' || key === 'Enter' || /^[a-z]$/i.test(key)) {
      e.preventDefault();
      handleKeyInput(key);
    }
  });

  $board.addEventListener('click', handleTileClick);
  $keyboard.addEventListener('click', handleKeyboardClick);

  $applySeed.addEventListener('click', () => {
    const val = $seedInput.value.trim();
    const numeric = Number(val);
    const newSeed = Number.isFinite(numeric) && val !== '' ? numeric : (val || todaySeedNumber());
    applySeed(newSeed);
  });
  $seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      $applySeed.click();
    }
  });

  try {
    await loadLists();
  } catch (err) {
    console.error(err);
    setMessage('Failed to load word lists. Check allowed.txt and answers.txt.', 5000);
    return;
  }

  // Determine seed from URL or default to today
  const paramSeed = getQueryParam('seed');
  let initialSeed;
  if (paramSeed && paramSeed.trim() !== '') {
    const n = Number(paramSeed);
    initialSeed = Number.isFinite(n) ? n : paramSeed;
  } else {
    initialSeed = todaySeedNumber();
    setQueryParam('seed', initialSeed);
  }
  seed = initialSeed;
  updateSeedUI();

  pickAnswerFromSeed();
  setMessage('Type your guess and press Enter.', 1600);
}

init();