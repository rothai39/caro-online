
const SUPABASE_URL = "https://rijyeebrotdulekbcoiu.supabase.co";
const SUPABASE_KEY = "sb_publishable_wxEd6IVZdqTzD8SQbbKotQ_YTZFdrRG";

const db = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

let playerId = null;
let room = null;
let mySymbol = null;
let channel = null;
let cells = [];

const $ = id => document.getElementById(id);

function showMessage(id, message) {
  $(id).textContent = message;
}

function getName() {
  return $("playerName").value.trim() || "Người chơi";
}

// Đăng nhập ẩn danh
async function initializeAuth() {
  let { data: { session }, error } =
    await db.auth.getSession();

  if (error) throw error;

  if (!session) {
    const result = await db.auth.signInAnonymously();

    if (result.error) throw result.error;

    session = result.data.session;
  }

  playerId = session.user.id;

  console.log("Authenticated player:", playerId);

  return true;
}

// Khởi tạo xác thực một lần duy nhất
const authReady = initializeAuth().catch(error => {
  console.error("Authentication error:", error);

  showMessage(
    "homeMessage",
    "Không thể đăng nhập. Vui lòng tải lại trang."
  );

  return false;
});

// Tạo phòng
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

// Tham gia phòng
$("joinBtn").onclick = async () => {
  const code = $("roomInput").value.trim().toUpperCase();

  if (!code) {
    showMessage("homeMessage", "Vui lòng nhập mã phòng!");
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

// Vào phòng
async function enterRoom(data) {
  room = data;

  if (room.player_x === playerId) {
    mySymbol = "X";
  } else if (room.player_o === playerId) {
    mySymbol = "O";
  } else {
    showMessage("homeMessage", "Không xác định được người chơi.");
    return;
  }

  $("homeScreen").classList.add("hidden");
  $("gameScreen").classList.remove("hidden");

  $("roomCode").textContent = room.room_code;

  renderRoom();

  if (channel) {
    await db.removeChannel(channel);
  }

  channel = db.channel("caro-" + room.room_code)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "caro_rooms",
        filter: "room_code=eq." + room.room_code
      },
      payload => {
        room = payload.new;
        renderRoom();
      }
    )
    .subscribe(status => {
      if (status === "SUBSCRIBED") {
        $("gameMessage").textContent = "Đã kết nối realtime!";
      } else if (status === "CHANNEL_ERROR") {
        $("gameMessage").textContent =
          "Lỗi kết nối realtime. Hãy tải lại trang.";
      }
    });
}

// Tạo bàn cờ 100 x 100
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

// Hiển thị trạng thái phòng
function renderRoom() {
  if (!room) return;

  $("nameX").textContent =
    room.player_x === playerId
      ? getName() + " (Bạn)"
      : "Người chơi X";

  $("nameO").textContent = room.player_o
    ? room.player_o === playerId
      ? getName() + " (Bạn)"
      : "Người chơi O"
    : "Đang chờ đối thủ...";

  $("playerX").classList.toggle(
    "active",
    room.turn === "X" && !room.winner
  );

  $("playerO").classList.toggle(
    "active",
    room.turn === "O" && !room.winner
  );

  $("gameStatus").textContent = room.winner
    ? "Ván đấu đã kết thúc!"
    : !room.player_o
      ? "Đang chờ người chơi thứ hai..."
      : room.turn === mySymbol
        ? "Đến lượt bạn (" + mySymbol + ")"
        : "Đang chờ đối thủ đánh...";

  const board = room.board || {};

  cells.forEach((cell, i) => {
    const value = board[i] || "";

    cell.textContent = value;
    cell.classList.toggle("x", value === "X");
    cell.classList.toggle("o", value === "O");

    cell.disabled = Boolean(
      value ||
      room.winner ||
      room.turn !== mySymbol ||
      !room.player_o
    );
  });

  if (room.winner) {
    $("winnerBox").classList.remove("hidden");
    $("winnerText").textContent =
      room.winner === mySymbol
        ? "🎉 BẠN ĐÃ CHIẾN THẮNG!"
        : "😢 BẠN ĐÃ THUA!";
  } else {
    $("winnerBox").classList.add("hidden");
  }
}

// Đánh cờ
$("board").addEventListener("click", async event => {
  const cell = event.target.closest(".cell");

  if (!cell || !room) return;

  const index = Number(cell.dataset.cell);

  if (
    room.winner ||
    room.turn !== mySymbol ||
    !room.player_o ||
    room.board[index]
  ) return;

  cell.disabled = true;

  const { data, error } = await db.rpc(
  "make_caro_move",
  {
    p_code: room.room_code,
    p_cell: index
  }
);

  if (error) {
    showMessage("gameMessage", error.message);
    renderRoom();
    return;
  }

  room = data;
  renderRoom();
  showMessage("gameMessage", "Đã đánh cờ!");
});

// Reset ván
$("resetBtn").onclick = async () => {
  if (!room || !room.winner) return;

  const confirmed = confirm(
    "Bạn có chắc muốn bắt đầu ván mới?"
  );

  if (!confirmed) return;

  $("resetBtn").disabled = true;

  const { data, error } = await db.rpc(
  "reset_caro_room",
  {
    p_code: room.room_code
  }
);

  $("resetBtn").disabled = false;

  if (error) {
    showMessage("gameMessage", error.message);
    return;
  }

  room = data;
  renderRoom();
  showMessage("gameMessage", "Đã bắt đầu ván mới!");
};

// Copy mã phòng
$("copyBtn").onclick = async () => {
  try {
    await navigator.clipboard.writeText(room.room_code);
    showMessage("gameMessage", "Đã copy mã phòng!");
  } catch {
    showMessage("gameMessage", "Không thể copy mã phòng.");
  }
};

// Zoom bàn cờ
$("zoom").oninput = event => {
  const value = Number(event.target.value);

  $("board").style.zoom = value + "%";
  $("zoomValue").textContent = value + "%";
};

// Rời phòng
$("leaveBtn").onclick = async () => {
  if (!confirm("Bạn muốn rời phòng?")) return;

  if (channel) {
    await db.removeChannel(channel);
    channel = null;
  }

  room = null;
  mySymbol = null;

  $("gameScreen").classList.add("hidden");
  $("homeScreen").classList.remove("hidden");

  showMessage("homeMessage", "Bạn đã rời phòng.");
};

