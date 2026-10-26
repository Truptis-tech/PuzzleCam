// ── DOM References ────────────────────────────────────────────────────────────
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const previewImage = document.getElementById("previewImage");
const puzzleContainer = document.getElementById("puzzleBoard");
const timerElement = document.getElementById("timer");
const movesElement = document.getElementById("moves");

const openCameraBtn = document.getElementById("openCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const retakeBtn = document.getElementById("retakeBtn");
const uploadInput = document.getElementById("imageUpload");
const cameraSelect = document.getElementById("cameraSelect");
const cameraSelectContainer = document.getElementById("cameraSelectContainer");
const startPuzzleBtn = document.getElementById("startPuzzleBtn");
const solveBtn = document.getElementById("solveBtn");

// ── Global Session State ───────────────────────────────────────────────────────
let currentStream = null;
let audioCtx = null;
let dragged = null;

// Shared global timer (persists across difficulty switches)
let globalTimer = 0;       // seconds elapsed
let timerInterval = null;
let isTimerRunning = false;

// Current active grid size
let gridSize = 3;

// Image data URL – kept once image is loaded so we can re-slice for any grid
let loadedImageSrc = null;

// Whether the overall game session is active (an image has been shuffled)
let isSessionActive = false;

// Auto-solver state
let isSolving = false;
let solvedByRobot = false;
let solveTimer = null;

// ── Per-Difficulty State Store ─────────────────────────────────────────────────
// Each key is a grid size (3,4,5,6). Value is an object:
// {
//   pieces: canvas[],        – ordered array of tile canvases for current arrangement
//   originalOrder: canvas[], – the winning arrangement
//   moves: number,
//   isCompleted: boolean,
//   isStarted: boolean,      – has been shuffled at least once
// }
const difficultyStates = {};

// ── LocalStorage Persistence Keys ─────────────────────────────────────────────
const LS_SESSION = "puzzlecam_session";

// ── Helpers ────────────────────────────────────────────────────────────────────
function padTime(n) { return String(n).padStart(2, "0"); }
function formatTimer(s) { return `${padTime(Math.floor(s / 60))}:${padTime(s % 60)}`; }

function updateProgressIndicators() {
    document.querySelectorAll(".grid-btn").forEach(btn => {
        const sz = parseInt(btn.dataset.grid);
        const state = difficultyStates[sz];
        if (state && state.isStarted && !state.isCompleted) {
            btn.setAttribute("data-has-progress", "true");
        } else {
            btn.removeAttribute("data-has-progress");
        }
    });
}

// ── Timer (Global, Shared) ─────────────────────────────────────────────────────
function startGlobalTimer() {
    if (isTimerRunning) return;
    isTimerRunning = true;
    timerInterval = setInterval(() => {
        globalTimer++;
        timerElement.textContent = formatTimer(globalTimer);
        persistSession();
    }, 1000);
}

function stopGlobalTimer() {
    if (!isTimerRunning) return;
    isTimerRunning = false;
    clearInterval(timerInterval);
    timerInterval = null;
}

function resetGlobalTimer() {
    stopGlobalTimer();
    globalTimer = 0;
    timerElement.textContent = "00:00";
}

// ── LocalStorage Persistence ───────────────────────────────────────────────────
function persistSession() {
    if (!loadedImageSrc) return;
    const snapshot = {
        globalTimer,
        isSessionActive,
        gridSize,
        difficulties: {}
    };
    for (const [size, state] of Object.entries(difficultyStates)) {
        if (!state.isStarted) continue;
        snapshot.difficulties[size] = {
            moves: state.moves,
            isCompleted: state.isCompleted,
            isStarted: state.isStarted,
            // Store piece order as index array referencing originalOrder
            pieceOrder: state.pieces.map(p => state.originalOrder.indexOf(p))
        };
    }
    try {
        localStorage.setItem("puzzlecam_state", JSON.stringify(snapshot));
    } catch (_) { /* storage might be full */ }
    updateProgressIndicators();
}

function restoreSession() {
    let rawImage = localStorage.getItem("puzzlecam_image");
    let rawState = localStorage.getItem("puzzlecam_state");

    // Automatic migration from older unified localStorage structure
    if (!rawImage && !rawState) {
        const rawLegacy = localStorage.getItem(LS_SESSION);
        if (rawLegacy) {
            try {
                const snap = JSON.parse(rawLegacy);
                if (snap.imageSrc) {
                    localStorage.setItem("puzzlecam_image", snap.imageSrc);
                    rawImage = snap.imageSrc;
                    delete snap.imageSrc;
                    localStorage.setItem("puzzlecam_state", JSON.stringify(snap));
                    rawState = JSON.stringify(snap);
                }
            } catch (_) { }
            localStorage.removeItem(LS_SESSION);
        }
    }

    if (!rawImage) return Promise.resolve(false);

    loadedImageSrc = rawImage;
    let snap = {};
    if (rawState) {
        try { snap = JSON.parse(rawState); } catch (_) { }
    }

    globalTimer = snap.globalTimer || 0;
    isSessionActive = snap.isSessionActive || false;
    gridSize = snap.gridSize || 3;

    timerElement.textContent = formatTimer(globalTimer);
    updateMovesDisplay(0);

    // Mark the active grid-btn
    document.querySelectorAll(".grid-btn").forEach(b => {
        b.classList.toggle("active", parseInt(b.dataset.grid) === gridSize);
    });

    // Rebuild the image canvas from stored data URL
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const min = Math.min(img.width, img.height);
            canvas.width = canvas.height = min;
            ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, min, min);
            previewImage.src = loadedImageSrc;
            previewImage.style.display = "block";

            // Rebuild states for each saved difficulty
            for (const [sizeStr, saved] of Object.entries(snap.difficulties || {})) {
                const sz = parseInt(sizeStr);
                const state = buildFreshState(sz);
                state.moves = saved.moves || 0;
                state.isCompleted = saved.isCompleted || false;
                state.isStarted = saved.isStarted || false;

                // Restore piece order
                if (saved.pieceOrder && saved.pieceOrder.length === state.originalOrder.length) {
                    state.pieces = saved.pieceOrder.map(i => state.originalOrder[i]);
                }
                difficultyStates[sz] = state;
            }

            // Render the current grid
            renderCurrentDifficulty(true);
            updateProgressIndicators();
            if (isSessionActive) {
                const state = difficultyStates[gridSize];
                if (state && !state.isCompleted) {
                    startGlobalTimer();
                }
                solveBtn.disabled = state ? state.isCompleted : true;
            }
            resolve(true);
        };
        img.src = loadedImageSrc;
    });
}

// ── Audio ──────────────────────────────────────────────────────────────────────
function playSound(win = false) {
    if (!document.getElementById("soundEffects").checked) return;
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();

    if (win) {
        [261.63, 329.63, 392.00, 523.25].forEach((f, i) => {
            const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
            osc.type = "triangle";
            osc.frequency.setValueAtTime(f, audioCtx.currentTime + i * 0.12);
            g.gain.setValueAtTime(0.12, audioCtx.currentTime + i * 0.12);
            g.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + i * 0.12 + 0.25);
            osc.connect(g).connect(audioCtx.destination);
            osc.start(audioCtx.currentTime + i * 0.12);
            osc.stop(audioCtx.currentTime + i * 0.12 + 0.25);
        });
    } else {
        const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
        osc.frequency.setValueAtTime(220, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.08);
        g.gain.setValueAtTime(0.07, audioCtx.currentTime);
        g.gain.linearRampToValueAtTime(0.01, audioCtx.currentTime + 0.08);
        osc.connect(g).connect(audioCtx.destination);
        osc.start(); osc.stop(audioCtx.currentTime + 0.08);
    }
}

// ── Camera ─────────────────────────────────────────────────────────────────────
async function startCamera(deviceId = null) {
    if (currentStream) currentStream.getTracks().forEach(t => t.stop());
    try {
        currentStream = await navigator.mediaDevices.getUserMedia({
            video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" }
        });
        video.srcObject = currentStream;
        video.style.display = "block";
        previewImage.style.display = "none";
        puzzleContainer.style.display = "none";

        const devices = await navigator.mediaDevices.enumerateDevices();
        const vDevices = devices.filter(d => d.kind === "videoinput");
        cameraSelect.innerHTML = "";
        if (vDevices.length > 1) {
            vDevices.forEach((d, i) => cameraSelect.options.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId, false, d.deviceId === deviceId)));
            cameraSelectContainer.style.display = "block";
        } else {
            cameraSelectContainer.style.display = "none";
        }
    } catch { alert("Camera access failed. Use Image Upload."); }
}

function onImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
    video.style.display = "none";
    const reader = new FileReader();
    reader.onload = () => loadImage(reader.result);
    reader.readAsDataURL(file);
}

function loadImage(src) {
    const img = new Image();
    img.onload = () => {
        const min = Math.min(img.width, img.height);
        canvas.width = canvas.height = min;
        ctx.drawImage(img, (img.width - min) / 2, (img.height - min) / 2, min, min, 0, 0, min, min);
        previewImage.src = src;
        previewImage.style.display = "block";
        video.style.display = "none";

        loadedImageSrc = src;
        try {
            localStorage.setItem("puzzlecam_image", src);
        } catch (_) { }

        // Clear all difficulty states when a new image is loaded
        for (const key of Object.keys(difficultyStates)) delete difficultyStates[key];

        // Build fresh state for current gridSize
        difficultyStates[gridSize] = buildFreshState(gridSize);

        // Show preview (not puzzle yet – wait for Start Puzzle)
        puzzleContainer.style.display = "none";
        isSessionActive = false;
        resetGlobalTimer();
        updateMovesDisplay(0);
        solveBtn.disabled = true;
        solveBtn.textContent = "🤖 Auto Solve";
        solveBtn.classList.remove("solving");

        // Clear localStorage state when new image is chosen
        localStorage.removeItem("puzzlecam_state");
        localStorage.removeItem(LS_SESSION);
    };
    img.src = src;
}

function captureImage() {
    if (!video.srcObject) return alert("Open camera first.");
    const min = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = canvas.height = min;
    ctx.drawImage(video, (video.videoWidth - min) / 2, (video.videoHeight - min) / 2, min, min, 0, 0, min, min);
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
    video.style.display = "none";
    previewImage.style.display = "none";

    loadedImageSrc = canvas.toDataURL("image/jpeg", 0.85);
    try {
        localStorage.setItem("puzzlecam_image", loadedImageSrc);
    } catch (_) { }

    for (const key of Object.keys(difficultyStates)) delete difficultyStates[key];
    difficultyStates[gridSize] = buildFreshState(gridSize);
    isSessionActive = false;
    resetGlobalTimer();
    solveBtn.disabled = true;

    // Clear previous state for new capture session
    localStorage.removeItem("puzzlecam_state");
    localStorage.removeItem(LS_SESSION);

    startPuzzle();
}

// ── Puzzle State Builder ────────────────────────────────────────────────────────
// Creates the canonical tile array for a given gridSize from the current canvas.
function buildFreshState(sz) {
    const w = canvas.width / sz, h = canvas.height / sz;
    const originalOrder = [];

    for (let r = 0; r < sz; r++) {
        for (let c = 0; c < sz; c++) {
            const p = document.createElement("canvas");
            p.width = w; p.height = h;
            const pctx = p.getContext("2d");
            pctx.drawImage(canvas, c * w, r * h, w, h, 0, 0, w, h);

            if (document.getElementById("showNumbers").checked) {
                const fs = Math.max(14, Math.floor(w * 0.16));
                pctx.fillStyle = "rgba(0,0,0,0.55)";
                pctx.beginPath();
                pctx.arc(fs * 1.2, fs * 1.2, fs * 0.9, 0, 2 * Math.PI);
                pctx.fill();
                pctx.fillStyle = "white";
                pctx.font = `bold ${fs}px Segoe UI, sans-serif`;
                pctx.textAlign = "center"; pctx.textBaseline = "middle";
                pctx.fillText((r * sz + c + 1).toString(), fs * 1.2, fs * 1.2);
            }

            p.classList.add("puzzle-piece");
            p.draggable = true;
            originalOrder.push(p);
        }
    }

    return {
        pieces: [...originalOrder],
        originalOrder,
        moves: 0,
        isCompleted: false,
        isStarted: false
    };
}

// ── Puzzle Rendering ───────────────────────────────────────────────────────────
function renderCurrentDifficulty(skipTransition = false) {
    const state = difficultyStates[gridSize];
    if (!state) return;

    puzzleContainer.style.transition = skipTransition ? "none" : "opacity 0.18s ease";
    if (!skipTransition) puzzleContainer.style.opacity = "0";

    setTimeout(() => {
        puzzleContainer.innerHTML = "";
        puzzleContainer.style.display = "grid";
        puzzleContainer.style.gridTemplateColumns = `repeat(${gridSize}, 1fr)`;
        puzzleContainer.style.gridTemplateRows = `repeat(${gridSize}, 1fr)`;
        puzzleContainer.style.gap = "2px";

        state.pieces.forEach(piece => {
            puzzleContainer.appendChild(piece);
            attachPieceDragHandlers(piece, state);
        });

        if (!skipTransition) {
            puzzleContainer.offsetHeight; // force reflow
            puzzleContainer.style.opacity = "1";
        }

        updateMovesDisplay(state.moves);
        previewImage.style.display = "none";
    }, skipTransition ? 0 : 90);
}

function attachPieceDragHandlers(piece, state) {
    piece.draggable = !isSolving && !state.isCompleted && state.isStarted;
    piece.ondragstart = (e) => {
        if (isSolving || state.isCompleted || !state.isStarted) return e.preventDefault();
        dragged = piece;
        piece.style.opacity = "0.6";
    };
    piece.ondragend = () => { piece.style.opacity = "1"; };
    piece.ondragover = (e) => { e.preventDefault(); };
    piece.ondrop = (e) => {
        e.preventDefault();
        if (isSolving || state.isCompleted || !state.isStarted) return;
        const from = state.pieces.indexOf(dragged);
        const to = state.pieces.indexOf(piece);
        if (from === -1 || to === -1 || from === to) return;
        [state.pieces[from], state.pieces[to]] = [state.pieces[to], state.pieces[from]];
        state.moves++;
        updateMovesDisplay(state.moves);
        playSound();
        persistSession();
        renderCurrentDifficulty(true);
        checkCompletion(state);
    };
}

function updateMovesDisplay(n) {
    movesElement.textContent = n;
}

// ── Game Flow ──────────────────────────────────────────────────────────────────
function startPuzzle() {
    if (!loadedImageSrc) {
        if (video.srcObject && video.style.display === "block") { captureImage(); return; }
        return alert("Open camera or upload an image first.");
    }
    if (isSolving) stopSolver();

    // Ensure state exists for current gridSize
    if (!difficultyStates[gridSize]) {
        difficultyStates[gridSize] = buildFreshState(gridSize);
    }

    const state = difficultyStates[gridSize];

    // Fisher-Yates shuffle
    for (let i = state.pieces.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.pieces[i], state.pieces[j]] = [state.pieces[j], state.pieces[i]];
    }

    state.moves = 0;
    state.isCompleted = false;
    state.isStarted = true;

    isSessionActive = true;
    solvedByRobot = false;
    solveBtn.disabled = false;
    solveBtn.textContent = "🤖 Auto Solve";
    solveBtn.classList.remove("solving");

    resetGlobalTimer();
    startGlobalTimer();
    renderCurrentDifficulty(true);
    persistSession();
}

// ── Difficulty Switching (Live, No Reset) ──────────────────────────────────────
function switchDifficulty(newSize) {
    if (newSize === gridSize) return;

    if (isSolving) stopSolver();

    // Switch
    gridSize = newSize;

    // Ensure a state exists for the new size
    if (!difficultyStates[gridSize]) {
        if (loadedImageSrc) {
            difficultyStates[gridSize] = buildFreshState(gridSize);
        }
    }

    // Update UI buttons
    document.querySelectorAll(".grid-btn").forEach(b => {
        b.classList.toggle("active", parseInt(b.dataset.grid) === gridSize);
    });

    if (!loadedImageSrc) return;

    const state = difficultyStates[gridSize];

    if (state && state.isStarted) {
        // Restore saved state with smooth transition
        renderCurrentDifficulty(false);
        updateMovesDisplay(state.moves);
        solveBtn.disabled = state.isCompleted;

        // Resume timer if restored difficulty is in progress and session is active
        if (isSessionActive && !state.isCompleted) {
            startGlobalTimer();
        } else {
            stopGlobalTimer();
        }
    } else if (state) {
        if (isSessionActive) {
            // Automatically shuffle and start this difficulty because the session is active!
            for (let i = state.pieces.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [state.pieces[i], state.pieces[j]] = [state.pieces[j], state.pieces[i]];
            }
            state.moves = 0;
            state.isCompleted = false;
            state.isStarted = true;

            renderCurrentDifficulty(false);
            updateMovesDisplay(0);
            solveBtn.disabled = false;
            startGlobalTimer();
        } else {
            // Preview mode - show the un-shuffled preview
            renderCurrentDifficulty(false);
            updateMovesDisplay(0);
            solveBtn.disabled = true;
        }
    }

    persistSession();
}

function resetPuzzle() {
    isSessionActive = false;
    if (isSolving) stopSolver();
    stopGlobalTimer();
    globalTimer = 0;
    timerElement.textContent = "00:00";

    // Clear all states
    for (const key of Object.keys(difficultyStates)) delete difficultyStates[key];
    loadedImageSrc = null;

    puzzleContainer.innerHTML = "";
    puzzleContainer.style.display = "none";
    previewImage.style.display = "none";
    previewImage.src = "";
    if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
    video.srcObject = null;
    video.style.display = "none";
    cameraSelectContainer.style.display = "none";
    solveBtn.disabled = true;
    solveBtn.textContent = "🤖 Auto Solve";
    solveBtn.classList.remove("solving");
    updateMovesDisplay(0);

    localStorage.removeItem("puzzlecam_image");
    localStorage.removeItem("puzzlecam_state");
    localStorage.removeItem(LS_SESSION);
    updateProgressIndicators();
}

function checkCompletion(state) {
    if (!isSessionActive || state.isCompleted) return;
    if (state.pieces.every((p, i) => p === state.originalOrder[i])) {
        state.isCompleted = true;
        if (!isSolving) stopGlobalTimer();
        playSound(true);
        persistSession();
        setTimeout(showResultModal, 300);
    }
}

// ── Animate Swap ───────────────────────────────────────────────────────────────
function animateSwap(state, fromIdx, toIdx, callback) {
    const p1 = state.pieces[fromIdx], p2 = state.pieces[toIdx];
    const r1 = p1.getBoundingClientRect(), r2 = p2.getBoundingClientRect();
    const dx = r2.left - r1.left, dy = r2.top - r1.top;

    p1.classList.add("piece-glow-a");
    p2.classList.add("piece-glow-b");

    setTimeout(() => {
        p1.style.transition = "transform 0.35s cubic-bezier(0.4,0,0.2,1)";
        p2.style.transition = "transform 0.35s cubic-bezier(0.4,0,0.2,1)";
        p1.style.transform = `translate(${dx}px, ${dy}px)`;
        p2.style.transform = `translate(${-dx}px, ${-dy}px)`;
        p1.style.zIndex = "20";
        p2.style.zIndex = "20";

        setTimeout(() => {
            p1.style.transition = ""; p1.style.transform = ""; p1.style.zIndex = "";
            p2.style.transition = ""; p2.style.transform = ""; p2.style.zIndex = "";
            p1.classList.remove("piece-glow-a");
            p2.classList.remove("piece-glow-b");

            [state.pieces[fromIdx], state.pieces[toIdx]] = [state.pieces[toIdx], state.pieces[fromIdx]];
            state.moves++;
            updateMovesDisplay(state.moves);
            playSound();
            persistSession();
            renderCurrentDifficulty(true);
            callback();
        }, 380);
    }, 120);
}

// ── Solver ─────────────────────────────────────────────────────────────────────
function toggleSolver() { isSolving ? stopSolver() : startSolver(); }

function startSolver() {
    const state = difficultyStates[gridSize];
    if (!isSessionActive || !state || !state.isStarted) return;
    isSolving = true;
    solvedByRobot = true;
    solveBtn.textContent = "⏹ Stop Solving";
    solveBtn.classList.add("solving");
    setUIDisabled(true);
    renderCurrentDifficulty(true);
    solveStep();
}

function solveStep() {
    if (!isSolving || !isSessionActive) return;
    const state = difficultyStates[gridSize];
    if (!state) return;

    let fromIdx = -1, toIdx = -1;
    for (let i = 0; i < state.pieces.length; i++) {
        if (state.pieces[i] !== state.originalOrder[i]) {
            fromIdx = i;
            toIdx = state.pieces.indexOf(state.originalOrder[i]);
            break;
        }
    }

    if (fromIdx === -1) { stopSolver(true); return; }

    animateSwap(state, fromIdx, toIdx, () => {
        if (!isSessionActive) { stopSolver(true); return; }
        solveTimer = setTimeout(solveStep, 150);
    });
}

function stopSolver(finished = false) {
    isSolving = false;
    if (solveTimer) { clearTimeout(solveTimer); solveTimer = null; }
    solveBtn.textContent = "🤖 Auto Solve";
    solveBtn.classList.remove("solving");
    setUIDisabled(false);
    if (!finished) {
        renderCurrentDifficulty(true);
    } else {
        // Solver finished successfully — mark completed and show result
        const state = difficultyStates[gridSize];
        if (state && !state.isCompleted) state.isCompleted = true;
        stopGlobalTimer();
        playSound(true);
        persistSession();
        // Brief toast + modal
        showToast(solvedByRobot ? "🤖 Solved by Robot!" : "Puzzle Solved!", 2600);
        setTimeout(showResultModal, 300);
    }
}

function setUIDisabled(disabled) {
    [startPuzzleBtn, openCameraBtn, captureBtn, retakeBtn].forEach(b => b.disabled = disabled);
    uploadInput.disabled = disabled;
    document.querySelector(".upload-btn").style.opacity = disabled ? "0.5" : "1";
    document.querySelector(".upload-btn").style.pointerEvents = disabled ? "none" : "auto";
    document.querySelectorAll(".grid-btn").forEach(b => {
        b.disabled = disabled;
        b.style.opacity = disabled ? "0.5" : "1";
        b.style.pointerEvents = disabled ? "none" : "auto";
    });
}

// ── Result Modal ───────────────────────────────────────────────────────────────
// Transient toast notification
function showToast(msg, duration = 2300) {
    const el = document.getElementById("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("show");
    if (el._toastTimer) clearTimeout(el._toastTimer);
    el._toastTimer = setTimeout(() => {
        el.classList.remove("show");
        el._toastTimer = null;
    }, duration);
}

function showResultModal() {
    const timeStr = timerElement.textContent;
    document.getElementById("resultTime").textContent = timeStr;

    const state = difficultyStates[gridSize];
    const moves = state ? state.moves : 0;

    document.getElementById("resultMoves").textContent = moves;
    document.getElementById("resultTitle").textContent = solvedByRobot ? "🤖 Solved by Robot!" : "Puzzle Solved!";
    document.getElementById("resultSub").textContent = solvedByRobot ? "The robotic solver cracked it!" : "Amazing work! Here's how you did:";
    document.getElementById("resultConfetti").textContent = solvedByRobot ? "⚙️" : "🎉";

    if (!solvedByRobot) {
        const key = `puzzle_best_${gridSize}`;
        const best = JSON.parse(localStorage.getItem(key) || "null");
        const isNew = !best || moves < best.moves || (moves === best.moves && globalTimer < best.timer);
        if (isNew) {
            localStorage.setItem(key, JSON.stringify({ moves, timeStr, timer: globalTimer }));
            document.getElementById("resultBest").textContent = "🌟 New Record!";
            loadBestScores();
        } else {
            document.getElementById("resultBest").textContent = `${best.moves} moves (${best.timeStr})`;
        }
    } else {
        document.getElementById("resultBest").textContent = "Robot Assisted";
    }

    document.getElementById("resultModal").classList.add("show");
}

document.getElementById("playAgainBtn").onclick = () => {
    document.getElementById("resultModal").classList.remove("show");
    startPuzzle();
};

document.getElementById("continueBtn").onclick = () => {
    document.getElementById("resultModal").classList.remove("show");
};

function loadBestScores() {
    for (let s = 3; s <= 6; s++) {
        const best = JSON.parse(localStorage.getItem(`puzzle_best_${s}`) || "null");
        const el = document.getElementById(`best${s}`);
        if (el) el.textContent = best ? `${best.moves} moves (${best.timeStr})` : "No Record";
    }
}

// ── Event Listeners ────────────────────────────────────────────────────────────
openCameraBtn.onclick = () => startCamera();
captureBtn.onclick = captureImage;
retakeBtn.onclick = resetPuzzle;
uploadInput.onchange = onImageUpload;
cameraSelect.onchange = (e) => startCamera(e.target.value);
startPuzzleBtn.onclick = startPuzzle;
solveBtn.onclick = toggleSolver;

document.querySelectorAll(".grid-btn").forEach(btn => {
    btn.onclick = () => {
        const newSize = parseInt(btn.dataset.grid);
        switchDifficulty(newSize);
    };
});

document.getElementById("showNumbers").onchange = () => {
    // Rebuild all difficulty states with new number overlay setting
    if (!loadedImageSrc) return;
    const activeSizes = Object.keys(difficultyStates).map(Number);
    for (const sz of activeSizes) {
        const oldState = difficultyStates[sz];
        const newState = buildFreshState(sz);
        // Restore piece arrangement by matching positional index
        if (oldState.isStarted) {
            newState.pieces = oldState.pieces.map(oldPiece => {
                const idx = oldState.originalOrder.indexOf(oldPiece);
                return idx >= 0 ? newState.originalOrder[idx] : newState.originalOrder[0];
            });
        }
        newState.moves = oldState.moves;
        newState.isCompleted = oldState.isCompleted;
        newState.isStarted = oldState.isStarted;
        difficultyStates[sz] = newState;
    }
    renderCurrentDifficulty(true);
};

// ── Init ───────────────────────────────────────────────────────────────────────
loadBestScores();

// Attempt to restore last session from localStorage
restoreSession().then(restored => {
    if (!restored) {
        // Nothing to restore – idle state
    }
}).catch(() => { });
