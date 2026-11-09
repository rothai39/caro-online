
// ========================================
// 1. SUPABASE CONFIG
// ========================================

const SUPABASE_URL =
  "https://rijyeebrotdulekbcoiu.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_wxEd6IVZdqTzD8SQbbKotQ_YTZFdrRG";

const db = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);


// ========================================
// 2. GLOBAL VARIABLES
// ========================================

let playerId = null;
let room = null;
let mySymbol = null;

let channel = null;
let chatChannel = null;

let cells = [];

let timerInterval = null;
let roomCheckInterval = null;

let timeoutRequestedFor = null;
let timeoutRequestInFlight = false;
let timeoutRetryAt = 0;

let roomDeleted = false;
// Ô đang chờ người chơi xác nhận
let pendingMoveIndex = null;

// Ngăn gửi nhiều request đánh cờ đồng thời
let moveInFlight = false;

const $ = id => document.getElementById(id);


// ========================================
// 3. GENERAL FUNCTIONS
// ========================================

function showMessage(id, message) {
  $(id).textContent = message;
}

function getName() {
  return (
    $("playerName").value.trim() || "Người chơi"
  ).slice(0, 20);
}

function isRoomActive() {
  return Boolean(room && !roomDeleted);
}


// ========================================
// 4. AUTHENTICATION
// ========================================

async function initializeAuth() {
  const {
    data: { session },
    error
  } = await db.auth.getSession();

  if (error) throw error;

  let currentSession = session;

  if (!currentSession) {
    const result = await db.auth.signInAnonymously();

    if (result.error) throw result.error;

    currentSession = result.data.session;
  }

  if (!currentSession) {
    throw new Error("Không thể tạo phiên đăng nhập.");
  }

  playerId = currentSession.user.id;

  console.log("Authenticated player:", playerId);

  return true;
}

const authReady = initializeAuth().catch(error => {
  console.error("Authentication error:", error);

  showMessage(
    "homeMessage",
    "Không thể đăng nhập. Vui lòng tải lại trang."
  );

  return false;
});


// ========================================
// 5. CREATE ROOM
// ========================================

$("createBtn").onclick = async () => {
  showMessage("homeMessage", "Đang tạo phòng...");

  if (!(await authReady)) return;

  const { data, error } = await db.rpc(
    "create_caro_room"
  );

  if (error) {
    showMessage("homeMessage", error.message);
    return;
  }

  await enterRoom(data);
};


// ========================================
// 6. JOIN ROOM
// ========================================

$("joinBtn").onclick = async () => {
  const code = $("roomInput").value
    .trim()
    .toUpperCase();

  if (!code) {
    showMessage(
      "homeMessage",
      "Vui lòng nhập mã phòng!"
    );
    return;
  }

  showMessage("homeMessage", "Đang tham gia...");

  if (!(await authReady)) return;

  const { data, error } = await db.rpc(
    "join_caro_room",
    {
      p_code: code
    }
  );

  if (error) {
    showMessage("homeMessage", error.message);
    return;
  }

  await enterRoom(data);
};


// ========================================
// 7. CHAT FUNCTIONS
// ========================================

// Render message

function renderChatMessage(message) {
  const container = $("chatMessages");

  if (
    container.querySelector(
      `[data-message-id="${message.id}"]`
    )
  ) {
    return;
  }

  const empty = container.querySelector(".chat-empty");

  if (empty) empty.remove();

  const isMine = message.user_id === playerId;

  const item = document.createElement("div");

  item.className =
    "chat-item " + (isMine ? "mine" : "other");

  item.dataset.messageId = message.id;

  const name = document.createElement("span");

  name.className = "chat-name";

  name.textContent =
    message.username + (isMine ? " (Bạn)" : "");

  const bubble = document.createElement("div");

  bubble.className = "chat-bubble";
  bubble.textContent = message.content;

  const time = document.createElement("span");

  time.className = "chat-time";

  time.textContent = new Date(
    message.created_at
  ).toLocaleTimeString("vi-VN", {
    hour: "2-digit",
    minute: "2-digit"
  });

  item.appendChild(name);
  item.appendChild(bubble);
  item.appendChild(time);

  container.appendChild(item);

  container.scrollTop = container.scrollHeight;
}


// Load chat history

async function loadChat() {
  if (!isRoomActive()) return;

  const currentCode = room.room_code;

  const { data, error } = await db
    .from("room_messages")
    .select("*")
    .eq("room_code", currentCode)
    .order("created_at", {
      ascending: true
    })
    .limit(100);

  if (error) {
    console.error("Load chat error:", error);

    showMessage(
      "chatMessage",
      "Không thể tải tin nhắn."
    );

    return;
  }

  if (
    !isRoomActive() ||
    room.room_code !== currentCode
  ) {
    return;
  }

  data.forEach(renderChatMessage);
}



// Setup realtime chat

async function setupChat() {
  if (chatChannel) {
    await db.removeChannel(chatChannel);
    chatChannel = null;
  }

  $("chatMessages").innerHTML =
    '<p class="chat-empty">Đang tải tin nhắn...</p>';

  const currentCode = room.room_code;

  chatChannel = db
    .channel("chat-" + currentCode)

    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "room_messages",
        filter: "room_code=eq." + currentCode
      },
      payload => {
        if (
          !isRoomActive() ||
          room.room_code !== currentCode
        ) {
          return;
        }

        renderChatMessage(payload.new);
      }
    )

    .subscribe(status => {
      if (
        !isRoomActive() ||
        room.room_code !== currentCode
      ) {
        return;
      }

      if (status === "SUBSCRIBED") {
        loadChat();

        showMessage("chatMessage", "");

      } else if (status === "CHANNEL_ERROR") {
        showMessage(
          "chatMessage",
          "Lỗi kết nối chat."
        );
      }
    });
}
      
// Send chat message

$("chatForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (!isRoomActive() || !playerId) return;

    const currentCode = room.room_code;

    const input = $("chatInput");
    const content = input.value.trim();

    if (!content) return;

    const sendBtn = $("chatSendBtn");

    sendBtn.disabled = true;

    try {
      const { error } = await db
        .from("room_messages")
        .insert({
          room_code: currentCode,
          user_id: playerId,
          username: getName(),
          content: content
        });

      if (error) throw error;

      input.value = "";
      input.focus();

      showMessage("chatMessage", "");

    } catch (error) {
      console.error("Send chat error:", error);

      showMessage(
        "chatMessage",
        "Gửi tin nhắn thất bại."
      );

    } finally {
      sendBtn.disabled = false;
    }
  }
);

// ========================================
// 8. ENTER ROOM
// ========================================


async function enterRoom(data) {
  if (!data || !data.room_code) {
    showMessage(
      "homeMessage",
      "Dữ liệu phòng không hợp lệ."
    );
    return;
  }

  // Dọn kết nối cũ
  stopTimer();
  stopRoomChecker();

  if (channel) {
    await db.removeChannel(channel);
    channel = null;
  }

  if (chatChannel) {
    await db.removeChannel(chatChannel);
    chatChannel = null;
  }

  room = data;
  roomDeleted = false;

  timeoutRequestedFor = null;
  timeoutRequestInFlight = false;
  timeoutRetryAt = 0;

  pendingMoveIndex = null;
  moveInFlight = false;

  if (room.player_x === playerId) {
    mySymbol = "X";
  } else if (room.player_o === playerId) {
    mySymbol = "O";
  } else {
    room = null;

    showMessage(
      "homeMessage",
      "Không xác định được người chơi."
    );

    return;
  }

  $("homeScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");

  $("roomCode").textContent = room.room_code;

  $("gameMessage").textContent = "";
  $("chatMessage").textContent = "";

  renderRoom();

  // Camera về chính giữa bàn cờ
  requestAnimationFrame(() => {
    if (isRoomActive()) {
      centerBoardStart(false);
    }
  });

  // Khởi động timer
  startTimer();

  // Kiểm tra phòng bị xóa
  startRoomChecker();

  // Khởi động chat
  setupChat();

  // Realtime game
  const currentCode = room.room_code;

  channel = db
    .channel("caro-" + currentCode)

    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "caro_rooms",
        filter: "room_code=eq." + currentCode
      },
      payload => {
        if (
          !isRoomActive() ||
          room.room_code !== currentCode
        ) {
          return;
        }

        const previousStartedAt =
  room.turn_started_at;

const oldMoveCount = Object.keys(
  room.board || {}
).length;

room = payload.new;

const newMoveCount = Object.keys(
  room.board || {}
).length;

// Nhận biết reset game
if (
  oldMoveCount > 0 &&
  newMoveCount === 0 &&
  !room.winner
) {
  pendingMoveIndex = null;

  requestAnimationFrame(() => {
    if (
      isRoomActive() &&
      room.room_code === currentCode
    ) {
      centerBoardStart(true);
    }
  });
}

        // Theo dõi nước đi đầu tiên
        if (
          oldMoveCount === 0 &&
          newMoveCount === 1 &&
          room.last_move !== null &&
          room.last_move !== undefined
        ) {
          const firstMove = room.last_move;

          requestAnimationFrame(() => {
            if (
              isRoomActive() &&
              room.room_code === currentCode
            ) {
              centerBoardAt(firstMove, true);
            }
          });
        }

        // Xóa lựa chọn cũ
        pendingMoveIndex = null;

        // Reset timeout khi có lượt mới
        if (
          room.turn_started_at !== previousStartedAt
        ) {
          timeoutRequestedFor = null;
          timeoutRetryAt = 0;
        }

        renderRoom();
      }
    )

    .subscribe(status => {
      if (
        !isRoomActive() ||
        room.room_code !== currentCode
      ) {
        return;
      }

      if (status === "SUBSCRIBED") {
        showMessage(
          "gameMessage",
          "Đã kết nối realtime!"
        );

      } else if (status === "CHANNEL_ERROR") {
        showMessage(
          "gameMessage",
          "Lỗi kết nối realtime. Hãy tải lại trang."
        );
      }
    });
}
// ========================================
// 9. CREATE BOARD 100 x 100
// ========================================

function createBoard() {
  const board = $("board");

  board.innerHTML = "";
  cells = [];

  const fragment = document.createDocumentFragment();

  for (let i = 0; i < 10000; i++) {
    const cell = document.createElement("button");

    cell.className = "cell";
    cell.type = "button";
    cell.dataset.cell = i;

    cell.setAttribute(
      "aria-label",
      `Hàng ${Math.floor(i / 100) + 1}, cột ${i % 100 + 1}`
    );

    fragment.appendChild(cell);

    cells.push(cell);
  }

  board.appendChild(fragment);
}

createBoard();

// ========================================
// added. BOARD CAMERA
// ========================================

// Căn camera đến một ô bất kỳ
function centerBoardAt(index, smooth = true) {
  if (
    index === null ||
    index < 0 ||
    index >= 10000
  ) {
    return;
  }

  const viewport = $("boardViewport");
  const cell = cells[index];

  if (!viewport || !cell) return;

  const viewportRect = viewport.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();

  const deltaX =
    cellRect.left +
    cellRect.width / 2 -
    (viewportRect.left + viewport.clientWidth / 2);

  const deltaY =
    cellRect.top +
    cellRect.height / 2 -
    (viewportRect.top + viewport.clientHeight / 2);

  viewport.scrollTo({
    left: viewport.scrollLeft + deltaX,
    top: viewport.scrollTop + deltaY,
    behavior: smooth ? "smooth" : "instant"
  });
}


// Căn về chính giữa bàn cờ
function centerBoardStart(smooth = true) {
  centerBoardAt(49 * 100 + 49, smooth);
}
// ========================================
// 10. CARO TURN TIMER
// ========================================

// Lấy thời gian còn lại

function getRemainingTime() {
  if (!room || !room.turn_started_at) {
    return 0;
  }

  const startedAt = new Date(
    room.turn_started_at
  ).getTime();

  const duration = Number(
    room.turn_duration || 30
  );

  if (!Number.isFinite(startedAt)) {
    return 0;
  }

  const elapsed = Math.floor(
    (Date.now() - startedAt) / 1000
  );

  return Math.max(0, duration - elapsed);
}


// ========================================
// 11. RENDER TIMER
// ========================================

function renderTimer() {
  const timerBox = $("timerBox");
  const timerDisplay = $("turnTimer");
  const timerHint = $("timerHint");

  if (
    !room ||
    !room.player_o ||
    room.winner ||
    !room.turn_started_at
  ) {
    timerDisplay.textContent = "--:--";

    timerBox.classList.remove(
      "timer-warning",
      "timer-danger",
      "timer-finished"
    );

    if (room?.winner) {
      timerHint.textContent =
        "Ván đấu đã kết thúc.";

    } else if (!room?.player_o) {
      timerHint.textContent =
        "Đang chờ người chơi thứ hai...";

    } else {
      timerHint.textContent =
        "Đang chờ khởi tạo đồng hồ...";
    }

    return;
  }

  const remaining = getRemainingTime();

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;

  timerDisplay.textContent =
    String(minutes).padStart(2, "0") +
    ":" +
    String(seconds).padStart(2, "0");

  timerBox.classList.remove(
    "timer-warning",
    "timer-danger",
    "timer-finished"
  );

  if (remaining <= 0) {
    timerBox.classList.add("timer-finished");

    timerHint.textContent =
      "Đang xác nhận hết giờ...";

  } else if (remaining <= 5) {
    timerBox.classList.add("timer-danger");

    timerHint.textContent =
      "Sắp hết giờ!";

  } else if (remaining <= 10) {
    timerBox.classList.add("timer-warning");

    timerHint.textContent =
      "Hãy nhanh chóng đánh!";

  } else {
    timerHint.textContent =
      "Lượt của " + room.turn;
  }
}


// ========================================
// 12. CHECK TIMEOUT ON SUPABASE
// ========================================

async function checkTimeout() {
  if (
    !isRoomActive() ||
    !room.player_o ||
    room.winner ||
    !room.turn_started_at ||
    timeoutRequestInFlight
  ) {
    return;
  }

  const turnStartedAt = room.turn_started_at;

  if (getRemainingTime() > 0) {
    return;
  }

  if (timeoutRequestedFor === turnStartedAt) {
    if (Date.now() < timeoutRetryAt) {
      return;
    }
  }

  timeoutRequestInFlight = true;
  timeoutRequestedFor = turnStartedAt;

  try {
    const currentCode = room.room_code;

    const { data, error } = await db.rpc(
      "check_caro_timeout",
      {
        p_code: currentCode
      }
    );

    if (error) {
      console.error("Timeout error:", error);

      // Thử lại sau 3 giây

      timeoutRetryAt = Date.now() + 3000;

      return;
    }

    if (
      isRoomActive() &&
      room.room_code === currentCode &&
      data
    ) {
      room = data;

      if (
        !data.winner &&
        data.turn_started_at === turnStartedAt
      ) {
        // Server chưa xác nhận hết giờ

        timeoutRetryAt = Date.now() + 1000;

      } else {
        timeoutRequestedFor = null;
        timeoutRetryAt = 0;
      }

      renderRoom();
    }

  } catch (error) {
    console.error("Timeout exception:", error);

    timeoutRetryAt = Date.now() + 3000;

  } finally {
    timeoutRequestInFlight = false;
  }
}


// ========================================
// 13. START / STOP TIMER
// ========================================

function startTimer() {
  stopTimer();

  renderTimer();

  timerInterval = setInterval(() => {
    if (!isRoomActive()) {
      stopTimer();
      return;
    }

    renderTimer();

    checkTimeout();

  }, 1000);
}


function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}


// ========================================
// 14. RENDER ROOM
// ========================================

function renderRoom() {
  if (!room) return;

  // Tên người chơi

  $("nameX").textContent =
    room.player_x === playerId
      ? getName() + " (Bạn)"
      : "Người chơi X";

  $("nameO").textContent =
    room.player_o
      ? room.player_o === playerId
        ? getName() + " (Bạn)"
        : "Người chơi O"
      : "Đang chờ đối thủ...";


  // Người đang đến lượt

  $("playerX").classList.toggle(
    "active",
    room.turn === "X" && !room.winner
  );

  $("playerO").classList.toggle(
    "active",
    room.turn === "O" && !room.winner
  );


  // Trạng thái game

  $("gameStatus").textContent =
    room.winner
      ? "Ván đấu đã kết thúc!"

      : !room.player_o
        ? "Đang chờ người chơi thứ hai..."

        : room.turn === mySymbol
          ? "Đến lượt bạn (" + mySymbol + ")"
          : "Đang chờ đối thủ đánh...";


  // Bàn cờ

  const board = room.board || {};

cells.forEach((cell, i) => {
  const value = board[i] || "";

  cell.textContent = value;

  cell.classList.toggle("x", value === "X");
  cell.classList.toggle("o", value === "O");

  // Highlight nước đi mới nhất
  cell.classList.toggle(
    "last-move",
    Number(room.last_move) === i &&
room.last_move !== null
  );

  // Highlight ô đang chờ xác nhận
  cell.classList.toggle(
    "selected-move",
    pendingMoveIndex === i
  );

  cell.disabled = Boolean(
    value ||
    room.winner ||
    room.turn !== mySymbol ||
    !room.player_o ||
    moveInFlight
  );
});

  // Người chiến thắng

  if (room.winner) {
    $("winnerBox").classList.remove("hidden");

    $("winnerText").textContent =
      room.winner === mySymbol
        ? "🎉 BẠN ĐÃ CHIẾN THẮNG!"
        : "😢 BẠN ĐÃ THUA!";

  } else {
    $("winnerBox").classList.add("hidden");
  }


  // Cập nhật đồng hồ

  renderTimer();
}

// ========================================
// 15. MAKE CARO MOVE
// ========================================


$("board").addEventListener("click", async event => {
  const cell = event.target.closest(".cell");

  if (!cell || !isRoomActive()) return;

  if (moveInFlight) return;

  const index = Number(cell.dataset.cell);

  if (
    room.winner ||
    room.turn !== mySymbol ||
    !room.player_o
  ) {
    return;
  }

  if (room.board?.[index]) {
    pendingMoveIndex = null;
    renderRoom();
    showMessage("gameMessage", "Ô này đã có quân cờ!");
    return;
  }

  // CLICK LẦN 1: Chọn ô
  if (pendingMoveIndex !== index) {
    pendingMoveIndex = index;

    renderRoom();

    showMessage(
      "gameMessage",
      "Đã chọn ô. Click lần nữa để xác nhận nước đi!"
    );

    return;
  }

  // CLICK LẦN 2: Xác nhận đánh
  pendingMoveIndex = null;
  moveInFlight = true;

  const currentCode = room.room_code;

  renderRoom();

  const oldMoveCount = Object.keys(
    room.board || {}
  ).length;

  try {
    const { data, error } = await db.rpc(
      "make_caro_move",
      {
        p_code: currentCode,
        p_cell: index
      }
    );

    if (
      !isRoomActive() ||
      room.room_code !== currentCode
    ) {
      return;
    }

    if (error) throw error;

    if (data) {
      room = data;

      timeoutRequestedFor = null;
      timeoutRetryAt = 0;

      // Chỉ track đến nước đi đầu tiên của ván
      const newMoveCount = Object.keys(
        data.board || {}
      ).length;

      if (
        oldMoveCount === 0 &&
        newMoveCount === 1
      ) {
        requestAnimationFrame(() => {
          if (isRoomActive()) {
            centerBoardAt(index, true);
          }
        });
      }

      renderRoom();

      showMessage(
        "gameMessage",
        "Đã đánh cờ!"
      );
    }

  } catch (error) {
    console.error("Move error:", error);

    showMessage(
      "gameMessage",
      error.message || "Không thể đánh cờ."
    );

  } finally {
    moveInFlight = false;

    if (isRoomActive()) {
      renderRoom();
    }
  }
});

// ========================================
// 16. RESET GAME
// ========================================

$("resetBtn").onclick = async () => {
  if (!isRoomActive() || !room.winner) return;

  const confirmed = confirm(
    "Bạn có chắc muốn bắt đầu ván mới?"
  );

  if (!confirmed) return;

  const currentCode = room.room_code;

  $("resetBtn").disabled = true;

  try {
    const { data, error } = await db.rpc(
      "reset_caro_room",
      {
        p_code: currentCode
      }
    );

    if (error) throw error;

    if (!isRoomActive() || room.room_code !== currentCode) {
      return;
    }

    room = data;

timeoutRequestedFor = null;
timeoutRetryAt = 0;

pendingMoveIndex = null;

renderRoom();

// Đưa camera về chính giữa sau reset
requestAnimationFrame(() => {
  if (isRoomActive()) {
    centerBoardStart(true);
  }
});

    showMessage(
      "gameMessage",
      "Đã bắt đầu ván mới!"
    );

  } catch (error) {
    console.error("Reset error:", error);

    showMessage("gameMessage", error.message);

  } finally {
    $("resetBtn").disabled = false;
  }
};


// ========================================
// 17. COPY ROOM CODE
// ========================================

$("copyBtn").onclick = async () => {
  if (!isRoomActive()) return;

  try {
    await navigator.clipboard.writeText(
      room.room_code
    );

    showMessage(
      "gameMessage",
      "Đã copy mã phòng!"
    );

  } catch (error) {
    showMessage(
      "gameMessage",
      "Không thể copy mã phòng."
    );
  }
};


// ========================================
// 18. BOARD ZOOM
// ========================================

$("zoom").oninput = event => {
  const value = Number(event.target.value);

  $("board").style.zoom = value + "%";

  $("zoomValue").textContent = value + "%";
};


// ========================================
// 19. CHECK ROOM EXISTENCE
// ========================================

// Kiểm tra phòng có bị Cron xóa hay không

async function checkRoomExists() {
  if (!isRoomActive()) return;

  const currentCode = room.room_code;

  const { data, error } = await db
    .from("caro_rooms")
    .select("room_code")
    .eq("room_code", currentCode)
    .maybeSingle();

  if (!isRoomActive() || room.room_code !== currentCode) {
    return;
  }

  if (error) {
    console.error("Room check error:", error);
    return;
  }

  if (!data) {
    handleRoomDeleted();
  }
}


// ========================================
// 20. HANDLE DELETED ROOM
// ========================================

function handleRoomDeleted() {
  if (roomDeleted) return;

  roomDeleted = true;

  stopTimer();
  stopRoomChecker();

  if (channel) {
    db.removeChannel(channel);
    channel = null;
  }

  if (chatChannel) {
    db.removeChannel(chatChannel);
    chatChannel = null;
  }

  room = null;
  mySymbol = null;

  $("gameScreen").classList.add("hidden");
  $("homeScreen").classList.remove("hidden");

  showMessage(
    "homeMessage",
    "Phòng đã bị xóa do không hoạt động quá 30 phút."
  );
}


// ========================================
// 21. ROOM CHECKER
// ========================================

function startRoomChecker() {
  stopRoomChecker();

  checkRoomExists();

  roomCheckInterval = setInterval(() => {
    checkRoomExists();
  }, 30000);
}


function stopRoomChecker() {
  if (roomCheckInterval) {
    clearInterval(roomCheckInterval);

    roomCheckInterval = null;
  }
}


// ========================================
// 22. LEAVE ROOM
// ========================================

$("leaveBtn").onclick = async () => {
  if (!isRoomActive()) return;

  if (!confirm("Bạn muốn rời phòng?")) return;

  stopTimer();
  stopRoomChecker();

  if (channel) {
    await db.removeChannel(channel);

    channel = null;
  }

  if (chatChannel) {
    await db.removeChannel(chatChannel);

    chatChannel = null;
  }

  room = null;
  mySymbol = null;

  roomDeleted = false;

  timeoutRequestedFor = null;
  timeoutRetryAt = 0;
  timeoutRequestInFlight = false;

  $("gameScreen").classList.add("hidden");
  $("homeScreen").classList.remove("hidden");

  $("chatMessages").innerHTML =
    '<p class="chat-empty">Chưa có tin nhắn nào.</p>';

  $("chatInput").value = "";

  showMessage(
    "homeMessage",
    "Bạn đã rời phòng."
  );
};


// ========================================
// 23. CLEANUP WHEN CLOSING PAGE
// ========================================

window.addEventListener("beforeunload", () => {
  stopTimer();
  stopRoomChecker();
});
