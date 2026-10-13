const status = document.getElementById("status");
const detail = document.getElementById("detail");
const dot = document.getElementById("dot");
const track = document.getElementById("track");
const clear = document.getElementById("clear");
let currentState = null;

function render(state) {
  currentState = state;
  track.disabled = !state.active;
  clear.disabled = !state.active || state.targetTabId === null;
  dot.classList.toggle("active", state.active && state.targetTabId !== null);
  status.textContent = !state.active ? "Ready when you are" : state.targetTabId === null ? "Choose the tab you are sharing" : "Tracking selected tab";
  detail.textContent = !state.active ? "Start a Cursor Studio recording first." : state.targetTitle || "Open your shared web page, then click below.";
}
async function request(type) {
  try {
    const response = await chrome.runtime.sendMessage({ type });
    if (!response.ok) throw new Error(response.error || "Could not connect to Cursor Studio.");
    return response;
  } catch (error) {
    status.textContent = "Tracker needs your attention";
    detail.textContent = error.message;
    return null;
  }
}
track.addEventListener("click", async () => {
  track.disabled = true;
  const response = await request("TARGET_TAB");
  if (response) render(response);
  else track.disabled = !currentState?.active;
});
clear.addEventListener("click", async () => {
  const response = await request("CLEAR_TARGET");
  if (response) render(response);
});
void request("GET_SESSION").then(state => { if (state) render(state); });
